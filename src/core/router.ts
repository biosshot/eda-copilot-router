import type {
  BackendRouteRequest,
  RouterBackendAdapter,
  RouterCapability,
} from "../adapters/contracts.js"
import {
  applyPcbPatchV1,
  type CoreStatus,
  type PcbPatchV1,
  type PcbSnapshotV1,
  type RoutingDiagnostic,
} from "./contracts.js"
import { validatePcbPatchForSnapshotV1, validatePcbSnapshotV1 } from "./validation.js"
import { isRoutingIntentV2, preflightRoutingIntent } from "../intent/index.js"

export type RoutePcbRequest<TIntent = unknown> = Readonly<{
  snapshot: PcbSnapshotV1
  intent: TIntent
  backend: RouterBackendAdapter<TIntent>
  /** full routes implicit ordinary nets; declared-only runs only explicit intent. */
  scope?: "full" | "declared-only"
  requiredCapabilities?: readonly RouterCapability[]
  /** Search/quality policy remains serializable and backend-neutral. */
  policy?: unknown
  signal?: AbortSignal
}>

export type RoutePcbResult = Readonly<{
  patch: PcbPatchV1
  outputSnapshot?: PcbSnapshotV1
  backend: Readonly<{ id: string; version: string }>
}>

function patch(
  baseSnapshotHash: string,
  coreStatus: CoreStatus,
  diagnostics: readonly RoutingDiagnostic[],
  operations: PcbPatchV1["operations"] = [],
): PcbPatchV1 {
  return {
    schema: "pcb-patch",
    version: 1,
    baseSnapshotHash,
    operations,
    diagnostics,
    coreStatus,
    requiresNativeVerification: true,
  }
}

function errorDiagnostic(code: string, message: string, details?: unknown): RoutingDiagnostic {
  return { code, severity: "error", message, ...(details === undefined ? {} : { details }) }
}

/**
 * Run a fully injected backend against an immutable snapshot. All failures are
 * captured as an error patch; the core never opens, writes, refills, or checks
 * an EDA document.
 */
export async function routePcb<TIntent = unknown>(
  request: RoutePcbRequest<TIntent>,
): Promise<RoutePcbResult> {
  const backend = { id: request.backend.id, version: request.backend.version }
  const snapshotValidation = validatePcbSnapshotV1(request.snapshot)
  if (!snapshotValidation.ok) {
    return {
      backend,
      patch: patch(request.snapshot?.contentHash ?? "invalid", "error", snapshotValidation.diagnostics),
    }
  }

  if (request.signal?.aborted) {
    return {
      backend,
      patch: patch(request.snapshot.contentHash, "error", [
        errorDiagnostic("ROUTING_ABORTED", "Routing was aborted before backend execution."),
      ]),
    }
  }

  const supported = new Set(request.backend.capabilities.supported)
  const portablePreflight = isRoutingIntentV2(request.intent)
    ? preflightRoutingIntent(request.snapshot, request.intent, {
        backendCapabilities: request.backend.capabilities,
        routeUnqualifiedNets: (request.scope ?? "full") === "full",
      })
    : undefined
  if (portablePreflight && !portablePreflight.valid) {
    return {
      backend,
      patch: patch(request.snapshot.contentHash, "error", portablePreflight.diagnostics),
    }
  }
  const missing = [...new Set([
    ...(request.requiredCapabilities ?? []),
    ...(portablePreflight?.requiredCapabilities ?? []),
  ])]
    .filter((capability) => !supported.has(capability))
  const layerLimit = request.backend.capabilities.maxCopperLayers
  const capabilityDiagnostics: RoutingDiagnostic[] = []
  if (missing.length) capabilityDiagnostics.push(errorDiagnostic(
    "UNSUPPORTED_CONSTRAINT",
    `Backend ${request.backend.id} lacks required capabilities.`,
    { missing },
  ))
  if (layerLimit !== undefined && request.snapshot.rawPcb.layers.length > layerLimit) {
    capabilityDiagnostics.push(errorDiagnostic(
      "UNSUPPORTED_LAYER_COUNT",
      `Backend ${request.backend.id} supports at most ${layerLimit} copper layers.`,
      { actual: request.snapshot.rawPcb.layers.length },
    ))
  }
  if (capabilityDiagnostics.length) {
    return { backend, patch: patch(request.snapshot.contentHash, "error", capabilityDiagnostics) }
  }

  const backendRequest: BackendRouteRequest<TIntent> = {
    snapshot: request.snapshot,
    intent: request.intent,
    scope: request.scope ?? "full",
    ...(request.policy === undefined ? {} : { policy: request.policy }),
    ...(request.signal ? { signal: request.signal } : {}),
  }

  let preflightDiagnostics: readonly RoutingDiagnostic[] = []
  try {
    preflightDiagnostics = (await request.backend.preflight?.(backendRequest))?.diagnostics ?? []
  } catch (error) {
    preflightDiagnostics = [errorDiagnostic(
      "BACKEND_PREFLIGHT_EXCEPTION",
      `Backend ${request.backend.id} preflight threw an exception.`,
      error instanceof Error ? error.message : String(error),
    )]
  }
  if (preflightDiagnostics.some((item) => item.severity === "error")) {
    return { backend, patch: patch(request.snapshot.contentHash, "error", preflightDiagnostics) }
  }

  try {
    const backendResult = await request.backend.route(backendRequest)
    const diagnostics = [...preflightDiagnostics, ...(backendResult.diagnostics ?? [])]
    const reportedStatus = backendResult.coreStatus
      ?? (diagnostics.some((item) => item.severity === "error") ? "partial" : "complete")
    const candidate = patch(
      request.snapshot.contentHash,
      reportedStatus,
      diagnostics,
      backendResult.operations,
    )
    const patchValidation = validatePcbPatchForSnapshotV1(request.snapshot, candidate)
    if (!patchValidation.ok) {
      return {
        backend,
        patch: patch(request.snapshot.contentHash, "error", [
          ...diagnostics,
          ...patchValidation.diagnostics,
        ]),
      }
    }
    try {
      const outputSnapshot = applyPcbPatchV1(request.snapshot, candidate)
      const outputValidation = validatePcbSnapshotV1(outputSnapshot)
      if (!outputValidation.ok) {
        return {
          backend,
          patch: patch(request.snapshot.contentHash, "error", [
            ...diagnostics,
            ...outputValidation.diagnostics,
          ]),
        }
      }
      return {
        backend,
        patch: candidate,
        outputSnapshot,
      }
    } catch (error) {
      return {
        backend,
        patch: patch(request.snapshot.contentHash, "error", [
          ...diagnostics,
          errorDiagnostic(
            "BACKEND_PATCH_REJECTED",
            "Backend returned a patch that cannot be applied atomically.",
            error instanceof Error ? error.message : String(error),
          ),
        ]),
      }
    }
  } catch (error) {
    return {
      backend,
      patch: patch(request.snapshot.contentHash, "error", [
        ...preflightDiagnostics,
        errorDiagnostic(
          "BACKEND_ROUTE_EXCEPTION",
          `Backend ${request.backend.id} threw an exception; it was captured.`,
          error instanceof Error ? error.message : String(error),
        ),
      ]),
    }
  }
}
