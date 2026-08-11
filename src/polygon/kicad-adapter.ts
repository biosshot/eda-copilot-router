import { randomUUID } from "node:crypto"
import {
  childText,
  footprintAt,
  footprintLayer,
  footprintReference,
  listChildren,
  padNet,
  padNumber,
  pcbFootprints,
} from "../../../kicad-copilot/src/kicad/pcb-reader"
import { boardOutline } from "../../../kicad-copilot/src/pcb/router-adapter"
import {
  atom,
  findChild,
  isSExpressionList,
  listHead,
  token,
  type SExpression,
} from "../../../kicad-copilot/src/kicad/sexpr/ast"
import type { ZonePlan } from "./engine"
import { mergeOctilinearBoundaries } from "./boundary-optimizer"
import type {
  PcbLayerName,
  PcbPoint,
  RawPcb,
  RawPcbArc,
  RawPcbComponent,
  RawPcbPad,
  RawPcbPolygon,
  RawPcbTrack,
  RawPcbVia,
} from "./raw-pcb"

const numberAt = (node: SExpression[] | undefined, index: number, fallback = 0) => {
  const value = Number(atom(node?.[index]))
  return Number.isFinite(value) ? value : fallback
}

const pointAt = (node: SExpression[] | undefined): PcbPoint => ({
  x: numberAt(node, 1),
  y: numberAt(node, 2),
})

const rotate = (point: PcbPoint, degrees: number): PcbPoint => {
  const radians = degrees * Math.PI / 180
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  }
}

export function transformFootprintPoint(point: PcbPoint, at: ReturnType<typeof footprintAt>, bottom: boolean) {
  const local = bottom ? { x: -point.x, y: point.y } : point
  // KiCad angles use screen-space orientation. Top-side local -> board
  // coordinates therefore use the opposite mathematical sign; a bottom
  // footprint is mirrored first and retains the existing sign convention.
  const rotated = rotate(local, bottom ? at.rotate : -at.rotate)
  return { x: rotated.x + at.x, y: rotated.y + at.y }
}

function roundedRect(width: number, height: number, radius: number) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  if (r <= 1e-6) return [
    { x: -width / 2, y: -height / 2 },
    { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 },
    { x: -width / 2, y: height / 2 },
  ]
  const points: PcbPoint[] = []
  const corners = [
    { x: width / 2 - r, y: -height / 2 + r, start: -90 },
    { x: width / 2 - r, y: height / 2 - r, start: 0 },
    { x: -width / 2 + r, y: height / 2 - r, start: 90 },
    { x: -width / 2 + r, y: -height / 2 + r, start: 180 },
  ]
  for (const corner of corners) {
    for (let index = 0; index <= 4; index += 1) {
      const angle = (corner.start + index * 22.5) * Math.PI / 180
      points.push({ x: corner.x + Math.cos(angle) * r, y: corner.y + Math.sin(angle) * r })
    }
  }
  return points
}

function ellipse(width: number, height: number) {
  return Array.from({ length: 24 }, (_, index) => {
    const angle = Math.PI * 2 * index / 24
    return { x: Math.cos(angle) * width / 2, y: Math.sin(angle) * height / 2 }
  })
}

function localPadOutline(pad: SExpression[]) {
  const shape = atom(pad[3]) ?? "rect"
  const size = findChild(pad, "size")
  const width = Math.max(0.001, numberAt(size, 1, 0.001))
  const height = Math.max(0.001, numberAt(size, 2, width))
  if (shape === "circle") return ellipse(width, width)
  if (shape === "oval") return roundedRect(width, height, Math.min(width, height) / 2)
  if (shape === "roundrect") {
    const ratio = numberAt(findChild(pad, "roundrect_rratio"), 1, 0.25)
    return roundedRect(width, height, Math.min(width, height) * ratio)
  }
  return roundedRect(width, height, 0)
}

function source(points: PcbPoint[]) {
  return [points[0].x, points[0].y, "L", ...points.slice(1).flatMap((point) => [point.x, point.y]), "Z"]
}

function rawLayer(name: string): PcbLayerName {
  if (name === "F.Cu") return "TOP"
  if (name === "B.Cu") return "BOTTOM"
  const inner = /^In(\d+)\.Cu$/.exec(name)
  return (inner ? `INNER_${inner[1]}` : name) as PcbLayerName
}

function padLayer(pad: SExpression[], footprintSide: string): PcbLayerName {
  const layers = findChild(pad, "layers")?.slice(1).map(atom).filter(Boolean) as string[] | undefined
  if (layers?.some((layer) => layer === "*.Cu") || (layers?.includes("F.Cu") && layers.includes("B.Cu"))) return "MULTI"
  const copper = layers?.find((layer) => layer.endsWith(".Cu"))
  return rawLayer(copper ?? footprintSide)
}

function drillDiameter(pad: SExpression[]) {
  const values = findChild(pad, "drill")?.slice(1)
    .map(atom)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0) ?? []
  return values.length ? Math.max(...values) : 0
}

