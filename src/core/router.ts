import type { BackendRouteRequest, BackendRouteResult, RouterBackendAdapter } from "../adapters/contracts.js"
import { compileRoutingDsl } from "../intent/builder.js"
import { compileRoutingRules } from "../intent/preflight.js"
import type { RoutingPolicy, RoutingProfile, RoutingProgram } from "../intent/types.js"
import type {
  RoutingBoard,
  RoutingCopper,
  RoutingDiagnostic,
  RoutingResult,
} from "./contracts.js"
import { planRoutingCopper } from "./copper-planner.js"
import { validateRoutingBoard, validateRoutingCopper } from "./validation.js"

export type RunRequest = Readonly<{
  board: RoutingBoard
  /** Local statement-oriented JavaScript DSL source or an already compiled program. */
  dsl: string | RoutingProgram
  backend?: RouterBackendAdapter
  policy?: RoutingPolicy
  /** The only supported way to stop a running router. */
  signal?: AbortSignal
}>

function exception(code: string, message: string, details?: unknown): RoutingDiagnostic {
  return { code, severity: "error", message, ...(details === undefined ? {} : { details }) }
}

function failed(
  operation: RoutingResult["operation"],
  board: RoutingBoard,
  diagnostics: readonly RoutingDiagnostic[],
  startedAt: number,
): RoutingResult {
  return {
    status: "error",
    operation,
    rules: { effective: board.rules, applyRequested: operation !== "route", overriddenFields: [] },
    diagnostics,
    metrics: { elapsedMs: performance.now() - startedAt },
    requiresNativeVerification: true,
  }
}

function mergeCopper(first: RoutingCopper, second: RoutingCopper): RoutingCopper {
  return {
    tracks: [...first.tracks, ...second.tracks],
    vias: [...first.vias, ...second.vias],
    zones: [...first.zones, ...second.zones],
  }
}

type BackendCandidate = Readonly<{
  index: number
  profile: RoutingProfile
  result: BackendRouteResult
}>

function profileCascade(policy: RoutingPolicy | undefined): RoutingProfile[] {
  if (!policy?.profile) return ["balanced"]
  const profiles: RoutingProfile[] = policy.profile === "fast"
    ? ["fast"]
    : policy.profile === "balanced"
      ? ["fast", "balanced"]
      : ["fast", "balanced", policy.profile]
  const requested = Math.max(1, Math.min(profiles.length, Math.trunc(policy.maxCandidates ?? profiles.length)))
  return profiles.slice(0, requested)
}

function candidateTrackLength(copper: RoutingCopper) {
  return copper.tracks.reduce((total, track) => total + track.points.slice(1).reduce((length, point, index) => {
    const previous = track.points[index]
    return length + Math.hypot(point.x - previous.x, point.y - previous.y)
  }, 0), 0)
}

function finiteMetric(value: unknown, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function candidateScore(candidate: BackendCandidate) {
  const errors = candidate.result.diagnostics?.filter((item) => item.severity === "error").length ?? 0
  const open = candidate.result.metrics?.openNetCount === undefined
    ? candidate.result.status === "complete" ? 0 : Number.MAX_SAFE_INTEGER
    : finiteMetric(candidate.result.metrics.openNetCount, Number.MAX_SAFE_INTEGER)
  return [
    candidate.result.status === "error" ? 1 : 0,
    open,
    errors,
    finiteMetric(candidate.result.metrics?.viaCount, candidate.result.copper.vias.length),
    finiteMetric(candidate.result.metrics?.trackLengthMm, candidateTrackLength(candidate.result.copper)),
    candidate.index,
  ]
}

function compareCandidates(left: BackendCandidate, right: BackendCandidate) {
  const a = candidateScore(left)
  const b = candidateScore(right)
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] - b[index]
  return 0
}

async function routeCandidate(
  backend: RouterBackendAdapter,
  request: BackendRouteRequest,
  policy: RoutingPolicy | undefined,
  profile: RoutingProfile,
) {
  return await backend.route({
    ...request,
    policy: { ...policy, profile, maxCandidates: 1 },
  })
}

/**
 * Compile rules and optionally route without opening an EDA. DSL terminal
 * commands return no value; this outer operation is the only result boundary.
 */
