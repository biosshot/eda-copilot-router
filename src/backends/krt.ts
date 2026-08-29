import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type {
  BackendRouteRequest,
  BackendRouteResult,
  RouterBackendAdapter,
} from "../adapters/contracts.js"
import type {
  RoutingCopper,
  RoutingDiagnostic,
  RoutingRuleValues,
} from "../core/contracts.js"
import { createLayerCatalog } from "../core/layers.js"
import { netTerminalSpansMm } from "../core/net-geometry.js"
import type { FanoutIntent } from "../intent/types.js"
import {
  auditKrtBoardConnectivity,
  auditKrtBoardDrc,
  krtCriticalNetDrcNonRegressing,
  persistKrtProtectedNets,
  runKrtRemaining,
  runKrtQfnFanout,
  runKrtSpecial,
  type KrtDiagnostic,
  type KrtNumericRules,
  type KrtProcessResult,
  type KrtQfnFanoutSpec,
  type KrtStageSpec,
} from "./krt-adapter.js"
import { RouterAssetError, type RouterAssetPolicy } from "./assets.js"
import {
  prepareKrtRuntime,
  type PreparedKrtRuntime,
} from "./krt-runtime.js"
import {
  krtProjectNetOrder,
  readKrtBoard,
  subtractKrtCopper,
  writeKrtBoard,
} from "./krt-codec.js"

export {
  auditKrtBoardConnectivity,
  auditKrtBoardDrc,
  buildKrtAuditScopeTransport,
  buildKrtNativeRecoveryEnvironment,
  buildKrtRemainingArgs,
  buildKrtSpecialCandidatePortfolio,
  buildKrtSpecialCandidates,
  compactKrtExactSelectorArgs,
  indexKrtDrcFingerprints,
  KRT_CAPTURED_LOG_TAIL_CHARS,
  KRT_DRC_SCOPE_SENTINEL,
  KRT_EXACT_NET_SENTINEL,
  KRT_EXACT_RIP_SENTINEL,
  krtBoundedLogTail,
  krtCriticalNetDrcNonRegressing,
  krtDrcViolationItem,
  krtLiteralGlobPattern,
  krtLiteralNetFilterPattern,
  krtOrdinaryMatchedCandidateRetryable,
  krtTransportDiagnostic,
  krtVerifiedDiffPairNets,
  parseKrtDrcViolationCount,
  parseKrtJsonSummaryMin,
  KRT_REQUIRED_NECKDOWN_ENVIRONMENT,
  KRT_RIPUP_ABANDON_METRIC_CHOICES,
  KRT_RIPUP_BLOCKER_SELECT_CHOICES,
  type KrtOrdering,
  type KrtDiffPairCustodyEvidence,
  type KrtOrdinaryMatchedRetryEvidence,
  type KrtRipupAbandonMetric,
  type KrtRipupBlockerSelect,
  type KrtSpecialCandidate,
  type KrtStageSpec,
} from "./krt-adapter.js"

export {
  KRT_MANAGED_VERSION,
  MANAGED_PYTHON_VERSION,
  krtManagedRelease,
  managedPythonRelease,
  prepareManagedPython,
  prepareKrtRuntime,
  readKrtLicense,
  type KrtRuntimeOptions,
  type PreparedKrtRuntime,
} from "./krt-runtime.js"

export type KrtBackendOptions = Readonly<{
  /** Optional development override. Normal package use lazily prepares KRT. */
  krtDirectory?: string
  pythonPath?: string
  assets?: RouterAssetPolicy
  artifactsDirectory?: string
  keepArtifacts?: boolean
  /** @deprecated Ignored. Cancel routing through BackendRouteRequest.signal. */
  timeoutMs?: number
}>

const EMPTY_COPPER: RoutingCopper = { tracks: [], vias: [], zones: [] }
const HARD_MIN_TRACK_WIDTH_MM = 0.127

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

function diagnostic(code: string, severity: RoutingDiagnostic["severity"], message: string, details?: unknown): RoutingDiagnostic {
  return { code, severity, message, ...(details === undefined ? {} : { details }) }
}

function convertDiagnostics(source: readonly KrtDiagnostic[]): RoutingDiagnostic[] {
  return source.map((item) => ({
    code: item.code,
    severity: item.severity,
    message: item.message,
    ...(item.details === undefined ? {} : { details: item.details }),
  }))
}

/**
 * Resolve KRT for support tooling. With no local override this performs the
 * same verified lazy preparation used by createKrtBackend().
 */
export async function discoverKrtDirectory(explicit?: string, assets?: RouterAssetPolicy) {
  return (await prepareKrtRuntime({ krtDirectory: explicit, assets })).directory
}

function ruleFor(request: BackendRouteRequest, net: string) {
  return request.rules.nets.find((item) => item.net === net)?.values ?? request.rules.default
}

function orderedScopeNets(request: Pick<BackendRouteRequest, "board" | "program">) {
  const boardNets = request.board.nets.map((item) => item.name)
  if (!request.program.onlyNets) return boardNets
  const known = new Set(boardNets)
  return request.program.onlyNets.filter((net) => known.has(net))
}

const GND_NET_NAMES = new Set(["GND", "/GND"])

function isGroundNetName(net: string) {
  return GND_NET_NAMES.has(net.trim().toUpperCase())
}

/**
 * Ground is intentionally excluded from KRT's maze-routing scope. Surface the
 * otherwise silent case where neither the core planner nor the imported board
 * supplies a ground zone and the caller did not explicitly ignore the net.
 */
export function krtUnplannedGroundNets(
  request: Pick<BackendRouteRequest, "board" | "program">,
) {
  const ignored = new Set(request.program.ignoreNets)
  const zoned = new Set([
    ...request.board.copper.fixed.zones,
    ...request.board.copper.editable.zones,
  ].flatMap((zone) => zone.net ? [zone.net] : []))
  return orderedScopeNets(request).filter((net) => (
    isGroundNetName(net)
    && !ignored.has(net)
    && !zoned.has(net)
    && request.board.pads.filter((pad) => pad.net === net).length >= 2
  ))
}

function routableScopeNets(request: BackendRouteRequest) {
  return request.plan.scopeNets.filter((net) => (
    !isGroundNetName(net)
    && request.board.pads.filter((pad) => pad.net === net).length >= 2
  ))
}

function normalizedLayerSet(layers: readonly string[]) {
  return [...new Set(layers)].sort()
}

function routeLayerDiagnostics(request: BackendRouteRequest, nets: readonly string[]) {
  const constrained = nets.flatMap((net) => {
    const layers = ruleFor(request, net).allowedLayers
    return layers?.length ? [{ net, layers: normalizedLayerSet(layers) }] : []
  })
  const sets = new Map<string, { layers: readonly string[]; nets: string[] }>()
  for (const item of constrained) {
    const key = item.layers.join("\u0000")
    const current = sets.get(key)
    if (current) current.nets.push(item.net)
    else sets.set(key, { layers: item.layers, nets: [item.net] })
  }
  return sets.size <= 1 ? [] : [diagnostic(
    "KRT_PER_NET_LAYER_SCOPE_UNSUPPORTED",
    "error",
    "One KRT process cannot preserve incompatible per-net allowedLayers; split the routing scope into compatible calls.",
    { groups: [...sets.values()] },
  )]
}

function routeLayersFor(request: BackendRouteRequest, nets: readonly string[]) {
  const catalog = createLayerCatalog(request.board.layers)
  const constrained = nets
    .map((net) => ruleFor(request, net).allowedLayers)
    .find((layers): layers is readonly string[] => Boolean(layers?.length))
  if (!constrained) return request.board.layers.map((item) => catalog.kiCadName(item.name))
  const allowed = new Set(constrained)
  // Unconstrained nets in this call inherit the one explicit safe subset. This
  // may reduce routability, but it can never violate another net's layer rule.
  return request.board.layers
    .map((item) => item.name)
    .filter((layer) => allowed.has(layer))
    .map((layer) => catalog.kiCadName(layer))
}

function sameNumber(values: readonly number[], epsilon = 1e-9) {
  return !values.length || values.every((value) => Math.abs(value - values[0]) <= epsilon)
}

function specialRules(request: BackendRouteRequest, gridStep = 0.1): { rules?: KrtNumericRules; diagnostics: RoutingDiagnostic[] } {
  const specialNets = new Set([
    ...request.program.differentialPairs.flatMap((pair) => [pair.positive, pair.negative]),
    ...request.program.matchedGroups.flatMap((group) => group.nets),
  ])
  if (!specialNets.size) return { diagnostics: [] }
  const values = [...specialNets].map((net) => ruleFor(request, net))
  const widths = values.map((item) => item.differential?.trackWidthMm ?? item.preferredTrackWidthMm)
  const clearances = values.map((item) => item.clearanceMm)
  const viaSizes = values.map((item) => item.via.preferredDiameterMm)
  const viaDrills = values.map((item) => item.via.preferredDrillMm)
  const gaps = request.program.differentialPairs.map((pair) => (
    ruleFor(request, pair.positive).differential?.gapMm
      ?? ruleFor(request, pair.negative).differential?.gapMm
      ?? Math.max(ruleFor(request, pair.positive).clearanceMm, ruleFor(request, pair.negative).clearanceMm)
  ))
  if (![widths, clearances, viaSizes, viaDrills, gaps].every(sameNumber)) return {
    diagnostics: [diagnostic(
      "KRT_SPECIAL_RULE_CONFLICT",
      "error",
      "One atomic KRT special stage requires one compatible width, clearance, via geometry and differential gap.",
      { widths, clearances, viaSizes, viaDrills, gaps },
    )],
  }
  const pairTolerances = request.program.differentialPairs.map((pair) => {
    const positive = ruleFor(request, pair.positive).differential?.maxSkewMm
    const negative = ruleFor(request, pair.negative).differential?.maxSkewMm
    return positive === undefined && negative === undefined
      ? undefined
      : Math.min(positive ?? Number.POSITIVE_INFINITY, negative ?? Number.POSITIVE_INFINITY)
  })
  const diagnostics: RoutingDiagnostic[] = []
  if (pairTolerances.some((value) => value !== undefined)
    && pairTolerances.some((value) => value === undefined)) diagnostics.push(diagnostic(
    "KRT_MIXED_DIFF_SKEW_POLICY_UNSUPPORTED",
    "error",
    "One KRT differential invocation cannot match only a subset of its pairs; split constrained and unconstrained pairs.",
  ))
  const tolerances = [
    ...request.program.matchedGroups.flatMap((group) => {
      const value = request.rules.matchedGroups?.find((item) => item.id === group.id)?.toleranceMm
      return value === undefined ? [] : [value]
    }),
    ...pairTolerances.flatMap((value) => value === undefined ? [] : [value]),
  ]
  if (!sameNumber(tolerances)) diagnostics.push(diagnostic(
    "KRT_SPECIAL_LENGTH_TOLERANCE_CONFLICT",
    "error",
    "One KRT special invocation cannot preserve different length-match tolerances; split those groups.",
    { tolerances },
  ))
  const tolerance = tolerances.length ? Math.min(...tolerances) : undefined
  const trackWidth = Math.max(HARD_MIN_TRACK_WIDTH_MM, widths[0])
  const hardViaSize = Math.max(...values.map((item) => item.via.minDiameterMm))
  const hardViaDrill = Math.max(...values.map((item) => item.via.minDrillMm))
  const hardViaAnnular = Math.max(
    0.001,
    ...values.map((item) => (item.via.minDiameterMm - item.via.minDrillMm) / 2),
  )
  const viaDrill = viaDrills[0]
  const viaSize = Math.max(viaSizes[0], viaDrill + 2 * hardViaAnnular)
  return {
    diagnostics,
    rules: {
      trackWidth,
      hardTrackWidth: Math.max(
        HARD_MIN_TRACK_WIDTH_MM,
        Math.min(...values.map((item) => item.minTrackWidthMm)),
      ),
      clearance: clearances[0],
      viaSize,
      viaDrill,
      hardViaSize,
      hardViaDrill,
      hardViaAnnular,
      diffPairGap: gaps[0] ?? clearances[0],
      gridStep,
      holeToHoleClearance: Math.max(...values.map((item) => item.holeToHoleClearanceMm ?? item.clearanceMm)),
      ...(tolerance === undefined ? {} : { lengthMatchTolerance: tolerance }),
    },
  }
}

function minimumRules(values: readonly RoutingRuleValues[], gridStep = 0.1): KrtNumericRules {
  const source = values.length ? values : []
  const hardTrackWidth = Math.max(HARD_MIN_TRACK_WIDTH_MM, Math.min(...source.map((item) => item.minTrackWidthMm)))
  const hardViaSize = Math.max(...source.map((item) => item.via.minDiameterMm))
  const hardViaDrill = Math.max(...source.map((item) => item.via.minDrillMm))
  const hardViaAnnular = Math.max(
    0.001,
    ...source.map((item) => (item.via.minDiameterMm - item.via.minDrillMm) / 2),
  )
  return {
    trackWidth: hardTrackWidth,
    hardTrackWidth,
    clearance: Math.min(...source.map((item) => item.clearanceMm)),
    // route.py accepts one global via geometry. Use the strictest minima so a
    // permissive class cannot make another class fail native DRC.
    viaSize: Math.max(hardViaSize, hardViaDrill + 2 * hardViaAnnular),
    viaDrill: hardViaDrill,
    hardViaSize,
    hardViaDrill,
    hardViaAnnular,
    gridStep,
    holeToHoleClearance: Math.max(...source.map((item) => item.holeToHoleClearanceMm ?? item.clearanceMm)),
    boardEdgeClearance: Math.max(...source.map((item) => item.edgeClearanceMm)),
  }
}

/** @internal Pure routed-copper safety gate exposed for contract tests. */
export function krtRoutedCopperRuleDiagnostics(request: BackendRouteRequest, copper: RoutingCopper) {
  const narrowTracks = copper.tracks.flatMap((track) => {
    const minimum = Math.max(HARD_MIN_TRACK_WIDTH_MM, ruleFor(request, track.net).minTrackWidthMm)
    return track.widthMm + 1e-9 < minimum
      ? [{ net: track.net, layer: track.layer, actualMm: track.widthMm, minimumMm: minimum }]
      : []
  })
  const undersizedVias = copper.vias.flatMap((via) => {
    const rules = ruleFor(request, via.net).via
    const minimumAnnularMm = Math.max((rules.minDiameterMm - rules.minDrillMm) / 2, 0.001)
    const actualAnnularMm = (via.diameterMm - via.drillMm) / 2
    return via.diameterMm + 1e-9 < rules.minDiameterMm
      || via.drillMm + 1e-9 < rules.minDrillMm
      || actualAnnularMm + 1e-9 < minimumAnnularMm
      ? [{
        net: via.net,
        actualDiameterMm: via.diameterMm,
        actualDrillMm: via.drillMm,
        minimumDiameterMm: rules.minDiameterMm,
        minimumDrillMm: rules.minDrillMm,
        actualAnnularMm,
        minimumAnnularMm,
      }]
      : []
  })
  const forbiddenLayers = copper.tracks.flatMap((track) => {
    const allowed = ruleFor(request, track.net).allowedLayers
    return allowed?.length && !allowed.includes(track.layer)
      ? [{ net: track.net, actualLayer: track.layer, allowedLayers: allowed }]
      : []
  })
  const diagnostics: RoutingDiagnostic[] = []
  if (narrowTracks.length) diagnostics.push(diagnostic(
    "KRT_TRACK_WIDTH_BELOW_HARD_MINIMUM",
    "error",
    `KRT produced ${narrowTracks.length} track segment(s) below the compiled hard minimum; the board is retained only as a partial candidate.`,
    { hardMinimumMm: HARD_MIN_TRACK_WIDTH_MM, samples: narrowTracks.slice(0, 16) },
  ))
  if (undersizedVias.length) diagnostics.push(diagnostic(
    "KRT_VIA_BELOW_HARD_MINIMUM",
    "error",
    `KRT produced ${undersizedVias.length} via(s) below the compiled hard minimum; the board is retained only as a partial candidate.`,
    { samples: undersizedVias.slice(0, 16) },
  ))
  if (forbiddenLayers.length) diagnostics.push(diagnostic(
    "KRT_TRACK_ON_FORBIDDEN_LAYER",
    "error",
    `KRT produced ${forbiddenLayers.length} track segment(s) outside their compiled allowedLayers; the board is retained only as a partial candidate.`,
    { samples: forbiddenLayers.slice(0, 16) },
  ))
  return diagnostics
}

