import type { BackendRouteRequest } from "../adapters/contracts.js"
import type { CopperTarget, LayerSelector, PlaneIntent, RoutingProgram, ZoneOptions } from "../intent/types.js"
import { DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM } from "../polygon/boundary-optimizer.js"
import { planPolygons } from "../polygon/engine.js"
import { routingBoardToPolygonScene } from "../polygon/routing-board-adapter.js"
import { distanceToPadHoleCenterline, padHoleGeometry } from "./pad-hole.js"
import { foreignZoneBlocksCircle } from "./zone-clearance.js"
import type {
  PointMm,
  RoutedVia,
  RoutedZone,
  RoutingBoard,
  RoutingCopper,
  RoutingDiagnostic,
  RoutingRules,
  RoutingRuleValues,
} from "./contracts.js"
import { MAX_GENERATED_STITCHING_VIAS_PER_INTENT } from "./stitching-limits.js"

const EPSILON = 1e-7

// KiCad zone min_thickness is a fill-detail/manufacturability parameter, not
// the required current-carrying width of the net.  Feeding a calculated power
// trace width (for example 1.85 mm) into it can erase narrow but intentional
// pad entries during refill.  Polygon geometry and routing rules retain their
// own independent width requirements.
const ROUTER_ZONE_MIN_THICKNESS_MM = DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM

// Native zone priority zero is reserved for the board-scale GND plane.  This
// keeps every router-owned compact power zone above the late ground pour even
// when the DSL leaves both priorities at their default value.
const ROUTER_COMPACT_ZONE_PRIORITY_BASE = 1
const GND_NET_NAMES = new Set(["GND", "/GND"])

function isGroundNetName(net: string) {
  return GND_NET_NAMES.has(net.trim().toUpperCase())
}

export type PlannedRoutingCopper = Readonly<{
  copper: RoutingCopper
  connectivity: NonNullable<BackendRouteRequest["connectivity"]>
  diagnostics: readonly RoutingDiagnostic[]
  metrics: Readonly<{
    compactPlans: number
    compactReady: number
    planeZones: number
    stitchingVias: number
  }>
}>

function valuesForNet(rules: RoutingRules, net: string) {
  return rules.nets.find((entry) => entry.net === net)?.values ?? rules.default
}

function routedZoneOptions(options: ZoneOptions | undefined, values: RoutingRuleValues) {
  const padConnection = {
    mode: options?.padConnection?.mode ?? "solid" as const,
    ...(options?.padConnection?.thermalGapMm === undefined ? {} : { thermalGapMm: options.padConnection.thermalGapMm }),
    ...(options?.padConnection?.spokeWidthMm === undefined ? {} : { spokeWidthMm: options.padConnection.spokeWidthMm }),
    ...(options?.padConnection?.spokeCount === undefined ? {} : { spokeCount: options.padConnection.spokeCount }),
    ...(options?.padConnection?.spokeAngleDeg === undefined ? {} : { spokeAngleDeg: options.padConnection.spokeAngleDeg }),
  }
  return {
    clearanceMm: options?.clearanceMm ?? values.clearanceMm,
    minThicknessMm: options?.minThicknessMm ?? ROUTER_ZONE_MIN_THICKNESS_MM,
    connection: padConnection.mode,
    fill: {
      style: options?.fill?.style ?? "solid" as const,
      ...(options?.fill?.hatchThicknessMm === undefined ? {} : { hatchThicknessMm: options.fill.hatchThicknessMm }),
      ...(options?.fill?.hatchGapMm === undefined ? {} : { hatchGapMm: options.fill.hatchGapMm }),
      ...(options?.fill?.hatchOrientationDeg === undefined ? {} : { hatchOrientationDeg: options.fill.hatchOrientationDeg }),
    },
    padConnection,
    removeIslandsBelowMm2: options?.removeIslandsBelowMm2 ?? 0,
  }
}

