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
import type { FanoutIntent } from "../intent/types.js"
import {
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

export {
  KRT_REQUIRED_NECKDOWN_ENVIRONMENT,
  KRT_RIPUP_ABANDON_METRIC_CHOICES,
  KRT_RIPUP_BLOCKER_SELECT_CHOICES,
  type KrtRipupAbandonMetric,
  type KrtRipupBlockerSelect,
} from "./krt-adapter.js"

export {
  KRT_MANAGED_VERSION,
  krtManagedRelease,
  prepareKrtRuntime,
  readKrtLicense,
  type KrtRuntimeOptions,
  type PreparedKrtRuntime,
} from "./krt-runtime.js"

export type KrtBoardTransportResult = Readonly<{
  inputBoard: string
  diagnostics?: readonly RoutingDiagnostic[]
}>

export type KrtBoardReadResult = Readonly<{
  copper: RoutingCopper
  diagnostics?: readonly RoutingDiagnostic[]
}>

/**
 * KRT itself consumes KiCad files. The EDA host owns this narrow transport,
 * while KRT stage selection, rule compilation and process custody stay here.
 */
export interface KrtBoardTransport {
  prepare(request: BackendRouteRequest, directory: string): Promise<KrtBoardTransportResult>
  read(
    request: BackendRouteRequest,
    preparedBoard: string,
    routedBoard: string,
  ): Promise<KrtBoardReadResult>
}

export type KrtBackendOptions = Readonly<{
  transport: KrtBoardTransport
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

function orderedScopeNets(request: BackendRouteRequest) {
  const boardNets = request.board.nets.map((item) => item.name)
  if (!request.program.onlyNets) return boardNets
  const known = new Set(boardNets)
  return request.program.onlyNets.filter((net) => known.has(net))
}

function routableScopeNets(request: BackendRouteRequest) {
  return orderedScopeNets(request).filter((net) => (
    net.toUpperCase() !== "GND"
    && !request.program.ignoreNets.includes(net)
    && request.board.pads.filter((pad) => pad.net === net).length >= 2
  ))
}

type KrtInternalRouteRequest = BackendRouteRequest & Readonly<{
  /** Full original scope used only by the first automatic component fanout pass. */
  krtAutomaticFanoutNets?: readonly string[]
  /** A preceding KRT stage already performed component-wide fanout. */
  krtSkipAutomaticFanout?: boolean
}>

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
  const constrained = nets
    .map((net) => ruleFor(request, net).allowedLayers)
    .find((layers): layers is readonly string[] => Boolean(layers?.length))
  if (!constrained) return request.board.layers.map((item) => item.name)
  const allowed = new Set(constrained)
  // Unconstrained nets in this call inherit the one explicit safe subset. This
  // may reduce routability, but it can never violate another net's layer rule.
  return request.board.layers.map((item) => item.name).filter((layer) => allowed.has(layer))
}

function sameNumber(values: readonly number[], epsilon = 1e-9) {
  return !values.length || values.every((value) => Math.abs(value - values[0]) <= epsilon)
}

function specialRules(request: BackendRouteRequest, gridStep = 0.05): { rules?: KrtNumericRules; diagnostics: RoutingDiagnostic[] } {
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
  const meander = request.policy?.meander
  if (meander?.spacingMm !== undefined && meander.spacingMm + 1e-9 < trackWidth + clearances[0]) diagnostics.push(diagnostic(
    "KRT_MEANDER_SPACING_BELOW_CLEARANCE",
    "error",
    "Meander spacingMm is centre-to-centre spacing and must include one routed width plus clearance.",
    { spacingMm: meander.spacingMm, minimumMm: trackWidth + clearances[0], trackWidth, clearance: clearances[0] },
  ))
  return {
    diagnostics,
    rules: {
      trackWidth,
      hardTrackWidth: Math.max(
        HARD_MIN_TRACK_WIDTH_MM,
        Math.min(...values.map((item) => item.minTrackWidthMm)),
      ),
      clearance: clearances[0],
      viaSize: viaSizes[0],
      viaDrill: viaDrills[0],
      diffPairGap: gaps[0] ?? clearances[0],
      gridStep,
      holeToHoleClearance: Math.max(...values.map((item) => item.holeToHoleClearanceMm ?? item.clearanceMm)),
      ...(tolerance === undefined ? {} : { lengthMatchTolerance: tolerance }),
      ...(meander?.amplitudeMm === undefined ? {} : { meanderAmplitude: meander.amplitudeMm }),
      ...(meander?.spacingMm === undefined ? {} : { meanderSpacing: meander.spacingMm / trackWidth }),
    },
  }
}

function minimumRules(values: readonly RoutingRuleValues[], gridStep = 0.05): KrtNumericRules {
  const source = values.length ? values : []
  const hardTrackWidth = Math.max(HARD_MIN_TRACK_WIDTH_MM, Math.min(...source.map((item) => item.minTrackWidthMm)))
  return {
    trackWidth: hardTrackWidth,
    hardTrackWidth,
    clearance: Math.min(...source.map((item) => item.clearanceMm)),
    // route.py accepts one global via geometry. Use the strictest minima so a
    // permissive class cannot make another class fail native DRC.
    viaSize: Math.max(...source.map((item) => item.via.minDiameterMm)),
    viaDrill: Math.max(...source.map((item) => item.via.minDrillMm)),
    gridStep,
    holeToHoleClearance: Math.max(...source.map((item) => item.holeToHoleClearanceMm ?? item.clearanceMm)),
    boardEdgeClearance: Math.max(...source.map((item) => item.edgeClearanceMm)),
  }
}

function routedCopperRuleDiagnostics(request: BackendRouteRequest, copper: RoutingCopper) {
  const narrowTracks = copper.tracks.flatMap((track) => {
    const minimum = Math.max(HARD_MIN_TRACK_WIDTH_MM, ruleFor(request, track.net).minTrackWidthMm)
    return track.widthMm + 1e-9 < minimum
      ? [{ net: track.net, layer: track.layer, actualMm: track.widthMm, minimumMm: minimum }]
      : []
  })
  const undersizedVias = copper.vias.flatMap((via) => {
    const rules = ruleFor(request, via.net).via
    return via.diameterMm + 1e-9 < rules.minDiameterMm || via.drillMm + 1e-9 < rules.minDrillMm
      ? [{
        net: via.net,
        actualDiameterMm: via.diameterMm,
        actualDrillMm: via.drillMm,
        minimumDiameterMm: rules.minDiameterMm,
        minimumDrillMm: rules.minDrillMm,
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
    `KRT produced ${narrowTracks.length} track segment(s) below the compiled hard minimum; the routed delta was rejected.`,
    { hardMinimumMm: HARD_MIN_TRACK_WIDTH_MM, samples: narrowTracks.slice(0, 16) },
  ))
  if (undersizedVias.length) diagnostics.push(diagnostic(
    "KRT_VIA_BELOW_HARD_MINIMUM",
    "error",
    `KRT produced ${undersizedVias.length} via(s) below the compiled hard minimum; the routed delta was rejected.`,
    { samples: undersizedVias.slice(0, 16) },
  ))
  if (forbiddenLayers.length) diagnostics.push(diagnostic(
    "KRT_TRACK_ON_FORBIDDEN_LAYER",
    "error",
    `KRT produced ${forbiddenLayers.length} track segment(s) outside their compiled allowedLayers; the routed delta was rejected.`,
    { samples: forbiddenLayers.slice(0, 16) },
  ))
  return diagnostics
}

async function writeFabOverrides(path: string, values: KrtNumericRules) {
  const annular = Math.max((values.viaSize - values.viaDrill) / 2, 0.001)
  const hardTrackWidth = Math.max(values.hardTrackWidth ?? values.trackWidth, HARD_MIN_TRACK_WIDTH_MM)
  const hole = Math.max(values.holeToHoleClearance ?? values.clearance, 0.001)
  await writeFile(path, [
    `track_width = ${hardTrackWidth}`,
    `clearance = ${values.clearance}`,
    `via_diameter = ${values.viaSize}`,
    `via_drill = ${values.viaDrill}`,
    `hole_to_hole = ${hole}`,
    `pad_hole_to_hole = ${hole}`,
    `annular = ${annular}`,
    `board_edge = ${Math.max(values.boardEdgeClearance ?? values.clearance, 0.001)}`,
    "",
  ].join("\n"))
}

export const KRT_QUALITY_PROFILES = Object.freeze({
  fast: Object.freeze({
    gridStep: 0.1,
    maxIterations: 120_000,
    maxProbeIterations: 5_000,
    maxRipup: 2,
    heuristicWeight: 2,
    viaCost: 50,
    viaProximityCost: 10,
    turnCost: 1_000,
    directionPreferenceCost: 250,
    dynamicIterations: false,
    ripupBlockerSelect: "cost" as const,
    ripupAbandonMetric: "stranded" as const,
    neckdownLength: 0.5,
    neckdownTaperLength: 0.5,
  }),
  balanced: Object.freeze({
    gridStep: 0.1,
    maxIterations: 300_000,
    maxProbeIterations: 5_000,
    maxRipup: 4,
    heuristicWeight: 1.8,
    viaCost: 50,
    viaProximityCost: 10,
    turnCost: 1_000,
    directionPreferenceCost: 250,
    dynamicIterations: false,
    ripupBlockerSelect: "cost" as const,
    ripupAbandonMetric: "complete-nets" as const,
    neckdownLength: 0.5,
    neckdownTaperLength: 0.5,
  }),
  "quality-first": Object.freeze({
    gridStep: 0.05,
    maxIterations: 600_000,
    maxProbeIterations: 10_000,
    maxRipup: 5,
    heuristicWeight: 1.3,
    viaCost: 80,
    viaProximityCost: 16,
    turnCost: 1_500,
    directionPreferenceCost: 400,
    dynamicIterations: false,
    ripupBlockerSelect: "cost" as const,
    ripupAbandonMetric: "complete-nets" as const,
    neckdownLength: 0.5,
    neckdownTaperLength: 0.5,
  }),
  "completion-first": Object.freeze({
    gridStep: 0.05,
    maxIterations: 750_000,
    maxProbeIterations: 10_000,
    maxRipup: 5,
    heuristicWeight: 1.9,
    viaCost: 10,
    viaProximityCost: 0,
    turnCost: 250,
    directionPreferenceCost: 0,
    dynamicIterations: true,
    ripupBlockerSelect: "mincut" as const,
    ripupAbandonMetric: "weighted-probe" as const,
    neckdownLength: 0.5,
    neckdownTaperLength: 0.5,
  }),
} as const)

function routeQuality(request: BackendRouteRequest) {
  switch (request.policy?.profile) {
    case "fast": return KRT_QUALITY_PROFILES.fast
    case "quality-first": return KRT_QUALITY_PROFILES["quality-first"]
    case "completion-first": return KRT_QUALITY_PROFILES["completion-first"]
    default: return KRT_QUALITY_PROFILES.balanced
  }
}

const KRT_FINE_PITCH_NEIGHBOR_DISTANCE_MM = 0.65
const KRT_FINE_PITCH_MIN_PAD_DIMENSION_MM = 0.35

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

function padAspectRatio(pad: BackendRouteRequest["board"]["pads"][number]) {
  switch (pad.shape.kind) {
    case "circle": return 1
    case "rect":
    case "round-rect":
    case "oval": return Math.max(pad.shape.widthMm, pad.shape.heightMm)
      / Math.max(Math.min(pad.shape.widthMm, pad.shape.heightMm), 1e-9)
    case "polygon": {
      const points = pad.shape.polygon.outer
      if (!points.length) return 1
      const xs = points.map((point) => point.x)
      const ys = points.map((point) => point.y)
      const width = Math.max(...xs) - Math.min(...xs)
      const height = Math.max(...ys) - Math.min(...ys)
      return Math.max(width, height) / Math.max(Math.min(width, height), 1e-9)
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

function componentLocalPoint(
  component: BackendRouteRequest["board"]["components"][number],
  point: Readonly<{ x: number; y: number }>,
) {
  const angle = -component.rotationDeg * Math.PI / 180
  const dx = point.x - component.at.x
  const dy = point.y - component.at.y
  return {
    x: dx * Math.cos(angle) - dy * Math.sin(angle),
    y: dx * Math.sin(angle) + dy * Math.cos(angle),
  }
}

function isDensePerimeterPackage(
  component: BackendRouteRequest["board"]["components"][number],
  pads: readonly BackendRouteRequest["board"]["pads"][number][],
) {
  if (pads.length < 8) return false
  const local = pads.map((pad) => componentLocalPoint(component, pad.at))
  const xs = local.map((point) => point.x)
  const ys = local.map((point) => point.y)
  const minX = Math.min(...xs); const maxX = Math.max(...xs)
  const minY = Math.min(...ys); const maxY = Math.max(...ys)
  const spanX = maxX - minX; const spanY = maxY - minY
  if (spanX <= 1e-6 || spanY <= 1e-6) return false
  const tolerance = Math.max(0.15, Math.min(spanX, spanY) * 0.12)
  const sides = new Set<string>()
  let perimeter = 0
  for (const point of local) {
    const on = [
      ["left", point.x - minX], ["right", maxX - point.x],
      ["top", point.y - minY], ["bottom", maxY - point.y],
    ] as const
    const close = on.filter(([, distance]) => distance <= tolerance + 1e-9)
    if (close.length) perimeter += 1
    for (const [side] of close) sides.add(side)
  }
  const finePitch = pads.some((pad) => padMinimumDimensionMm(pad) + 1e-9 < KRT_FINE_PITCH_MIN_PAD_DIMENSION_MM)
    || pads.some((pad, index) => pads.slice(index + 1).some((other) => (
      Math.hypot(other.at.x - pad.at.x, other.at.y - pad.at.y)
        <= KRT_FINE_PITCH_NEIGHBOR_DISTANCE_MM + 0.001
    )))
  const elongated = pads.filter((pad) => padAspectRatio(pad) >= 1.2).length
  return finePitch && sides.size >= 3 && perimeter / pads.length >= 0.8 && elongated / pads.length >= 0.5
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
  const scope = new Set(routeNets.filter((net) => net.toUpperCase() !== "GND"))
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
  for (const intent of request.program.fanouts ?? []) {
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
    const dense = isDensePerimeterPackage(component, packagePads)
    const componentPolicy = componentPolicies.get(component.designator)
    const explicitlyTargetedPads = packagePads.some((pad) => padPolicies.has(`${pad.component}\u0000${pad.number}`))
    if (!dense && !componentPolicy && !explicitlyTargetedPads) continue
    const eligible = packagePads.filter((pad) => (
      pad.net
      && scope.has(pad.net)
      && (logicalPadCounts.get(pad.net) ?? 0) >= 2
      && !excludedPads.has(`${pad.component}\u0000${pad.number}`)
      && (dense || Boolean(componentPolicy) || padPolicies.has(`${pad.component}\u0000${pad.number}`))
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
      layer: mountedLayer,
      rules: group.rules,
      method: group.method,
      extensionMm: group.extensionMm,
    })
  }
  return output
}

/**
 * Keep the common fast/balanced case on KRT's general-purpose 0.1 mm grid,
 * but do not quantize away a dense-pad escape. These thresholds deliberately
 * match KRT's own fine-tap detector. The universal 0.127 mm neck-down floor is
 * not itself a fine-grid trigger: large power pads still use the faster grid.
 */
export function selectKrtGridStep(
  request: BackendRouteRequest,
  requestedGridStep: number,
  routeNets: readonly string[] = orderedScopeNets(request),
) {
  if (requestedGridStep <= 0.05 + 1e-9) return requestedGridStep
  const scope = new Set(routeNets.filter((net) => (
    net.toUpperCase() !== "GND" && !request.program.ignoreNets.includes(net)
  )))
  const fineNominalFeature = [...scope].some((net) => {
    const values = ruleFor(request, net)
    return [
      values.preferredTrackWidthMm,
      ...(values.differential ? [values.differential.trackWidthMm, values.differential.gapMm] : []),
    ].some((value) => value + 1e-9 < requestedGridStep * 2)
  })
  const terminals = request.board.pads.filter((pad) => pad.net && scope.has(pad.net))
  const finePad = terminals.some((pad) => (
    padMinimumDimensionMm(pad) + 1e-9 < KRT_FINE_PITCH_MIN_PAD_DIMENSION_MM
  ))
  const padsByComponent = new Map<string, typeof request.board.pads>()
  for (const pad of request.board.pads) {
    const current = padsByComponent.get(pad.component) ?? []
    padsByComponent.set(pad.component, [...current, pad])
  }
  const closeNeighbor = terminals.some((pad) => (
    (padsByComponent.get(pad.component) ?? []).some((other) => (
      other !== pad
      && other.number !== pad.number
      && Math.hypot(other.at.x - pad.at.x, other.at.y - pad.at.y) > 1e-9
      && Math.hypot(other.at.x - pad.at.x, other.at.y - pad.at.y)
        <= KRT_FINE_PITCH_NEIGHBOR_DISTANCE_MM + 0.001
    ))
  ))
  return fineNominalFeature || finePad || closeNeighbor
    ? Math.min(requestedGridStep, 0.05)
    : requestedGridStep
}

function recordArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : []
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function summaryOpenNets(summary: Record<string, unknown> | undefined) {
  const output = new Set<string>()
  if (!summary) return output
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

function processFailed(result: KrtProcessResult) {
  return result.status !== "completed" || result.diagnostics.some((item) => item.severity === "error")
}

export function createKrtBackend(options: KrtBackendOptions): RouterBackendAdapter {
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
      diagnostics.push(...specialRules(request).diagnostics)
      const specialNets = [
        ...request.program.differentialPairs.flatMap((pair) => [pair.positive, pair.negative]),
        ...request.program.matchedGroups.flatMap((group) => group.nets),
      ]
      const special = new Set(specialNets)
      const remaining = orderedScopeNets(request).filter((net) => (
        net.toUpperCase() !== "GND"
        && !special.has(net)
        && !request.program.ignoreNets.includes(net)
        && request.board.pads.filter((pad) => pad.net === net).length >= 2
      ))
      diagnostics.push(...routeLayerDiagnostics(request, specialNets))
      diagnostics.push(...routeLayerDiagnostics(request, remaining))
      return diagnostics
    },
    async route(request): Promise<BackendRouteResult> {
      const diagnostics: RoutingDiagnostic[] = []
      let managed: PreparedKrtRuntime
      try {
        managed = await runtime(request.signal)
      } catch (error) {
        return { status: "error", copper: EMPTY_COPPER, diagnostics: [runtimeDiagnostic(error)] }
      }
      const krtDirectory = managed.directory
      const specialStage = request.program.differentialPairs.length > 0
        || request.program.matchedGroups.length > 0
        || request.program.viaFences.length > 0
      const root = options.artifactsDirectory
        ? join(resolve(options.artifactsDirectory), request.policy?.profile ?? "default", specialStage ? "special" : "remaining")
        : await mkdtemp(join(tmpdir(), "copilot-router-krt-"))
      const ownedTemporary = !options.artifactsDirectory
      await mkdir(root, { recursive: true })
      const startedAt = performance.now()
      try {
        const prepared = await options.transport.prepare(request, root)
        diagnostics.push(...(prepared.diagnostics ?? []))
        if (diagnostics.some((item) => item.severity === "error")) return {
          status: "error", copper: EMPTY_COPPER, diagnostics,
        }
        const quality = routeQuality(request)
        const { gridStep: requestedGridStep, ...stageQuality } = quality
        const allSpecial = new Set([
          ...request.program.differentialPairs.flatMap((pair) => [pair.positive, pair.negative]),
          ...request.program.matchedGroups.flatMap((group) => group.nets),
        ])
        const routeScopeNets = routableScopeNets(request)
        const remainingNets = routeScopeNets.filter((net) => !allSpecial.has(net))
        const specialGridStep = selectKrtGridStep(request, requestedGridStep, [...allSpecial])
        const remainingGridStep = selectKrtGridStep(request, requestedGridStep, remainingNets)
        const special = specialRules(request, specialGridStep)
        diagnostics.push(...special.diagnostics)
        if (special.diagnostics.some((item) => item.severity === "error")) return {
          status: "error", copper: EMPTY_COPPER, diagnostics,
        }
        const remainingValues = remainingNets.map((net) => ruleFor(request, net))
        const remainingRules = minimumRules(
          remainingValues.length ? remainingValues : [request.rules.default],
          remainingGridStep,
        )
        const specialFab = join(root, "special-fab.txt")
        const remainingFab = join(root, "remaining-fab.txt")
        if (special.rules) await writeFabOverrides(specialFab, special.rules)
        await writeFabOverrides(remainingFab, remainingRules)
        const common: Omit<KrtStageSpec, "rules" | "fabOverridesPath"> = {
          pythonPath: managed.pythonPath,
          pythonPathEntries: managed.pythonPathEntries,
          krtDirectory,
          layers: request.board.layers.map((item) => item.name),
          diffPairs: request.program.differentialPairs.map((pair) => [pair.positive, pair.negative] as const),
          matchedGroups: request.program.matchedGroups.map((group) => group.nets),
          remainingNets,
          matchDifferentialPairLengths: request.program.differentialPairs.some((pair) => (
            ruleFor(request, pair.positive).differential?.maxSkewMm !== undefined
            || ruleFor(request, pair.negative).differential?.maxSkewMm !== undefined
          )),
          // A viaFence is generated only after its source routing succeeds, so
          // a planned fence cannot safely replace KRT's native return vias.
          suppressGroundReturnVias: false,
          // onlyNets controls scope, never priority. All KRT subprocesses use
          // the same MPS ordering without direct-first resorting.
          ordering: "mps",
          preserveNetOrder: true,
          // A dense pad escape may need the fixed 0.127 mm hard floor even
          // when the ordinary preferred width cannot leave the footprint.
          // This is a completion mechanism, never a reason to weaken via or
          // clearance rules.
          enableTerminalEscalation: true,
          ...stageQuality,
          collectStats: false,
          debugMemory: false,
          exactFilledZoneObstacles: true,
          signal: request.signal,
        }
        let current = prepared.inputBoard
        const fanoutResults: KrtProcessResult[] = []
        const internalRequest = request as KrtInternalRouteRequest
        const fanoutNets = internalRequest.krtAutomaticFanoutNets ?? routeScopeNets
        const fanoutGridStep = selectKrtGridStep(request, requestedGridStep, fanoutNets)
        const fanoutPlans = internalRequest.krtSkipAutomaticFanout
          ? []
          : planKrtQfnFanout(request, fanoutNets, fanoutGridStep)
        if (fanoutPlans.length) diagnostics.push(diagnostic(
          "KRT_AUTOMATIC_FANOUT_PLANNED",
          "info",
          `KRT will attempt ${fanoutPlans.length} automatic QFN/QFP fanout batch(es) before maze routing.`,
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
            if (accepted) current = output
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
        let specialResult: KrtProcessResult | undefined
        if (allSpecial.size && special.rules) {
          const output = join(root, "02-special.kicad_pcb")
          specialResult = await runKrtSpecial(current, output, {
            ...common,
            layers: routeLayersFor(request, [...allSpecial]),
            rules: special.rules,
            fabOverridesPath: specialFab,
            ordinaryMatchedRules: special.rules,
            ordinaryMatchedFabOverridesPath: specialFab,
          }, join(root, "special"))
          diagnostics.push(...convertDiagnostics(specialResult.diagnostics))
          // KRT may leave a useful, parseable partial board even when its
          // summary or a semantic audit reports an error. Preserve that
          // candidate; final validation, not transport status, decides its
          // electrical quality.
          if (specialResult.attempted && await exists(output)) current = output
        }
        let remainingResult: KrtProcessResult | undefined
        if (remainingNets.length) {
          const output = join(root, "03-remaining.kicad_pcb")
          const preferredWidthNets = new Set([
            ...request.program.powerNets.map((intent) => intent.net),
            ...request.program.signalNets.filter((intent) => intent.impedance).map((intent) => intent.net),
          ])
          remainingResult = await runKrtRemaining(current, output, {
            ...common,
            layers: routeLayersFor(request, remainingNets),
            rules: remainingRules,
            fabOverridesPath: remainingFab,
            powerNets: remainingNets.filter((net) => preferredWidthNets.has(net)).map((net) => ({
              net,
              width: ruleFor(request, net).preferredTrackWidthMm,
            })),
          }, join(root, "remaining"))
          diagnostics.push(...convertDiagnostics(remainingResult.diagnostics))
          if (remainingResult.attempted && await exists(output)) current = output
        }
        const routed = await options.transport.read(request, prepared.inputBoard, current)
        diagnostics.push(...(routed.diagnostics ?? []))
        const ruleDiagnostics = routedCopperRuleDiagnostics(request, routed.copper)
        diagnostics.push(...ruleDiagnostics)
        const failed = (specialResult ? processFailed(specialResult) : false)
          || (remainingResult ? processFailed(remainingResult) : false)
        const openNets = new Set([
          ...summaryOpenNets(specialResult?.jsonSummary),
          ...summaryOpenNets(remainingResult?.jsonSummary),
        ])
        if (remainingResult && !remainingResult.jsonSummary) {
          for (const net of remainingNets) openNets.add(net)
        }
        if (specialResult && !specialResult.jsonSummary) {
          for (const net of allSpecial) openNets.add(net)
        }
        const routeScope = new Set([...allSpecial, ...remainingNets])
        return {
          status: failed || diagnostics.some((item) => item.severity === "error") ? "partial" : "complete",
          copper: routed.copper,
          diagnostics,
          metrics: {
            elapsedMs: performance.now() - startedAt,
            routedNetCount: Math.max(0, routeScope.size - openNets.size),
            openNetCount: openNets.size,
            openNets: [...openNets].sort(),
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
              special: specialResult?.jsonSummary,
              remaining: remainingResult?.jsonSummary,
              fanout: fanoutResults.map((result) => ({
                status: result.status,
                elapsedMs: result.elapsedMs,
                summary: result.jsonSummary,
              })),
            },
          },
        }
      } catch (error) {
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
  const specialMembers = (request: BackendRouteRequest) => [...new Set([
    ...request.program.differentialPairs.flatMap((pair) => [pair.positive, pair.negative]),
    ...request.program.matchedGroups.flatMap((group) => group.nets),
    ...request.program.viaFences.flatMap((fence) => fence.along),
  ])]
  return {
    ...adapter,
    routeSpecial(request) {
      const members = specialMembers(request)
      const scoped: KrtInternalRouteRequest = {
        ...request,
        // QFN/QFP fanout is component-wide and must happen before any power,
        // differential, or ordinary maze route can occupy the escape ring.
        krtAutomaticFanoutNets: routableScopeNets(request),
        program: {
          ...request.program,
          signalNets: request.program.signalNets.filter((item) => members.includes(item.net)),
          powerNets: request.program.powerNets.filter((item) => members.includes(item.net)),
          onlyNets: members,
          ignoreNets: request.board.nets.map((item) => item.name).filter((net) => !members.includes(net)),
        },
      }
      return adapter.route(scoped)
    },
    routeRemaining(request) {
      const members = specialMembers(request)
      const scoped: KrtInternalRouteRequest = {
        ...request,
        krtSkipAutomaticFanout: true,
        program: {
          ...request.program,
          differentialPairs: [], matchedGroups: [], viaFences: [],
          ignoreNets: [...new Set([...request.program.ignoreNets, ...members])],
        },
      }
      return adapter.route(scoped)
    },
  }
}