export async function run(request: RunRequest): Promise<RoutingResult> {
  const startedAt = performance.now()
  const boardValidation = validateRoutingBoard(request.board)
  if (!boardValidation.ok) return failed("route", request.board, boardValidation.diagnostics, startedAt)

  let program: RoutingProgram
  try {
    program = typeof request.dsl === "string" ? compileRoutingDsl(request.dsl) : structuredClone(request.dsl)
  } catch (error) {
    return failed("route", request.board, [exception(
      "DSL_COMPILE_ERROR", "Routing DSL could not be compiled.", error instanceof Error ? error.message : String(error),
    )], startedAt)
  }
  const compiled = compileRoutingRules(request.board, program, request.backend?.capabilities)
  const errors = compiled.diagnostics.filter((item) => item.severity === "error")
  const applyRequested = program.operation !== "route"
  if (errors.length) return {
    status: "error",
    operation: program.operation,
    rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
    diagnostics: compiled.diagnostics,
    metrics: { elapsedMs: performance.now() - startedAt },
    requiresNativeVerification: true,
  }
  if (program.operation === "apply-drc") return {
    status: "complete",
    operation: program.operation,
    rules: { effective: compiled.effective, applyRequested: true, overriddenFields: compiled.overriddenFields },
    diagnostics: compiled.diagnostics,
    metrics: { elapsedMs: performance.now() - startedAt },
    requiresNativeVerification: true,
  }
  if (!request.backend) return {
    status: "error",
    operation: program.operation,
    rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
    diagnostics: [...compiled.diagnostics, exception("BACKEND_REQUIRED", "Routing operation requires a backend.")],
    metrics: { elapsedMs: performance.now() - startedAt },
    requiresNativeVerification: true,
  }
  if (request.signal?.aborted) return {
    status: "error",
    operation: program.operation,
    rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
    diagnostics: [...compiled.diagnostics, exception("ROUTING_ABORTED", "Routing was aborted before backend execution.")],
    metrics: { elapsedMs: performance.now() - startedAt },
    requiresNativeVerification: true,
  }
  let planned: ReturnType<typeof planRoutingCopper>
  try {
    planned = planRoutingCopper(request.board, program, compiled.effective, {
      compact: true,
      planes: false,
    })
  } catch (error) {
    return {
      status: "error", operation: program.operation,
      rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
      diagnostics: [...compiled.diagnostics, exception(
        "COPPER_PLANNING_EXCEPTION", "Polygon or plane planning threw an exception.",
        error instanceof Error ? error.message : String(error),
      )],
      metrics: { elapsedMs: performance.now() - startedAt },
      requiresNativeVerification: true,
    }
  }
  const plannedValidation = validateRoutingCopper(planned.copper, request.board)
  if (!plannedValidation.ok) return {
    status: "error", operation: program.operation,
    rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
    diagnostics: [...compiled.diagnostics, ...planned.diagnostics, ...plannedValidation.diagnostics],
    metrics: { elapsedMs: performance.now() - startedAt },
    requiresNativeVerification: true,
  }
  const backendBoard: RoutingBoard = {
    ...request.board,
    copper: {
      fixed: mergeCopper(request.board.copper.fixed, planned.copper),
      editable: request.board.copper.editable,
    },
  }
  const backendRequest = {
    board: backendBoard,
    // Polygon and plane statements are core-owned. External backends receive
    // only electrical/special intent plus the already planned fixed copper.
    program: { ...program, polygons: [], planes: [] },
    rules: compiled.effective,
    connectivity: planned.connectivity,
    ...(request.policy ? { policy: request.policy } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  }
  let backendPreflight: readonly RoutingDiagnostic[] = []
  try {
    backendPreflight = await request.backend.preflight?.(backendRequest) ?? []
  } catch (error) {
    backendPreflight = [exception(
      "BACKEND_PREFLIGHT_EXCEPTION", `${request.backend.id} preflight threw an exception.`,
      error instanceof Error ? error.message : String(error),
    )]
  }
  if (backendPreflight.some((item) => item.severity === "error")) return {
    status: "error", operation: program.operation,
    rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
    diagnostics: [...compiled.diagnostics, ...backendPreflight],
    metrics: { elapsedMs: performance.now() - startedAt, backend: request.backend.id },
    requiresNativeVerification: true,
  }
  const candidates: BackendCandidate[] = []
  const profiles = profileCascade(request.policy)
  for (const profile of profiles) {
    if (request.signal?.aborted) break
    try {
      const result = await routeCandidate(request.backend, backendRequest, request.policy, profile)
      candidates.push({ index: candidates.length, profile, result })
      if (result.status === "complete" && finiteMetric(result.metrics?.openNetCount, 0) === 0) break
    } catch (error) {
      candidates.push({
        index: candidates.length,
        profile,
        result: {
          status: "error",
          copper: { tracks: [], vias: [], zones: [] },
          diagnostics: [exception(
            "BACKEND_ROUTE_EXCEPTION", `${request.backend.id} threw during ${profile} routing.`,
            error instanceof Error ? error.message : String(error),
          )],
        },
      })
    }
  }
  if (request.signal?.aborted) return {
    status: "error", operation: program.operation,
    rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
    diagnostics: [...compiled.diagnostics, ...backendPreflight, exception(
      "ROUTING_ABORTED", "Routing was aborted by the caller.", request.signal.reason,
    )],
    metrics: { elapsedMs: performance.now() - startedAt, backend: request.backend.id, candidateCount: candidates.length },
    requiresNativeVerification: true,
  }
  if (!candidates.length) return {
    status: "error", operation: program.operation,
    rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
    diagnostics: [...compiled.diagnostics, ...backendPreflight, exception(
      "ROUTING_ABORTED",
      "Routing was aborted before a candidate completed.",
    )],
    metrics: { elapsedMs: performance.now() - startedAt, backend: request.backend.id, candidateCount: 0 },
    requiresNativeVerification: true,
  }
  candidates.sort(compareCandidates)
  const selected = candidates[0]
  const backendResult = selected.result

  try {
    const planeBoard: RoutingBoard = {
      ...request.board,
      copper: {
        fixed: mergeCopper(request.board.copper.fixed, planned.copper),
        editable: backendResult.copper,
      },
    }
    const planes = planRoutingCopper(planeBoard, program, compiled.effective, {
      compact: false,
      planes: true,
    })
    const resultCopper = mergeCopper(mergeCopper(planned.copper, backendResult.copper), planes.copper)
    const copperValidation = validateRoutingCopper(resultCopper, request.board)
    const diagnostics = [
      ...compiled.diagnostics,
      ...planned.diagnostics,
      ...planes.diagnostics,
      ...backendPreflight,
      ...(backendResult.diagnostics ?? []),
      ...copperValidation.diagnostics,
      ...(candidates.length > 1 ? [{
        code: "ROUTING_PORTFOLIO_SELECTED",
        severity: "info" as const,
        message: `Selected ${selected.profile} from ${candidates.length} routing candidate(s).`,
        details: {
          selectedProfile: selected.profile,
          candidates: candidates.map((candidate) => ({
            profile: candidate.profile,
            status: candidate.result.status,
            openNetCount: candidate.result.metrics?.openNetCount,
            viaCount: candidate.result.metrics?.viaCount ?? candidate.result.copper.vias.length,
            elapsedMs: candidate.result.metrics?.elapsedMs,
          })),
        },
      }] : []),
    ]
    if (!copperValidation.ok) return {
      status: "error", operation: program.operation,
      rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
      diagnostics,
      metrics: { elapsedMs: performance.now() - startedAt, backend: request.backend.id },
      requiresNativeVerification: true,
    }
    return {
      status: backendResult.status === "error"
        ? "error"
        : diagnostics.some((item) => item.severity === "error") ? "partial" : backendResult.status,
      operation: program.operation,
      rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
      copper: resultCopper,
      diagnostics,
      metrics: {
        ...backendResult.metrics,
        elapsedMs: performance.now() - startedAt,
        backend: request.backend.id,
        candidateCount: candidates.length,
        details: {
          ...backendResult.metrics?.details,
          copperPlanning: planned.metrics,
          planePlanning: planes.metrics,
        },
      },
      requiresNativeVerification: true,
    }
  } catch (error) {
    return {
      status: "error", operation: program.operation,
      rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
      diagnostics: [
        ...compiled.diagnostics,
        ...planned.diagnostics,
        ...backendPreflight,
        ...(backendResult.diagnostics ?? []),
        exception(
        "PLANE_PLANNING_EXCEPTION", "Plane or stitching planning threw an exception.",
        error instanceof Error ? error.message : String(error),
      )],
      metrics: { elapsedMs: performance.now() - startedAt, backend: request.backend.id },
      requiresNativeVerification: true,
    }
  }
}