function selectedLayers(board: RoutingBoard, selector: LayerSelector) {
  if (selector.kind === "all") return board.layers.map((layer) => layer.name)
  if (selector.kind === "top") return board.layers.filter((layer) => layer.side === "top").map((layer) => layer.name)
  if (selector.kind === "bottom") return board.layers.filter((layer) => layer.side === "bottom").map((layer) => layer.name)
  if (selector.kind === "outer") return board.layers.filter((layer) => layer.side !== "inner").map((layer) => layer.name)
  const inner = board.layers.filter((layer) => layer.side === "inner").sort((left, right) => left.index - right.index)
  return selector.names.map((name) => {
    if (name === "TOP") return board.layers.find((layer) => layer.side === "top")?.name ?? name
    if (name === "BOTTOM") return board.layers.find((layer) => layer.side === "bottom")?.name ?? name
    const match = /^INNER_(\d+)$/.exec(name)
    return match ? inner[Number(match[1]) - 1]?.name ?? name : name
  })
}

function polygonProgramWithPowerPadTargets(program: RoutingProgram): RoutingProgram {
  const powerPads = new Map(program.powerNets.flatMap((intent) => (
    intent.powerPads?.length ? [[intent.net, intent.powerPads] as const] : []
  )))
  if (!powerPads.size) return program
  return {
    ...program,
    polygons: program.polygons.map((intent) => {
      const scopedPads = powerPads.get(intent.net)
      if (!scopedPads || !intent.targets.some((target) => target.kind === "net" && target.net === intent.net)) {
        return intent
      }
      const expanded: CopperTarget[] = []
      for (const target of intent.targets) {
        if (target.kind === "net" && target.net === intent.net) expanded.push(...scopedPads)
        else expanded.push(target)
      }
      const unique = new Map<string, CopperTarget>()
      for (const target of expanded) {
        const key = target.kind === "pad"
          ? `pad\u0000${target.component}\u0000${target.pad}`
          : `net\u0000${target.net}`
        unique.set(key, target)
      }
      return { ...intent, targets: [...unique.values()] }
    }),
  }
}

function pointInRing(point: PointMm, ring: readonly PointMm[]) {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index]
    const b = ring[previous]
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function distanceToSegment(point: PointMm, start: PointMm, end: PointMm) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length2 = dx * dx + dy * dy
  if (length2 <= EPSILON) return Math.hypot(point.x - start.x, point.y - start.y)
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length2))
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy)
}

function orientation(a: PointMm, b: PointMm, c: PointMm) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function pointOnSegment(point: PointMm, start: PointMm, end: PointMm) {
  return Math.abs(orientation(start, end, point)) <= EPSILON
    && point.x >= Math.min(start.x, end.x) - EPSILON
    && point.x <= Math.max(start.x, end.x) + EPSILON
    && point.y >= Math.min(start.y, end.y) - EPSILON
    && point.y <= Math.max(start.y, end.y) + EPSILON
}

function segmentsIntersect(a: PointMm, b: PointMm, c: PointMm, d: PointMm) {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
    && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) return true
  return (Math.abs(abC) <= EPSILON && pointOnSegment(c, a, b))
    || (Math.abs(abD) <= EPSILON && pointOnSegment(d, a, b))
    || (Math.abs(cdA) <= EPSILON && pointOnSegment(a, c, d))
    || (Math.abs(cdB) <= EPSILON && pointOnSegment(b, c, d))
}

function distanceBetweenSegments(a: PointMm, b: PointMm, c: PointMm, d: PointMm) {
  if (segmentsIntersect(a, b, c, d)) return 0
  return Math.min(
    distanceToSegment(a, c, d),
    distanceToSegment(b, c, d),
    distanceToSegment(c, a, b),
    distanceToSegment(d, a, b),
  )
}

function distanceToRing(point: PointMm, ring: readonly PointMm[]) {
  if (pointInRing(point, ring)) return 0
  return distanceToRingBoundary(point, ring)
}

