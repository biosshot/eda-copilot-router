import {
  netClassFor,
  type PcbNetClassRule,
  type PcbRoutingRules,
} from "../../kicad-copilot/src/pcb/router-rules"
import {
  ringsFromRawPad,
  ringsFromRawPolygon,
} from "./polygon/engine"
import type {
  PcbLayerName,
  PcbPoint,
  RawPcb,
  RawPcbPad,
} from "./polygon/raw-pcb"

export type NetScheduleTier =
  | "escape_critical"
  | "congested"
  | "ordinary"
  | "large_tree"

export type PadEscapeMetric = {
  component?: string
  padNumber: string
  layer: PcbLayerName
  componentPadCount: number
  componentDensity: number
  componentComplexity: number
  denseComponent: boolean
  freeDirections: number
  directionChoices: number
  blockedRatio: number
  blockerCount: number
  escapeLengthMm: number
}

export type NetScheduleItem = {
  net: string
  tier: NetScheduleTier
  priority: number
  padCount: number
  componentCount: number
  minFreeDirections: number
  minDirectionChoices: number
  worstEscapeBlockedRatio: number
  localBlockerCount: number
  densePadCount: number
  denseMinFreeDirections: number
  denseDirectionChoices: number
  denseWorstEscapeBlockedRatio: number
  denseLocalBlockerCount: number
  maxComponentDensity: number
  maxComponentComplexity: number
  denseComponentPadFraction: number
  spanMm: number
  spanBoardRatio: number
  mstLowerBoundMm: number
  largeTreeCost: number
  ruleDemandMm: number
  ranks: {
    escape: number
    congestion: number
    density: number
    ruleDemand: number
    span: number
    largeTree: number
  }
  padEscapes: PadEscapeMetric[]
  reasons: string[]
}

export type NetSchedule = {
  version: 1
  strategy: "escape-risk-first"
  board: {
    diagonalMm: number
    componentCount: number
    padCount: number
    candidateNetCount: number
  }
  orderedNets: string[]
  tiers: Array<{ tier: NetScheduleTier; nets: string[] }>
  items: NetScheduleItem[]
}

export type NetSchedulerOptions = {
  nets?: readonly string[]
  excludedNets?: readonly string[]
  layers?: readonly PcbLayerName[]
}

type Bounds = { left: number; right: number; top: number; bottom: number }
type Segment = { start: PcbPoint; end: PcbPoint }
type ComponentRouteMetric = {
  padCount: number
  density: number
  complexity: number
  dense: boolean
}

const DIRECTIONS = Array.from({ length: 8 }, (_, index) => {
  const angle = Math.PI * index / 4
  return { x: Math.cos(angle), y: Math.sin(angle) }
})

const TIER_ORDER: Record<NetScheduleTier, number> = {
  escape_critical: 0,
  congested: 1,
  ordinary: 2,
  large_tree: 3,
}

function ruleForNet(rules: PcbRoutingRules, net: string): PcbNetClassRule {
  const name = netClassFor(rules, net)
  return rules.classes.find((item) => item.name === name)
    ?? rules.classes.find((item) => item.name === "Default")!
}

function boundsFromPoints(points: PcbPoint[]): Bounds | undefined {
  if (!points.length) return undefined
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  }
}

function padBounds(pad: RawPcbPad, fallbackWidth: number): Bounds {
  return boundsFromPoints(ringsFromRawPad(pad).flat()) ?? {
    left: pad.x - fallbackWidth / 2,
    right: pad.x + fallbackWidth / 2,
    top: pad.y - fallbackWidth / 2,
    bottom: pad.y + fallbackWidth / 2,
  }
}

function expandBounds(bounds: Bounds, amount: number): Bounds {
  return {
    left: bounds.left - amount,
    right: bounds.right + amount,
    top: bounds.top - amount,
    bottom: bounds.bottom + amount,
  }
}

function pointInBounds(point: PcbPoint, bounds: Bounds) {
  return point.x >= bounds.left && point.x <= bounds.right
    && point.y >= bounds.top && point.y <= bounds.bottom
}