async function writeFabOverrides(path: string, values: KrtNumericRules) {
  const hardViaSize = values.hardViaSize ?? values.viaSize
  const hardViaDrill = values.hardViaDrill ?? values.viaDrill
  const annular = values.hardViaAnnular ?? Math.max((hardViaSize - hardViaDrill) / 2, 0.001)
  const hardTrackWidth = Math.max(values.hardTrackWidth ?? values.trackWidth, HARD_MIN_TRACK_WIDTH_MM)
  const hole = Math.max(values.holeToHoleClearance ?? values.clearance, 0.001)
  await writeFile(path, [
    `track_width = ${hardTrackWidth}`,
    `clearance = ${values.clearance}`,
    `via_diameter = ${hardViaSize}`,
    `via_drill = ${hardViaDrill}`,
    `hole_to_hole = ${hole}`,
    `pad_hole_to_hole = ${hole}`,
    `annular = ${annular}`,
    `board_edge = ${Math.max(values.boardEdgeClearance ?? values.clearance, 0.001)}`,
    "",
  ].join("\n"))
}

/**
 * One production policy: preserve KRT's measured native search/cost defaults
 * and set only orchestration invariants. In particular, via cost, heuristic
 * weight, iteration caps and rip-up ranking are deliberately not overridden.
 */
export const KRT_NATIVE_AUTO_POLICY = Object.freeze({
  gridStep: 0.1,
  ordering: "mps" as const,
  enableNetRescue: true,
  enableTerminalEscalation: true,
  ripPreexisting: true,
  dynamicIterations: true,
  planeFinalize: false,
  finalizeRip: true,
  specialMaxCandidates: 1,
})

/**
 * One bounded ordering alternative for an ordinary matched group. KRT's MPS
 * and declared-order meander passes can reach materially different local
 * minima, while both candidates remain isolated on disk and are selected by
 * the existing connectivity, DRC and whole-group length audit.
 */
export const KRT_ORDINARY_MATCHED_MAX_CANDIDATES = 2
/** Fine-grid fallback is local to one failed ordinary matched candidate. */
export const KRT_MATCHED_FINE_GRID_STEP_MM = 0.05
/** Prevent a local fallback from allocating an unbounded grid on a huge board. */
export const KRT_MATCHED_FINE_GRID_MAX_CELLS_PER_LAYER = 4_000_000

/** @internal Reserve convergence headroom for KRT's non-iterative meander overshoot. */
export function krtMatchedFallbackTolerance(toleranceMm: number) {
  if (!Number.isFinite(toleranceMm) || toleranceMm <= 0) return toleranceMm
  return Math.max(0.001, toleranceMm - Math.min(2, toleranceMm * 0.25))
}

/** @internal Choose fine grid only when the full board stays under the explicit memory bound. */
export function krtMatchedFallbackGridStep(
  outline: readonly Readonly<{ x: number; y: number }>[],
  currentGridStep: number,
) {
  if (currentGridStep <= KRT_MATCHED_FINE_GRID_STEP_MM || outline.length < 3) return currentGridStep
  const xs = outline.map((point) => point.x)
  const ys = outline.map((point) => point.y)
  const widthCells = Math.ceil((Math.max(...xs) - Math.min(...xs)) / KRT_MATCHED_FINE_GRID_STEP_MM) + 1
  const heightCells = Math.ceil((Math.max(...ys) - Math.min(...ys)) / KRT_MATCHED_FINE_GRID_STEP_MM) + 1
  const cellsPerLayer = widthCells * heightCells
  return Number.isSafeInteger(cellsPerLayer)
    && cellsPerLayer <= KRT_MATCHED_FINE_GRID_MAX_CELLS_PER_LAYER
    ? KRT_MATCHED_FINE_GRID_STEP_MM
    : currentGridStep
}

/** Shared bound for targeted attempts after the full-board main pass. */
export const KRT_MAX_POST_MAIN_REPAIRS = 8
/** Exact native blocker grants per open repair; custody keeps this deliberately small. */
export const KRT_MAX_OPEN_REPAIR_BLOCKER_VICTIMS = 3
export const KRT_POST_MAIN_REPAIR_BUDGET_RATIO = 0.3
/** Enough startup allowance for a tiny-board isolated native repair. */
export const KRT_MIN_POST_MAIN_REPAIR_BUDGET_MS = 5_000
export const KRT_SHORT_VIA_REPAIR_MAX_LENGTH_MM = 10
export const KRT_SHORT_VIA_REPAIR_MAX_DETOUR_RATIO = 2
export const KRT_SHORT_VIA_REPAIR_LENGTH_SLACK_MM = 2
/** Nearby hard clearances share one conservative native process. */
export const KRT_ORDINARY_CLEARANCE_BUCKET_MM = 0.05
/** Nearby hard neck-down floors share one conservative native process. */
export const KRT_ORDINARY_TRACK_WIDTH_BUCKET_MM = 0.05
/** Hard cap across critical/early/main ordinary compatibility batches. */
export const KRT_MAX_ORDINARY_ROUTE_BATCHES = 32

type KrtRepairOrderItem = Readonly<{
  kind: "open" | "short-via"
  priorityWeight: number
  clearanceMm: number
  firstNet: string
}>

/** @internal Connectivity repairs always precede cosmetic via cleanup. */
export function compareKrtRepairOrder(left: KrtRepairOrderItem, right: KrtRepairOrderItem) {
  return Number(right.kind === "open") - Number(left.kind === "open")
    || right.priorityWeight - left.priorityWeight
    || right.clearanceMm - left.clearanceMm
    || left.firstNet.localeCompare(right.firstNet)
}

/** @internal A backend-complete result requires positive final connectivity evidence. */
export function krtNativeAutoResultStatus(evidence: Readonly<{
  constraintsDeferred: boolean
  processFailed: boolean
  diagnosticsHaveErrors: boolean
  openNetCount: number
  connectivityAudited: boolean
}>) {
  return evidence.constraintsDeferred
    || evidence.processFailed
    || evidence.diagnosticsHaveErrors
    || evidence.openNetCount > 0
    || !evidence.connectivityAudited
    ? "partial" as const
    : "complete" as const
}

type KrtConnectivityEvidence = Readonly<{
  openNets: readonly string[]
  componentsByNet: Readonly<Record<string, number>>
  connectivityComponentCount: number
}>

/** @internal Preserve audited multipoint progress in exception checkpoints. */
export function krtRecoveredConnectivityFields(
  initial: KrtConnectivityEvidence | undefined,
  checkpoint: KrtConnectivityEvidence | undefined,
) {
  return {
    metrics: checkpoint
      ? { connectivityComponentCount: checkpoint.connectivityComponentCount }
      : {},
    details: {
      initialConnectivity: initial ?? { auditFailed: true },
      finalConnectivity: checkpoint ?? { auditFailed: true },
    },
  }
}

/** @internal Pure policy seam kept testable without launching a KRT process. */
export function krtStageDrcGatePasses(
  gate: "strict" | "ordinary",
  evidence: Readonly<{
    drcNonRegressing: boolean
    shortsNonRegressing: boolean
    connectivityImproved: boolean
  }>,
) {
  return gate === "strict"
    ? evidence.drcNonRegressing
    : evidence.shortsNonRegressing
      && (evidence.drcNonRegressing || evidence.connectivityImproved)
}

/** @internal Candidate-local connectivity gate used by checkpoint promotion. */
export function krtStageConnectivityGatePasses(evidence: Readonly<{
  connectivityNonRegressing: boolean
  connectivityImproved: boolean
  allowWeightedTradeoff?: boolean
  hardConnectivityNonRegressing?: boolean
  weightedConnectivityImproved?: boolean
  requireConnectivityImprovement?: boolean
}>) {
  const weightedTradeoffPasses = evidence.allowWeightedTradeoff === true
    && evidence.hardConnectivityNonRegressing === true
    && evidence.weightedConnectivityImproved === true
  return (evidence.connectivityNonRegressing || weightedTradeoffPasses)
    && (!evidence.requireConnectivityImprovement
      || evidence.connectivityImproved
      || weightedTradeoffPasses)
}

const KRT_HARD_STAGE_DAMAGE = new Set([
  "KRT_PROTECTED_COPPER_RIPPED",
  "KRT_RIP_VICTIM_INCOMPLETE",
  "KRT_COVERAGE_GATE_FAILED",
])

export const KRT_VIA_PREFERENCE_COSTS = Object.freeze({
  avoid: 300,
  forbid: 1_000_000,
})

function padMinimumDimensionMm(pad: BackendRouteRequest["board"]["pads"][number]) {
  switch (pad.shape.kind) {
    case "circle": return pad.shape.diameterMm
    case "rect":
    case "round-rect":
    case "oval": return Math.min(pad.shape.widthMm, pad.shape.heightMm)
    case "polygon": {
      const points = pad.shape.polygon.outer
      if (!points.length) return Number.POSITIVE_INFINITY
      const xs = points.map((point) => point.x)
      const ys = points.map((point) => point.y)
      return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    }
  }
}

function pointSegmentDistance(
  point: Readonly<{ x: number; y: number }>,
  start: Readonly<{ x: number; y: number }>,
  end: Readonly<{ x: number; y: number }>,
) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const denominator = dx * dx + dy * dy
  const t = denominator <= 1e-18
    ? 0
    : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator))
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))
}

function padAlreadyHasRoutedCopper(request: BackendRouteRequest, pad: BackendRouteRequest["board"]["pads"][number]) {
  if (!pad.net) return false
  const copper = [request.board.copper.fixed, request.board.copper.editable]
  const radius = padMinimumDimensionMm(pad) / 2
  if (copper.some((set) => set.vias.some((via) => (
    via.net === pad.net && Math.hypot(via.at.x - pad.at.x, via.at.y - pad.at.y) <= radius + via.diameterMm / 2 + 1e-6
  )))) return true
  return copper.some((set) => set.tracks.some((track) => (
    track.net === pad.net
    && pad.layers.includes(track.layer)
    && track.points.slice(1).some((point, index) => (
      pointSegmentDistance(pad.at, track.points[index], point) <= radius + track.widthMm / 2 + 1e-6
    ))
  )))
}

export type KrtQfnFanoutPlan = Readonly<{
  component: string
  padNumbers: readonly string[]
  nets: readonly string[]
  layer: string
  rules: KrtNumericRules
  method: FanoutIntent["method"]
  extensionMm: number
}>

/** Build conservative, backend-neutral QFN/QFP escape batches from physical pad geometry. */
export function planKrtQfnFanout(
  request: BackendRouteRequest,
  routeNets: readonly string[],
  gridStep: number,
): readonly KrtQfnFanoutPlan[] {
  // QFN/QFP fanout is an explicit routing operation. Physical package shape
  // alone must never activate it or mutate a board that did not request it.
  const fanouts = request.plan?.fanout.targets ?? request.program.fanouts ?? []
  if (!fanouts.length) return []
  const scope = new Set(routeNets.filter((net) => !isGroundNetName(net)))
  const layerCatalog = createLayerCatalog(request.board.layers)
  const logicalPadCounts = new Map<string, number>()
  for (const pad of request.board.pads) if (pad.net) {
    logicalPadCounts.set(pad.net, (logicalPadCounts.get(pad.net) ?? 0) + 1)
  }
  const excludedComponents = new Set((request.program.fanoutExclusions ?? [])
    .filter((target) => target.kind === "component").map((target) => target.component))
  const excludedPads = new Set((request.program.fanoutExclusions ?? [])
    .filter((target) => target.kind === "pad").map((target) => `${target.component}\u0000${target.pad}`))
  const componentPolicies = new Map<string, FanoutIntent>()
  const padPolicies = new Map<string, FanoutIntent>()
  for (const intent of fanouts) {
    if (intent.target.kind === "component") componentPolicies.set(intent.target.component, intent)
    else padPolicies.set(`${intent.target.component}\u0000${intent.target.pad}`, intent)
  }
  const output: KrtQfnFanoutPlan[] = []

  for (const component of request.board.components) {
    if (excludedComponents.has(component.designator)) continue
    const mountedLayer = request.board.layers.find((layer) => layer.side === component.side)?.name
    if (!mountedLayer) continue
    const packagePads = request.board.pads.filter((pad) => (
      pad.component === component.designator && !pad.hole && pad.layers.includes(mountedLayer)
    ))
    const componentPolicy = componentPolicies.get(component.designator)
    const explicitlyTargetedPads = packagePads.some((pad) => padPolicies.has(`${pad.component}\u0000${pad.number}`))
    if (!componentPolicy && !explicitlyTargetedPads) continue
    const eligible = packagePads.filter((pad) => (
      pad.net
      && scope.has(pad.net)
      && (logicalPadCounts.get(pad.net) ?? 0) >= 2
      && !excludedPads.has(`${pad.component}\u0000${pad.number}`)
      && (Boolean(componentPolicy) || padPolicies.has(`${pad.component}\u0000${pad.number}`))
      && !padAlreadyHasRoutedCopper(request, pad)
      && (!ruleFor(request, pad.net).allowedLayers?.length
        || ruleFor(request, pad.net).allowedLayers!.includes(mountedLayer))
    ))
    const groups = new Map<string, {
      pads: typeof eligible
      rules: KrtNumericRules
      method: FanoutIntent["method"]
      extensionMm: number
    }>()
    for (const pad of eligible) {
      const values = ruleFor(request, pad.net!)
      const policy = padPolicies.get(`${pad.component}\u0000${pad.number}`) ?? componentPolicy
      const method = policy?.method ?? "stub"
      const extensionMm = policy?.extensionMm ?? 0.1
      const width = Math.max(HARD_MIN_TRACK_WIDTH_MM, values.minTrackWidthMm)
      const rules: KrtNumericRules = {
        trackWidth: width,
        hardTrackWidth: width,
        clearance: values.clearanceMm,
        viaSize: values.via.minDiameterMm,
        viaDrill: values.via.minDrillMm,
        gridStep,
        holeToHoleClearance: values.holeToHoleClearanceMm ?? values.clearanceMm,
        boardEdgeClearance: values.edgeClearanceMm,
      }
      const geometryKey = [
        width, rules.clearance, rules.viaSize, rules.viaDrill,
        rules.holeToHoleClearance, rules.boardEdgeClearance, extensionMm,
      ].map((value) => Number(value).toFixed(9)).join("\u0000")
      const key = `${geometryKey}\u0000${method}`
      const current = groups.get(key)
      if (current) current.pads.push(pad)
      else groups.set(key, { pads: [pad], rules, method, extensionMm })
    }
    for (const group of groups.values()) if (group.pads.length) output.push({
      component: component.designator,
      padNumbers: [...new Set(group.pads.map((pad) => pad.number))],
      nets: [...new Set(group.pads.flatMap((pad) => pad.net ? [pad.net] : []))],
      layer: layerCatalog.kiCadName(mountedLayer),
      rules: group.rules,
      method: group.method,
      extensionMm: group.extensionMm,
    })
  }
  return output
}