function distanceToRingBoundary(point: PointMm, ring: readonly PointMm[]) {
  return ring.reduce((minimum, start, index) => Math.min(
    minimum, distanceToSegment(point, start, ring[(index + 1) % ring.length]),
  ), Infinity)
}

function boardPointAllowed(board: RoutingBoard, point: PointMm, radius: number, edgeClearance: number) {
  if (!pointInRing(point, board.outline) || board.cutouts.some((cutout) => pointInRing(point, cutout))) return false
  const margin = radius + edgeClearance
  return [board.outline, ...board.cutouts].every((ring) =>
    distanceToRingBoundary(point, ring) >= margin - EPSILON)
}

/** Distance to pad copper, in the pad's rotated local coordinate system. */
function distanceToPad(point: PointMm, pad: RoutingBoard["pads"][number]) {
  const angle = -pad.rotationDeg * Math.PI / 180
  const dx = point.x - pad.at.x
  const dy = point.y - pad.at.y
  const local = { x: dx * Math.cos(angle) - dy * Math.sin(angle), y: dx * Math.sin(angle) + dy * Math.cos(angle) }
  const shape = pad.shape
  if (shape.kind === "circle") return Math.max(0, Math.hypot(dx, dy) - shape.diameterMm / 2)
  if (shape.kind === "polygon") return distanceToRing(local, shape.polygon.outer)
  const halfX = shape.widthMm / 2
  const halfY = shape.heightMm / 2
  const corner = shape.kind === "oval" ? Math.min(halfX, halfY)
    : shape.kind === "round-rect" ? shape.cornerRadiusMm : 0
  return Math.max(0, Math.hypot(
    Math.max(0, Math.abs(local.x) - halfX + corner),
    Math.max(0, Math.abs(local.y) - halfY + corner),
  ) - corner)
}

function keepoutBlocksVia(board: RoutingBoard, point: PointMm, layers: readonly string[], radius: number) {
  return board.keepouts.some((keepout) => keepout.forbid.vias
    && keepout.layers.some((layer) => layers.includes(layer))
    && distanceToRing(point, keepout.polygon.outer) < radius - EPSILON)
}

function existingCopper(board: RoutingBoard) {
  return {
    tracks: [...board.copper.fixed.tracks, ...board.copper.editable.tracks],
    vias: [...board.copper.fixed.vias, ...board.copper.editable.vias],
  }
}

