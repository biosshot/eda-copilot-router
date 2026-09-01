import type { BackendRouteRequest, BackendRouteResult, RouterBackendAdapter } from "../adapters/contracts.js"
import { createKrtBackend } from "../backends/krt.js"
import { compileRoutingDsl } from "../intent/builder.js"
import { compileRoutingRules } from "../intent/preflight.js"
import type { ClearRoutingIntent, RoutingProgram } from "../intent/types.js"
import type {
  RoutingBoard,
  RoutingCopper,
  RoutingDiagnostic,
  RoutingResult,
} from "./contracts.js"
import { gradeRoutingCandidate, retainRoutingChampion, type RoutingCandidate } from "./candidate-grader.js"
import { retainCopperCheckpoint } from "./copper-checkpoint.js"
import { planRoutingCopper } from "./copper-planner.js"
import { canonicalizeCopper, canonicalizeRoutingBoard, createLayerCatalog } from "./layers.js"
import { resolveRoutePlan } from "./route-plan.js"
import { materializeRoutingStackup } from "./stackup.js"
import { validateRoutingBoard, validateRoutingCopper } from "./validation.js"
import { planViaStitches } from "./via-stitch.js"

export type RunRequest = Readonly<{
  board: RoutingBoard
  /** Local statement-oriented JavaScript DSL source or an already compiled program. */
  dsl: string | RoutingProgram
  backend?: RouterBackendAdapter
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
    rules: board.rules,
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
  const selected = (item: keyof ClearRoutingIntent, net: string | undefined) => {
    const nets = intent[item]
    return net !== undefined && (nets === "all" || Boolean(nets?.includes(net)))
  }
  return {
    tracks: copper.tracks.filter((item) => !selected("tracks", item.net)),
    vias: copper.vias.filter((item) => !selected("vias", item.net)),
    zones: copper.zones.filter((item) => !selected("zones", item.net)),
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
    viaStitches: program.viaStitches.filter((item) => {
      if (item.mode === "along") return item.routes.every(selected)
      if (item.mode === "return" && item.forNets) return item.forNets.every(selected)
      return true
    }),
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function initialConnectivityEvidence(result: BackendRouteResult) {
  const details = record(result.metrics?.details)
  const hasPreRouteEvidence = Boolean(details
    && Object.prototype.hasOwnProperty.call(details, "preRouteConnectivity"))
  const value = record(hasPreRouteEvidence
    ? details?.preRouteConnectivity
    : details?.initialConnectivity)
  if (!value || !Array.isArray(value.openNets)) return undefined
  const openNets = value.openNets.filter((item): item is string => typeof item === "string")
  const componentCount = Number(value.connectivityComponentCount)
  return Number.isFinite(componentCount) && componentCount >= 0
    ? { openNets, componentCount }
    : undefined
}

function completedViaStitchSourceNets(
  result: BackendRouteResult,
  stitches: RoutingProgram["viaStitches"],
) {
  const sourceNets = [...new Set(stitches.flatMap((stitch) => stitch.mode === "along" ? stitch.routes : []))]
  if (result.metrics?.openNets) {
    const open = new Set(result.metrics.openNets)
    return sourceNets.filter((net) => !open.has(net))
  }
  return result.metrics?.openNetCount === 0
    ? sourceNets
    : []
}

/**
 * Compile rules and optionally route without opening an EDA. DSL terminal
 * commands return no value; this outer operation is the only result boundary.
 */
export async function run(request: RunRequest): Promise<RoutingResult> {
  const startedAt = performance.now()
  const boardValidation = validateRoutingBoard(request.board)
  if (!boardValidation.ok) return failed("route", request.board, boardValidation.diagnostics, startedAt)
  const canonicalized = canonicalizeRoutingBoard(request.board)
  const canonicalInput = canonicalized.board

  let program: RoutingProgram
  try {
    program = typeof request.dsl === "string" ? compileRoutingDsl(request.dsl) : structuredClone(request.dsl)
  } catch (error) {
    return failed("route", request.board, [exception(
      "DSL_COMPILE_ERROR", "Routing DSL could not be compiled.", error instanceof Error ? error.message : String(error),
    )], startedAt)
  }
  const board = materializeRoutingStackup(canonicalInput, program.stack)
  const effectiveLayerCatalog = createLayerCatalog(board.layers)
  const effectiveBoardValidation = validateRoutingBoard(board)
  if (!effectiveBoardValidation.ok) return failed(program.operation, board, effectiveBoardValidation.diagnostics, startedAt)
  const needsBackend = program.operation === "route" || program.operation === "all"
  const backend = needsBackend ? request.backend ?? createKrtBackend() : undefined
  const compiled = compileRoutingRules(board, program, backend?.capabilities)
  const errors = compiled.diagnostics.filter((item) => item.severity === "error")
  const stackup = program.stack && board.stackup
    ? { stackup: { effective: board.stackup, applyRequested: true as const } }
    : {}
  if (errors.length) return {
    status: "error",
    operation: program.operation,
    rules: compiled.effective,
    ...stackup,
    diagnostics: compiled.diagnostics,
    metrics: { elapsedMs: performance.now() - startedAt },
    requiresNativeVerification: true,
  }
  if (program.operation === "apply-drc") return {
    status: "complete",
    operation: program.operation,
    rules: compiled.effective,
    ...stackup,
    diagnostics: compiled.diagnostics,
    metrics: { elapsedMs: performance.now() - startedAt },
    requiresNativeVerification: true,
  }
  if (program.operation === "apply-stackup") return {
    status: "complete",
    operation: program.operation,
    rules: compiled.effective,
    ...stackup,
    diagnostics: compiled.diagnostics,
    metrics: { elapsedMs: performance.now() - startedAt },
    requiresNativeVerification: true,
  }
  if (request.signal?.aborted) return {
    status: "error",
    operation: program.operation,
    rules: compiled.effective,
    ...stackup,
    diagnostics: [...compiled.diagnostics, exception("ROUTING_ABORTED", "Routing was aborted before backend execution.")],
    metrics: { elapsedMs: performance.now() - startedAt },
    requiresNativeVerification: true,
  }
  let planned: ReturnType<typeof planRoutingCopper>
  try {
    const cleared = program.clearRouting
      ? {
          ...board,
          copper: {
            ...board.copper,
            editable: clearEditableCopper(board.copper.editable, program.clearRouting),
          },
        }
      : board
    planned = planRoutingCopper(cleared, program, compiled.effective, {
      compact: true,
      planes: false,
    })
  } catch (error) {
    return {
      status: "error", operation: program.operation,
      rules: compiled.effective,
      ...stackup,
      diagnostics: [...compiled.diagnostics, exception(
        "COPPER_PLANNING_EXCEPTION", "Polygon or plane planning threw an exception.",
        error instanceof Error ? error.message : String(error),
      )],
      metrics: { elapsedMs: performance.now() - startedAt },
      requiresNativeVerification: true,
    }
  }
  const plannedValidation = validateRoutingCopper(planned.copper, board)
  if (!plannedValidation.ok) return {
    status: "error", operation: program.operation,
    rules: compiled.effective,
    ...stackup,
    diagnostics: [...compiled.diagnostics, ...planned.diagnostics, ...plannedValidation.diagnostics],
    metrics: { elapsedMs: performance.now() - startedAt },
    requiresNativeVerification: true,
  }
  const transactionBoard: RoutingBoard = program.clearRouting ? {
    ...board,
    copper: {
      ...board.copper,
      editable: clearEditableCopper(board.copper.editable, program.clearRouting),
    },
  } : board
  if (program.operation === "copper") {
    let copperCheckpoint = mergeCopper(transactionBoard.copper.editable, planned.copper)
    let plannedCheckpoint = planned.copper
    const copperDiagnostics: RoutingDiagnostic[] = []
    let planePlanningMetrics: unknown
    try {
      const existingAlong = program.viaStitches.filter((item) => item.mode === "along")
      const along = planViaStitches(
        transactionBoard,
        planned.copper,
        existingAlong,
        compiled.effective,
        { completedNets: existingAlong.flatMap((item) => item.routes), modes: ["along"] },
      )
      copperDiagnostics.push(...along.diagnostics)
      const alongCheckpoint = retainCopperCheckpoint(
        board,
        plannedCheckpoint,
        mergeCopper(plannedCheckpoint, { tracks: [], vias: along.vias, zones: [] }),
        "copper viaStitch(along)",
      )
      copperDiagnostics.push(...alongCheckpoint.diagnostics)
      plannedCheckpoint = alongCheckpoint.copper
      copperCheckpoint = mergeCopper(transactionBoard.copper.editable, plannedCheckpoint)
      const planeBoard: RoutingBoard = {
        ...transactionBoard,
        copper: {
          fixed: mergeCopper(transactionBoard.copper.fixed, plannedCheckpoint),
          editable: transactionBoard.copper.editable,
        },
      }
      const planes = planRoutingCopper(planeBoard, program, compiled.effective, { compact: false, planes: true })
      planePlanningMetrics = planes.metrics
      copperDiagnostics.push(...planes.diagnostics)
      const planeCheckpoint = retainCopperCheckpoint(
        board,
        plannedCheckpoint,
        mergeCopper(plannedCheckpoint, planes.copper),
        "copper plane planning",
      )
      copperDiagnostics.push(...planeCheckpoint.diagnostics)
      plannedCheckpoint = planeCheckpoint.copper
      copperCheckpoint = mergeCopper(transactionBoard.copper.editable, plannedCheckpoint)
      const defaultReturnNets = [...new Set([
        ...backendProgram(program).signalNets.map((item) => item.net),
        ...backendProgram(program).differentialPairs.flatMap((item) => [item.positive, item.negative]),
      ])]
      const returns = planViaStitches(
        {
          ...planeBoard,
          copper: { fixed: transactionBoard.copper.fixed, editable: { tracks: [], vias: [], zones: [] } },
        },
        copperCheckpoint,
        program.viaStitches,
        compiled.effective,
        { completedNets: [], modes: ["return"], defaultReturnNets },
      )
      copperDiagnostics.push(...returns.diagnostics)
      const returnCheckpoint = retainCopperCheckpoint(
        board,
        copperCheckpoint,
        mergeCopper(copperCheckpoint, { tracks: [], vias: returns.vias, zones: [] }),
        "copper viaStitch(return)",
      )
      copperDiagnostics.push(...returnCheckpoint.diagnostics)
      copperCheckpoint = returnCheckpoint.copper
      const stitches = planViaStitches(
        {
          ...planeBoard,
          copper: { fixed: transactionBoard.copper.fixed, editable: { tracks: [], vias: [], zones: [] } },
        },
        copperCheckpoint,
        program.viaStitches,
        compiled.effective,
        { completedNets: [], modes: ["grid", "around"] },
      )
      copperDiagnostics.push(...stitches.diagnostics)
      const finalCheckpoint = retainCopperCheckpoint(
        board,
        copperCheckpoint,
        mergeCopper(copperCheckpoint, { tracks: [], vias: stitches.vias, zones: [] }),
        "copper viaStitch(grid/around)",
      )
      copperDiagnostics.push(...finalCheckpoint.diagnostics)
      copperCheckpoint = finalCheckpoint.copper
      const diagnostics = [
        ...compiled.diagnostics,
        ...planned.diagnostics,
        ...copperDiagnostics,
      ]
      return {
        status: !diagnostics.some((item) => item.severity === "error") ? "complete" : "partial",
        operation: program.operation,
        rules: compiled.effective,
        ...stackup,
        ...(program.clearRouting ? { clearRouting: program.clearRouting } : {}),
        copper: copperCheckpoint,
        diagnostics,
        metrics: {
          elapsedMs: performance.now() - startedAt,
          details: { copperPlanning: planned.metrics, planePlanning: planePlanningMetrics },
        },
        requiresNativeVerification: true,
      }
    } catch (error) {
      return {
        status: "partial", operation: program.operation,
        rules: compiled.effective,
        ...stackup,
        ...(program.clearRouting ? { clearRouting: program.clearRouting } : {}),
        copper: copperCheckpoint,
        diagnostics: [...compiled.diagnostics, ...planned.diagnostics, ...copperDiagnostics, exception(
          "COPPER_POSTPROCESS_EXCEPTION", "Copper postprocessing failed; the last applicable checkpoint was retained.",
          error instanceof Error ? error.message : String(error),
        )],
        metrics: {
          elapsedMs: performance.now() - startedAt,
          details: { copperPlanning: planned.metrics, planePlanning: planePlanningMetrics },
        },
        requiresNativeVerification: true,
      }
    }
  }
  if (!backend) return failed(program.operation, board, [exception("BACKEND_REQUIRED", "Routing requires a backend.")], startedAt)
  const backendBoard: RoutingBoard = {
    ...transactionBoard,
    copper: {
      fixed: mergeCopper(board.copper.fixed, planned.copper),
      editable: transactionBoard.copper.editable,
    },
  }
  const routeProgram = backendProgram(program)
  const routePlan = resolveRoutePlan(backendBoard, routeProgram, compiled.effective)
  const backendRequest: BackendRouteRequest = {
    board: backendBoard,
    // Polygon and plane statements are core-owned. External backends receive
    // only electrical/special intent plus the already planned fixed copper.
    program: routeProgram,
    rules: compiled.effective,
    connectivity: planned.connectivity,
    plan: routePlan,
    ...(request.signal ? { signal: request.signal } : {}),
  }
  let backendPreflight: readonly RoutingDiagnostic[] = []
  try {
    backendPreflight = await backend.preflight?.(backendRequest) ?? []
  } catch (error) {
    backendPreflight = [exception(
      "BACKEND_PREFLIGHT_EXCEPTION", `${backend.id} preflight threw an exception.`,
      error instanceof Error ? error.message : String(error),
    )]
  }
  if (backendPreflight.some((item) => item.severity === "error")) return {
    status: "error", operation: program.operation,
    rules: compiled.effective,
    ...stackup,
    diagnostics: [...compiled.diagnostics, ...backendPreflight],
    metrics: { elapsedMs: performance.now() - startedAt, backend: backend.id },
    requiresNativeVerification: true,
  }
  let routedCandidate: BackendRouteResult
  try {
    routedCandidate = await backend.route(backendRequest)
  } catch (error) {
    // An engine exception does not erase the applicable pre-route snapshot.
    // Empty backend copper is a valid partial candidate and still lets the
    // caller apply core-planned copper and explicit clearRouting intent.
    routedCandidate = {
      status: "error",
      copper: { tracks: [], vias: [], zones: [] },
      diagnostics: [exception(
        "BACKEND_ROUTE_EXCEPTION", `${backend.id} threw during routing.`,
        error instanceof Error ? error.message : String(error),
      )],
    }
  }
  const candidateCopper = routedCandidate.copper as unknown
  if (candidateCopper && typeof candidateCopper === "object"
    && Array.isArray((candidateCopper as RoutingCopper).tracks)
    && Array.isArray((candidateCopper as RoutingCopper).vias)
    && Array.isArray((candidateCopper as RoutingCopper).zones)) {
    // Transitional compatibility for backend adapters that still emit their
    // imported/native layer aliases. The internal result is always canonical.
    routedCandidate = {
      ...routedCandidate,
      copper: canonicalizeCopper(candidateCopper as RoutingCopper, effectiveLayerCatalog),
    }
  }
  if (request.signal?.aborted) return {
    status: "error", operation: program.operation,
    rules: compiled.effective,
    ...stackup,
    diagnostics: [...compiled.diagnostics, ...backendPreflight, exception(
      "ROUTING_ABORTED", "Routing was aborted by the caller.", request.signal.reason,
    )],
    metrics: { elapsedMs: performance.now() - startedAt, backend: backend.id, candidateCount: 1 },
    requiresNativeVerification: true,
  }
  const audited: RoutingCandidate = {
    index: 0,
    label: backend.id,
    result: routedCandidate,
    grade: gradeRoutingCandidate(board, routeProgram, compiled.effective, routedCandidate),
  }
  const backendInitialConnectivity = initialConnectivityEvidence(routedCandidate)
  const baselineOpenNets = backendInitialConnectivity?.openNets ?? routePlan.scopeNets
  const baselineComponentCount = backendInitialConnectivity?.componentCount
    ?? routePlan.scopeNets.reduce((sum, net) => (
      sum + Math.max(1, backendBoard.pads.filter((pad) => pad.net === net).length)
    ), 0)
  const baselineResult: BackendRouteResult = {
    status: "partial",
    // Backends return the complete transaction-owned editable replacement.
    // This pre-route snapshot is the recovery candidate if a later result is
    // structurally invalid or semantically worse.
    copper: transactionBoard.copper.editable,
    metrics: {
      openNetCount: baselineOpenNets.length,
      openNets: baselineOpenNets,
      connectivityComponentCount: baselineComponentCount,
      viaCount: transactionBoard.copper.editable.vias.length,
    },
  }
  const baseline: RoutingCandidate = {
    index: -1,
    label: "pre-route-checkpoint",
    result: baselineResult,
    grade: gradeRoutingCandidate(board, routeProgram, compiled.effective, baselineResult, -1),
  }
  const selected = retainRoutingChampion(retainRoutingChampion(undefined, baseline), audited)
  if (!selected) return {
    status: "error", operation: program.operation,
    rules: compiled.effective,
    ...stackup,
    diagnostics: [
      ...compiled.diagnostics,
      ...planned.diagnostics,
      ...backendPreflight,
      ...(routedCandidate.diagnostics ?? []),
      exception(
        "ROUTING_NO_USABLE_CANDIDATE",
        "The backend returned no structurally applicable copper candidate.",
        { validation: audited.grade.structuralDiagnostics },
      ),
    ],
    metrics: { elapsedMs: performance.now() - startedAt, backend: backend.id, candidateCount: 1 },
    requiresNativeVerification: true,
  }
  const destructiveClear = Boolean(program.clearRouting && (
    transactionBoard.copper.editable.tracks.length < board.copper.editable.tracks.length
    || transactionBoard.copper.editable.vias.length < board.copper.editable.vias.length
    || transactionBoard.copper.editable.zones.length < board.copper.editable.zones.length
  ))
  if (destructiveClear && selected === baseline) return {
    // Applying the post-clear baseline would turn an engine failure into a
    // destructive partial result. This is the hard rollback boundary: keep
    // the host transaction unapplied instead of deleting source copper.
    status: "error", operation: program.operation,
    rules: compiled.effective,
    ...stackup,
    diagnostics: [
      ...compiled.diagnostics,
      ...planned.diagnostics,
      ...backendPreflight,
      ...(routedCandidate.diagnostics ?? []),
      exception(
        "ROUTING_CLEAR_ROLLBACK",
        "The backend produced no candidate safer than the post-clear baseline; clearRouting was rolled back and no partial board should be applied.",
        { validation: audited.grade.structuralDiagnostics },
      ),
    ],
    metrics: { elapsedMs: performance.now() - startedAt, backend: backend.id, candidateCount: 1 },
    requiresNativeVerification: true,
  }
  const backendResult = selected.result
  const auditSummary = (candidate: RoutingCandidate) => ({
    label: candidate.label,
    status: candidate.result.status,
    structurallyUsable: candidate.grade.structurallyUsable,
    criticalRegressionCount: candidate.grade.criticalRegressionCount,
    priorityOpenPenalty: candidate.grade.priorityOpenPenalty,
    openNetCount: candidate.grade.openNetCount,
    connectivityComponentCount: candidate.grade.connectivityComponentCount,
    differentialViolationCount: candidate.grade.differentialViolationCount,
    matchedViolationCount: candidate.grade.matchedViolationCount,
    impedanceViolationCount: candidate.grade.impedanceViolationCount,
    drcViolationCount: candidate.grade.drcViolationCount,
    errorCount: candidate.grade.errorCount,
    forbiddenViaCount: candidate.grade.forbiddenViaCount,
    shortAvoidViaPenalty: candidate.grade.shortAvoidViaPenalty,
    avoidViaPenalty: candidate.grade.avoidViaPenalty,
    viaCount: candidate.grade.viaCount,
    trackLengthMm: candidate.grade.trackLengthMm,
    score: candidate.grade.score,
    ...(candidate.grade.structurallyUsable
      ? {}
      : { structuralDiagnostics: candidate.grade.structuralDiagnostics }),
  })
  const candidateAudit = {
    selected: auditSummary(selected),
    attempted: auditSummary(audited),
    baseline: auditSummary(baseline),
  }
  const rejectedAttemptDiagnostics = selected === audited ? [] : [
    ...(routedCandidate.diagnostics ?? []),
    ...(!audited.grade.structurallyUsable ? [exception(
      "ROUTING_CANDIDATE_REJECTED",
      "The backend candidate was structurally invalid; the pre-route checkpoint was retained.",
      { validation: audited.grade.structuralDiagnostics },
    )] : []),
  ]
  let checkpointCopper = mergeCopper(planned.copper, backendResult.copper)
  let routedCheckpoint = backendResult.copper
  const postDiagnostics: RoutingDiagnostic[] = []
  let planePlanningMetrics: unknown
  try {
    const stitchBoard: RoutingBoard = {
      ...transactionBoard,
      copper: {
        fixed: mergeCopper(
          transactionBoard.copper.fixed,
          planned.copper,
        ),
        editable: { tracks: [], vias: [], zones: [] },
      },
    }
    const alongStitches = routeProgram.viaStitches.filter((item) => item.mode === "along")
    const alreadyFenced = backendResult.copper.vias.some((via) => String(via.id ?? "").startsWith("via-stitch:"))
    const fences = alreadyFenced
      ? { vias: [], diagnostics: [] as RoutingDiagnostic[] }
      : planViaStitches(
        stitchBoard,
        backendResult.copper,
        alongStitches,
        compiled.effective,
        { completedNets: completedViaStitchSourceNets(backendResult, alongStitches), modes: ["along"] },
      )
    postDiagnostics.push(...fences.diagnostics)
    const fenceCheckpoint = retainCopperCheckpoint(
      board,
      routedCheckpoint,
      mergeCopper(routedCheckpoint, { tracks: [], vias: fences.vias, zones: [] }),
      "viaStitch(along)",
    )
    postDiagnostics.push(...fenceCheckpoint.diagnostics)
    routedCheckpoint = fenceCheckpoint.copper
    checkpointCopper = mergeCopper(planned.copper, routedCheckpoint)
    const postRouteStitches = routeProgram.viaStitches
    const defaultReturnNets = [...new Set([
      ...routeProgram.signalNets.map((item) => item.net),
      ...routeProgram.differentialPairs.flatMap((item) => [item.positive, item.negative]),
    ])]
    const planeBoard: RoutingBoard = {
      ...stitchBoard,
      copper: { ...stitchBoard.copper, editable: routedCheckpoint },
    }
    const planes = planRoutingCopper(planeBoard, program, compiled.effective, {
      compact: false,
      planes: true,
    })
    planePlanningMetrics = planes.metrics
    postDiagnostics.push(...planes.diagnostics)
    const planeCheckpoint = retainCopperCheckpoint(
      board,
      routedCheckpoint,
      mergeCopper(routedCheckpoint, planes.copper),
      "plane planning",
    )
    postDiagnostics.push(...planeCheckpoint.diagnostics)
    routedCheckpoint = planeCheckpoint.copper
    checkpointCopper = mergeCopper(planned.copper, routedCheckpoint)
    const returns = planViaStitches(
      { ...planeBoard, copper: { ...planeBoard.copper, editable: { tracks: [], vias: [], zones: [] } } },
      routedCheckpoint,
      postRouteStitches,
      compiled.effective,
      { completedNets: [], modes: ["return"], defaultReturnNets },
    )
    postDiagnostics.push(...returns.diagnostics)
    const returnCheckpoint = retainCopperCheckpoint(
      board,
      routedCheckpoint,
      mergeCopper(routedCheckpoint, { tracks: [], vias: returns.vias, zones: [] }),
      "viaStitch(return)",
    )
    postDiagnostics.push(...returnCheckpoint.diagnostics)
    routedCheckpoint = returnCheckpoint.copper
    checkpointCopper = mergeCopper(planned.copper, routedCheckpoint)
    const finalStitches = planViaStitches(
      { ...planeBoard, copper: { ...planeBoard.copper, editable: { tracks: [], vias: [], zones: [] } } },
      routedCheckpoint,
      postRouteStitches,
      compiled.effective,
      { completedNets: [], modes: ["grid", "around"] },
    )
    postDiagnostics.push(...finalStitches.diagnostics)
    const finalCheckpoint = retainCopperCheckpoint(
      board,
      routedCheckpoint,
      mergeCopper(routedCheckpoint, { tracks: [], vias: finalStitches.vias, zones: [] }),
      "viaStitch(grid/around)",
    )
    postDiagnostics.push(...finalCheckpoint.diagnostics)
    routedCheckpoint = finalCheckpoint.copper
    checkpointCopper = mergeCopper(planned.copper, routedCheckpoint)
    const diagnostics = [
      ...compiled.diagnostics,
      ...planned.diagnostics,
      ...postDiagnostics,
      ...backendPreflight,
      ...(backendResult.diagnostics ?? []),
      ...rejectedAttemptDiagnostics,
      {
        code: "ROUTING_CANDIDATE_AUDITED",
        severity: "info" as const,
        message: `Selected ${selected.label} after semantic candidate audit.`,
        details: candidateAudit,
      },
    ]
    return {
      status: backendResult.status === "complete"
        && selected.grade.openNetCount === 0
        && !diagnostics.some((item) => item.severity === "error") ? "complete" : "partial",
      operation: program.operation,
      rules: compiled.effective,
      ...stackup,
      ...(program.clearRouting ? { clearRouting: program.clearRouting } : {}),
      copper: checkpointCopper,
      diagnostics,
      metrics: {
        ...backendResult.metrics,
        elapsedMs: performance.now() - startedAt,
        backend: backend.id,
        candidateCount: backendResult.metrics?.candidateCount ?? 1,
        details: {
          ...backendResult.metrics?.details,
          copperPlanning: planned.metrics,
          planePlanning: planePlanningMetrics,
          routePlan,
          candidateAudit,
        },
      },
      requiresNativeVerification: true,
    }
  } catch (error) {
    const diagnostics = [
      ...compiled.diagnostics,
      ...planned.diagnostics,
      ...postDiagnostics,
      ...backendPreflight,
      ...(backendResult.diagnostics ?? []),
      ...rejectedAttemptDiagnostics,
      exception(
        "ROUTING_POSTPROCESS_EXCEPTION",
        "Plane or stitching postprocessing failed; the last applicable checkpoint was retained.",
        error instanceof Error ? error.message : String(error),
      ),
    ]
    return {
      status: "partial", operation: program.operation,
      rules: compiled.effective,
      ...stackup,
      ...(program.clearRouting ? { clearRouting: program.clearRouting } : {}),
      copper: checkpointCopper,
      diagnostics,
      metrics: {
        ...backendResult.metrics,
        elapsedMs: performance.now() - startedAt,
        backend: backend.id,
        candidateCount: backendResult.metrics?.candidateCount ?? 1,
        details: {
          ...backendResult.metrics?.details,
          copperPlanning: planned.metrics,
          planePlanning: planePlanningMetrics,
          routePlan,
          candidateAudit,
        },
      },
      requiresNativeVerification: true,
    }
  }
}