function orientation(a: PcbPoint, b: PcbPoint, c: PcbPoint) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function segmentsIntersect(left: Segment, right: Segment) {
  const o1 = orientation(left.start, left.end, right.start)
  const o2 = orientation(left.start, left.end, right.end)
  const o3 = orientation(right.start, right.end, left.start)
  const o4 = orientation(right.start, right.end, left.end)
  const epsilon = 1e-9
  if (((o1 > epsilon && o2 < -epsilon) || (o1 < -epsilon && o2 > epsilon))
    && ((o3 > epsilon && o4 < -epsilon) || (o3 < -epsilon && o4 > epsilon))) return true
  const onSegment = (point: PcbPoint, line: Segment) => Math.abs(orientation(line.start, line.end, point)) <= epsilon
    && point.x >= Math.min(line.start.x, line.end.x) - epsilon
    && point.x <= Math.max(line.start.x, line.end.x) + epsilon
    && point.y >= Math.min(line.start.y, line.end.y) - epsilon
    && point.y <= Math.max(line.start.y, line.end.y) + epsilon
  return onSegment(right.start, left) || onSegment(right.end, left)
    || onSegment(left.start, right) || onSegment(left.end, right)
}

function boundsEdges(bounds: Bounds): Segment[] {
  const topLeft = { x: bounds.left, y: bounds.top }
  const topRight = { x: bounds.right, y: bounds.top }
  const bottomRight = { x: bounds.right, y: bounds.bottom }
  const bottomLeft = { x: bounds.left, y: bounds.bottom }
  return [
    { start: topLeft, end: topRight },
    { start: topRight, end: bottomRight },
    { start: bottomRight, end: bottomLeft },
    { start: bottomLeft, end: topLeft },
  ]
}

function segmentIntersectsBounds(segment: Segment, bounds: Bounds) {
  return pointInBounds(segment.start, bounds) || pointInBounds(segment.end, bounds)
    || boundsEdges(bounds).some((edge) => segmentsIntersect(segment, edge))
}

function pointSegmentDistance(point: PcbPoint, segment: Segment) {
  const dx = segment.end.x - segment.start.x
  const dy = segment.end.y - segment.start.y
  const length2 = dx * dx + dy * dy
  if (length2 <= 1e-18) return Math.hypot(point.x - segment.start.x, point.y - segment.start.y)
  const t = Math.max(0, Math.min(1,
    ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / length2))
  return Math.hypot(point.x - (segment.start.x + t * dx), point.y - (segment.start.y + t * dy))
}

function segmentDistance(left: Segment, right: Segment) {
  if (segmentsIntersect(left, right)) return 0
  return Math.min(
    pointSegmentDistance(left.start, right),
    pointSegmentDistance(left.end, right),
    pointSegmentDistance(right.start, left),
    pointSegmentDistance(right.end, left),
  )
}

function pointInRing(point: PcbPoint, ring: PcbPoint[]) {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index]
    const b = ring[previous]
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || 1e-12) + a.x) inside = !inside
  }
  return inside
}

function segmentDistanceToRing(segment: Segment, ring: PcbPoint[]) {
  if (pointInRing(segment.start, ring) || pointInRing(segment.end, ring)) return 0
  let distance = Infinity
  for (let index = 0; index < ring.length; index += 1) {
    distance = Math.min(distance, segmentDistance(segment, {
      start: ring[index],
      end: ring[(index + 1) % ring.length],
    }))
  }
  return distance
}

function compatibleLayer(left: PcbLayerName, right: PcbLayerName) {
  return left === "MULTI" || right === "MULTI" || left === right
}

function rayExitDistance(bounds: Bounds, center: PcbPoint, direction: PcbPoint) {
  const distances: number[] = []
  if (direction.x > 1e-9) distances.push((bounds.right - center.x) / direction.x)
  if (direction.x < -1e-9) distances.push((bounds.left - center.x) / direction.x)
  if (direction.y > 1e-9) distances.push((bounds.bottom - center.y) / direction.y)
  if (direction.y < -1e-9) distances.push((bounds.top - center.y) / direction.y)
  return Math.max(0, Math.min(...distances.filter((value) => value >= 0)))
}

