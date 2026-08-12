import { randomUUID } from "node:crypto"
import {
  atom,
  findChild,
  isSExpressionList,
  listHead,
  token,
  type SExpression,
} from "../../kicad-copilot/src/kicad/sexpr/ast"
import {
  childText,
  listChildren,
  pcbNetNames,
} from "../../kicad-copilot/src/kicad/pcb-reader"
import { boardOutline } from "../../kicad-copilot/src/pcb/router-adapter"
import {
  netClassFor,
  type PcbRoutingRules,
} from "../../kicad-copilot/src/pcb/router-rules"
import type {
  PlaneIntent,
  PolygonLayerSelector,
} from "./polygon/dsl"
import {
  ringsFromRawPad,
  ringsFromRawPolygon,
} from "./polygon/engine"
import { kicadToRawPcb } from "./polygon/kicad-adapter"
import type { PcbPoint } from "./polygon/raw-pcb"

type Point = PcbPoint

export type PlaneStitchingManifest = {
  version: 1
  planesRequested: number
  zonesAdded: number
  unsupportedRegions: Array<{ net: string; kind: "components"; designators: string[] }>
  generatedViaUuids: string[]
  gridVias: number
  padVias: number
  padsCoveredByVisibleVia: number
  pthPadsSkipped: number
  padViaFailures: Array<{ component?: string; padNumber: string; reason: string }>
  viaDiameterMm: number
  viaDrillMm: number
}

export type PlaneStitchingCleanup = {
  expected: number
  removed: number
  removedUuids: string[]
}

const EPSILON = 1e-6

function numberAt(node: SExpression[] | undefined, index: number, fallback = 0) {
  const value = Number(atom(node?.[index]))
  return Number.isFinite(value) ? value : fallback
}

function pointAt(node: SExpression[] | undefined): Point {
  return { x: numberAt(node, 1), y: numberAt(node, 2) }
}

function itemUuid(node: SExpression[]) {
  return childText(node, "uuid") ?? childText(node, "tstamp") ?? ""
}

function nodeNetName(root: SExpression[], node: SExpression[]) {
  const net = findChild(node, "net")
  if (!net) return ""
  if (net.length >= 3) return atom(net[2]) ?? ""
  const value = atom(net[1]) ?? ""
  if (!/^\d+$/.test(value)) return value
  return atom(listChildren(root, "net").find((item) => atom(item[1]) === value)?.[2]) ?? ""
}

function kicadLayer(name: string) {
  if (name === "TOP") return "F.Cu"
  if (name === "BOTTOM") return "B.Cu"
  const inner = /^INNER_(\d+)$/.exec(name)
  return inner ? `In${inner[1]}.Cu` : name
}

function selectedLayers(selector: PolygonLayerSelector) {
  if (selector.kind === "outer") return ["F.Cu", "B.Cu"]
  if (selector.kind === "top") return ["F.Cu"]
  if (selector.kind === "bottom") return ["B.Cu"]
  return selector.names.map(kicadLayer)
}

function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]
    const b = polygon[previous]
    if (((a.y > point.y) !== (b.y > point.y))
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function distancePointToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length2 = dx * dx + dy * dy
  if (length2 <= EPSILON * EPSILON) return Math.hypot(point.x - start.x, point.y - start.y)
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length2))
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy)
}

function orientation(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function onSegment(point: Point, start: Point, end: Point) {
  return Math.abs(orientation(start, end, point)) <= EPSILON
    && point.x >= Math.min(start.x, end.x) - EPSILON
    && point.x <= Math.max(start.x, end.x) + EPSILON
    && point.y >= Math.min(start.y, end.y) - EPSILON
    && point.y <= Math.max(start.y, end.y) + EPSILON
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
    && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) return true
  return (Math.abs(abC) <= EPSILON && onSegment(c, a, b))
    || (Math.abs(abD) <= EPSILON && onSegment(d, a, b))
    || (Math.abs(cdA) <= EPSILON && onSegment(a, c, d))
    || (Math.abs(cdB) <= EPSILON && onSegment(b, c, d))
}

