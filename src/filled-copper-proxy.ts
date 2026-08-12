import { randomUUID } from "node:crypto"
import ClipperLib from "clipper-lib"
import {
  atom,
  findChild,
  isSExpressionList,
  listHead,
  token,
  type SExpression,
} from "../../kicad-copilot/src/kicad/sexpr/ast"
import { childText, listChildren } from "../../kicad-copilot/src/kicad/pcb-reader"
import { kicadToRawPcb } from "./polygon/kicad-adapter"

type Point = { x: number; y: number }

export type FilledCopperProxyComponent = {
  net: string
  layer: string
  filledPolygonIndex: number
  sourceVertices: number
  proxySegments: number
}

export type FilledCopperProxyManifest = {
  version: 1
  widthMm: number
  pitchMm: number
  zoneCount: number
  filledPolygonCount: number
  zonesWithoutNativeFill: Array<{ net: string; layer: string }>
  segmentUuids: string[]
  components: FilledCopperProxyComponent[]
}

export type FilledCopperProxyRemoval = {
  expected: number
  removed: number
  missingUuids: string[]
}

export type FilledCopperPad = {
  component: string
  padNumber: string
  x: number
  y: number
}

export type FilledCopperPadGroup = {
  net: string
  layer: string
  pads: FilledCopperPad[]
  representative: FilledCopperPad
  redundantPads: FilledCopperPad[]
}

const SCALE = 1_000_000
const EPSILON = 1 / SCALE

function numberAt(node: SExpression[] | undefined, index: number, fallback = 0) {
  const value = Number(atom(node?.[index]))
  return Number.isFinite(value) ? value : fallback
}

function pointAt(node: SExpression[] | undefined): Point {
  return { x: numberAt(node, 1), y: numberAt(node, 2) }
}

function nodeNetName(root: SExpression[], node: SExpression[]) {
  const net = findChild(node, "net")
  if (!net) return ""
  if (net.length >= 3) return atom(net[2]) ?? ""
  const value = atom(net[1]) ?? ""
  if (!/^\d+$/.test(value)) return value
  return atom(listChildren(root, "net").find((item) => atom(item[1]) === value)?.[2]) ?? ""
}

function cleanRing(points: Point[]) {
  const output: Point[] = []
  for (const point of points) {
    const previous = output.at(-1)
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > EPSILON) output.push(point)
  }
  if (output.length > 1 && Math.hypot(output[0].x - output.at(-1)!.x, output[0].y - output.at(-1)!.y) <= EPSILON) {
    output.pop()
  }
  return output
}

function sourcePoints(source: Array<string | number>) {
  const points: Point[] = []
  for (let index = 0; index + 1 < source.length; index += 1) {
    if (typeof source[index] !== "number" || typeof source[index + 1] !== "number") continue
    points.push({ x: source[index] as number, y: source[index + 1] as number })
    index += 1
  }
  return cleanRing(points)
}

function pointInRing(point: Point, ring: Point[]) {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index]
    const b = ring[previous]
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x)
    if (Math.abs(cross) <= 1e-6
      && point.x >= Math.min(a.x, b.x) - 1e-6 && point.x <= Math.max(a.x, b.x) + 1e-6
      && point.y >= Math.min(a.y, b.y) - 1e-6 && point.y <= Math.max(a.y, b.y) + 1e-6) return true
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function padKey(pad: FilledCopperPad) {
  return `${pad.component}\u0000${pad.padNumber}`
}