function stitchingCandidates(
  board: RoutingBoard,
  plane: PlaneIntent,
  rules: RoutingRuleValues,
  plannedZones: readonly RoutedZone[],
  effectiveRules: RoutingRules,
  diagnostics: RoutingDiagnostic[],
  previousVias: readonly RoutedVia[],
): RoutedVia[] {
  if (!plane.stitching) return []
  const stitching = plane.stitching
  const planeLayers = selectedLayers(board, plane.layers)
  const viaLayers = [...board.layers].sort((left, right) => left.index - right.index).map((layer) => layer.name)
  if (planeLayers.length < 2 || viaLayers.length < 2 || !board.outline.length) return []
  const viaRule = stitching.via === "drc-min"
    ? { diameterMm: rules.via.minDiameterMm, drillMm: rules.via.minDrillMm }
    : stitching.via
  const radius = viaRule.diameterMm / 2
  const xs = board.outline.map((point) => point.x)
  const ys = board.outline.map((point) => point.y)
  const copper = existingCopper(board)
  copper.vias.push(...previousVias)
  const zones = [...board.copper.fixed.zones, ...board.copper.editable.zones, ...plannedZones]
  const accepted: RoutedVia[] = []
  const clearanceFor = (net?: string) => Math.max(rules.clearanceMm,
    net ? valuesForNet(effectiveRules, net).clearanceMm : 0)
  const candidateAllowed = (point: PointMm, ownerPad?: RoutingBoard["pads"][number]) => {
    if (!boardPointAllowed(board, point, radius, rules.edgeClearanceMm)) return false
    if (keepoutBlocksVia(board, point, viaLayers, radius)) return false
    if (foreignZoneBlocksCircle(point, plane.net, viaLayers, radius, rules.clearanceMm, zones)) return false
    for (const pad of board.pads) {
      const hole = padHoleGeometry(pad)
      const holeClearance = rules.holeToHoleClearanceMm ?? rules.clearanceMm
      if (hole && distanceToPadHoleCenterline(point, hole)
        < viaRule.drillMm / 2 + hole.radiusMm + holeClearance - EPSILON) return false
      if (pad === ownerPad) continue
      if (pad.layers.some((layer) => viaLayers.includes(layer))
        && distanceToPad(point, pad) < radius + (pad.net === plane.net ? 0 : clearanceFor(pad.net)) - EPSILON) return false
    }
    for (const track of copper.tracks) {
      if (track.net === plane.net || !viaLayers.includes(track.layer)) continue
      const clearance = radius + track.widthMm / 2 + clearanceFor(track.net)
      if (track.points.slice(1).some((end, index) =>
        distanceToSegment(point, track.points[index], end) < clearance - EPSILON)) return false
    }
    for (const via of [...copper.vias, ...accepted]) {
      const distance = Math.hypot(point.x - via.at.x, point.y - via.at.y)
      const clearance = radius + via.diameterMm / 2 + (via.net === plane.net ? 0 : clearanceFor(via.net))
      if (distance < clearance - EPSILON) return false
      const holeClearance = rules.holeToHoleClearanceMm ?? rules.clearanceMm
      if (distance < viaRule.drillMm / 2 + via.drillMm / 2 + holeClearance - EPSILON) return false
    }
    return true
  }
  const padSeesVia = (pad: RoutingBoard["pads"][number], via: RoutedVia) => {
    const start = pad.at
    const end = via.at
    if (via.net !== plane.net) return false
    if (Math.hypot(end.x - start.x, end.y - start.y) > stitching.maxPadViaDistanceMm) return false
    const from = viaLayers.indexOf(via.fromLayer)
    const to = viaLayers.indexOf(via.toLayer)
    const span = via.type === "through" ? viaLayers : viaLayers.slice(Math.min(from, to), Math.max(from, to) + 1)
    // A visible connection must exist on a pad-bearing plane layer. Obstacles
    // on other layers still block the via itself, but not this copper path.
    return planeLayers.filter((layer) => pad.layers.includes(layer) && span.includes(layer)).some((layer) => {
      const corridor = (plane.zone?.minThicknessMm ?? ROUTER_ZONE_MIN_THICKNESS_MM) / 2
      const rings = [board.outline, ...board.cutouts]
      if (rings.some((ring) => ring.some((point, index) => distanceBetweenSegments(
        start, end, point, ring[(index + 1) % ring.length],
      ) < corridor - EPSILON))) return false
      if (board.keepouts.some((keepout) => keepout.forbid.zones && keepout.layers.includes(layer)
        && (pointInRing(start, keepout.polygon.outer) || pointInRing(end, keepout.polygon.outer)
          || keepout.polygon.outer.some((point, index) => distanceBetweenSegments(
            start, end, point, keepout.polygon.outer[(index + 1) % keepout.polygon.outer.length],
          ) < corridor + EPSILON)))) return false
      for (const track of copper.tracks) {
        if (track.net === plane.net || track.layer !== layer) continue
        const clearance = track.widthMm / 2 + Math.max(clearanceFor(track.net), plane.zone?.clearanceMm ?? 0) + corridor
        if (track.points.slice(1).some((point, index) => distanceBetweenSegments(
          start, end, track.points[index], point,
        ) < clearance - EPSILON)) return false
      }
      for (const zone of zones.filter((zone) => zone.net !== plane.net && zone.layers.includes(layer))) {
        const clearance = Math.max(clearanceFor(zone.net), zone.clearanceMm ?? 0, plane.zone?.clearanceMm ?? 0) + corridor
        if (foreignZoneBlocksCircle(start, plane.net, [layer], 0, clearance, [zone])
          || [zone.outline.outer, ...(zone.outline.holes ?? [])].some((ring) => ring.some((point, index) =>
            distanceBetweenSegments(start, end, point, ring[(index + 1) % ring.length]) < clearance - EPSILON))) return false
      }
      // Pad silhouettes and drill/via clearances are checked along the whole
      // corridor. Half-step inflation covers the space between samples.
      const count = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 0.1))
      const margin = corridor + Math.hypot(end.x - start.x, end.y - start.y) / count / 2
      for (let i = 0; i <= count; i += 1) {
        const point = { x: start.x + (end.x - start.x) * i / count, y: start.y + (end.y - start.y) * i / count }
        if (board.pads.some((other) => other.net !== plane.net && other.layers.includes(layer)
          && distanceToPad(point, other) < margin + Math.max(clearanceFor(other.net), plane.zone?.clearanceMm ?? 0) - EPSILON)) return false
        if (board.pads.some((other) => {
          if (other === pad) return false
          const hole = padHoleGeometry(other)
          return hole && distanceToPadHoleCenterline(point, hole) < hole.radiusMm + margin - EPSILON
        })) return false
        if (copper.vias.some((other) => other.net !== plane.net
          && Math.hypot(point.x - other.at.x, point.y - other.at.y)
            < margin + other.diameterMm / 2 + Math.max(clearanceFor(other.net), plane.zone?.clearanceMm ?? 0) - EPSILON)) return false
      }
      return true
    })
  }
  const makeVia = (point: PointMm): RoutedVia => ({
    net: plane.net, at: { ...point }, diameterMm: viaRule.diameterMm, drillMm: viaRule.drillMm,
    fromLayer: viaLayers[0], toLayer: viaLayers.at(-1)!, type: "through",
  })
  const add = (point: PointMm, ownerPad?: RoutingBoard["pads"][number]) => {
    if (accepted.length >= MAX_GENERATED_STITCHING_VIAS_PER_INTENT || !candidateAllowed(point, ownerPad)) return false
    accepted.push({
      net: plane.net,
      at: { ...point },
      diameterMm: viaRule.diameterMm,
      drillMm: viaRule.drillMm,
      fromLayer: viaLayers[0],
      toLayer: viaLayers.at(-1)!,
      type: "through",
    })
    return true
  }
  // Pad-local connections take priority over the background plane grid.
  for (const pad of board.pads.filter((candidate) => plane.zone?.padConnection?.mode !== "none"
    && candidate.net === plane.net
    && candidate.layers.some((layer) => planeLayers.includes(layer))
    && pointInRing(candidate.at, board.outline)
    && !board.cutouts.some((ring) => pointInRing(candidate.at, ring)))) {
    if ([...copper.vias, ...accepted].some((via) => padSeesVia(pad, via))) continue
    if (stitching.viaInPad && !pad.hole && add(pad.at, pad)) continue
    let placed = false
    const maximum = stitching.maxPadViaDistanceMm
    const radialStep = Math.min(0.1, radius / 2)
    const minimum = radius + (pad.shape.kind === "circle" ? pad.shape.diameterMm / 2
      : pad.shape.kind === "polygon" ? 0 : Math.min(pad.shape.widthMm, pad.shape.heightMm) / 2)
    const steps = Math.max(0, Math.ceil((maximum - minimum) / radialStep))
    for (let stepIndex = 0; minimum <= maximum + EPSILON && stepIndex <= steps
      && !placed && accepted.length < MAX_GENERATED_STITCHING_VIAS_PER_INTENT; stepIndex += 1) {
      const distance = Math.min(maximum, minimum + stepIndex * radialStep)
      const directions = Math.max(32, Math.ceil(2 * Math.PI * distance / 0.1))
      for (let direction = 0; direction < directions; direction += 1) {
        const angle = 2 * Math.PI * direction / directions + pad.rotationDeg * Math.PI / 180
        const at = { x: pad.at.x + distance * Math.cos(angle), y: pad.at.y + distance * Math.sin(angle) }
        if (!candidateAllowed(at) || !padSeesVia(pad, makeVia(at))) continue
        placed = add(at)
        if (placed) break
      }
    }
    if (!placed) diagnostics.push({
      code: "PLANE_STITCH_PAD_NOT_PLACED", severity: "warning",
      message: `Plane ${plane.net} could not place a visible via within ${maximum} mm of ${pad.component}.${pad.number}.`,
      details: { net: plane.net, component: pad.component, pad: pad.number, at: pad.at, maxDistanceMm: maximum },
    })
  }
  const step = stitching.gridMm
  for (let y = Math.min(...ys) + step / 2; y <= Math.max(...ys); y += step) {
    for (let x = Math.min(...xs) + step / 2; x <= Math.max(...xs); x += step) add({ x, y })
  }
  return accepted
}