function distanceSegmentToSegment(a: Point, b: Point, c: Point, d: Point) {
  if (segmentsIntersect(a, b, c, d)) return 0
  return Math.min(
    distancePointToSegment(a, c, d),
    distancePointToSegment(b, c, d),
    distancePointToSegment(c, a, b),
    distancePointToSegment(d, a, b),
  )
}

function arcPoints(node: SExpression[]) {
  const start = pointAt(findChild(node, "start"))
  const mid = pointAt(findChild(node, "mid"))
  const end = pointAt(findChild(node, "end"))
  const determinant = 2 * (
    start.x * (mid.y - end.y)
    + mid.x * (end.y - start.y)
    + end.x * (start.y - mid.y)
  )
  if (Math.abs(determinant) < EPSILON) return [start, mid, end]
  const start2 = start.x ** 2 + start.y ** 2
  const mid2 = mid.x ** 2 + mid.y ** 2
  const end2 = end.x ** 2 + end.y ** 2
  const center = {
    x: (start2 * (mid.y - end.y) + mid2 * (end.y - start.y) + end2 * (start.y - mid.y)) / determinant,
    y: (start2 * (end.x - mid.x) + mid2 * (end.y - start.y) + end2 * (mid.x - start.x)) / determinant,
  }
  const angle = (point: Point) => Math.atan2(point.y - center.y, point.x - center.x)
  const tau = Math.PI * 2
  const normalized = (value: number) => ((value % tau) + tau) % tau
  const from = angle(start)
  let to = angle(end)
  const ccwSpan = normalized(to - from)
  const ccwMid = normalized(angle(mid) - from)
  if (ccwMid > ccwSpan) {
    while (to >= from) to -= tau
  } else {
    while (to <= from) to += tau
  }
  const radius = Math.hypot(start.x - center.x, start.y - center.y)
  const count = Math.max(2, Math.ceil(Math.abs(to - from) * radius / 0.25))
  return Array.from({ length: count + 1 }, (_, index) => {
    const current = from + (to - from) * index / count
    return { x: center.x + Math.cos(current) * radius, y: center.y + Math.sin(current) * radius }
  })
}

function distancePointToRing(point: Point, ring: Point[]) {
  if (pointInPolygon(point, ring)) return 0
  return ring.reduce((minimum, start, index) => Math.min(
    minimum,
    distancePointToSegment(point, start, ring[(index + 1) % ring.length]),
  ), Infinity)
}

function segmentHitsRing(start: Point, end: Point, ring: Point[], clearance: number) {
  if (pointInPolygon(start, ring) || pointInPolygon(end, ring)) return true
  return ring.some((point, index) => distanceSegmentToSegment(
    start,
    end,
    point,
    ring[(index + 1) % ring.length],
  ) < clearance - EPSILON)
}

function farFromOutline(point: Point, outline: ReturnType<typeof boardOutline>, margin: number) {
  if (!pointInPolygon(point, outline.points)) return false
  if (outline.holes.some((hole) => pointInPolygon(point, hole))) return false
  const rings = [outline.points, ...outline.holes]
  return rings.every((ring) => ring.every((start, index) => (
    distancePointToSegment(point, start, ring[(index + 1) % ring.length]) >= margin - EPSILON
  )))
}

function resolvedRule(rules: PcbRoutingRules, net: string) {
  const className = netClassFor(rules, net)
  const item = rules.classes.find((entry) => entry.name === className)
    ?? rules.classes.find((entry) => entry.name === "Default")
    ?? {
      name: "Default",
      clearance: 0.2,
      trackWidth: 0.25,
      viaDiameter: 0.6,
      viaDrill: 0.3,
      diffPairWidth: 0.25,
      diffPairGap: 0.2,
    }
  const viaDrill = rules.minimumViaDrill > 0 ? rules.minimumViaDrill : item.viaDrill
  const minimumDiameter = rules.minimumViaDiameter > 0 ? rules.minimumViaDiameter : item.viaDiameter
  return {
    clearance: Math.max(rules.minimumClearance, item.clearance),
    edgeClearance: Math.max(rules.copperEdgeClearance, rules.minimumClearance, item.clearance),
    viaDrill,
    viaDiameter: Math.max(minimumDiameter, viaDrill + rules.minimumViaAnnularWidth * 2),
  }
}