/** Native filled-copper components expressed as terminal equivalence groups. */
export function filledCopperPadGroups(root: SExpression[]): FilledCopperPadGroup[] {
  const raw = kicadToRawPcb(root, { includeZones: true })
  const padByKey = new Map(raw.pads.map((pad) => [
    `${pad.component}\u0000${pad.padNumber}`,
    { component: pad.component, padNumber: pad.padNumber, x: pad.x, y: pad.y },
  ] as const))
  const candidates = raw.polygons.flatMap((polygon) => polygon.sources.flatMap((source) => {
    const ring = sourcePoints(source)
    if (ring.length < 3) return []
    const pads = raw.pads
      .filter((pad) => pad.net === polygon.net
        && (pad.layer === "MULTI" || pad.layer === polygon.layer)
        && pointInRing(pad, ring))
      .map((pad) => padByKey.get(`${pad.component}\u0000${pad.padNumber}`)!)
    return pads.length >= 2 ? [{ net: polygon.net, layer: String(polygon.layer), pads }] : []
  }))

  // Native refill may encode one electrical island as overlapping contours.
  // Merge only groups that share an actual pad; never hull disjoint islands.
  const merged: typeof candidates = []
  for (const candidate of candidates) {
    const keys = new Set(candidate.pads.map(padKey))
    const overlaps = merged.filter((group) => group.net === candidate.net
      && group.layer === candidate.layer
      && group.pads.some((pad) => keys.has(padKey(pad))))
    if (!overlaps.length) {
      merged.push(candidate)
      continue
    }
    const combined = new Map(candidate.pads.map((pad) => [padKey(pad), pad]))
    for (const group of overlaps) for (const pad of group.pads) combined.set(padKey(pad), pad)
    for (const group of overlaps) merged.splice(merged.indexOf(group), 1)
    merged.push({ net: candidate.net, layer: candidate.layer, pads: [...combined.values()] })
  }

  return merged.map((group) => {
    const memberKeys = new Set(group.pads.map(padKey))
    const outsiders = raw.pads.filter((pad) => pad.net === group.net
      && !memberKeys.has(`${pad.component}\u0000${pad.padNumber}`))
    const sorted = [...group.pads].sort((left, right) => {
      const distance = (pad: FilledCopperPad) => outsiders.length
        ? Math.min(...outsiders.map((other) => Math.hypot(pad.x - other.x, pad.y - other.y)))
        : 0
      return distance(left) - distance(right)
        || left.component.localeCompare(right.component)
        || left.padNumber.localeCompare(right.padNumber, undefined, { numeric: true })
    })
    return {
      ...group,
      representative: sorted[0],
      redundantPads: sorted.slice(1),
    }
  })
}

export function fullyConnectedByFilledCopperNets(root: SExpression[]) {
  const raw = kicadToRawPcb(root, { includeZones: true })
  const padCounts = new Map<string, number>()
  for (const pad of raw.pads) if (pad.net) padCounts.set(pad.net, (padCounts.get(pad.net) ?? 0) + 1)
  return [...new Set(filledCopperPadGroups(root)
    .filter((group) => group.pads.length >= 2 && group.pads.length === padCounts.get(group.net))
    .map((group) => group.net))].sort()
}

function insetRings(points: Point[], distanceMm: number): Point[][] {
  const ring = cleanRing(points)
  if (ring.length < 3) return []
  const offsetter = new ClipperLib.ClipperOffset(3, 0.25 * SCALE)
  offsetter.AddPath(
    ring.map((point) => ({ X: Math.round(point.x * SCALE), Y: Math.round(point.y * SCALE) })),
    ClipperLib.JoinType.jtMiter,
    ClipperLib.EndType.etClosedPolygon,
  )
  const result: Array<Array<{ X: number; Y: number }>> = []
  offsetter.Execute(result, -distanceMm * SCALE)
  return result
    .map((path) => cleanRing(path.map((point) => ({ x: point.X / SCALE, y: point.Y / SCALE }))))
    .filter((path) => path.length >= 3)
}

function scanIntervals(ring: Point[], value: number, horizontal: boolean) {
  const intersections: number[] = []
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index]
    const b = ring[(index + 1) % ring.length]
    const aCross = horizontal ? a.y : a.x
    const bCross = horizontal ? b.y : b.x
    if (!((aCross <= value && bCross > value) || (bCross <= value && aCross > value))) continue
    const ratio = (value - aCross) / (bCross - aCross)
    intersections.push((horizontal ? a.x : a.y) + ratio * ((horizontal ? b.x : b.y) - (horizontal ? a.x : a.y)))
  }
  intersections.sort((left, right) => left - right)
  const intervals: Array<[number, number]> = []
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    if (intersections[index + 1] - intersections[index] > EPSILON) {
      intervals.push([intersections[index], intersections[index + 1]])
    }
  }
  return intervals
}

function gridValues(minimum: number, maximum: number, pitch: number) {
  const values: number[] = []
  const first = Math.ceil((minimum - EPSILON) / pitch) * pitch
  for (let value = first; value <= maximum + EPSILON; value += pitch) {
    values.push(Math.round(value * SCALE) / SCALE)
  }
  return values
}

