import type { RouterBackendAdapter } from "../adapters/contracts.js"
import { compileRoutingDsl } from "../intent/builder.js"
import { compileRoutingRules } from "../intent/preflight.js"
import type { RoutingPolicy, RoutingProgram } from "../intent/types.js"
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
  try {
    const backendResult = await request.backend.route(backendRequest)
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
    ]
    if (!copperValidation.ok) return {
      status: "error", operation: program.operation,
      rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
      diagnostics,
      metrics: { elapsedMs: performance.now() - startedAt, backend: request.backend.id },
      requiresNativeVerification: true,
    }
    return {
      status: diagnostics.some((item) => item.severity === "error") ? "partial" : backendResult.status,
      operation: program.operation,
      rules: { effective: compiled.effective, applyRequested, overriddenFields: compiled.overriddenFields },
      copper: resultCopper,
      diagnostics,
      metrics: {
        elapsedMs: performance.now() - startedAt,
        backend: request.backend.id,
        ...backendResult.metrics,
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
      diagnostics: [...compiled.diagnostics, ...backendPreflight, exception(
        "BACKEND_ROUTE_EXCEPTION", `${request.backend.id} threw an exception.`,
        error instanceof Error ? error.message : String(error),
      )],
      metrics: { elapsedMs: performance.now() - startedAt, backend: request.backend.id },
      requiresNativeVerification: true,
    }
  }
}