function rawPads(root: SExpression[]) {
  const pads: RawPcbPad[] = []
  const components: RawPcbComponent[] = []
  for (const [componentIndex, footprint] of pcbFootprints(root).entries()) {
    const at = footprintAt(footprint)
    const side = footprintLayer(footprint)
    const bottom = side === "B.Cu"
    const designator = footprintReference(footprint) ?? `FP${componentIndex + 1}`
    const componentPads: PcbPoint[] = []
    for (const [padIndex, pad] of listChildren(footprint, "pad").entries()) {
      const padAt = findChild(pad, "at")
      const center = transformFootprintPoint(pointAt(padAt), at, bottom)
      const padRotation = numberAt(padAt, 3)
      const outline = localPadOutline(pad)
        .map((point) => rotate(point, -padRotation))
        .map((point) => ({ x: point.x + numberAt(padAt, 1), y: point.y + numberAt(padAt, 2) }))
        .map((point) => transformFootprintPoint(point, at, bottom))
      componentPads.push(...outline)
      const drill = drillDiameter(pad)
      pads.push({
        id: childText(pad, "uuid"),
        component: designator,
        x: center.x,
        y: center.y,
        net: padNet(pad),
        padNumber: padNumber(pad) ?? String(padIndex + 1),
        layer: padLayer(pad, side),
        shape: ["POLYGON", source(outline)],
        rotation: 0,
        ...(drill > 0 ? { hole: { data: [drill], offsetX: 0, offsetY: 0, rotation: 0 } } : {}),
      })
    }
    const xs = componentPads.map((point) => point.x)
    const ys = componentPads.map((point) => point.y)
    components.push({
      designator,
      x: at.x,
      y: at.y,
      rotate: at.rotate,
      layer: rawLayer(side),
      ...(xs.length ? { bbox: { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) } } : {}),
    })
  }
  return { pads, components }
}

function nodeNetName(root: SExpression[], node: SExpression[]) {
  const net = findChild(node, "net")
  if (!net) return ""
  if (net.length >= 3) return atom(net[2]) ?? ""
  const value = atom(net[1]) ?? ""
  if (!/^\d+$/.test(value)) return value
  return atom(listChildren(root, "net").find((item) => atom(item[1]) === value)?.[2]) ?? ""
}

function arcAngle(start: PcbPoint, mid: PcbPoint, end: PcbPoint) {
  const determinant = 2 * (start.x * (mid.y - end.y) + mid.x * (end.y - start.y) + end.x * (start.y - mid.y))
  if (Math.abs(determinant) < 1e-12) return 0
  const start2 = start.x ** 2 + start.y ** 2
  const mid2 = mid.x ** 2 + mid.y ** 2
  const end2 = end.x ** 2 + end.y ** 2
  const center = {
    x: (start2 * (mid.y - end.y) + mid2 * (end.y - start.y) + end2 * (start.y - mid.y)) / determinant,
    y: (start2 * (end.x - mid.x) + mid2 * (start.x - end.x) + end2 * (mid.x - start.x)) / determinant,
  }
  const angle = (point: PcbPoint) => Math.atan2(point.y - center.y, point.x - center.x)
  const tau = Math.PI * 2
  const normalized = (value: number) => ((value % tau) + tau) % tau
  const from = angle(start)
  const to = angle(end)
  const through = angle(mid)
  const ccwSpan = normalized(to - from)
  const ccwMid = normalized(through - from)
  return (ccwMid <= ccwSpan ? ccwSpan : ccwSpan - tau) * 180 / Math.PI
}

function zonePolygons(root: SExpression[]) {
  const polygons: RawPcbPolygon[] = []
  for (const zone of listChildren(root, "zone")) {
    const net = nodeNetName(root, zone)
    const zoneLayers = findChild(zone, "layers")?.slice(1).map(atom).filter(Boolean) as string[] | undefined
    const layers = zoneLayers?.length ? zoneLayers : [childText(zone, "layer") ?? "F.Cu"]
    const filled = listChildren(zone, "filled_polygon")
    const contours = filled.length ? filled : listChildren(zone, "polygon")
    for (const contour of contours) {
      const points = listChildren(findChild(contour, "pts") ?? [], "xy").map(pointAt)
      if (points.length < 3) continue
      const contourLayer = childText(contour, "layer")
      for (const layer of contourLayer ? [contourLayer] : layers) {
        polygons.push({ net, layer: rawLayer(layer), fill: true, lineWidth: 0, sources: [source(points)] })
      }
    }
  }
  return polygons
}