function proxyLines(ring: Point[], pitch: number) {
  const lines: Array<{ start: Point; end: Point }> = []
  // The inset outline makes the raster one electrically connected object.
  // Its finite width reaches the real filled boundary without protruding past it.
  for (let index = 0; index < ring.length; index += 1) {
    lines.push({ start: ring[index], end: ring[(index + 1) % ring.length] })
  }
  const xs = ring.map((point) => point.x)
  const ys = ring.map((point) => point.y)
  for (const y of gridValues(Math.min(...ys), Math.max(...ys), pitch)) {
    for (const [from, to] of scanIntervals(ring, y, true)) {
      lines.push({ start: { x: from, y }, end: { x: to, y } })
    }
  }
  for (const x of gridValues(Math.min(...xs), Math.max(...xs), pitch)) {
    for (const [from, to] of scanIntervals(ring, x, false)) {
      lines.push({ start: { x, y: from }, end: { x, y: to } })
    }
  }
  return lines.filter((line) => Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y) > EPSILON)
}

function segmentNode(
  start: Point,
  end: Point,
  widthMm: number,
  layer: string,
  net: string,
  uuid: string,
) {
  return [
    token("segment"),
    [token("start"), token(String(start.x)), token(String(start.y))],
    [token("end"), token(String(end.x)), token(String(end.y))],
    [token("width"), token(String(widthMm))],
    [token("locked"), token("yes")],
    [token("layer"), token(layer, true)],
    [token("net"), token(net, true)],
    [token("uuid"), token(uuid, true)],
  ] as SExpression[]
}

/**
 * Materialize native KiCad filled copper as temporary, locked, same-net tracks.
 *
 * The three remaining backends all understand existing tracks, while KRT and
 * EasyEDA do not understand exact KiCad filled_polygon geometry.  A connected
 * inset mesh gives them one common model: foreign nets see an obstacle, and
 * the owner net sees already-connected copper instead of routing the same pad
 * group for a second time.  These objects are staging-only and must be removed
 * with removeFilledCopperProxy before a user-visible board is saved.
 */
export function appendFilledCopperProxy(
  root: SExpression[],
  options: { widthMm?: number; pitchMm?: number } = {},
): FilledCopperProxyManifest {
  const widthMm = Math.max(0.02, options.widthMm ?? 0.1)
  const pitchMm = Math.max(widthMm, options.pitchMm ?? Math.max(0.2, widthMm * 2))
  const segmentUuids: string[] = []
  const components: FilledCopperProxyComponent[] = []
  const zonesWithoutNativeFill: Array<{ net: string; layer: string }> = []
  let filledPolygonCount = 0
  const zones = listChildren(root, "zone")

  for (const zone of zones) {
    const net = nodeNetName(root, zone)
    const zoneLayer = childText(zone, "layer") ?? "F.Cu"
    const filled = listChildren(zone, "filled_polygon")
    if (!filled.length) {
      zonesWithoutNativeFill.push({ net, layer: zoneLayer })
      continue
    }
    for (const [filledPolygonIndex, contour] of filled.entries()) {
      const points = listChildren(findChild(contour, "pts") ?? [], "xy").map(pointAt)
      const layer = childText(contour, "layer") ?? zoneLayer
      if (!net || points.length < 3) continue
      filledPolygonCount += 1
      const rings = insetRings(points, widthMm / 2)
      let proxySegments = 0
      for (const ring of rings) {
        const seen = new Set<string>()
        for (const line of proxyLines(ring, pitchMm)) {
          const key = [line.start.x, line.start.y, line.end.x, line.end.y]
            .map((value) => Math.round(value * SCALE))
            .join(":")
          if (seen.has(key)) continue
          seen.add(key)
          const uuid = randomUUID()
          root.push(segmentNode(line.start, line.end, widthMm, layer, net, uuid))
          segmentUuids.push(uuid)
          proxySegments += 1
        }
      }
      components.push({ net, layer, filledPolygonIndex, sourceVertices: points.length, proxySegments })
    }
  }

  return {
    version: 1,
    widthMm,
    pitchMm,
    zoneCount: zones.length,
    filledPolygonCount,
    zonesWithoutNativeFill,
    segmentUuids,
    components,
  }
}

export function removeFilledCopperProxy(
  root: SExpression[],
  manifest: FilledCopperProxyManifest,
): FilledCopperProxyRemoval {
  const expected = new Set(manifest.segmentUuids)
  const removed = new Set<string>()
  for (let index = root.length - 1; index >= 0; index -= 1) {
    const node = root[index]
    if (!isSExpressionList(node) || listHead(node) !== "segment") continue
    const uuid = childText(node, "uuid") ?? ""
    if (!expected.has(uuid)) continue
    root.splice(index, 1)
    removed.add(uuid)
  }
  return {
    expected: expected.size,
    removed: removed.size,
    missingUuids: [...expected].filter((uuid) => !removed.has(uuid)),
  }
}