/** Keep the full-board grid stable; KRT owns bounded local fine-grid rescue. */
export function selectKrtGridStep(
  _request: BackendRouteRequest,
  requestedGridStep: number,
  _routeNets?: readonly string[],
) {
  return requestedGridStep
}

type KrtViaPreference = "auto" | "avoid" | "forbid"

type KrtSpecialBatch = Readonly<{
  id: string
  nets: readonly string[]
  request: BackendRouteRequest
  layers: readonly string[]
  rules: KrtNumericRules
  viaPreference: KrtViaPreference
  /** Strongest portable priority in this atomic native batch. */
  priorityWeight: number
  /** Differential routing keeps its special-before-ordinary custody boundary. */
  containsDifferential: boolean
}>

function strongestViaPreference(request: BackendRouteRequest, nets: readonly string[]): KrtViaPreference {
  const order: readonly KrtViaPreference[] = ["auto", "avoid", "forbid"]
  const policies = new Map<string, KrtViaPreference>(request.plan.netPolicies
    .map((policy) => [policy.net, policy.viaPreference] as const))
  return nets.reduce<KrtViaPreference>((strongest, net) => {
    const preference = policies.get(net) ?? "auto"
    return order.indexOf(preference) > order.indexOf(strongest) ? preference : strongest
  }, "auto" as KrtViaPreference)
}

function strongestPriorityWeight(request: BackendRouteRequest, nets: readonly string[]) {
  const policies = new Map(request.plan.netPolicies
    .map((policy) => [policy.net, policy.priorityWeight] as const))
  return nets.reduce((strongest, net) => Math.max(strongest, policies.get(net) ?? 4), 0)
}

/** @internal Differential and critical special batches retain the pre-critical custody boundary. */
export function krtSpecialBatchRunsBeforeCritical(
  batch: Pick<KrtSpecialBatch, "containsDifferential" | "priorityWeight">,
) {
  return batch.containsDifferential || batch.priorityWeight >= 64
}

/**
 * @internal A special invocation earns custody only for copper that both won
 * the outer checkpoint gate and passed KRT's semantic verification. Everything
 * else must stay in the ordinary recovery scope; a rejected artifact is never
 * evidence that its declared nets were routed on the promoted board.
 */
export function krtSpecialBatchRecoveryDisposition(
  batchNets: readonly string[],
  candidatePromoted: boolean,
  semanticallyVerifiedNets: readonly string[] = [],
) {
  const uniqueBatchNets = [...new Set(batchNets)]
  const verified = candidatePromoted ? new Set(semanticallyVerifiedNets) : new Set<string>()
  const verifiedNets = uniqueBatchNets.filter((net) => verified.has(net))
  return {
    verifiedNets,
    ordinaryFallbackNets: uniqueBatchNets.filter((net) => !verified.has(net)),
  }
}

/** @internal Keep only nets that are not held by verified special custody. */
export function krtOrdinaryRecoveryScope(
  nets: readonly string[],
  verifiedSpecialNets: readonly string[],
) {
  const verified = new Set(verifiedSpecialNets)
  return [...new Set(nets)].filter((net) => !verified.has(net))
}

function scopedSpecialRequest(request: BackendRouteRequest, nets: readonly string[]): BackendRouteRequest {
  const scope = new Set(nets)
  return {
    ...request,
    program: {
      ...request.program,
      differentialPairs: request.program.differentialPairs.filter((pair) => (
        scope.has(pair.positive) && scope.has(pair.negative)
      )),
      matchedGroups: request.program.matchedGroups.filter((group) => (
        group.nets.every((net) => scope.has(net))
      )),
      onlyNets: [...scope],
    },
  }
}

/**
 * Partition disconnected special constraints, then coalesce only batches that
 * have exactly compatible native rules and routing layers. This keeps one KRT
 * process per useful compatibility class instead of either flattening rules or
 * spawning one process per net/pair on large boards.
 */
/** @internal Compatibility planner exposed for deterministic contract tests. */
export function planKrtSpecialBatches(
  request: BackendRouteRequest,
  routeScopeNets: readonly string[],
  gridStep: number,
): { batches: KrtSpecialBatch[]; diagnostics: RoutingDiagnostic[] } {
  const scope = new Set(routeScopeNets)
  const diagnostics: RoutingDiagnostic[] = []
  const declaredEdges = [
    ...request.program.differentialPairs.map((pair) => ({
      kind: "differential" as const,
      id: pair.id,
      nets: [pair.positive, pair.negative],
    })),
    ...request.program.matchedGroups.map((group) => ({
      kind: "matched" as const,
      id: group.id,
      nets: [...group.nets],
    })),
  ]
  const edges: string[][] = []
  for (const edge of declaredEdges) {
    const routableNets = edge.nets.filter((net) => scope.has(net))
    if (routableNets.length === edge.nets.length) edges.push(edge.nets)
    else if (routableNets.length) diagnostics.push(diagnostic(
      "KRT_SPECIAL_GROUP_DEFERRED",
      "warning",
      "Only part of an atomic special group is in KRT's routable scope; its routable members are deferred to ordinary routing and the result remains partial.",
      {
        kind: edge.kind,
        id: edge.id,
        nets: edge.nets,
        routableNets,
        unavailableNets: edge.nets.filter((net) => !scope.has(net)),
      },
    ))
  }
  const parent = new Map<string, string>()
  const find = (net: string): string => {
    const current = parent.get(net)
    if (!current) {
      parent.set(net, net)
      return net
    }
    if (current === net) return net
    const root = find(current)
    parent.set(net, root)
    return root
  }
  const union = (left: string, right: string) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent.set(b, a)
  }
  for (const edge of edges) {
    for (const net of edge) find(net)
    for (let index = 1; index < edge.length; index += 1) union(edge[0], edge[index])
  }
  const components = new Map<string, string[]>()
  for (const net of parent.keys()) {
    const root = find(net)
    const current = components.get(root) ?? []
    current.push(net)
    components.set(root, current)
  }

  const compatible = new Map<string, string[]>()
  for (const nets of components.values()) {
    const scoped = scopedSpecialRequest(request, nets)
    const resolved = specialRules(scoped, gridStep)
    const viaPreference = strongestViaPreference(request, nets)
    const layerDiagnostics = routeLayerDiagnostics(scoped, nets)
    const groupDiagnostics = [...resolved.diagnostics, ...layerDiagnostics]
    if (!resolved.rules || groupDiagnostics.some((item) => item.severity === "error")) {
      // A non-representable atomic special group is local damage, not a reason
      // to discard every routable net on the board. Keep the original codes and
      // details visible, but defer these members to ordinary routing; final
      // differential/length audits will keep the overall result partial.
      diagnostics.push(...groupDiagnostics.map((item) => ({
        ...item,
        severity: item.severity === "error" ? "warning" as const : item.severity,
      })))
      diagnostics.push(diagnostic(
        "KRT_SPECIAL_GROUP_DEFERRED",
        "warning",
        "A special group cannot be represented by one native KRT invocation; its nets remain eligible for ordinary routing and final partial-result auditing.",
        { nets },
      ))
      continue
    }
    diagnostics.push(...groupDiagnostics)
    const key = JSON.stringify({
      rules: resolved.rules,
      layers: routeLayersFor(scoped, nets),
      containsDifferential: scoped.program.differentialPairs.length > 0,
      matchDifferentialPairLengths: scoped.program.differentialPairs.some((pair) => (
        ruleFor(scoped, pair.positive).differential?.maxSkewMm !== undefined
        || ruleFor(scoped, pair.negative).differential?.maxSkewMm !== undefined
      )),
      viaPreference,
      priorityWeight: strongestPriorityWeight(request, nets),
    })
    const current = compatible.get(key) ?? []
    current.push(...nets)
    compatible.set(key, current)
  }

  const batches: KrtSpecialBatch[] = []
  for (const [index, nets] of [...compatible.values()].entries()) {
    const uniqueNets = [...new Set(nets)]
    const scoped = scopedSpecialRequest(request, uniqueNets)
    const resolved = specialRules(scoped, gridStep)
    if (!resolved.rules) continue
    batches.push({
      id: `special-${String(index + 1).padStart(2, "0")}`,
      nets: uniqueNets,
      request: scoped,
      layers: routeLayersFor(scoped, uniqueNets),
      rules: resolved.rules,
      viaPreference: strongestViaPreference(request, uniqueNets),
      priorityWeight: strongestPriorityWeight(request, uniqueNets),
      containsDifferential: scoped.program.differentialPairs.length > 0,
    })
  }
  return {
    batches: batches.sort((left, right) => (
      Number(right.containsDifferential) - Number(left.containsDifferential)
      || right.priorityWeight - left.priorityWeight
      || left.id.localeCompare(right.id)
    )),
    diagnostics,
  }
}

type KrtOrdinaryBatch = Readonly<{
  id: string
  nets: readonly string[]
  layers: readonly string[]
  viaPreference: KrtViaPreference
  clearanceMm: number
  viaSizeMm: number
  viaDrillMm: number
  hardTrackWidthMm: number
  priorityWeight: number
}>

export function planKrtOrdinaryBatches(
  request: BackendRouteRequest,
  nets: readonly string[],
  partitionViaPreference: boolean,
) {
  const policies = new Map(request.plan.netPolicies.map((policy) => [policy.net, policy]))
  const groups = new Map<string, {
    nets: string[]
    layers: readonly string[]
    viaPreference: KrtViaPreference
    clearanceMm: number
    viaSizeMm: number
    viaDrillMm: number
    hardTrackWidthMm: number
    priorityWeight: number
  }>()
  for (const net of nets) {
    const netRules = ruleFor(request, net)
    const allowed = normalizedLayerSet(netRules.allowedLayers ?? [])
    const clearanceMm = netRules.clearanceMm
    const viaSizeMm = netRules.via.preferredDiameterMm
    const viaDrillMm = netRules.via.preferredDrillMm
    const hardTrackWidthMm = Math.max(HARD_MIN_TRACK_WIDTH_MM, netRules.minTrackWidthMm)
    const priorityWeight = policies.get(net)?.priorityWeight ?? 4
    const viaPreference = partitionViaPreference
      ? policies.get(net)?.viaPreference ?? "auto"
      : "auto"
    // KRT computes one routing-side clearance floor as the maximum class
    // clearance among every net in one route.py call. Partition by effective
    // clearance so a Wide net cannot silently over-block every Default net.
    // Very close values share a conservative upward bucket; this bounds
    // process/audit growth for boards with generated per-net rule variants.
    const clearanceBucketMm = Math.ceil(
      Math.max(0, clearanceMm - 1e-9) / KRT_ORDINARY_CLEARANCE_BUCKET_MM,
    ) * KRT_ORDINARY_CLEARANCE_BUCKET_MM
    const trackWidthBucketMm = Math.ceil(
      Math.max(0, hardTrackWidthMm - 1e-9) / KRT_ORDINARY_TRACK_WIDTH_BUCKET_MM,
    ) * KRT_ORDINARY_TRACK_WIDTH_BUCKET_MM
    const key = [
      allowed.length ? allowed.join("\u0000") : "*",
      viaPreference,
      clearanceBucketMm.toFixed(9),
      trackWidthBucketMm.toFixed(9),
    ].join("\u0001")
    const current = groups.get(key)
    if (current) {
      current.nets.push(net)
      current.priorityWeight = Math.max(current.priorityWeight, priorityWeight)
      current.clearanceMm = Math.max(current.clearanceMm, clearanceMm)
      current.viaSizeMm = Math.min(current.viaSizeMm, viaSizeMm)
      current.viaDrillMm = Math.min(current.viaDrillMm, viaDrillMm)
      current.hardTrackWidthMm = Math.max(current.hardTrackWidthMm, hardTrackWidthMm)
    }
    else groups.set(key, {
      nets: [net],
      layers: routeLayersFor(request, [net]),
      viaPreference,
      clearanceMm,
      viaSizeMm,
      viaDrillMm,
      hardTrackWidthMm,
      priorityWeight,
    })
  }
  const preferenceRank = (value: KrtViaPreference) => value === "forbid" ? 2 : value === "avoid" ? 1 : 0
  return [...groups.values()]
    .sort((left, right) => (
      right.priorityWeight - left.priorityWeight
      || preferenceRank(right.viaPreference) - preferenceRank(left.viaPreference)
      || right.clearanceMm - left.clearanceMm
      || left.nets[0].localeCompare(right.nets[0])
    ))
    .map((group, index): KrtOrdinaryBatch => {
      const netRules = group.nets.map((net) => ruleFor(request, net))
      const hardViaSize = Math.max(...netRules.map((item) => item.via.minDiameterMm))
      const hardViaDrill = Math.max(...netRules.map((item) => item.via.minDrillMm))
      const hardViaAnnular = Math.max(
        0.001,
        ...netRules.map((item) => (item.via.minDiameterMm - item.via.minDrillMm) / 2),
      )
      const preferred = netRules.map((item) => ({
        size: item.via.preferredDiameterMm,
        drill: item.via.preferredDrillMm,
      })).filter((item) => item.size + 1e-9 >= hardViaSize && item.drill + 1e-9 >= hardViaDrill)
        .sort((left, right) => left.size - right.size || left.drill - right.drill)
      const working = preferred[0] ?? { size: hardViaSize, drill: hardViaDrill }
      const viaDrillMm = Math.max(hardViaDrill, working.drill)
      const viaSizeMm = Math.max(hardViaSize, working.size, viaDrillMm + 2 * hardViaAnnular)
      return {
        id: `ordinary-${String(index + 1).padStart(2, "0")}`,
        ...group,
        viaSizeMm,
        viaDrillMm,
      }
    })
}

/**
 * @internal A completion fallback is intentionally near-monolithic: soft via
 * preferences may share one process, but incompatible hard layer/clearance/
 * width floors still fail closed instead of being flattened.
 */
export function krtMonolithicFallbackBatch(
  request: BackendRouteRequest,
  nets: readonly string[],
) {
  if (!nets.length) return undefined
  const batches = planKrtOrdinaryBatches(request, nets, false)
  return batches.length === 1 ? batches[0] : undefined
}

/**
 * @internal Reproduce the order of the generated KiCad project for KRT's
 * `ordering=original` path. The canonical board model is lexicographically
 * sorted and is therefore not an equivalent source of routing order.
 */
export function krtMonolithicFallbackSelectors(request: BackendRouteRequest) {
  const fallbackScope = new Set(orderedScopeNets(request))
  const projectOrderedNets = krtProjectNetOrder(request.rules)
  const projectOrderedSet = new Set(projectOrderedNets)
  return [
    ...projectOrderedNets,
    // A malformed/custom request may omit a board net from rules.nets. Keep
    // it routable, but never disturb authoritative project order before it.
    ...orderedScopeNets(request).filter((net) => !projectOrderedSet.has(net)),
  ].filter((net) => (
    fallbackScope.has(net)
    && !isGroundNetName(net)
    && !request.program.ignoreNets.includes(net)
  ))
}