function componentRouteMetrics(pcb: RawPcb, pads: RawPcbPad[]) {
  const padsByComponent = new Map<string, RawPcbPad[]>()
  for (const pad of pads) {
    if (!pad.component) continue
    padsByComponent.set(pad.component, [...(padsByComponent.get(pad.component) ?? []), pad])
  }
  const raw = new Map<string, Omit<ComponentRouteMetric, "dense">>()
  for (const component of pcb.components) {
    const componentPads = padsByComponent.get(component.designator) ?? []
    if (componentPads.length < 3) {
      raw.set(component.designator, { padCount: componentPads.length, density: 0, complexity: 0 })
      continue
    }
    const fallbackWidth = 0.2
    const points = componentPads.flatMap((pad) => {
      const bounds = padBounds(pad, fallbackWidth)
      return [
        { x: bounds.left, y: bounds.top },
        { x: bounds.right, y: bounds.bottom },
      ]
    })
    const derived = boundsFromPoints(points)
    const declared = component.bbox
    const width = Math.max(1e-6, Math.abs((declared?.right ?? derived?.right ?? 0)
      - (declared?.left ?? derived?.left ?? 0)))
    const height = Math.max(1e-6, Math.abs((declared?.bottom ?? derived?.bottom ?? 0)
      - (declared?.top ?? derived?.top ?? 0)))
    const padAreas = componentPads.map((pad) => {
      const bounds = padBounds(pad, fallbackWidth)
      return Math.max(1e-9, (bounds.right - bounds.left) * (bounds.bottom - bounds.top))
    }).sort((a, b) => a - b)
    const medianPadArea = padAreas[Math.floor(padAreas.length / 2)] ?? 1e-6
    const density = componentPads.length / Math.max(width * height, medianPadArea)
    raw.set(component.designator, {
      padCount: componentPads.length,
      density,
      complexity: Math.sqrt(componentPads.length) * Math.sqrt(density),
    })
  }
  const nontrivial = [...raw.values()].filter((item) => item.padCount >= 3)
    .map((item) => item.complexity).sort((a, b) => a - b)
  // A relative cut keeps this board- and package-independent.  Using ceil is
  // intentional: on a small board the MOSFET bank must not be mistaken for the
  // one genuinely dense controller merely because both are above the median.
  const denseThreshold = nontrivial[Math.ceil(Math.max(0, nontrivial.length - 1) * 0.90)] ?? Infinity
  const output = new Map<string, ComponentRouteMetric>()
  for (const [component, metric] of raw) output.set(component, {
    ...metric,
    dense: metric.padCount >= 3 && metric.complexity >= denseThreshold - 1e-12,
  })
  return output
}

function boardDiagonal(pcb: RawPcb, pads: RawPcbPad[]) {
  const points = pcb.board?.polygon?.length ? pcb.board.polygon : pads.map((pad) => ({ x: pad.x, y: pad.y }))
  const bounds = boundsFromPoints(points)
  return bounds ? Math.max(1e-6, Math.hypot(bounds.right - bounds.left, bounds.bottom - bounds.top)) : 1
}

function mstLength(pads: RawPcbPad[]) {
  if (pads.length < 2) return 0
  const included = new Set([0])
  let total = 0
  while (included.size < pads.length) {
    let best: { index: number; distance: number } | undefined
    for (const from of included) {
      for (let index = 0; index < pads.length; index += 1) {
        if (included.has(index)) continue
        const distance = Math.hypot(pads[from].x - pads[index].x, pads[from].y - pads[index].y)
        if (!best || distance < best.distance) best = { index, distance }
      }
    }
    if (!best) break
    included.add(best.index)
    total += best.distance
  }
  return total
}

function normalizedRanks(values: number[]) {
  if (!values.length) return []
  if (values.every((value) => Math.abs(value - values[0]) <= 1e-12)) return values.map(() => 0.5)
  const sorted = [...values].sort((a, b) => a - b)
  return values.map((value) => {
    const first = sorted.findIndex((candidate) => candidate >= value - 1e-12)
    let last = sorted.length - 1
    while (last >= 0 && sorted[last] > value + 1e-12) last -= 1
    return ((first + last) / 2) / Math.max(1, sorted.length - 1)
  })
}