export function kicadToRawPcb(root: SExpression[], options: { includeZones?: boolean } = {}): RawPcb {
  const outline = boardOutline(root)
  const { pads, components } = rawPads(root)
  const tracks: RawPcbTrack[] = listChildren(root, "segment").map((segment) => ({
    ...(() => {
      const start = pointAt(findChild(segment, "start"))
      const end = pointAt(findChild(segment, "end"))
      return { x1: start.x, y1: start.y, x2: end.x, y2: end.y }
    })(),
    width: numberAt(findChild(segment, "width"), 1, 0.2),
    layer: rawLayer(childText(segment, "layer") ?? "F.Cu"),
    net: nodeNetName(root, segment),
  }))
  const arcs: RawPcbArc[] = listChildren(root, "arc").map((arc) => {
    const start = pointAt(findChild(arc, "start"))
    const mid = pointAt(findChild(arc, "mid"))
    const end = pointAt(findChild(arc, "end"))
    return {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      arcAngle: arcAngle(start, mid, end),
      width: numberAt(findChild(arc, "width"), 1, 0.2),
      layer: rawLayer(childText(arc, "layer") ?? "F.Cu"),
      net: nodeNetName(root, arc),
    }
  })
  const vias: RawPcbVia[] = listChildren(root, "via").map((via) => {
    const at = pointAt(findChild(via, "at"))
    return {
      ...at,
      net: nodeNetName(root, via),
      diameter: numberAt(findChild(via, "size"), 1, 0.6),
      drill: numberAt(findChild(via, "drill"), 1, 0.3),
    }
  })
  return {
    board: { polygon: outline.points },
    components,
    pads,
    tracks,
    arcs,
    vias,
    polygons: options.includeZones === false ? [] : zonePolygons(root),
  }
}

export function removeKicadZones(root: SExpression[]) {
  let removed = 0
  for (let index = root.length - 1; index >= 0; index -= 1) {
    const node = root[index]
    if (!isSExpressionList(node) || listHead(node) !== "zone") continue
    root.splice(index, 1)
    removed += 1
  }
  return removed
}

export type KicadZoneExportOptions = {
  clearanceForNet?: (net: string) => number
  minThickness?: number
  /** Backend policy, not LLM geometry intent. Solid is the robust autorouting default. */
  padConnection?: "solid" | "thermal"
}

function zoneNode(plan: ZonePlan, options: KicadZoneExportOptions, exportPriority: number) {
  if (!plan.boundary) throw new Error("cannot export a zone plan without a boundary")
  const clearance = Math.max(0, options.clearanceForNet?.(plan.net) ?? 0.2)
  const minThickness = Math.max(0.001, options.minThickness ?? 0.1)
  const connectPads: SExpression[] = options.padConnection === "thermal"
    ? [token("connect_pads"), [token("clearance"), token(String(clearance))]]
    : [token("connect_pads"), token("yes"), [token("clearance"), token(String(clearance))]]
  return [
    token("zone"),
    [token("net"), token(plan.net, true)],
    [token("layer"), token(plan.layer === "TOP" ? "F.Cu" : plan.layer === "BOTTOM" ? "B.Cu" : plan.layer.replace("INNER_", "In") + ".Cu", true)],
    [token("uuid"), token(randomUUID(), true)],
    [token("name"), token(`copilot-router:${plan.net}:${plan.layer}:${plan.intent.mode}`, true)],
    [token("hatch"), token("edge"), token("0.5")],
    ...(exportPriority > 0 ? [[token("priority"), token(String(exportPriority))] as SExpression[]] : []),
    connectPads,
    [token("min_thickness"), token(String(minThickness))],
    [
      token("fill"), token("yes"),
      [token("thermal_gap"), token(String(Math.max(clearance, 0.2)))],
      [token("thermal_bridge_width"), token("0.3")],
      [token("island_removal_mode"), token("0")],
    ],
    [token("polygon"), [
      token("pts"),
      ...plan.boundary.map((point) => [token("xy"), token(String(point.x)), token(String(point.y))] as SExpression[]),
    ]],
  ] as SExpression[]
}

export function appendPlannedZones(root: SExpression[], plans: ZonePlan[], options: KicadZoneExportOptions = {}) {
  let count = 0
  const ready = plans.filter((plan) => plan.status === "ready" && plan.boundary)
  const grouped = new Map<string, ZonePlan[]>()
  for (const plan of ready) {
    const key = `${plan.net}\u0000${plan.layer}\u0000${plan.intent.mode}\u0000${plan.intent.priority}`
    grouped.set(key, [...(grouped.get(key) ?? []), plan])
  }
  const merged = [...grouped.values()].flatMap((group) => {
    const template = group[0]
    const minimumFeatureMm = group.reduce((minimum, plan) =>
      Math.min(minimum, plan.optimization?.minimumFeatureMm ?? Infinity), Infinity)
    return mergeOctilinearBoundaries(
      group.map((plan) => plan.boundary!),
      Number.isFinite(minimumFeatureMm) ? minimumFeatureMm : 0,
    )
      .map((boundary) => ({ ...template, boundary }))
  })
  for (const [index, plan] of merged.entries()) {
    // KiCad reports intersecting zones with identical priorities as a DRC
    // error. Same-net touching outlines are unioned above; priorities remain
    // unique only for genuinely disjoint contours and different nets.
    const exportPriority = plan.intent.priority * 1000 + merged.length - index
    root.push(zoneNode(plan, options, exportPriority))
    count += 1
  }
  return count
}