/** @internal Bound process growth while leaving deferred nets for partial/final audit reporting. */
export function limitKrtOrdinaryBatches(
  batches: readonly KrtOrdinaryBatch[],
  alreadyScheduled = 0,
) {
  const available = Math.max(0, KRT_MAX_ORDINARY_ROUTE_BATCHES - alreadyScheduled)
  return batches.slice(0, available)
}

/** Semantic via preference translated to a search cost, never a DRC rule. */
function krtViaCost(preference: KrtOrdinaryBatch["viaPreference"]) {
  if (preference === "forbid") return KRT_VIA_PREFERENCE_COSTS.forbid
  if (preference === "avoid") return KRT_VIA_PREFERENCE_COSTS.avoid
  return undefined
}

function recordArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : []
}

/**
 * Select only native-attributed blockers of the requested open nets. A victim
 * must have lower portable priority, still own copper, and remain outside a
 * caller-supplied protected semantic scope (notably differential/matched nets).
 */
export function krtOpenRepairBlockerVictims(
  summaries: readonly (Readonly<Record<string, unknown>> | undefined)[],
  targetNets: readonly string[],
  netPolicies: readonly Readonly<{ net: string; priorityWeight: number }>[],
  options: Readonly<{
    excludedNets?: readonly string[]
    copperNets?: readonly string[]
    limit?: number
  }> = {},
) {
  const targets = new Set(targetNets)
  const excluded = new Set([...(options.excludedNets ?? []), ...targetNets])
  const copper = options.copperNets ? new Set(options.copperNets) : undefined
  const weights = new Map(netPolicies.map((policy) => [policy.net, policy.priorityWeight] as const))
  const scores = new Map<string, { count: number; first: number; priorityWeight: number }>()
  let ordinal = 0
  // Newest summaries are supplied first. Count repeated native attribution but
  // keep the first observation as the stable tie-breaker.
  for (const summary of summaries) for (const report of recordArray(summary?.blockers)) {
    const target = typeof report.net === "string" ? report.net : undefined
    if (!target || !targets.has(target)) continue
    const targetWeight = weights.get(target) ?? 4
    for (const blocker of recordArray(report.blocked_by)) {
      const victim = typeof blocker.net === "string" ? blocker.net : undefined
      const victimWeight = victim ? weights.get(victim) : undefined
      if (!victim || victimWeight === undefined || victimWeight >= targetWeight
        || excluded.has(victim) || (copper && !copper.has(victim))) continue
      const current = scores.get(victim)
      if (current) current.count += 1
      else scores.set(victim, { count: 1, first: ordinal, priorityWeight: victimWeight })
      ordinal += 1
    }
  }
  const limit = Math.max(0, Math.min(
    KRT_MAX_OPEN_REPAIR_BLOCKER_VICTIMS,
    Math.trunc(options.limit ?? KRT_MAX_OPEN_REPAIR_BLOCKER_VICTIMS),
  ))
  return [...scores.entries()]
    .sort(([, left], [, right]) => (
      right.count - left.count
      || left.priorityWeight - right.priorityWeight
      || left.first - right.first
    ))
    .slice(0, limit)
    .map(([net]) => net)
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function summaryOpenNets(summary: Record<string, unknown> | undefined) {
  const output = new Set<string>()
  if (!summary) return output
  if (Array.isArray(summary.special_open_nets)) {
    for (const net of stringArray(summary.special_open_nets)) output.add(net)
    return output
  }
  for (const key of ["failed_single", "open_single", "single_ended_followup_nets"]) {
    for (const net of stringArray(summary[key])) output.add(net)
  }
  for (const key of ["failed_multipoint", "pad_pairs_open", "pair_reports"]) {
    for (const item of recordArray(summary[key])) {
      const incomplete = stringArray(item.incomplete_members)
      if (incomplete.length) for (const net of incomplete) output.add(net)
      else if (key !== "pair_reports" || item.outcome !== "coupled") for (const field of ["net", "p_net", "n_net"]) {
        if (typeof item[field] === "string") output.add(item[field] as string)
      }
    }
  }
  return output
}

function trackLengthMm(copper: RoutingCopper) {
  return copper.tracks.reduce((total, track) => total + track.points.slice(1).reduce((length, point, index) => {
    const previous = track.points[index]
    return length + Math.hypot(point.x - previous.x, point.y - previous.y)
  }, 0), 0)
}

function copperStatsByNet(copper: RoutingCopper) {
  const stats = new Map<string, { trackLengthMm: number; viaCount: number }>()
  const forNet = (net: string) => {
    const current = stats.get(net) ?? { trackLengthMm: 0, viaCount: 0 }
    stats.set(net, current)
    return current
  }
  for (const track of copper.tracks) {
    const current = forNet(track.net)
    current.trackLengthMm += track.points.slice(1).reduce((length, point, index) => {
      const previous = track.points[index]
      return length + Math.hypot(point.x - previous.x, point.y - previous.y)
    }, 0)
  }
  for (const via of copper.vias) forNet(via.net).viaCount += 1
  return stats
}

function fingerprintMultisetIsSubset(candidate: readonly string[], baseline: readonly string[]) {
  const remaining = new Map<string, number>()
  for (const fingerprint of baseline) remaining.set(fingerprint, (remaining.get(fingerprint) ?? 0) + 1)
  for (const fingerprint of candidate) {
    const count = remaining.get(fingerprint) ?? 0
    if (!count) return false
    remaining.set(fingerprint, count - 1)
  }
  return true
}

export type ConnectivityAuditEvidence = Readonly<{
  componentCountByNet: Readonly<Record<string, number>>
  issueFingerprintsByNet: Readonly<Record<string, readonly string[]>>
}>

export function connectivityComponentsNonRegressing(
  candidate: ConnectivityAuditEvidence,
  baseline: ConnectivityAuditEvidence,
) {
  return Object.entries(candidate.componentCountByNet).every(([net, count]) => {
    const baselineCount = baseline.componentCountByNet[net]
    if (baselineCount === undefined || count > baselineCount) return false
    if (count < baselineCount) return true
    // The same number of components can still mean that a previously joined
    // pad was exchanged for another one. Preserve the exact disconnected-pad
    // identity unless the component count strictly improves.
    return fingerprintMultisetIsSubset(
      candidate.issueFingerprintsByNet[net] ?? [],
      baseline.issueFingerprintsByNet[net] ?? [],
    )
  })
}

export function connectivityComponentsImproved(
  candidate: ConnectivityAuditEvidence,
  baseline: ConnectivityAuditEvidence,
) {
  return Object.entries(candidate.componentCountByNet).some(([net, count]) => {
    const baselineCount = baseline.componentCountByNet[net]
    return baselineCount !== undefined && count < baselineCount
  })
}

type KrtStageConnectivitySnapshot = ConnectivityAuditEvidence & Readonly<{
  openNets: readonly string[]
}>

type KrtStageConnectivityPolicy = Readonly<{
  net: string
  priorityWeight: number
  protectOnSuccess?: boolean
}>

export type KrtStageConnectivityTradeoff = Readonly<{
  evidenceComplete: boolean
  hardConnectivityNonRegressing: boolean
  weightedConnectivityImproved: boolean
  baselinePriorityOpenPenalty: number
  candidatePriorityOpenPenalty: number
  baselineOpenNetCount: number
  candidateOpenNetCount: number
  baselineComponentExcess: number
  candidateComponentExcess: number
  newlyOpenedNets: readonly string[]
  newlyOpenedHardNets: readonly string[]
  newlyClosedNets: readonly string[]
}>

/**
 * Compare two full-board connectivity snapshots without making every ordinary
 * net monotonic. Critical and already-protected nets remain hard invariants;
 * unprotected nets may trade places only when the same priority/open/component
 * tuple used by final candidate selection strictly improves.
 */
export function krtStageConnectivityTradeoff(
  baseline: KrtStageConnectivitySnapshot,
  candidate: KrtStageConnectivitySnapshot,
  netPolicies: readonly KrtStageConnectivityPolicy[],
  protectedNets: readonly string[] = [],
): KrtStageConnectivityTradeoff {
  const weights = new Map(netPolicies.map((policy) => [policy.net, policy.priorityWeight] as const))
  const hardNets = new Set([
    ...protectedNets,
    ...netPolicies.filter((policy) => policy.protectOnSuccess).map((policy) => policy.net),
  ])
  const baselineOpen = new Set(baseline.openNets)
  const candidateOpen = new Set(candidate.openNets)
  const newlyOpenedNets = [...candidateOpen].filter((net) => !baselineOpen.has(net)).sort()
  const newlyClosedNets = [...baselineOpen].filter((net) => !candidateOpen.has(net)).sort()
  const newlyOpenedHardNets = newlyOpenedNets.filter((net) => hardNets.has(net))
  const score = (snapshot: KrtStageConnectivitySnapshot, open: ReadonlySet<string>) => {
    let priorityOpenPenalty = 0
    let componentExcess = 0
    for (const net of open) {
      const count = snapshot.componentCountByNet[net]
      if (!Number.isFinite(count) || count < 1) return undefined
      const configuredWeight = weights.get(net)
      priorityOpenPenalty += Number.isFinite(configuredWeight) && configuredWeight! > 0
        ? configuredWeight!
        : 4
      componentExcess += count - 1
    }
    return {
      priorityOpenPenalty,
      openNetCount: open.size,
      componentExcess,
      tuple: [priorityOpenPenalty, open.size, componentExcess] as const,
    }
  }
  const baselineScore = score(baseline, baselineOpen)
  const candidateScore = score(candidate, candidateOpen)
  const hardEvidence = (snapshot: KrtStageConnectivitySnapshot, open: ReadonlySet<string>) => {
    const componentCountByNet: Record<string, number> = {}
    const issueFingerprintsByNet: Record<string, readonly string[]> = {}
    for (const net of open) {
      if (!hardNets.has(net)) continue
      const count = snapshot.componentCountByNet[net]
      if (!Number.isFinite(count) || count < 1) return undefined
      componentCountByNet[net] = count
      issueFingerprintsByNet[net] = snapshot.issueFingerprintsByNet[net] ?? []
    }
    return { componentCountByNet, issueFingerprintsByNet }
  }
  const baselineHard = hardEvidence(baseline, baselineOpen)
  const candidateHard = hardEvidence(candidate, candidateOpen)
  const evidenceComplete = Boolean(baselineScore && candidateScore && baselineHard && candidateHard)
  const weightedConnectivityImproved = Boolean(
    evidenceComplete
    && candidateScore!.tuple.some((value, index) => (
      value < baselineScore!.tuple[index]
      && candidateScore!.tuple.slice(0, index).every((prefix, prefixIndex) => (
        prefix === baselineScore!.tuple[prefixIndex]
      ))
    )),
  )
  const hardConnectivityNonRegressing = Boolean(
    evidenceComplete
    && newlyOpenedHardNets.length === 0
    && connectivityComponentsNonRegressing(candidateHard!, baselineHard!),
  )
  return {
    evidenceComplete,
    hardConnectivityNonRegressing,
    weightedConnectivityImproved,
    baselinePriorityOpenPenalty: baselineScore?.priorityOpenPenalty ?? Number.MAX_SAFE_INTEGER,
    candidatePriorityOpenPenalty: candidateScore?.priorityOpenPenalty ?? Number.MAX_SAFE_INTEGER,
    baselineOpenNetCount: baselineScore?.openNetCount ?? Number.MAX_SAFE_INTEGER,
    candidateOpenNetCount: candidateScore?.openNetCount ?? Number.MAX_SAFE_INTEGER,
    baselineComponentExcess: baselineScore?.componentExcess ?? Number.MAX_SAFE_INTEGER,
    candidateComponentExcess: candidateScore?.componentExcess ?? Number.MAX_SAFE_INTEGER,
    newlyOpenedNets,
    newlyOpenedHardNets,
    newlyClosedNets,
  }
}

function processFailed(result: KrtProcessResult) {
  return result.status !== "completed" || result.diagnostics.some((item) => item.severity === "error")
}

export function createKrtBackend(options: KrtBackendOptions = {}): RouterBackendAdapter {
  let preparedRuntime: Promise<PreparedKrtRuntime> | undefined
  const runtime = (signal?: AbortSignal) => {
    if (!preparedRuntime) preparedRuntime = prepareKrtRuntime({
      krtDirectory: options.krtDirectory,
      pythonPath: options.pythonPath,
      assets: { ...options.assets, ...(signal ? { signal } : {}) },
    }).catch((error) => {
      preparedRuntime = undefined
      throw error
    })
    return preparedRuntime
  }
  const runtimeDiagnostic = (error: unknown) => diagnostic(
    error instanceof RouterAssetError ? error.code : "KRT_RUNTIME_PREPARE_FAILED",
    "error",
    error instanceof Error ? error.message : String(error),
    error instanceof RouterAssetError ? error.details : undefined,
  )
  const adapter: RouterBackendAdapter = {
    id: "krt",
    capabilities: {
      supported: [
        "ordinary-routing", "vias", "differential-pairs", "matched-length",
        "impedance-controlled", "preserve-fixed-copper", "fixed-zone-obstacles",
        "preconnected-pad-groups", "parallel-vias",
      ],
      maxCopperLayers: 32,
    },
    async preflight(request) {
      const diagnostics: RoutingDiagnostic[] = []
      try {
        await runtime(request.signal)
      } catch (error) {
        diagnostics.push(runtimeDiagnostic(error))
      }
      if (request.board.layers.length > 32) diagnostics.push(diagnostic(
        "KRT_LAYER_LIMIT", "error", "KRT supports at most 32 copper layers.",
      ))
      const unplannedGroundNets = krtUnplannedGroundNets(request)
      if (unplannedGroundNets.length) diagnostics.push(diagnostic(
        "KRT_GROUND_UNPLANNED",
        "warning",
        "KRT excludes ground from maze routing, but no ground zone is present; these nets will not be routed or counted as open.",
        {
          nets: unplannedGroundNets.map((net) => ({
            net,
            padCount: request.board.pads.filter((pad) => pad.net === net).length,
          })),
          remediation: "Declare plane(...), retain a verified existing ground zone, or explicitly ignoreNets(...).",
        },
      ))
      const routeScope = routableScopeNets(request)
      const specialPlan = planKrtSpecialBatches(request, routeScope, KRT_NATIVE_AUTO_POLICY.gridStep)
      diagnostics.push(...specialPlan.diagnostics)
      const specialNets = new Set(specialPlan.batches.flatMap((batch) => batch.nets))
      const ordinary = routeScope.filter((net) => !specialNets.has(net))
      // Ordinary calls are split at incompatible layer boundaries. The KRT
      // sidecar remains authoritative for all other per-net rule differences.
      for (const batch of planKrtOrdinaryBatches(request, ordinary, false)) {
        diagnostics.push(...routeLayerDiagnostics(request, batch.nets))
      }
      return diagnostics
    },
    async route(request): Promise<BackendRouteResult> {
      const diagnostics: RoutingDiagnostic[] = []
      let fallbackPrepared: Awaited<ReturnType<typeof writeKrtBoard>> | undefined
      let fallbackCurrentBoard: string | undefined
      let fallbackRouteScopeNets: readonly string[] = []
      let fallbackOpenNets: readonly string[] = []
      let fallbackInitialConnectivityEvidence: KrtConnectivityEvidence | undefined
      let fallbackCheckpointConnectivityEvidence: KrtConnectivityEvidence | undefined
      let managed: PreparedKrtRuntime
      try {
        managed = await runtime(request.signal)
      } catch (error) {
        return { status: "error", copper: EMPTY_COPPER, diagnostics: [runtimeDiagnostic(error)] }
      }
      const krtDirectory = managed.directory
      const specialStage = request.program.differentialPairs.length > 0
        || request.program.matchedGroups.length > 0
        || request.program.viaStitches.some((item) => item.mode === "along")
      const root = options.artifactsDirectory
        ? join(resolve(options.artifactsDirectory), "native-auto", specialStage ? "special" : "remaining")
        : await mkdtemp(join(tmpdir(), "copilot-router-krt-"))
      const ownedTemporary = !options.artifactsDirectory
      await mkdir(root, { recursive: true })
      const startedAt = performance.now()
      try {
        const prepared = await writeKrtBoard(request, root)
        fallbackPrepared = prepared
        const layerCatalog = createLayerCatalog(request.board.layers)
        const { gridStep: requestedGridStep, ...nativePolicy } = KRT_NATIVE_AUTO_POLICY
        const routeScopeNets = routableScopeNets(request)
        fallbackRouteScopeNets = routeScopeNets
        fallbackOpenNets = routeScopeNets
        const routeScope = new Set(routeScopeNets)
        // Keep declared and actually planned special scope separate. A group
        // can be declared yet unrepresentable (or only partly routable); those
        // members must flow into ordinary routing instead of disappearing.
        const declaredSpecialNets = new Set<string>()
        for (const pair of request.program.differentialPairs) {
          if (routeScope.has(pair.positive)) declaredSpecialNets.add(pair.positive)
          if (routeScope.has(pair.negative)) declaredSpecialNets.add(pair.negative)
        }
        for (const group of request.program.matchedGroups) {
          for (const net of group.nets) if (routeScope.has(net)) declaredSpecialNets.add(net)
        }
        const specialGridStep = selectKrtGridStep(request, requestedGridStep, [...declaredSpecialNets])
        const specialPlan = planKrtSpecialBatches(request, routeScopeNets, specialGridStep)
        diagnostics.push(...specialPlan.diagnostics)
        // Net-set subtraction alone cannot detect an overlapping constraint:
        // a net may be routed by one complete special group while another group
        // containing it was deferred. Keep that semantic loss partial too.
        const specialConstraintsDeferred = specialPlan.diagnostics.some((item) => (
          item.code === "KRT_SPECIAL_GROUP_DEFERRED"
        ))
        const plannedSpecialNets = new Set(specialPlan.batches.flatMap((batch) => batch.nets))
        const deferredSpecialNets = [...declaredSpecialNets]
          .filter((net) => !plannedSpecialNets.has(net))
        const fullBoardRules = minimumRules(
          routeScopeNets.length
            ? routeScopeNets.map((net) => ruleFor(request, net))
            : [request.rules.default],
          requestedGridStep,
        )
        const fullBoardFab = join(root, "native-auto-fab.txt")
        await writeFabOverrides(fullBoardFab, fullBoardRules)
        const common: Omit<KrtStageSpec, "rules" | "fabOverridesPath"> = {
          pythonPath: managed.pythonPath,
          pythonPathEntries: managed.pythonPathEntries,
          krtDirectory,
          authoritativeProjectPath: prepared.inputProject,
          layers: request.board.layers.map((item) => layerCatalog.kiCadName(item.name)),
          diffPairs: [],
          matchedGroups: [],
          remainingNets: [],
          matchDifferentialPairLengths: false,
          // Core-owned return stitching runs only after final routing and plane
          // creation; the adapter applies the native-return safety policy.
          suppressGroundReturnVias: false,
          // onlyNets controls scope, never priority. Native MPS remains the
          // default ordering for both ordinary and special routing.
          preserveNetOrder: true,
          // A dense pad escape may need the fixed 0.127 mm hard floor even
          // when the ordinary preferred width cannot leave the footprint.
          // This is a completion mechanism, never a reason to weaken via or
          // clearance rules.
          ...nativePolicy,
          collectStats: false,
          debugMemory: false,
          exactFilledZoneObstacles: true,
          signal: request.signal,
        }
        let current = prepared.inputBoard
        fallbackCurrentBoard = current
        const initialAuditSpec: KrtStageSpec = {
          ...common,
          rules: fullBoardRules,
          fabOverridesPath: fullBoardFab,
          remainingNets: routeScopeNets,
          protectedNets: [],
        }
        const initialConnectivity = routeScopeNets.length
          ? await auditKrtBoardConnectivity(
              current,
              routeScopeNets,
              initialAuditSpec,
              join(root, "initial-audit", "connectivity"),
            )
          : {
              openNets: [] as string[], issueFingerprints: [] as string[], issueFingerprintsByNet: {}, componentCountByNet: {},
              elapsedMs: 0, diagnostics: [] as KrtDiagnostic[],
            }
        diagnostics.push(...convertDiagnostics(initialConnectivity.diagnostics).map((item) => (
          item.severity === "error" ? { ...item, severity: "warning" as const } : item
        )))
        const connectivityEvidence = (audit: typeof initialConnectivity): KrtConnectivityEvidence | undefined => {
          if (audit.diagnostics.some((item) => item.severity === "error")) return undefined
          const open = new Set(audit.openNets)
          const componentsByNet: Record<string, number> = {}
          for (const net of routeScopeNets) {
            const count = open.has(net) ? audit.componentCountByNet[net] : 1
            if (count === undefined || !Number.isFinite(count) || count < 1) return undefined
            componentsByNet[net] = count
          }
          return {
            openNets: [...audit.openNets].sort(),
            componentsByNet,
            connectivityComponentCount: Object.values(componentsByNet).reduce((sum, count) => sum + count, 0),
          }
        }
        const initialConnectivityEvidence = connectivityEvidence(initialConnectivity)
        fallbackInitialConnectivityEvidence = initialConnectivityEvidence
        fallbackCheckpointConnectivityEvidence = initialConnectivityEvidence
        fallbackOpenNets = initialConnectivity.openNets
        let fanoutPromoted = false
        const fanoutResults: KrtProcessResult[] = []
        // Fanout is now strictly explicit, so an explicit target may include
        // differential/matched pads as well as ordinary nets. The old
        // automatic path excluded special nets to avoid unsolicited asymmetric
        // stubs; that concern no longer justifies silently ignoring a request.
        const fanoutNets = routeScopeNets
        // An explicitly requested fanout is already component-local, so its
        // proven 0.05 mm escape grid does not create a full-board fine map.
        const fanoutGridStep = Math.min(requestedGridStep, 0.05)
        const fanoutPlans = planKrtQfnFanout(request, fanoutNets, fanoutGridStep)
        if (fanoutPlans.length) diagnostics.push(diagnostic(
          "KRT_QFN_FANOUT_PLANNED",
          "info",
          `KRT will attempt ${fanoutPlans.length} explicitly requested QFN/QFP fanout batch(es) before maze routing.`,
          fanoutPlans.map((plan) => ({
            component: plan.component,
            pads: plan.padNumbers,
            nets: plan.nets,
            layer: plan.layer,
            widthMm: plan.rules.trackWidth,
            method: plan.method,
            extensionMm: plan.extensionMm,
          })),
        ))
        for (const [index, plan] of fanoutPlans.entries()) {
          const tag = `${String(index + 1).padStart(2, "0")}-${plan.component.replace(/[^A-Za-z0-9_.-]+/g, "_")}`
          const fanoutFab = join(root, `fanout-${tag}-fab.txt`)
          await writeFabOverrides(fanoutFab, plan.rules)
          const planInput = current
          const runFanout = async (
            method: "stub" | "underpad",
            nets: readonly string[],
            input: string,
            suffix = "",
          ) => {
            const attemptTag = suffix ? `${tag}-${suffix}` : tag
            const output = join(root, `01-fanout-${attemptTag}.kicad_pcb`)
            const fanoutSpec: KrtQfnFanoutSpec = {
              ...common,
              layers: [plan.layer],
              rules: plan.rules,
              fabOverridesPath: fanoutFab,
              diffPairs: [],
              matchedGroups: [],
              remainingNets: nets,
              component: plan.component,
              padNumbers: plan.padNumbers,
              nets,
              layer: plan.layer,
              extension: plan.extensionMm,
              method,
            }
            const result = await runKrtQfnFanout(
              input,
              output,
              fanoutSpec,
              join(root, "fanout", attemptTag),
            )
            fanoutResults.push(result)
            // Fanout is an optional search aid. A failed attempt is retained
            // in diagnostics but never blocks the maze-routing stages.
            diagnostics.push(...convertDiagnostics(result.diagnostics).map((item) => (
              item.severity === "error" ? { ...item, severity: "warning" as const } : item
            )))
            const accepted = result.status === "completed" && await exists(output)
            if (accepted) {
              current = output
              fallbackCurrentBoard = current
              fanoutPromoted = true
            }
            return { result, accepted }
          }

          if (plan.method !== "auto") {
            await runFanout(plan.method, plan.nets, current)
            continue
          }

          const surface = await runFanout("stub", plan.nets, current, "stub")
          const unescaped = surface.accepted
            ? stringArray(surface.result.jsonSummary?.unescaped_nets)
            : [...plan.nets]
          if (unescaped.length) {
            await runFanout(
              "underpad",
              unescaped,
              surface.accepted ? current : planInput,
              "underpad",
            )
          }
        }
        const protectedNets = new Set<string>()
        const boardAuditSpec = (): KrtStageSpec => ({
          ...common,
          rules: fullBoardRules,
          fabOverridesPath: fullBoardFab,
          remainingNets: routeScopeNets,
          protectedNets: [...protectedNets],
        })
        let checkpointConnectivity: Awaited<ReturnType<typeof auditKrtBoardConnectivity>> | undefined = fanoutPromoted
          ? undefined
          : initialConnectivity
        let checkpointDrc: Awaited<ReturnType<typeof auditKrtBoardDrc>> | undefined
        let stageGateElapsedMs = 0
        const demoteErrors = (items: readonly RoutingDiagnostic[]) => items.map((item) => (
          item.severity === "error" ? { ...item, severity: "warning" as const } : item
        ))
        const ensureCheckpointAudits = async (tag: string) => {
          const spec = boardAuditSpec()
          if (!checkpointConnectivity && routeScopeNets.length) checkpointConnectivity = await auditKrtBoardConnectivity(
            current,
            routeScopeNets,
            spec,
            join(root, "stage-gates", tag, "baseline-connectivity"),
          )
          if (!checkpointDrc && routeScopeNets.length) checkpointDrc = await auditKrtBoardDrc(
            current,
            routeScopeNets,
            spec,
            join(root, "stage-gates", tag, "baseline-drc"),
          )
          const evidence = checkpointConnectivity && connectivityEvidence(checkpointConnectivity)
          if (evidence) {
            fallbackCheckpointConnectivityEvidence = evidence
            fallbackOpenNets = evidence.openNets
          }
          return { spec, connectivity: checkpointConnectivity, drc: checkpointDrc }
        }
        const promoteStageCandidate = async (
          tag: string,
          output: string,
          result: KrtProcessResult,
          gate: "strict" | "ordinary" = "strict",
          requireConnectivityImprovement = false,
        ) => {
          const resultDiagnostics = convertDiagnostics(result.diagnostics)
          const outputExists = result.attempted && await exists(output)
          let candidateCopper: RoutingCopper | undefined
          let unreadable: unknown
          let checkpointCopper: RoutingCopper | undefined
          let checkpointUnreadable: unknown
          if (outputExists) {
            try {
              candidateCopper = (await readKrtBoard(prepared.inputBoard, output, request.board)).copper
            } catch (error) {
              unreadable = error
            }
            try {
              checkpointCopper = (await readKrtBoard(prepared.inputBoard, current, request.board)).copper
            } catch (error) {
              checkpointUnreadable = error
            }
          }
          // The replacement copper includes input/editable geometry. Hard-rule
          // gates apply only to newly added or changed primitives; otherwise one
          // inherited narrow trace would deadlock every useful partial stage.
          // The final result still reports absolute rule diagnostics below.
          const candidateDelta = candidateCopper
            ? checkpointCopper ? subtractKrtCopper(checkpointCopper, candidateCopper) : candidateCopper
            : undefined
          const ruleDiagnostics = candidateDelta
            ? krtRoutedCopperRuleDiagnostics(request, candidateDelta)
            : []
          const baseline = outputExists && candidateCopper
            ? await ensureCheckpointAudits(tag)
            : { spec: boardAuditSpec(), connectivity: undefined, drc: undefined }
          const candidateConnectivity = outputExists && candidateCopper && routeScopeNets.length
            ? await auditKrtBoardConnectivity(
                output,
                routeScopeNets,
                baseline.spec,
                join(root, "stage-gates", tag, "candidate-connectivity"),
              )
            : undefined
          const candidateDrc = outputExists && candidateCopper && routeScopeNets.length
            ? await auditKrtBoardDrc(
                output,
                routeScopeNets,
                baseline.spec,
                join(root, "stage-gates", tag, "candidate-drc"),
              )
            : undefined
          stageGateElapsedMs += (candidateConnectivity?.elapsedMs ?? 0) + (candidateDrc?.elapsedMs ?? 0)
          const baselineConnectivityUsable = Boolean(
            baseline.connectivity
            && !baseline.connectivity.diagnostics.some((item) => item.severity === "error"),
          )
          const candidateConnectivityUsable = Boolean(
            candidateConnectivity
            && !candidateConnectivity.diagnostics.some((item) => item.severity === "error"),
          )
          const baselineOpen = new Set(baseline.connectivity?.openNets ?? [])
          const connectivityNonRegressing = !routeScopeNets.length || Boolean(
            baselineConnectivityUsable
            && candidateConnectivityUsable
            && candidateConnectivity!.openNets.every((net) => baselineOpen.has(net))
            && connectivityComponentsNonRegressing(
              candidateConnectivity!,
              baseline.connectivity!,
            ),
          )
          const drcComparable = Boolean(
            baseline.drc && candidateDrc && !baseline.drc.failed && !candidateDrc.failed,
          )
          const drcNonRegressing = !routeScopeNets.length || Boolean(
            drcComparable
            && candidateDrc!.violationCount <= baseline.drc!.violationCount
            && fingerprintMultisetIsSubset(candidateDrc!.fingerprints, baseline.drc!.fingerprints)
            && fingerprintMultisetIsSubset(candidateDrc!.shortFingerprints, baseline.drc!.shortFingerprints),
          )
          const shortsNonRegressing = !routeScopeNets.length || Boolean(
            drcComparable
            && fingerprintMultisetIsSubset(candidateDrc!.shortFingerprints, baseline.drc!.shortFingerprints),
          )
          const connectivityImproved = Boolean(
            baselineConnectivityUsable
            && candidateConnectivityUsable
            && (candidateConnectivity!.openNets.length < baselineOpen.size
              || connectivityComponentsImproved(candidateConnectivity!, baseline.connectivity!)),
          )
          const connectivityTradeoff = baselineConnectivityUsable && candidateConnectivityUsable
            ? krtStageConnectivityTradeoff(
                baseline.connectivity!,
                candidateConnectivity!,
                request.plan.netPolicies,
                [...protectedNets],
              )
            : undefined
          const allowWeightedTradeoff = gate === "ordinary"
          const weightedTradeoffPasses = Boolean(
            allowWeightedTradeoff
            && connectivityTradeoff?.hardConnectivityNonRegressing
            && connectivityTradeoff.weightedConnectivityImproved,
          )
          const effectiveConnectivityImproved = connectivityImproved || weightedTradeoffPasses
          // An ordinary full-board pass is allowed to retain useful partial
          // copper with a new non-short DRC diagnostic. Rejecting 900 newly
          // connected nets because of one clearance item recreates the old
          // all-or-nothing failure mode. Physical shorts, critical/protected
          // connectivity damage and hard-rule violations remain hard gates.
          const drcGatePassed = krtStageDrcGatePasses(gate, {
            drcNonRegressing,
            shortsNonRegressing,
            connectivityImproved: effectiveConnectivityImproved,
          })
          const hardDamage = result.diagnostics.filter((item) => (
            item.severity === "error" && KRT_HARD_STAGE_DAMAGE.has(item.code)
          ))
          const accepted = Boolean(
            outputExists
            && candidateCopper
            && !hardDamage.length
            && !ruleDiagnostics.some((item) => item.severity === "error")
            && krtStageConnectivityGatePasses({
              connectivityNonRegressing,
              connectivityImproved,
              allowWeightedTradeoff,
              hardConnectivityNonRegressing: connectivityTradeoff?.hardConnectivityNonRegressing,
              weightedConnectivityImproved: connectivityTradeoff?.weightedConnectivityImproved,
              requireConnectivityImprovement,
            })
            && drcGatePassed,
          )
          const auditDiagnostics = [
            ...convertDiagnostics(baseline.connectivity?.diagnostics ?? []),
            ...convertDiagnostics(baseline.drc?.diagnostics ?? []),
            ...convertDiagnostics(candidateConnectivity?.diagnostics ?? []),
            ...convertDiagnostics(candidateDrc?.diagnostics ?? []),
          ]
          const stageDiagnostics = [...resultDiagnostics, ...auditDiagnostics, ...ruleDiagnostics]
          diagnostics.push(...(accepted ? stageDiagnostics : demoteErrors(stageDiagnostics)))
          if (accepted && !connectivityNonRegressing && weightedTradeoffPasses) diagnostics.push(diagnostic(
            "KRT_STAGE_WEIGHTED_CONNECTIVITY_TRADEOFF_SELECTED",
            "info",
            "Selected a stage that strictly improves weighted full-board connectivity while preserving every critical/protected net.",
            { tag, gate, ...connectivityTradeoff },
          ))
          if (accepted) {
            current = output
            fallbackCurrentBoard = current
            checkpointConnectivity = candidateConnectivityUsable ? candidateConnectivity : undefined
            checkpointDrc = candidateDrc && !candidateDrc.failed ? candidateDrc : undefined
            const evidence = candidateConnectivityUsable
              ? connectivityEvidence(candidateConnectivity!)
              : undefined
            if (evidence) fallbackCheckpointConnectivityEvidence = evidence
            fallbackOpenNets = candidateConnectivityUsable
              ? candidateConnectivity!.openNets
              : routeScopeNets
          } else diagnostics.push(diagnostic(
            "KRT_STAGE_CANDIDATE_REJECTED",
            "warning",
            "A KRT stage artifact was retained for diagnosis but the workflow rolled back to its previous checkpoint because a full-board safety invariant regressed.",
            {
              tag,
              outputExists,
              unreadable: unreadable instanceof Error ? unreadable.message : unreadable === undefined ? undefined : String(unreadable),
              checkpointUnreadable: checkpointUnreadable instanceof Error
                ? checkpointUnreadable.message
                : checkpointUnreadable === undefined ? undefined : String(checkpointUnreadable),
              hardDamage: hardDamage.map((item) => item.code),
              ruleErrors: ruleDiagnostics.filter((item) => item.severity === "error").map((item) => item.code),
              beforeOpenNets: baseline.connectivity?.openNets,
              afterOpenNets: candidateConnectivity?.openNets,
              beforeDrcViolations: baseline.drc?.violationCount,
              afterDrcViolations: candidateDrc?.violationCount,
              connectivityNonRegressing,
              connectivityImproved,
              effectiveConnectivityImproved,
              allowWeightedTradeoff,
              connectivityTradeoff,
              requireConnectivityImprovement,
              shortsNonRegressing,
              drcNonRegressing,
              gate,
            },
          ))
          return {
            accepted,
            connectivity: candidateConnectivity,
            drc: candidateDrc,
            baselineConnectivity: baseline.connectivity,
            baselineDrc: baseline.drc,
          }
        }
        const indexedSpecialBatches = specialPlan.batches.map((batch, index) => ({ batch, index }))
        const leadingSpecialBatches = indexedSpecialBatches.filter(({ batch }) => (
          krtSpecialBatchRunsBeforeCritical(batch)
        ))
        const trailingSpecialBatches = indexedSpecialBatches.filter(({ batch }) => (
          !krtSpecialBatchRunsBeforeCritical(batch)
        ))
        const specialResults: KrtProcessResult[] = []
        const verifiedSpecialNets = new Set<string>()
        const ordinaryFallbackSpecialNets = new Set<string>()
        const rejectedSpecialNets = new Set<string>()
        const runSpecialBatches = async (
          batches: readonly (typeof indexedSpecialBatches)[number][],
        ) => {
          for (const { batch, index } of batches) {
            const tag = `${String(index + 1).padStart(2, "0")}-${batch.id}`
            const specialFab = join(root, `special-${tag}-fab.txt`)
            const output = join(root, `02-special-${tag}.kicad_pcb`)
            await writeFabOverrides(specialFab, batch.rules)
            const matchedFallbackRules = batch.containsDifferential
              ? undefined
              : {
                  ...batch.rules,
                  gridStep: krtMatchedFallbackGridStep(
                    request.board.outline,
                    batch.rules.gridStep ?? requestedGridStep,
                  ),
                  ...(batch.rules.lengthMatchTolerance === undefined
                    ? {}
                    : { lengthMatchTolerance: krtMatchedFallbackTolerance(batch.rules.lengthMatchTolerance) }),
                }
            const result = await runKrtSpecial(current, output, {
              ...common,
              layers: batch.layers,
              rules: batch.rules,
              fabOverridesPath: specialFab,
              diffPairs: batch.request.program.differentialPairs.map((pair) => (
                [pair.positive, pair.negative] as const
              )),
              matchedGroups: batch.request.program.matchedGroups.map((group) => group.nets),
              ...(krtViaCost(batch.viaPreference) === undefined
                ? {}
                : { viaCost: krtViaCost(batch.viaPreference) }),
              ordinaryMatchedRules: batch.rules,
              ordinaryMatchedFallbackRules: matchedFallbackRules,
              ordinaryMatchedFabOverridesPath: specialFab,
              // Differential routing keeps the single measured native path.
              // An ordinary matched group gets one cheap declared-order
              // alternative; a complete first candidate still short-circuits
              // the portfolio in runKrtSpecial().
              specialMaxCandidates: batch.containsDifferential
                ? KRT_NATIVE_AUTO_POLICY.specialMaxCandidates
                : KRT_ORDINARY_MATCHED_MAX_CANDIDATES,
              protectedNets: [...protectedNets],
              matchDifferentialPairLengths: batch.request.program.differentialPairs.some((pair) => (
                ruleFor(batch.request, pair.positive).differential?.maxSkewMm !== undefined
                || ruleFor(batch.request, pair.negative).differential?.maxSkewMm !== undefined
              )),
            }, join(root, "special", tag))
            specialResults.push(result)
            const promoted = await promoteStageCandidate(`02-special-${tag}`, output, result)
            const disposition = krtSpecialBatchRecoveryDisposition(
              batch.nets,
              promoted.accepted,
              result.protectedNets,
            )
            for (const net of disposition.verifiedNets) {
              verifiedSpecialNets.add(net)
              protectedNets.add(net)
            }
            for (const net of disposition.ordinaryFallbackNets) ordinaryFallbackSpecialNets.add(net)
            if (!promoted.accepted) for (const net of batch.nets) rejectedSpecialNets.add(net)
            if (disposition.ordinaryFallbackNets.length) diagnostics.push(diagnostic(
              "KRT_SPECIAL_NETS_RETURNED_TO_ORDINARY",
              promoted.accepted ? "info" : "warning",
              promoted.accepted
                ? "The safely promoted special candidate did not semantically verify every declared net; unverified nets remain editable and eligible for ordinary recovery."
                : "The special candidate failed the full-board checkpoint gate; its retained artifact was not applied and all batch nets returned to ordinary recovery.",
              {
                batch: batch.id,
                promoted: promoted.accepted,
                verifiedNets: disposition.verifiedNets,
                ordinaryFallbackNets: disposition.ordinaryFallbackNets,
              },
            ))
          }
        }
        // Differential custody and critical special intent remain first. Lower
        // priority matched groups wait until critical ordinary nets have had a
        // chance to claim scarce escape corridors.
        await runSpecialBatches(leadingSpecialBatches)

        const preferredWidthNets = new Set([
          ...request.program.powerNets.map((intent) => intent.net),
          ...request.program.signalNets.filter((intent) => intent.impedance).map((intent) => intent.net),
        ])
        const powerWidths = (nets: readonly string[]) => nets
          .filter((net) => preferredWidthNets.has(net))
          .map((net) => ({ net, width: ruleFor(request, net).preferredTrackWidthMm }))
        const ordinarySpec = async (
          batch: KrtOrdinaryBatch,
          tag: string,
          includeBus: boolean,
          forceReroute = false,
          temporarilyUnprotectedNets: readonly string[] = [],
          ripExistingNets: readonly string[] = [],
        ) => {
          const rules = minimumRules(batch.nets.map((net) => ruleFor(request, net)), requestedGridStep)
          const routedRules = {
            ...rules,
            // route.py omits --track-width for ordinary routing so native
            // netclass widths remain authoritative. This value is only the
            // shared neck-down/fabrication floor for this compatible bucket.
            trackWidth: batch.hardTrackWidthMm,
            hardTrackWidth: batch.hardTrackWidthMm,
            viaSize: batch.viaSizeMm,
            viaDrill: batch.viaDrillMm,
          }
          const fab = join(root, `${tag}-fab.txt`)
          await writeFabOverrides(fab, routedRules)
          const temporarilyUnprotected = new Set(temporarilyUnprotectedNets)
          return {
            ...common,
            layers: batch.layers,
            rules: routedRules,
            fabOverridesPath: fab,
            remainingNets: batch.nets,
            protectedNets: [...protectedNets].filter((net) => !temporarilyUnprotected.has(net)),
            ...(includeBus && request.program.busDetect ? { busDetect: request.program.busDetect } : {}),
            powerNets: powerWidths(batch.nets),
            ...(krtViaCost(batch.viaPreference) === undefined
              ? {}
              : { viaCost: krtViaCost(batch.viaPreference) }),
            ...(forceReroute ? { forceReroute: true } : {}),
            ...(ripExistingNets.length ? { ripExistingNets } : {}),
          } satisfies KrtStageSpec
        }

        const policies = new Map(request.plan.netPolicies.map((policy) => [policy.net, policy]))
        let ordinaryRouteBatchCount = 0
        const batchBudgetWarnedPhases = new Set<string>()
        const scheduledOrdinaryBatches = (
          phase: "critical" | "early" | "main",
          nets: readonly string[],
        ) => {
          const planned = planKrtOrdinaryBatches(request, nets, true)
          const batches = limitKrtOrdinaryBatches(planned, ordinaryRouteBatchCount)
          ordinaryRouteBatchCount += batches.length
          const scheduled = new Set(batches.flatMap((batch) => batch.nets))
          const deferredNets = [...new Set(nets)].filter((net) => !scheduled.has(net))
          if (deferredNets.length && !batchBudgetWarnedPhases.has(phase)) {
            batchBudgetWarnedPhases.add(phase)
            diagnostics.push(diagnostic(
            "KRT_ORDINARY_BATCH_BUDGET_EXHAUSTED",
            "warning",
            `Deferred ${deferredNets.length} ${phase} net(s) after reaching the bounded ${KRT_MAX_ORDINARY_ROUTE_BATCHES}-process ordinary routing budget.`,
            {
              phase,
              plannedBatches: planned.length,
              scheduledBatches: batches.length,
              ordinaryRouteBatchCount,
              deferredNets: deferredNets.slice(0, 64),
            },
            ))
          }
          return { batches, deferredNets }
        }
        const criticalGroups = request.plan.groups
          .filter((group) => group.kind === "critical")
          .map((group) => krtOrdinaryRecoveryScope(
            group.nets.filter((net) => routeScope.has(net)),
            [...verifiedSpecialNets],
          ))
          .filter((nets) => nets.length)
        const criticalNets = new Set(criticalGroups.flat())
        const criticalResults: KrtProcessResult[] = []
        const criticalOpenNets = new Set<string>()
        let criticalIndex = 0
        for (const group of criticalGroups) {
          const scheduled = scheduledOrdinaryBatches("critical", group)
          for (const net of scheduled.deferredNets) criticalOpenNets.add(net)
          for (const batch of scheduled.batches) {
            criticalIndex += 1
            const tag = `03-critical-${String(criticalIndex).padStart(2, "0")}`
            const output = join(root, `${tag}.kicad_pcb`)
            const spec = await ordinarySpec(batch, tag, false)
            // The outer full-board checkpoint gate is stronger than the old
            // critical wrapper's duplicate scoped audits. Route once, then use
            // the already-required full-board connectivity/DRC evidence below
            // to protect each clean connected member.
            const result = await runKrtRemaining(
              current,
              output,
              spec,
              join(root, "critical", String(criticalIndex).padStart(2, "0")),
            )
            criticalResults.push(result)
            const promoted = await promoteStageCandidate(tag, output, result, "ordinary")
            const connected = promoted.accepted
              && promoted.connectivity
              && !promoted.connectivity.diagnostics.some((item) => item.severity === "error")
              ? batch.nets.filter((net) => !promoted.connectivity!.openNets.includes(net))
              : []
            const verified = promoted.baselineDrc && promoted.drc
              && !promoted.baselineDrc.failed && !promoted.drc.failed
              ? connected.filter((net) => krtCriticalNetDrcNonRegressing(
                  net,
                  promoted.baselineDrc!,
                  promoted.drc!,
                ))
              : []
            // The in-memory ledger is authoritative even if persistence fails;
            // every later stage re-materializes it from ordinarySpec.
            for (const net of verified) protectedNets.add(net)
            if (verified.length) {
              result.protectedNets = [...new Set([...(result.protectedNets ?? []), ...verified])]
              try {
                const persisted = await persistKrtProtectedNets(output, verified, "workflow-critical")
                result.protectedNetsPath = persisted.path
                diagnostics.push(diagnostic(
                  "KRT_CRITICAL_NETS_PROTECTED",
                  "info",
                  `Protected ${verified.length} full-board-verified critical net(s) for later native recovery.`,
                  { nets: verified },
                ))
              } catch (error) {
                diagnostics.push(diagnostic(
                  "KRT_CRITICAL_PROTECTION_FAILED",
                  "warning",
                  "Could not persist the verified critical-net ledger; the in-memory ledger remains active for this workflow.",
                  { nets: verified, error: error instanceof Error ? error.message : String(error) },
                ))
              }
            }
            const open = batch.nets.filter((net) => !verified.includes(net))
            result.jsonSummary = {
              ...(result.jsonSummary ?? {}),
              critical_open_nets: open,
              critical_verified_nets: verified,
            }
            for (const net of open) criticalOpenNets.add(net)
          }
        }

        await runSpecialBatches(trailingSpecialBatches)
        // Keep one disk-backed checkpoint before early/main fragmentation. If
        // the staged route remains incomplete and all remaining hard policies
        // are compatible, KRT gets one global original-order recovery attempt
        // from this point. Verified special/critical copper stays protected.
        const monolithicFallbackInput = current

        // High-priority and via-sensitive ordinary nets get an inexpensive
        // head start. They stay editable: only verified critical/special nets
        // are protected, so native blocker recovery may still move them.
        const plannedMain = krtOrdinaryRecoveryScope([
          ...request.plan.mainNets,
          ...deferredSpecialNets,
          ...ordinaryFallbackSpecialNets,
        ], [...verifiedSpecialNets])
          .filter((net) => (
            routeScope.has(net)
            && !criticalNets.has(net)
          ))
        const earlyNets = plannedMain.filter((net) => {
          const policy = policies.get(net)
          return policy?.priority === "high" || (policy?.viaPreference ?? "auto") !== "auto"
        })
        const earlySet = new Set(earlyNets)
        const earlyOpenNets = new Set<string>()
        const earlyResults: KrtProcessResult[] = []
        const scheduledEarly = scheduledOrdinaryBatches("early", earlyNets)
        for (const net of scheduledEarly.deferredNets) earlyOpenNets.add(net)
        for (const [index, batch] of scheduledEarly.batches.entries()) {
          const tag = `04-early-${String(index + 1).padStart(2, "0")}`
          const output = join(root, `${tag}.kicad_pcb`)
          const spec = await ordinarySpec(batch, tag, false)
          const result = await runKrtRemaining(current, output, spec, join(root, "early", batch.id))
          earlyResults.push(result)
          const promoted = await promoteStageCandidate(tag, output, result, "ordinary")
          if (promoted.accepted && promoted.connectivity
            && !promoted.connectivity.diagnostics.some((item) => item.severity === "error")) {
            const open = new Set(promoted.connectivity.openNets)
            for (const net of batch.nets) if (open.has(net)) earlyOpenNets.add(net)
          } else for (const net of batch.nets) earlyOpenNets.add(net)
        }

        const mainNets = [...new Set([
          ...plannedMain.filter((net) => !earlySet.has(net)),
          ...earlyOpenNets,
          ...criticalOpenNets,
        ])]
        const mainResults: KrtProcessResult[] = []
        const scheduledMain = scheduledOrdinaryBatches("main", mainNets)
        for (const [index, batch] of scheduledMain.batches.entries()) {
          const tag = `05-main-${String(index + 1).padStart(2, "0")}`
          const output = join(root, `${tag}.kicad_pcb`)
          const spec = await ordinarySpec(batch, tag, true)
          const result = await runKrtRemaining(current, output, spec, join(root, "main", batch.id))
          mainResults.push(result)
          await promoteStageCandidate(tag, output, result, "ordinary")
        }

        const finalAuditSpec = boardAuditSpec()
        let finalAudit = routeScopeNets.length
          ? await auditKrtBoardConnectivity(current, routeScopeNets, finalAuditSpec, join(root, "final-audit"))
          : {
              openNets: [] as string[], issueFingerprints: [] as string[], issueFingerprintsByNet: {}, componentCountByNet: {},
              elapsedMs: 0, diagnostics: [] as KrtDiagnostic[],
            }
        diagnostics.push(...convertDiagnostics(finalAudit.diagnostics))
        fallbackOpenNets = finalAudit.openNets
        const auditedFinalEvidence = connectivityEvidence(finalAudit)
        if (auditedFinalEvidence) fallbackCheckpointConnectivityEvidence = auditedFinalEvidence
        const monolithicFallbackNets = krtOrdinaryRecoveryScope(
          routeScopeNets,
          [...protectedNets],
        )
        // Preserve the board/netclass order used by KRT's proven original-order
        // path. Connected protected nets and one-terminal assignments act only
        // as stable ordering placeholders; the protected ledger still forbids
        // their copper from being changed.
        const monolithicFallbackSelectors = krtMonolithicFallbackSelectors(request)
        const monolithicFallbackBatch = krtMonolithicFallbackBatch(
          request,
          monolithicFallbackNets,
        )
        const fallbackCanImprove = !finalAudit.diagnostics.some((item) => item.severity === "error")
          && finalAudit.openNets.some((net) => monolithicFallbackNets.includes(net))
        if (fallbackCanImprove && monolithicFallbackBatch) {
          const tag = "05-main-fallback-original"
          const output = join(root, `${tag}.kicad_pcb`)
          const fallbackSpec = {
            ...(await ordinarySpec(monolithicFallbackBatch, tag, true)),
            ordering: "original" as const,
            // Treat every unprotected member uniformly in this global pass.
            // KRT's dedicated --power-nets multipoint phase reproduced the
            // same corridor fragmentation here and could reopen a supply net;
            // authoritative per-net widths still come from the project.
            powerNets: [],
            remainingNets: monolithicFallbackSelectors,
            // This is a candidate-local search cost, not a global DRC rule.
            // It materially reduced gratuitous vias in the measured ICM20948
            // completion fallback while preserving full connectivity.
            viaCost: KRT_VIA_PREFERENCE_COSTS.avoid,
          }
          const beforeOpenNets = [...finalAudit.openNets]
          const result = await runKrtRemaining(
            monolithicFallbackInput,
            output,
            fallbackSpec,
            join(root, "main-fallback", "original-via-avoid"),
          )
          mainResults.push(result)
          const promoted = await promoteStageCandidate(tag, output, result, "ordinary", true)
          if (promoted.accepted && promoted.connectivity) {
            finalAudit = promoted.connectivity
            diagnostics.push(diagnostic(
              "KRT_MONOLITHIC_FALLBACK_SELECTED",
              "info",
              "Selected the bounded original-order monolithic fallback because it improved full-board connectivity without regressing DRC or protected copper.",
              {
                beforeOpenNets,
                afterOpenNets: finalAudit.openNets,
                routableNetCount: monolithicFallbackNets.length,
                selectorNetCount: monolithicFallbackSelectors.length,
                ordering: "original",
                viaCost: KRT_VIA_PREFERENCE_COSTS.avoid,
              },
            ))
          }
        } else if (fallbackCanImprove && !monolithicFallbackBatch) diagnostics.push(diagnostic(
          "KRT_MONOLITHIC_FALLBACK_INCOMPATIBLE",
          "info",
          "Skipped the global completion fallback because the remaining nets require multiple incompatible hard-policy batches.",
          {
            netCount: monolithicFallbackNets.length,
            hardPolicyBatchCount: planKrtOrdinaryBatches(request, monolithicFallbackNets, false).length,
          },
        ))
        type RepairJob = Readonly<{
          kind: "open"
          batch: KrtOrdinaryBatch
          blockerVictims: readonly string[]
        } | {
          kind: "short-via"
          batch: KrtOrdinaryBatch
          targetNet: string
        }>
        const repairResults: Array<Readonly<{
          kind: RepairJob["kind"]
          targetNet?: string
          result: KrtProcessResult
          accepted: boolean
          beforeOpenNets: readonly string[]
          afterOpenNets: readonly string[]
          beforeDrcViolations?: number
          afterDrcViolations?: number
          beforeTargetVias?: number
          afterTargetVias?: number
          blockerVictims?: readonly string[]
        }>> = []
        // KRT skips already-connected nets during ordinary routing. For a
        // short avoid/forbid net with vias, explicitly ask native route.py to
        // re-route only that one net, then keep it only when every full-board
        // safety gate passes and the target via count strictly decreases.
        let incumbentCopper: RoutingCopper | undefined
        try {
          incumbentCopper = (await readKrtBoard(prepared.inputBoard, current, request.board)).copper
        } catch (error) {
          diagnostics.push(diagnostic(
            "KRT_REPAIR_BASELINE_UNREADABLE",
            "warning",
            "Could not inspect the post-main copper for connected short-net via repair.",
            { error: error instanceof Error ? error.message : String(error) },
          ))
        }
        const openSet = new Set(finalAudit.openNets)
        const incumbentStats = incumbentCopper ? copperStatsByNet(incumbentCopper) : new Map()
        const repairRipExclusions = new Set([
          ...verifiedSpecialNets,
          ...request.board.nets.map((item) => item.name).filter(isGroundNetName),
          ...request.board.copper.fixed.zones.flatMap((zone) => zone.net ? [zone.net] : []),
          ...request.board.copper.editable.zones.flatMap((zone) => zone.net ? [zone.net] : []),
        ])
        const blockerSummaries = [...mainResults, ...earlyResults, ...criticalResults]
          .reverse()
          .map((result) => result.jsonSummary)
        const ordinaryOpen = krtOrdinaryRecoveryScope(finalAudit.openNets, [...verifiedSpecialNets])
        const openRepairJobs: RepairJob[] = planKrtOrdinaryBatches(request, ordinaryOpen, true)
          .map((batch) => ({
            kind: "open",
            batch,
            blockerVictims: krtOpenRepairBlockerVictims(
              blockerSummaries,
              batch.nets,
              request.plan.netPolicies,
              {
                // Never dissolve verified differential/matched custody as an
                // ordinary repair. Unverified special copper remains editable.
                excludedNets: [...repairRipExclusions],
                copperNets: [...incumbentStats.keys()],
              },
            ),
          }))
        const terminalSpans = netTerminalSpansMm(request.board)
        const shortViaNets = request.plan.netPolicies.map((policy) => policy.net)
          .filter((net) => routeScope.has(net))
          .filter((net) => {
            const policy = policies.get(net)
            const stats = incumbentStats.get(net)
            return Boolean(
              policy
              && policy.viaPreference !== "auto"
              && !verifiedSpecialNets.has(net)
              && !openSet.has(net)
              && stats
              && stats.viaCount > 0
              && terminalSpans.get(net) !== undefined
              && terminalSpans.get(net)! <= KRT_SHORT_VIA_REPAIR_MAX_LENGTH_MM,
            )
          })
          .sort((left, right) => {
            const leftPolicy = policies.get(left)!
            const rightPolicy = policies.get(right)!
            const leftStats = incumbentStats.get(left)!
            const rightStats = incumbentStats.get(right)!
            return rightPolicy.viaPenalty - leftPolicy.viaPenalty
              || rightPolicy.priorityWeight - leftPolicy.priorityWeight
              || leftStats.trackLengthMm - rightStats.trackLengthMm
              || rightStats.viaCount - leftStats.viaCount
              || left.localeCompare(right)
          })
        const shortViaRepairJobs: RepairJob[] = shortViaNets.flatMap((targetNet) => {
          const [batch] = planKrtOrdinaryBatches(request, [targetNet], true)
          return batch ? [{ kind: "short-via" as const, batch, targetNet }] : []
        })
        const repairPriority = (job: RepairJob) => job.kind === "short-via"
          ? policies.get(job.targetNet)?.priorityWeight ?? job.batch.priorityWeight
          : job.batch.priorityWeight
        const allRepairJobs: RepairJob[] = [...openRepairJobs, ...shortViaRepairJobs]
          .sort((left, right) => compareKrtRepairOrder(
            {
              kind: left.kind,
              priorityWeight: repairPriority(left),
              clearanceMm: left.batch.clearanceMm,
              firstNet: left.batch.nets[0],
            },
            {
              kind: right.kind,
              priorityWeight: repairPriority(right),
              clearanceMm: right.batch.clearanceMm,
              firstNet: right.batch.nets[0],
            },
          ))
        const ordinaryElapsedMs = [...earlyResults, ...mainResults]
          .reduce((sum, result) => sum + result.elapsedMs, 0)
        const repairBudgetMs = Math.max(
          KRT_MIN_POST_MAIN_REPAIR_BUDGET_MS,
          ordinaryElapsedMs * KRT_POST_MAIN_REPAIR_BUDGET_RATIO,
        )
        const repairStartedAt = performance.now()
        const remainingRepairBudget = () => Math.max(
          0,
          repairBudgetMs - (performance.now() - repairStartedAt),
        )
        let repairElapsedMs = 0
        let skippedRepairJobs = 0
        let baselineDrc = routeScopeNets.length
          ? await auditKrtBoardDrc(
              current,
              routeScopeNets,
              { ...finalAuditSpec, timeoutMs: Math.max(1, remainingRepairBudget()) },
              join(root, "repair", "baseline-drc"),
            )
          : undefined
        if (baselineDrc) diagnostics.push(...convertDiagnostics(baselineDrc.diagnostics))
        const hardRepairDamage = new Set([
          "KRT_PROTECTED_COPPER_RIPPED",
          "KRT_RIP_VICTIM_INCOMPLETE",
        ])
        for (const [jobIndex, job] of allRepairJobs.entries()) {
          if (repairResults.length >= KRT_MAX_POST_MAIN_REPAIRS) break
          // Every native process, including the first, is bounded by the
          // measured post-main budget. Previously a hopeless first repair
          // could consume more time than the entire ordinary pass.
          const remainingRepairBudgetMs = remainingRepairBudget()
          if (remainingRepairBudgetMs < 1_000) break
          if (!baselineDrc || baselineDrc.failed) break
          const remainingAttemptSlots = Math.max(1, Math.min(
            KRT_MAX_POST_MAIN_REPAIRS - repairResults.length,
            allRepairJobs.length - jobIndex,
          ))
          // Preserve the strict global deadline without letting one hopeless
          // first open consume every later repair slot. Connectivity jobs keep
          // their ordering advantage; this only bounds one route subprocess.
          const routeAttemptBudgetMs = Math.max(
            1_000,
            remainingRepairBudgetMs / remainingAttemptSlots,
          )
          const liveStats = incumbentCopper ? copperStatsByNet(incumbentCopper) : new Map()
          const beforeTargetVias = job.kind === "short-via"
            ? liveStats.get(job.targetNet)?.viaCount
            : undefined
          const liveTargetLength = job.kind === "short-via"
            ? liveStats.get(job.targetNet)?.trackLengthMm
            : undefined
          const targetTerminalSpan = job.kind === "short-via"
            ? terminalSpans.get(job.targetNet)
            : undefined
          if (job.kind === "short-via" && (
            beforeTargetVias === undefined
            || beforeTargetVias === 0
            || liveTargetLength === undefined
            || targetTerminalSpan === undefined
            || targetTerminalSpan > KRT_SHORT_VIA_REPAIR_MAX_LENGTH_MM
            || finalAudit.openNets.includes(job.targetNet)
          )) {
            skippedRepairJobs += 1
            continue
          }
          const attemptNumber = repairResults.length + 1
          const beforeDrcViolations = baselineDrc.violationCount
          const tag = `06-repair-${String(attemptNumber).padStart(2, "0")}`
          const output = join(root, `${tag}-${job.kind}.kicad_pcb`)
          const blockerVictims = job.kind === "open" ? job.blockerVictims : []
          const temporarilyUnprotectedNets = job.kind === "short-via"
            ? protectedNets.has(job.targetNet) ? [job.targetNet] : []
            : blockerVictims.filter((net) => protectedNets.has(net))
          const spec = {
            ...await ordinarySpec(
              job.batch,
              tag,
              false,
              job.kind === "short-via",
              temporarilyUnprotectedNets,
              blockerVictims,
            ),
            timeoutMs: routeAttemptBudgetMs,
          }
          const beforeOpenNets = [...finalAudit.openNets]
          const artifactDir = join(root, "repair", `${String(attemptNumber).padStart(2, "0")}-${job.kind}-${job.batch.id}`)
          const result = await runKrtRemaining(current, output, spec, artifactDir)
          const outputExists = result.attempted && await exists(output)
          const connectivityBudgetMs = remainingRepairBudget()
          const canAuditConnectivity = outputExists && connectivityBudgetMs >= 1_000
          const candidateAudit = canAuditConnectivity
            ? await auditKrtBoardConnectivity(
                output,
                routeScopeNets,
                { ...finalAuditSpec, timeoutMs: connectivityBudgetMs },
                join(artifactDir, "connectivity"),
              )
            : {
                openNets: [...routeScopeNets], issueFingerprints: [] as string[], issueFingerprintsByNet: {}, componentCountByNet: {},
                elapsedMs: 0, diagnostics: [] as KrtDiagnostic[],
              }
          const drcBudgetMs = remainingRepairBudget()
          const canAuditDrc = outputExists && drcBudgetMs >= 1_000
          const candidateDrc = canAuditDrc
            ? await auditKrtBoardDrc(
                output,
                routeScopeNets,
                { ...finalAuditSpec, timeoutMs: drcBudgetMs },
                join(artifactDir, "drc"),
              )
            : undefined
          if (outputExists && (!canAuditConnectivity || !canAuditDrc)) diagnostics.push(diagnostic(
            "KRT_REPAIR_AUDIT_BUDGET_EXHAUSTED",
            "warning",
            "The targeted repair artifact was retained but rejected because the shared route-and-audit deadline expired before every safety gate completed.",
            {
              kind: job.kind,
              nets: job.batch.nets,
              blockerVictims,
              connectivityAudited: canAuditConnectivity,
              drcAudited: canAuditDrc,
              repairBudgetMs,
              elapsedMs: performance.now() - repairStartedAt,
            },
          ))
          let candidateCopper: RoutingCopper | undefined
          if (outputExists) {
            try {
              candidateCopper = (await readKrtBoard(prepared.inputBoard, output, request.board)).copper
            } catch (error) {
              diagnostics.push(diagnostic(
                "KRT_REPAIR_CANDIDATE_UNREADABLE",
                "warning",
                "A targeted repair artifact could not be parsed and was rejected.",
                {
                  kind: job.kind,
                  nets: job.batch.nets,
                  error: error instanceof Error ? error.message : String(error),
                },
              ))
            }
          }
          const afterTargetVias = job.kind === "short-via" && candidateCopper
            ? copperStatsByNet(candidateCopper).get(job.targetNet)?.viaCount ?? 0
            : undefined
          const afterTargetLength = job.kind === "short-via" && candidateCopper
            ? copperStatsByNet(candidateCopper).get(job.targetNet)?.trackLengthMm ?? 0
            : undefined
          const beforeOpen = new Set(finalAudit.openNets)
          const connectivityNonRegressing = !candidateAudit.diagnostics.some((item) => item.severity === "error")
            && candidateAudit.openNets.every((net) => beforeOpen.has(net))
            && connectivityComponentsNonRegressing(
              candidateAudit,
              finalAudit,
            )
          const drcNonRegressing = Boolean(candidateDrc
            && !candidateDrc.failed
            && candidateDrc.violationCount <= baselineDrc.violationCount
            && fingerprintMultisetIsSubset(candidateDrc.fingerprints, baselineDrc.fingerprints)
            && fingerprintMultisetIsSubset(candidateDrc.shortFingerprints, baselineDrc.shortFingerprints))
          const electricallyImproved = Boolean(candidateDrc
            && (candidateAudit.openNets.length < beforeOpen.size
              || connectivityComponentsImproved(candidateAudit, finalAudit)
              || candidateDrc.violationCount < baselineDrc.violationCount))
          const viaImproved = job.kind === "short-via"
            && beforeTargetVias !== undefined
            && afterTargetVias !== undefined
            && afterTargetVias < beforeTargetVias
          const detourBounded = job.kind !== "short-via" || Boolean(
            liveTargetLength !== undefined
            && targetTerminalSpan !== undefined
            && afterTargetLength !== undefined
            && afterTargetLength <= Math.min(
              liveTargetLength * KRT_SHORT_VIA_REPAIR_MAX_DETOUR_RATIO + KRT_SHORT_VIA_REPAIR_LENGTH_SLACK_MM,
              targetTerminalSpan * KRT_SHORT_VIA_REPAIR_MAX_DETOUR_RATIO + KRT_SHORT_VIA_REPAIR_LENGTH_SLACK_MM,
            ) + 1e-9,
          )
          const strictlyImproved = job.kind === "open" ? electricallyImproved : viaImproved
          const protectedDamage = result.diagnostics.some((item) => (
            item.severity === "error" && hardRepairDamage.has(item.code)
          ))
          const candidateAccepted = Boolean(
            outputExists
            && candidateCopper
            && connectivityNonRegressing
            && drcNonRegressing
            && strictlyImproved
            && detourBounded
            && !protectedDamage,
          )
          let protectionRestored = true
          if (candidateAccepted && temporarilyUnprotectedNets.length) {
            try {
              await persistKrtProtectedNets(
                output,
                temporarilyUnprotectedNets,
                job.kind === "short-via" ? "workflow-critical-via-repair" : "workflow-open-repair-victim",
              )
            } catch (error) {
              protectionRestored = false
              diagnostics.push(diagnostic(
                "KRT_REPAIR_PROTECTION_RESTORE_FAILED",
                "warning",
                "The improved repair candidate was rejected because its temporarily relaxed protection ledger could not be restored.",
                {
                  nets: temporarilyUnprotectedNets,
                  error: error instanceof Error ? error.message : String(error),
                },
              ))
            }
          }
          const accepted = candidateAccepted && protectionRestored
          const stageDiagnostics = [
            ...convertDiagnostics(result.diagnostics),
            ...convertDiagnostics(candidateAudit.diagnostics),
            ...convertDiagnostics(candidateDrc?.diagnostics ?? []),
          ]
          diagnostics.push(...(accepted ? stageDiagnostics : stageDiagnostics.map((item) => (
            item.severity === "error" ? { ...item, severity: "warning" as const } : item
          ))))
          if (accepted) {
            current = output
            fallbackCurrentBoard = current
            incumbentCopper = candidateCopper
            finalAudit = candidateAudit
            fallbackOpenNets = finalAudit.openNets
            const repairedEvidence = connectivityEvidence(finalAudit)
            if (repairedEvidence) fallbackCheckpointConnectivityEvidence = repairedEvidence
            baselineDrc = candidateDrc
          } else diagnostics.push(diagnostic(
            "KRT_REPAIR_CANDIDATE_REJECTED",
            "warning",
            "A targeted repair candidate was retained as an artifact but not applied because it did not improve its target or regressed a full-board safety gate.",
            {
              kind: job.kind,
              nets: job.batch.nets,
              targetNet: job.kind === "short-via" ? job.targetNet : undefined,
              blockerVictims,
              beforeOpenNets,
              afterOpenNets: candidateAudit.openNets,
              beforeDrcViolations,
              afterDrcViolations: candidateDrc?.violationCount,
              beforeTargetVias,
              afterTargetVias,
              beforeTargetLength: liveTargetLength,
              afterTargetLength,
              targetTerminalSpan,
              detourBounded,
              protectedDamage,
              protectionRestored,
              strictlyImproved,
            },
          ))
          repairElapsedMs = performance.now() - repairStartedAt
          repairResults.push({
            kind: job.kind,
            ...(job.kind === "short-via" ? { targetNet: job.targetNet } : {}),
            ...(blockerVictims.length ? { blockerVictims } : {}),
            result,
            accepted,
            beforeOpenNets,
            afterOpenNets: candidateAudit.openNets,
            beforeDrcViolations,
            afterDrcViolations: candidateDrc?.violationCount,
            beforeTargetVias,
            afterTargetVias,
          })
        }
        repairElapsedMs = performance.now() - repairStartedAt
        const deferredRepairJobs = Math.max(0, allRepairJobs.length - repairResults.length - skippedRepairJobs)
        if (deferredRepairJobs) diagnostics.push(diagnostic(
          "KRT_REPAIR_BUDGET_EXHAUSTED",
          "info",
          `Stopped targeted repair after ${repairResults.length} attempt(s) within the bounded post-main budget.`,
          {
            maxAttempts: KRT_MAX_POST_MAIN_REPAIRS,
            repairBudgetMs,
            repairElapsedMs,
            deferredJobCount: deferredRepairJobs,
            openRepairJobCount: openRepairJobs.length,
            shortViaRepairJobCount: shortViaRepairJobs.length,
          },
        ))
        if (baselineDrc && !baselineDrc.failed && baselineDrc.violationCount > 0) diagnostics.push(diagnostic(
          "KRT_FINAL_DRC_VIOLATIONS",
          "error",
          `The last promoted KRT checkpoint contains ${baselineDrc.violationCount} native DRC violation(s); it remains applicable only as a partial result.`,
          {
            violationCount: baselineDrc.violationCount,
            byType: baselineDrc.byType,
            contactsByType: baselineDrc.contactsByType,
          },
        ))
        const routed = await readKrtBoard(prepared.inputBoard, current, request.board)
        const ruleDiagnostics = krtRoutedCopperRuleDiagnostics(request, routed.copper)
        diagnostics.push(...ruleDiagnostics)
        const stageResults = [...specialResults, ...criticalResults, ...earlyResults, ...mainResults]
        const openNets = new Set(finalAudit.openNets)
        const finalConnectivityEvidence = connectivityEvidence(finalAudit)
        const status = krtNativeAutoResultStatus({
          constraintsDeferred: specialConstraintsDeferred
            || deferredSpecialNets.length > 0
            || ordinaryFallbackSpecialNets.size > 0,
          processFailed: stageResults.some(processFailed),
          diagnosticsHaveErrors: diagnostics.some((item) => item.severity === "error"),
          openNetCount: openNets.size,
          connectivityAudited: Boolean(finalConnectivityEvidence),
        })
        return {
          status,
          copper: routed.copper,
          diagnostics,
          metrics: {
            elapsedMs: performance.now() - startedAt,
            routedNetCount: Math.max(0, routeScope.size - openNets.size),
            openNetCount: openNets.size,
            openNets: [...openNets].sort(),
            ...(finalConnectivityEvidence
              ? { connectivityComponentCount: finalConnectivityEvidence.connectivityComponentCount }
              : {}),
            viaCount: routed.copper.vias.length,
            trackLengthMm: trackLengthMm(routed.copper),
            backend: "krt",
            details: {
              artifactsDirectory: root,
              runtime: {
                version: managed.version,
                source: managed.source,
                cacheDirectory: managed.cacheDirectory,
              },
              policy: "native-auto",
              initialConnectivity: initialConnectivityEvidence ?? { auditFailed: true },
              finalConnectivity: finalConnectivityEvidence ?? { auditFailed: true },
              protectedNets: [...protectedNets].sort(),
              // Preserve the historical single-special summary shape while
              // exposing every compatibility batch explicitly.
              special: specialResults.length <= 1
                ? specialResults[0]?.jsonSummary
                : specialResults.map((result) => result.jsonSummary),
              specialBatches: specialResults.map((result) => result.jsonSummary),
              specialConstraintsDeferred,
              deferredSpecialNets,
              verifiedSpecialNets: [...verifiedSpecialNets].sort(),
              ordinaryFallbackSpecialNets: [...ordinaryFallbackSpecialNets].sort(),
              rejectedSpecialNets: [...rejectedSpecialNets].sort(),
              critical: criticalResults.map((result) => result.jsonSummary),
              early: earlyResults.map((result) => result.jsonSummary),
              main: mainResults.map((result) => result.jsonSummary),
              repairs: repairResults.map((attempt) => ({
                kind: attempt.kind,
                targetNet: attempt.targetNet,
                blockerVictims: attempt.blockerVictims,
                accepted: attempt.accepted,
                status: attempt.result.status,
                elapsedMs: attempt.result.elapsedMs,
                beforeOpenNets: attempt.beforeOpenNets,
                afterOpenNets: attempt.afterOpenNets,
                beforeDrcViolations: attempt.beforeDrcViolations,
                afterDrcViolations: attempt.afterDrcViolations,
                beforeTargetVias: attempt.beforeTargetVias,
                afterTargetVias: attempt.afterTargetVias,
                summary: attempt.result.jsonSummary,
              })),
              repairBudgetMs,
              repairElapsedMs,
              ordinaryRouteBatchCount,
              ordinaryRouteBatchLimit: KRT_MAX_ORDINARY_ROUTE_BATCHES,
              finalConnectivityAuditMs: finalAudit.elapsedMs,
              finalDrc: baselineDrc && !baselineDrc.failed ? {
                drcViolationCount: baselineDrc.violationCount,
                shortViolationCount: baselineDrc.shortFingerprints.length,
                byType: baselineDrc.byType,
                contactsByType: baselineDrc.contactsByType,
                fingerprintCount: baselineDrc.fingerprints.length,
                fingerprintSamples: baselineDrc.fingerprints.slice(0, 64),
                shortFingerprintSamples: baselineDrc.shortFingerprints.slice(0, 64),
              } : { auditFailed: true },
              stageGateElapsedMs,
              fanout: fanoutResults.map((result) => ({
                status: result.status,
                elapsedMs: result.elapsedMs,
                summary: result.jsonSummary,
              })),
            },
          },
        }
      } catch (error) {
        if (fallbackPrepared && fallbackCurrentBoard) {
          try {
            const fallback = await readKrtBoard(
              fallbackPrepared.inputBoard,
              fallbackCurrentBoard,
              request.board,
            )
            const recoveredConnectivity = krtRecoveredConnectivityFields(
              fallbackInitialConnectivityEvidence,
              fallbackCheckpointConnectivityEvidence,
            )
            return {
              status: "partial",
              copper: fallback.copper,
              diagnostics: [...diagnostics, diagnostic(
                "KRT_BACKEND_FAILED_AFTER_CHECKPOINT", "error",
                "KRT stopped after producing a readable checkpoint; the last promoted partial board was retained.",
                { error: error instanceof Error ? error.message : String(error), board: fallbackCurrentBoard },
              )],
              metrics: {
                elapsedMs: performance.now() - startedAt,
                routedNetCount: Math.max(0, fallbackRouteScopeNets.length - fallbackOpenNets.length),
                openNetCount: fallbackOpenNets.length,
                openNets: [...fallbackOpenNets],
                ...recoveredConnectivity.metrics,
                viaCount: fallback.copper.vias.length,
                trackLengthMm: trackLengthMm(fallback.copper),
                backend: "krt",
                details: {
                  artifactsDirectory: root,
                  policy: "native-auto",
                  recoveredCheckpoint: fallbackCurrentBoard,
                  ...recoveredConnectivity.details,
                },
              },
            }
          } catch {
            // Fall through to a terminal backend error only when even the last
            // promoted checkpoint cannot be parsed.
          }
        }
        return {
          status: "error", copper: EMPTY_COPPER,
          diagnostics: [...diagnostics, diagnostic(
            "KRT_BACKEND_FAILED", "error",
            error instanceof Error ? error.message : String(error),
          )],
        }
      } finally {
        if (ownedTemporary && !options.keepArtifacts) await rm(root, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
  return adapter
}