function makeZone(
  net: string,
  layers: string[],
  boundary: Point[],
  priority: number,
  clearance: number,
  minThickness: number,
) {
  return [
    token("zone"),
    [token("net"), token(net, true)],
    layers.length === 1
      ? [token("layer"), token(layers[0], true)]
      : [token("layers"), ...layers.map((layer) => token(layer, true))],
    [token("uuid"), token(randomUUID(), true)],
    [token("name"), token(`copilot-router:plane:${net}`, true)],
    [token("hatch"), token("edge"), token("0.5")],
    ...(priority > 0 ? [[token("priority"), token(String(priority))] as SExpression[]] : []),
    [token("connect_pads"), token("yes"), [token("clearance"), token(String(clearance))]],
    [token("min_thickness"), token(String(minThickness))],
    [
      token("fill"), token("yes"),
      [token("thermal_gap"), token(String(Math.max(clearance, 0.2)))],
      [token("thermal_bridge_width"), token(String(Math.max(minThickness * 3, 0.3)))],
      // KiCad removes any plane island that the grid/via-in-pad pass did not
      // connect. Such copper cannot provide a usable return path.
      [token("island_removal_mode"), token("0")],
    ],
    [token("polygon"), [
      token("pts"),
      ...boundary.map((point) => [token("xy"), token(String(point.x)), token(String(point.y))] as SExpression[]),
    ]],
  ] as SExpression[]
}

function makeVia(point: Point, net: string, diameter: number, drill: number, uuid: string) {
  return [
    token("via"),
    [token("at"), token(String(point.x)), token(String(point.y))],
    [token("size"), token(String(diameter))],
    [token("drill"), token(String(drill))],
    [token("layers"), token("F.Cu", true), token("B.Cu", true)],
    [token("net"), token(net, true)],
    [token("uuid"), token(uuid, true)],
  ] as SExpression[]
}

function managedGroupName(net: string) {
  return `copilot-router:stitch:${net}`
}

function keepoutRings(root: SExpression[]) {
  const rings: Point[][] = []
  const walk = (value: SExpression) => {
    if (!isSExpressionList(value)) return
    if ((listHead(value) === "zone" || listHead(value) === "rule_area") && findChild(value, "keepout")) {
      for (const polygon of listChildren(value, "polygon")) {
        const points = listChildren(findChild(polygon, "pts") ?? [], "xy").map(pointAt)
        if (points.length >= 3) rings.push(points)
      }
    }
    for (const child of value) walk(child)
  }
  for (const child of root) walk(child)
  return rings
}

function drillDiameter(data: Array<string | number> | undefined) {
  const values = (data ?? []).map(Number).filter((value) => Number.isFinite(value) && value > 0)
  return values.length ? Math.max(...values) : 0
}

function viaInPadCandidates(pad: Parameters<typeof ringsFromRawPad>[0], diameter: number) {
  const rings = ringsFromRawPad(pad)
  const candidates: Point[] = [{ x: pad.x, y: pad.y }]
  const radius = diameter / 2
  for (const ring of rings) {
    const xs = ring.map((point) => point.x)
    const ys = ring.map((point) => point.y)
    const left = Math.min(...xs) + radius
    const right = Math.max(...xs) - radius
    const top = Math.min(...ys) + radius
    const bottom = Math.max(...ys) - radius
    if (left > right || top > bottom) continue
    for (const y of [pad.y, top, bottom, (top + bottom) / 2]) {
      for (const x of [pad.x, left, right, (left + right) / 2]) {
        const point = { x, y }
        if (distancePointToRing(point, ring) === 0
          && ring.every((start, index) => distancePointToSegment(
            point,
            start,
            ring[(index + 1) % ring.length],
          ) >= radius - EPSILON)) candidates.push(point)
      }
    }
  }
  return candidates
    .sort((left, right) => Math.hypot(left.x - pad.x, left.y - pad.y)
      - Math.hypot(right.x - pad.x, right.y - pad.y))
    .filter((point, index, all) => all.findIndex((other) => (
      Math.hypot(point.x - other.x, point.y - other.y) < EPSILON
    )) === index)
}

/**
 * Add board-wide native planes and a cheap, deterministic stitching pass.
 *
 * Component bodies/courtyards are deliberately not obstacles. Exact native
 * copper, pads, holes, keepouts, tracks, vias, and board edges are.
 */