export function planRoutingCopper(
  board: RoutingBoard,
  program: RoutingProgram,
  rules: RoutingRules,
  phases: Readonly<{ compact?: boolean; planes?: boolean }> = { compact: true, planes: true },
): PlannedRoutingCopper {
  const diagnostics: RoutingDiagnostic[] = []
  const zones: RoutedZone[] = []
  const vias: RoutedVia[] = []
  const groups: Array<{
    net: string
    pads: Array<{ component: string; pad: string }>
  }> = []
  let compactPlans = 0
  let compactReady = 0
  if (phases.compact !== false && program.polygons.length) {
    const result = planPolygons(routingBoardToPolygonScene(board), polygonProgramWithPowerPadTargets(program), {
      rulesForNet: (net) => {
        const value = valuesForNet(rules, net)
        return {
          obstacleClearanceMm: value.clearanceMm,
          // Polygon feasibility always starts from one fixed manufacturable
          // corridor. Power-current width must not inflate the search graph.
          minimumCorridorWidthMm: DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM,
        }
      },
    })
    compactPlans = result.plans.length
    result.plans.forEach((plan, index) => {
      if (plan.status !== "ready" || !plan.boundary) {
        diagnostics.push({
          code: plan.status === "error" ? "POLYGON_PLAN_ERROR" : "POLYGON_PLAN_SKIPPED",
          severity: plan.status === "error" ? "error" : "warning",
          message: plan.reason ?? `Compact polygon ${plan.net} was not produced.`,
          details: { net: plan.net, layer: plan.layer },
        })
        return
      }
      compactReady += 1
      const values = valuesForNet(rules, plan.net)
      zones.push({
        id: `compact:${index}:${plan.net}:${plan.layer}`,
        net: plan.net,
        layers: [plan.layer],
        outline: { outer: plan.boundary },
        priority: ROUTER_COMPACT_ZONE_PRIORITY_BASE + index,
        ...routedZoneOptions(plan.intent.zone, values),
      })
      groups.push({
        net: plan.net,
        pads: plan.targetPads.map((pad) => ({ component: pad.component ?? "", pad: pad.padNumber })),
      })
    })
  }
  let planeZones = 0
  for (const [index, plane] of (phases.planes === false ? [] : program.planes).entries()) {
    if (plane.region.kind !== "board") continue
    const layers = selectedLayers(board, plane.layers)
    const values = valuesForNet(rules, plane.net)
    zones.push({
      id: `plane:${index}:${plane.net}`,
      net: plane.net,
      layers,
      outline: { outer: board.outline, holes: board.cutouts },
      priority: isGroundNetName(plane.net)
        ? 0
        : ROUTER_COMPACT_ZONE_PRIORITY_BASE,
      ...routedZoneOptions(plane.zone, values),
    })
    planeZones += 1
    vias.push(...stitchingCandidates(board, plane, values, zones, rules, diagnostics, vias))
  }
  return {
    copper: { tracks: [], vias, zones },
    connectivity: { preconnectedPadGroups: groups },
    diagnostics,
    metrics: { compactPlans, compactReady, planeZones, stitchingVias: vias.length },
  }
}