function rounded(value: number, digits = 6) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function padEscapeMetric(
  pcb: RawPcb,
  pad: RawPcbPad,
  allPads: RawPcbPad[],
  rules: PcbRoutingRules,
  layers: readonly PcbLayerName[],
  componentMetrics: ReadonlyMap<string, ComponentRouteMetric>,
): PadEscapeMetric {
  const rule = ruleForNet(rules, pad.net)
  const width = Math.max(rules.minimumTrackWidth, rule.trackWidth)
  const clearance = Math.max(rules.minimumClearance, rule.clearance)
  const ownBounds = padBounds(pad, width)
  const ownSpan = Math.max(ownBounds.right - ownBounds.left, ownBounds.bottom - ownBounds.top)
  const escapeLengthMm = Math.max(ownSpan * 1.5, (width + 2 * clearance) * 2)
  const candidateLayers = pad.layer === "MULTI"
    ? layers
    : layers.filter((layer) => compatibleLayer(pad.layer, layer))
  const blockers = new Set<string>()
  let freeDirections = 0
  let directionChoices = 0

  for (const layer of candidateLayers) {
    for (const direction of DIRECTIONS) {
      directionChoices += 1
      const exit = rayExitDistance(ownBounds, pad, direction) + 1e-4
      const segment = {
        start: { x: pad.x + direction.x * exit, y: pad.y + direction.y * exit },
        end: { x: pad.x + direction.x * escapeLengthMm, y: pad.y + direction.y * escapeLengthMm },
      }
      let blocked = false
      for (const foreign of allPads) {
        if (foreign === pad || foreign.net === pad.net || !compatibleLayer(foreign.layer, layer)) continue
        const foreignRule = ruleForNet(rules, foreign.net)
        const crossClearance = Math.max(clearance, rules.minimumClearance, foreignRule.clearance)
        if (!segmentIntersectsBounds(segment, expandBounds(padBounds(foreign, width), crossClearance + width / 2))) continue
        blocked = true
        blockers.add(`pad:${foreign.id ?? `${foreign.component ?? ""}.${foreign.padNumber}`}`)
      }
      for (const [index, track] of pcb.tracks.entries()) {
        if (blocked || track.net === pad.net || !compatibleLayer(track.layer, layer)) continue
        const foreignRule = ruleForNet(rules, track.net)
        const crossClearance = Math.max(clearance, rules.minimumClearance, foreignRule.clearance)
        if (segmentDistance(segment, {
          start: { x: track.x1, y: track.y1 },
          end: { x: track.x2, y: track.y2 },
        }) > crossClearance + (width + track.width) / 2) continue
        blocked = true
        blockers.add(`track:${index}`)
      }
      for (const [index, via] of pcb.vias.entries()) {
        if (blocked || via.net === pad.net) continue
        const foreignRule = ruleForNet(rules, via.net)
        const crossClearance = Math.max(clearance, rules.minimumClearance, foreignRule.clearance)
        if (pointSegmentDistance(via, segment) > crossClearance + width / 2 + via.diameter / 2) continue
        blocked = true
        blockers.add(`via:${index}`)
      }
      for (const [index, polygon] of pcb.polygons.entries()) {
        if (blocked || polygon.net === pad.net || !compatibleLayer(polygon.layer, layer)) continue
        const foreignRule = ruleForNet(rules, polygon.net)
        const crossClearance = Math.max(clearance, rules.minimumClearance, foreignRule.clearance)
        if (!ringsFromRawPolygon(polygon).some((ring) =>
          segmentDistanceToRing(segment, ring) <= crossClearance + width / 2)) continue
        blocked = true
        blockers.add(`polygon:${index}`)
      }
      if (!blocked) freeDirections += 1
    }
  }

  const componentMetric = componentMetrics.get(pad.component ?? "")
    ?? { padCount: 0, density: 0, complexity: 0, dense: false }
  return {
    component: pad.component,
    padNumber: pad.padNumber,
    layer: pad.layer,
    componentPadCount: componentMetric.padCount,
    componentDensity: rounded(componentMetric.density),
    componentComplexity: rounded(componentMetric.complexity),
    denseComponent: componentMetric.dense,
    freeDirections,
    directionChoices,
    blockedRatio: directionChoices ? rounded(1 - freeDirections / directionChoices) : 1,
    blockerCount: blockers.size,
    escapeLengthMm: rounded(escapeLengthMm),
  }
}