export function applyPlaneStitching(
  root: SExpression[],
  planes: readonly PlaneIntent[],
  rules: PcbRoutingRules,
  options: { holeToHoleMm?: number } = {},
): PlaneStitchingManifest {
  const raw = kicadToRawPcb(root, { includeZones: true })
  const outline = boardOutline(root)
  const knownNets = new Set(pcbNetNames(root))
  const keepouts = keepoutRings(root)
  const generatedViaUuids: string[] = []
  const unsupportedRegions: PlaneStitchingManifest["unsupportedRegions"] = []
  const padViaFailures: PlaneStitchingManifest["padViaFailures"] = []
  let zonesAdded = 0
  let gridVias = 0
  let padVias = 0
  let padsCoveredByVisibleVia = 0
  let pthPadsSkipped = 0
  let lastViaDiameter = 0
  let lastViaDrill = 0

  for (const plane of planes) {
    if (!knownNets.has(plane.net)) {
      padViaFailures.push({ padNumber: "", reason: `plane net does not exist: ${plane.net}` })
      continue
    }
    if (plane.region.kind !== "board") {
      unsupportedRegions.push({ net: plane.net, kind: "components", designators: plane.region.designators })
      continue
    }
    const layerNames = selectedLayers(plane.layers)
    const native = resolvedRule(rules, plane.net)
    lastViaDiameter = native.viaDiameter
    lastViaDrill = native.viaDrill
    root.push(makeZone(
      plane.net,
      layerNames,
      outline.points,
      plane.priority,
      native.clearance,
      Math.max(rules.minimumTrackWidth, 0.05),
    ))
    zonesAdded += 1
    if (!plane.stitching || plane.stitching.maxVias === 0) continue

    const viaRadius = native.viaDiameter / 2
    const viaDrillRadius = native.viaDrill / 2
    const holeToHole = Math.max(options.holeToHoleMm ?? native.clearance, 0.001)
    const existingVias = raw.vias.map((via) => ({ ...via, point: { x: via.x, y: via.y } }))
    const selectedRawLayers = new Set(layerNames.map((layer) => (
      layer === "F.Cu" ? "TOP" : layer === "B.Cu" ? "BOTTOM" : layer.replace(/^In/, "INNER_").replace(/\.Cu$/, "")
    )))
    const padRings = raw.pads.map((pad) => ({ pad, rings: ringsFromRawPad(pad) }))
    const foreignPolygons = raw.polygons
      .filter((polygon) => polygon.net !== plane.net && selectedRawLayers.has(polygon.layer))
      .flatMap((polygon) => ringsFromRawPolygon(polygon).map((ring) => ({ net: polygon.net, ring })))
    const copperSegments = [
      ...listChildren(root, "segment").map((segment) => ({
        net: nodeNetName(root, segment),
        layer: childText(segment, "layer") ?? "F.Cu",
        width: numberAt(findChild(segment, "width"), 1, 0.2),
        points: [pointAt(findChild(segment, "start")), pointAt(findChild(segment, "end"))],
      })),
      ...listChildren(root, "arc").map((arc) => ({
        net: nodeNetName(root, arc),
        layer: childText(arc, "layer") ?? "F.Cu",
        width: numberAt(findChild(arc, "width"), 1, 0.2),
        points: arcPoints(arc),
      })),
    ].filter((item) => layerNames.includes(item.layer))

    const accepted: Array<{ point: Point; kind: "grid" | "pad" }> = []
    const planeUuids: string[] = []
    const candidateAllowed = (point: Point, allowPadId?: string) => {
      if (!farFromOutline(point, outline, native.edgeClearance + viaRadius)) return false
      if (keepouts.some((ring) => distancePointToRing(point, ring) < viaRadius + native.clearance)) return false
      if (foreignPolygons.some((item) => distancePointToRing(point, item.ring)
        < viaRadius + Math.max(native.clearance, resolvedRule(rules, item.net).clearance))) return false
      for (const { pad, rings } of padRings) {
        const owner = allowPadId && pad.id === allowPadId
        const sameNet = pad.net === plane.net
        const copperClearance = viaRadius + Math.max(native.clearance, resolvedRule(rules, pad.net).clearance)
        if (!owner && !sameNet
          && rings.some((ring) => distancePointToRing(point, ring) < copperClearance - EPSILON)) return false
        const hole = drillDiameter(pad.hole?.data)
        if (hole > 0 && Math.hypot(point.x - pad.x, point.y - pad.y)
          < hole / 2 + viaDrillRadius + holeToHole - EPSILON) return false
      }
      for (const track of copperSegments) {
        if (track.net === plane.net) continue
        const clearance = viaRadius + track.width / 2
          + Math.max(native.clearance, resolvedRule(rules, track.net).clearance)
        if (track.points.some((start, index) => index + 1 < track.points.length
          && distancePointToSegment(point, start, track.points[index + 1]) < clearance - EPSILON)) return false
      }
      for (const via of existingVias) {
        const centerDistance = Math.hypot(point.x - via.x, point.y - via.y)
        if (centerDistance < viaDrillRadius + via.drill / 2 + holeToHole - EPSILON) return false
        if (via.net !== plane.net && centerDistance < viaRadius + via.diameter / 2 + native.clearance - EPSILON) return false
      }
      if (accepted.some((via) => Math.hypot(point.x - via.point.x, point.y - via.point.y)
        < native.viaDrill + holeToHole - EPSILON)) return false
      return true
    }

    const addVia = (point: Point, kind: "grid" | "pad") => {
      if (planeUuids.length >= plane.stitching!.maxVias) return false
      const uuid = randomUUID()
      root.push(makeVia(point, plane.net, native.viaDiameter, native.viaDrill, uuid))
      generatedViaUuids.push(uuid)
      planeUuids.push(uuid)
      accepted.push({ point, kind })
      if (kind === "grid") gridVias += 1
      else padVias += 1
      return true
    }

    const xs = outline.points.map((point) => point.x)
    const ys = outline.points.map((point) => point.y)
    const left = Math.min(...xs)
    const right = Math.max(...xs)
    const top = Math.min(...ys)
    const bottom = Math.max(...ys)
    const grid = plane.stitching.gridMm
    for (let y = top + native.edgeClearance + viaRadius; y <= bottom; y += grid) {
      for (let x = left + native.edgeClearance + viaRadius; x <= right; x += grid) {
        if (planeUuids.length >= plane.stitching.maxVias) break
        const point = { x, y }
        if (candidateAllowed(point)) addVia(point, "grid")
      }
      if (planeUuids.length >= plane.stitching.maxVias) break
    }

    const lineVisible = (padId: string | undefined, start: Point, end: Point) => {
      if (!farFromOutline(end, outline, native.edgeClearance + viaRadius)) return false
      const samples = Math.max(2, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 0.5))
      for (let index = 0; index <= samples; index += 1) {
        const t = index / samples
        const point = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }
        if (!pointInPolygon(point, outline.points)
          || outline.holes.some((hole) => pointInPolygon(point, hole))) return false
      }
      if (keepouts.some((ring) => segmentHitsRing(start, end, ring, native.clearance))) return false
      if (outline.holes.some((hole) => segmentHitsRing(start, end, hole, EPSILON))) return false
      if (foreignPolygons.some((item) => segmentHitsRing(
        start,
        end,
        item.ring,
        Math.max(native.clearance, resolvedRule(rules, item.net).clearance),
      ))) return false
      for (const { pad, rings } of padRings) {
        if (pad.id === padId || pad.net === plane.net) continue
        if (rings.some((ring) => segmentHitsRing(
          start,
          end,
          ring,
          Math.max(native.clearance, resolvedRule(rules, pad.net).clearance),
        ))) return false
      }
      for (const track of copperSegments) {
        if (track.net === plane.net) continue
        const clearance = track.width / 2 + Math.max(native.clearance, resolvedRule(rules, track.net).clearance)
        if (track.points.some((point, index) => index + 1 < track.points.length
          && distanceSegmentToSegment(start, end, point, track.points[index + 1]) < clearance - EPSILON)) return false
      }
      for (const via of existingVias) {
        if (via.net === plane.net) continue
        if (distancePointToSegment(via.point, start, end) < via.diameter / 2 + native.clearance - EPSILON) return false
      }
      return true
    }

    const allVisibleVias = () => [
      ...existingVias.filter((via) => via.net === plane.net).map((via) => via.point),
      ...raw.pads.filter((pad) => pad.net === plane.net && pad.hole).map((pad) => ({ x: pad.x, y: pad.y })),
      ...accepted.map((item) => item.point),
    ]
    for (const pad of raw.pads) {
      if (pad.net !== plane.net || pad.hole) {
        if (pad.net === plane.net && pad.hole) pthPadsSkipped += 1
        continue
      }
      if (!(pad.layer === "MULTI" || selectedRawLayers.has(pad.layer))) continue
      const visible = allVisibleVias().some((via) => (
        Math.hypot(via.x - pad.x, via.y - pad.y) <= plane.stitching!.maxPadViaDistanceMm + EPSILON
        && lineVisible(pad.id, pad, via)
      ))
      if (visible) {
        padsCoveredByVisibleVia += 1
        continue
      }
      if (!plane.stitching.viaInPad) {
        padViaFailures.push({ component: pad.component, padNumber: pad.padNumber, reason: "no visible via within limit" })
        continue
      }
      const viaPoint = viaInPadCandidates(pad, native.viaDiameter)
        .find((point) => candidateAllowed(point, pad.id))
      if (!viaPoint) {
        padViaFailures.push({ component: pad.component, padNumber: pad.padNumber, reason: "via-in-pad violates a geometric obstacle" })
        continue
      }
      if (!addVia(viaPoint, "pad")) {
        padViaFailures.push({ component: pad.component, padNumber: pad.padNumber, reason: "plane stitching maxVias exhausted" })
      }
    }

    if (accepted.length) {
      root.push([
        token("group"), token(managedGroupName(plane.net), true),
        [token("uuid"), token(randomUUID(), true)],
        [token("members"), ...planeUuids.map((uuid) => token(uuid, true))],
      ])
    }
  }

  return {
    version: 1,
    planesRequested: planes.length,
    zonesAdded,
    unsupportedRegions,
    generatedViaUuids,
    gridVias,
    padVias,
    padsCoveredByVisibleVia,
    pthPadsSkipped,
    padViaFailures,
    viaDiameterMm: lastViaDiameter,
    viaDrillMm: lastViaDrill,
  }
}

