import type { BackendRouteRequest, BackendRouteResult, RouterBackendAdapter } from "../adapters/contracts.js"
import { compileRoutingDsl } from "../intent/builder.js"
import { compileRoutingRules } from "../intent/preflight.js"
import type { ClearRoutingIntent, RoutingPolicy, RoutingProfile, RoutingProgram } from "../intent/types.js"
import type {
  RoutingBoard,
  RoutingCopper,
  RoutingDiagnostic,
  RoutingResult,
} from "./contracts.js"
import { planRoutingCopper } from "./copper-planner.js"
import { validateRoutingBoard, validateRoutingCopper } from "./validation.js"
import { planViaFences } from "./via-fence.js"

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

function clearEditableCopper(copper: RoutingCopper, intent: ClearRoutingIntent): RoutingCopper {
  const selected = (net: string) => intent.nets === "all" || intent.nets.includes(net)
  return {
    tracks: intent.items.includes("tracks") ? copper.tracks.filter((item) => !selected(item.net)) : copper.tracks,
    vias: intent.items.includes("vias") ? copper.vias.filter((item) => !selected(item.net)) : copper.vias,
    zones: intent.items.includes("zones") ? copper.zones.filter((item) => !selected(item.net)) : copper.zones,
  }
}

function backendProgram(program: RoutingProgram): RoutingProgram {
  const selected = (net: string) => (!program.onlyNets || program.onlyNets.includes(net)) && !program.ignoreNets.includes(net)
  return {
    ...program,
    polygons: [],
    planes: [],
    signalNets: program.signalNets.filter((item) => selected(item.net)),
    powerNets: program.powerNets.filter((item) => selected(item.net)),
    differentialPairs: program.differentialPairs.filter((item) => selected(item.positive) && selected(item.negative)),
    matchedGroups: program.matchedGroups.filter((item) => item.nets.every(selected)),
    viaFences: program.viaFences.filter((item) => item.along.every(selected)),
  }
}

type BackendCandidate = Readonly<{
  index: number
  profile: RoutingProfile
  result: BackendRouteResult
}>

function profileCascade(policy: RoutingPolicy | undefined): RoutingProfile[] {
  const selected = policy?.profile ?? "balanced"
  const candidateLimit = Number(policy?.maxCandidates ?? 1)
  const requested = Number.isFinite(candidateLimit)
    ? Math.max(1, Math.min(16, Math.trunc(candidateLimit)))
    : 1
  if (requested === 1 || selected === "fast") return [selected]
  const profiles: RoutingProfile[] = selected === "balanced"
    ? ["fast", "balanced"]
    : requested >= 3
      ? ["fast", "balanced", selected]
      : ["fast", selected]
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
  const scoped = {
    ...request,
    policy: { ...policy, profile, maxCandidates: 1 },
  }
  if (!request.program.viaFences.length || !backend.routeSpecial || !backend.routeRemaining) {
    return await backend.route(scoped)
  }
  const special = await backend.routeSpecial(scoped)
  const fenceBoard: RoutingBoard = {
    ...request.board,
    copper: {
      fixed: mergeCopper(request.board.copper.fixed, special.copper),
      editable: request.board.copper.editable,
    },
  }
  const fences = planViaFences(fenceBoard, special.copper, request.program.viaFences, request.rules)
  const fenceCopper: RoutingCopper = { tracks: [], vias: fences.vias, zones: [] }
  const remaining = await backend.routeRemaining({
    ...scoped,
    board: {
      ...fenceBoard,
      copper: { ...fenceBoard.copper, fixed: mergeCopper(fenceBoard.copper.fixed, fenceCopper) },
    },
  })
  const diagnostics = [...(special.diagnostics ?? []), ...fences.diagnostics, ...(remaining.diagnostics ?? [])]
  return {
    status: special.status === "error" || remaining.status === "error"
      ? "error" as const
      : special.status === "partial" || remaining.status === "partial" ? "partial" as const : "complete" as const,
    copper: mergeCopper(mergeCopper(special.copper, fenceCopper), remaining.copper),
    diagnostics,
    metrics: {
      ...remaining.metrics,
      elapsedMs: Number(special.metrics?.elapsedMs ?? 0) + Number(remaining.metrics?.elapsedMs ?? 0),
      viaCount: special.copper.vias.length + fences.vias.length + remaining.copper.vias.length,
      details: { ...remaining.metrics?.details, special: special.metrics?.details, viaFenceCount: fences.vias.length },
    },
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
  const policy: RoutingPolicy = { ...program.quality, ...request.policy }
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
    const cleared = program.clearRouting
      ? {
          ...request.board,
          copper: {
            ...request.board.copper,
            editable: clearEditableCopper(request.board.copper.editable, program.clearRouting),
          },
        }
      : request.board
    planned = planRoutingCopper(cleared, program, compiled.effective, {
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
  const transactionBoard: RoutingBoard = program.clearRouting ? {
    ...request.board,
    copper: {
      ...request.board.copper,
      editable: clearEditableCopper(request.board.copper.editable, program.clearRouting),
    },
  } : request.board
  const backendBoard: RoutingBoard = {
    ...transactionBoard,
    copper: {
      fixed: mergeCopper(request.board.copper.fixed, planned.copper),
      editable: transactionBoard.copper.editable,
    },
  }
  const backendRequest = {
    board: backendBoard,
    // Polygon and plane statements are core-owned. External backends receive
    // only electrical/special intent plus the already planned fixed copper.
    program: backendProgram(program),
    rules: compiled.effective,
    connectivity: planned.connectivity,
    policy,
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
  const profiles = profileCascade(policy)
  for (const profile of profiles) {
    if (request.signal?.aborted) break
    try {
      const result = await routeCandidate(request.backend, backendRequest, policy, profile)
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
    const fenceBoard: RoutingBoard = {
      ...transactionBoard,
      copper: {
        fixed: mergeCopper(transactionBoard.copper.fixed, planned.copper),
        editable: backendResult.copper,
      },
    }
    const alreadyFenced = backendResult.copper.vias.some((via) => String(via.id ?? "").startsWith("via-fence:"))
    const fences = alreadyFenced
      ? { vias: [], diagnostics: [] as RoutingDiagnostic[] }
      : planViaFences(fenceBoard, backendResult.copper, backendProgram(program).viaFences, compiled.effective)
    const routedWithFences = mergeCopper(backendResult.copper, { tracks: [], vias: fences.vias, zones: [] })
    const planeBoard: RoutingBoard = {
      ...fenceBoard,
      copper: { ...fenceBoard.copper, editable: routedWithFences },
    }
    const planes = planRoutingCopper(planeBoard, program, compiled.effective, {
      compact: false,
      planes: true,
    })
    const resultCopper = mergeCopper(mergeCopper(planned.copper, routedWithFences), planes.copper)
    const copperValidation = validateRoutingCopper(resultCopper, request.board)
    const diagnostics = [
      ...compiled.diagnostics,
      ...planned.diagnostics,
      ...planes.diagnostics,
      ...fences.diagnostics,
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