export function scheduleNets(
  pcb: RawPcb,
  rules: PcbRoutingRules,
  options: NetSchedulerOptions = {},
): NetSchedule {
  const excluded = new Set((options.excludedNets ?? []).map(String))
  const requested = options.nets?.length
    ? [...new Set(options.nets.map(String))]
    : [...new Set(pcb.pads.map((pad) => pad.net).filter(Boolean))]
  const nets = requested.filter((net) => net && !excluded.has(net) && net.toUpperCase() !== "GND")
  const layers = options.layers?.length ? [...new Set(options.layers)] : ["TOP", "BOTTOM"] as PcbLayerName[]
  const candidatePads = pcb.pads.filter((pad) => pad.net && pad.net.toUpperCase() !== "GND")
  const componentMetrics = componentRouteMetrics(pcb, pcb.pads)
  const diagonalMm = boardDiagonal(pcb, candidatePads)

  const rawItems = nets.flatMap((net) => {
    const pads = candidatePads.filter((pad) => pad.net === net)
    if (pads.length < 2) return []
    const padEscapes = pads.map((pad) => padEscapeMetric(
      pcb, pad, candidatePads, rules, layers, componentMetrics,
    ))
    const xs = pads.map((pad) => pad.x)
    const ys = pads.map((pad) => pad.y)
    const spanMm = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    const mstLowerBoundMm = mstLength(pads)
    const metrics = pads.map((pad) => componentMetrics.get(pad.component ?? ""))
    const densities = metrics.map((metric) => metric?.density ?? 0)
    const complexities = metrics.map((metric) => metric?.complexity ?? 0)
    const denseEscapes = padEscapes.filter((metric) => metric.denseComponent)
    const maxComponentDensity = Math.max(0, ...densities)
    const rule = ruleForNet(rules, net)
    const ruleDemandMm = Math.max(rules.minimumTrackWidth, rule.trackWidth)
      + 2 * Math.max(rules.minimumClearance, rule.clearance)
    const minDirectionChoices = Math.min(...padEscapes.map((metric) => metric.directionChoices))
    const minFreeDirections = Math.min(...padEscapes.map((metric) => metric.freeDirections))
    return [{
      net,
      pads,
      padEscapes,
      padCount: pads.length,
      componentCount: new Set(pads.map((pad) => pad.component).filter(Boolean)).size,
      minFreeDirections,
      minDirectionChoices,
      worstEscapeBlockedRatio: Math.max(...padEscapes.map((metric) => metric.blockedRatio)),
      localBlockerCount: Math.max(...padEscapes.map((metric) => metric.blockerCount)),
      densePadCount: denseEscapes.length,
      denseMinFreeDirections: denseEscapes.length
        ? Math.min(...denseEscapes.map((metric) => metric.freeDirections))
        : 0,
      denseDirectionChoices: denseEscapes.length
        ? Math.min(...denseEscapes.map((metric) => metric.directionChoices))
        : 0,
      denseWorstEscapeBlockedRatio: denseEscapes.length
        ? Math.max(...denseEscapes.map((metric) => metric.blockedRatio))
        : 0,
      denseLocalBlockerCount: denseEscapes.length
        ? Math.max(...denseEscapes.map((metric) => metric.blockerCount))
        : 0,
      maxComponentDensity,
      maxComponentComplexity: Math.max(0, ...complexities),
      denseComponentPadFraction: 0,
      spanMm,
      spanBoardRatio: spanMm / diagonalMm,
      mstLowerBoundMm,
      largeTreeCost: Math.sqrt(pads.length) * Math.sqrt(Math.max(0, mstLowerBoundMm / diagonalMm)),
      ruleDemandMm,
    }]
  })

  const densityRanks = normalizedRanks(rawItems.map((item) => item.maxComponentComplexity))
  for (const item of rawItems) {
    item.denseComponentPadFraction = item.pads.filter((pad) =>
      componentMetrics.get(pad.component ?? "")?.dense).length / item.pads.length
  }
  const escapeRanks = normalizedRanks(rawItems.map((item) => item.denseWorstEscapeBlockedRatio))
  const congestionRanks = normalizedRanks(rawItems.map((item) => item.denseLocalBlockerCount))
  const ruleRanks = normalizedRanks(rawItems.map((item) => item.ruleDemandMm))
  const spanRanks = normalizedRanks(rawItems.map((item) => item.spanBoardRatio))
  const largeTreeRanks = normalizedRanks(rawItems.map((item) => item.largeTreeCost))

  const rankedItems = rawItems.map((item, index) => {
    const ranks = {
      escape: escapeRanks[index],
      congestion: congestionRanks[index],
      density: densityRanks[index],
      ruleDemand: ruleRanks[index],
      span: spanRanks[index],
      largeTree: largeTreeRanks[index],
    }
    const priority = item.densePadCount
      ? 0.45 * ranks.escape
        + 0.20 * ranks.congestion
        + 0.15 * ranks.density
        + 0.15 * ranks.span
        + 0.05 * ranks.ruleDemand
        - 0.10 * ranks.largeTree
      : 0.20 * ranks.congestion
        + 0.15 * ranks.density
        + 0.10 * ranks.span
        + 0.05 * ranks.ruleDemand
        - 0.10 * ranks.largeTree
    const reasons = [
      `${item.minFreeDirections}/${item.minDirectionChoices} escape directions remain at the most constrained terminal`,
      `${item.localBlockerCount} local foreign obstacle(s) affect the worst terminal`,
      `${item.padCount} terminal(s), ${item.mstLowerBoundMm.toFixed(2)} mm MST lower bound`,
    ]
    if (item.densePadCount) reasons.unshift(
      `${item.denseMinFreeDirections}/${item.denseDirectionChoices} escape directions remain at the dense-component terminal`,
    )
    return {
      net: item.net,
      tier: "ordinary" as NetScheduleTier,
      priority: rounded(priority),
      padCount: item.padCount,
      componentCount: item.componentCount,
      minFreeDirections: item.minFreeDirections,
      minDirectionChoices: item.minDirectionChoices,
      worstEscapeBlockedRatio: rounded(item.worstEscapeBlockedRatio),
      localBlockerCount: item.localBlockerCount,
      densePadCount: item.densePadCount,
      denseMinFreeDirections: item.denseMinFreeDirections,
      denseDirectionChoices: item.denseDirectionChoices,
      denseWorstEscapeBlockedRatio: rounded(item.denseWorstEscapeBlockedRatio),
      denseLocalBlockerCount: item.denseLocalBlockerCount,
      maxComponentDensity: rounded(item.maxComponentDensity),
      maxComponentComplexity: rounded(item.maxComponentComplexity),
      denseComponentPadFraction: rounded(item.denseComponentPadFraction),
      spanMm: rounded(item.spanMm),
      spanBoardRatio: rounded(item.spanBoardRatio),
      mstLowerBoundMm: rounded(item.mstLowerBoundMm),
      largeTreeCost: rounded(item.largeTreeCost),
      ruleDemandMm: rounded(item.ruleDemandMm),
      ranks: Object.fromEntries(Object.entries(ranks).map(([key, value]) => [key, rounded(value)])) as NetScheduleItem["ranks"],
      padEscapes: item.padEscapes,
      reasons,
    }
  })

  const criticalCandidates = [...rankedItems].filter((item) => item.densePadCount > 0
    && item.denseWorstEscapeBlockedRatio >= 0.5)
    .sort((left, right) => right.priority - left.priority || left.net.localeCompare(right.net))
  const criticalLimit = Math.max(1, Math.ceil(Math.sqrt(rankedItems.length)))
  const criticalNets = new Set(criticalCandidates.slice(0, criticalLimit).map((item) => item.net))
  const items = rankedItems.map((item) => {
    const largeTree = item.padCount >= 3 && item.ranks.largeTree >= 0.75 && !criticalNets.has(item.net)
    const tier: NetScheduleTier = criticalNets.has(item.net)
      ? "escape_critical"
      : largeTree
        ? "large_tree"
        : item.densePadCount > 0 || item.ranks.congestion >= 0.70
          ? "congested"
          : "ordinary"
    return {
      ...item,
      tier,
      reasons: largeTree
        ? [...item.reasons, "large multipoint/span cost is deferred to preserve routing channels"]
        : item.reasons,
    }
  }).sort((left, right) => TIER_ORDER[left.tier] - TIER_ORDER[right.tier]
    || right.priority - left.priority
    || left.net.localeCompare(right.net))

  const tiers = (Object.keys(TIER_ORDER) as NetScheduleTier[]).map((tier) => ({
    tier,
    nets: items.filter((item) => item.tier === tier).map((item) => item.net),
  })).filter((tier) => tier.nets.length)

  return {
    version: 1,
    strategy: "escape-risk-first",
    board: {
      diagonalMm: rounded(diagonalMm),
      componentCount: pcb.components.length,
      padCount: pcb.pads.length,
      candidateNetCount: items.length,
    },
    orderedNets: items.map((item) => item.net),
    tiers,
    items,
  }
}