function errorViolationUuids(report: unknown) {
  const root = report && typeof report === "object" ? report as Record<string, unknown> : {}
  const output = new Set<string>()
  for (const violation of Array.isArray(root.violations) ? root.violations : []) {
    if (!violation || typeof violation !== "object") continue
    const item = violation as Record<string, unknown>
    if (item.severity !== "error") continue
    for (const subject of Array.isArray(item.items) ? item.items : []) {
      if (!subject || typeof subject !== "object") continue
      const uuid = (subject as Record<string, unknown>).uuid
      if (typeof uuid === "string") output.add(uuid)
    }
  }
  return output
}

/** Remove only generated stitching vias explicitly named by native KiCad errors. */
export function removeInvalidPlaneVias(
  root: SExpression[],
  manifest: PlaneStitchingManifest,
  report: unknown,
): PlaneStitchingCleanup {
  const generated = new Set(manifest.generatedViaUuids)
  const invalid = errorViolationUuids(report)
  const removedUuids: string[] = []
  for (let index = root.length - 1; index >= 0; index -= 1) {
    const item = root[index]
    if (!isSExpressionList(item) || listHead(item) !== "via") continue
    const uuid = itemUuid(item)
    if (!generated.has(uuid) || !invalid.has(uuid)) continue
    root.splice(index, 1)
    removedUuids.push(uuid)
  }
  if (removedUuids.length) {
    const removed = new Set(removedUuids)
    for (const group of listChildren(root, "group")) {
      const members = findChild(group, "members")
      if (!members) continue
      for (let index = members.length - 1; index >= 1; index -= 1) {
        if (removed.has(atom(members[index]) ?? "")) members.splice(index, 1)
      }
    }
  }
  return {
    expected: manifest.generatedViaUuids.length,
    removed: removedUuids.length,
    removedUuids: removedUuids.sort(),
  }
}
