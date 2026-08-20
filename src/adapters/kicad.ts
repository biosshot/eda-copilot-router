import { randomUUID } from "node:crypto"
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, resolve } from "node:path"
import type {
  PointMm,
  PolygonMm,
  RoutedTrack,
  RoutedVia,
  RoutedZone,
  RoutingBoard,
  RoutingCopper,
  RoutingDiagnostic,
  RoutingResult,
  RoutingRuleValues,
  RoutingRules,
} from "../core/contracts.js"
import { validateRoutingBoard } from "../core/validation.js"
import {
  atom,
  findChild,
  isSExpressionList,
  listChildren,
  listHead,
  parsePcbSource,
  printSExpression,
  token,
  type SExpression,
} from "../internal/kicad-sexpr.js"
import { approximateKiCadArc } from "../backends/krt-codec.js"

const EMPTY_COPPER: RoutingCopper = { tracks: [], vias: [], zones: [] }
const DEFAULT_TRACK_MM = 0.127
const DEFAULT_VIA_MM = 0.6
const DEFAULT_DRILL_MM = 0.3
const DEFAULT_CLEARANCE_MM = 0.2

export type KiCadRouterImportOptions = Readonly<{
  existingCopper?: "fixed" | "editable"
}>

export type KiCadRoutingContext = Readonly<{
  path: string
  source: string
  root: SExpression[]
  version: number
  existingCopper: "fixed" | "editable"
}>

export type KiCadRoutingImport = Readonly<{
  board?: RoutingBoard
  context?: KiCadRoutingContext
  diagnostics: readonly RoutingDiagnostic[]
}>

export type KiCadRoutingApplyResult = Readonly<{
  outputPath?: string
  diagnostics: readonly RoutingDiagnostic[]
  nativeVerification: "not-run"
}>

function childText(node: SExpression[], head: string) {
  return atom(findChild(node, head)?.[1])
}

function numberAt(node: SExpression[] | undefined, index: number, fallback = 0) {
  const value = Number(atom(node?.[index]))
  return Number.isFinite(value) ? value : fallback
}

function pointAt(node: SExpression[] | undefined): PointMm {
  return { x: numberAt(node, 1), y: numberAt(node, 2) }
}

function rotate(point: PointMm, degrees: number): PointMm {
  const radians = degrees * Math.PI / 180
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  }
}

function placedPoint(point: PointMm, origin: PointMm, rotationDeg: number, bottom: boolean) {
  const mirrored = bottom ? { x: -point.x, y: point.y } : point
  const value = rotate(mirrored, bottom ? rotationDeg : -rotationDeg)
  return { x: origin.x + value.x, y: origin.y + value.y }
}

function copperLayers(root: SExpression[]) {
  const values = findChild(root, "layers")?.slice(1).flatMap((item) => {
    if (!isSExpressionList(item)) return []
    const name = atom(item[1])
    return name?.endsWith(".Cu") ? [name] : []
  }) ?? []
  return values.length ? values : ["F.Cu", "B.Cu"]
}

function nodeLayers(node: SExpression[], available: readonly string[], fallback = "F.Cu") {
  const layers = findChild(node, "layers")?.slice(1).map(atom).filter((item): item is string => Boolean(item)) ?? []
  if (layers.includes("*.Cu")) return [...available]
  const copper = layers.filter((item) => item.endsWith(".Cu"))
  return copper.length ? copper : [childText(node, "layer") ?? fallback]
}

function padShape(node: SExpression[], diagnostics: RoutingDiagnostic[], path: string): RoutingBoard["pads"][number]["shape"] {
  const kind = atom(node[3]) ?? "rect"
  const size = findChild(node, "size")
  const widthMm = Math.max(0.001, numberAt(size, 1, 0.001))
  const heightMm = Math.max(0.001, numberAt(size, 2, widthMm))
  if (kind === "circle") return { kind: "circle", diameterMm: widthMm }
  if (kind === "oval") return { kind: "oval", widthMm, heightMm }
  if (kind === "roundrect") return {
    kind: "round-rect", widthMm, heightMm,
    cornerRadiusMm: Math.min(widthMm, heightMm) * numberAt(findChild(node, "roundrect_rratio"), 1, 0.25),
  }
  if (kind === "rect") return { kind: "rect", widthMm, heightMm }
  const points = listChildren(findChild(node, "primitives") ?? [], "gr_poly")
    .flatMap((primitive) => listChildren(findChild(primitive, "pts") ?? [], "xy").map(pointAt))
  diagnostics.push({
    code: "KICAD_CUSTOM_PAD_APPROXIMATED", severity: "warning", path,
    message: `Custom KiCad pad at ${path} was conservatively approximated for routing.`,
  })
  if (points.length >= 3) return { kind: "polygon", polygon: { outer: points } }
  return { kind: "rect", widthMm, heightMm }
}

function padHole(node: SExpression[]) {
  const drill = findChild(node, "drill")
  if (!drill) return undefined
  const oval = atom(drill[1]) === "oval"
  const start = oval ? 2 : 1
  const first = Number(atom(drill[start]))
  const second = oval ? Number(atom(drill[start + 1])) : first
  if (!(first > 0) || !(second > 0)) return undefined
  const offsetNode = findChild(drill, "offset")
  const offset = offsetNode ? pointAt(offsetNode) : undefined
  const diameterMm = Math.min(first, second)
  return {
    shape: oval ? "slot" as const : "round" as const,
    diameterMm,
    ...(oval ? { slotLengthMm: Math.max(first, second) - diameterMm } : {}),
    ...(offset && (offset.x !== 0 || offset.y !== 0) ? { offset } : {}),
    plated: atom(node[2]) !== "np_thru_hole",
  }
}

function netMap(root: SExpression[]) {
  return new Map(listChildren(root, "net").flatMap((item) => {
    const id = atom(item[1])
    const name = atom(item[2])
    return id !== undefined && name !== undefined ? [[id, name] as const] : []
  }))
}

function nodeNet(root: SExpression[], node: SExpression[], nets = netMap(root)) {
  const form = findChild(node, "net")
  if (!form) return undefined
  if (form.length >= 3) return atom(form[2])
  const value = atom(form[1])
  return value === undefined ? undefined : nets.get(value) ?? (/^\d+$/.test(value) ? undefined : value)
}

function locked(node: SExpression[]) {
  const value = findChild(node, "locked")
  return Boolean(value && (value.length === 1 || atom(value[1]) === "yes"))
}

function samePoint(a: PointMm, b: PointMm) {
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-5
}

function polygonArea(points: readonly PointMm[]) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]
    return sum + point.x * next.y - next.x * point.y
  }, 0) / 2)
}

function edgeCutRings(root: SExpression[]) {
  const edges: PointMm[][] = []
  for (const node of listChildren(root, "gr_line")) if (childText(node, "layer") === "Edge.Cuts") {
    edges.push([pointAt(findChild(node, "start")), pointAt(findChild(node, "end"))])
  }
  for (const node of listChildren(root, "gr_arc")) if (childText(node, "layer") === "Edge.Cuts") {
    edges.push(approximateKiCadArc(pointAt(findChild(node, "start")), pointAt(findChild(node, "mid")), pointAt(findChild(node, "end")), 0.02))
  }
  for (const node of listChildren(root, "gr_rect")) if (childText(node, "layer") === "Edge.Cuts") {
    const start = pointAt(findChild(node, "start")); const end = pointAt(findChild(node, "end"))
    edges.push([start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }, start])
  }
  for (const node of listChildren(root, "gr_circle")) if (childText(node, "layer") === "Edge.Cuts") {
    const center = pointAt(findChild(node, "center")); const end = pointAt(findChild(node, "end"))
    const radius = Math.hypot(end.x - center.x, end.y - center.y)
    const count = Math.max(24, Math.ceil(Math.PI * 2 * radius / 0.25))
    edges.push(Array.from({ length: count + 1 }, (_, index) => ({
      x: center.x + Math.cos(Math.PI * 2 * index / count) * radius,
      y: center.y + Math.sin(Math.PI * 2 * index / count) * radius,
    })))
  }
  for (const node of listChildren(root, "gr_poly")) if (childText(node, "layer") === "Edge.Cuts") {
    const points = listChildren(findChild(node, "pts") ?? [], "xy").map(pointAt)
    if (points.length >= 3) edges.push([...points, points[0]])
  }
  const remaining = [...edges]
  const rings: PointMm[][] = []
  while (remaining.length) {
    const chain = [...remaining.shift()!]
    while (!samePoint(chain[0], chain.at(-1)!)) {
      const end = chain.at(-1)!
      const index = remaining.findIndex((edge) => samePoint(edge[0], end) || samePoint(edge.at(-1)!, end))
      if (index < 0) throw new TypeError("Edge.Cuts is not a closed outline")
      const edge = remaining.splice(index, 1)[0]
      if (samePoint(edge.at(-1)!, end)) edge.reverse()
      chain.push(...edge.slice(1))
    }
    rings.push(chain.slice(0, -1))
  }
  rings.sort((a, b) => polygonArea(b) - polygonArea(a))
  if (!rings[0]?.length) throw new TypeError("PCB has no closed Edge.Cuts outline")
  return rings
}

function polygonNode(node: SExpression[]) {
  return listChildren(findChild(node, "pts") ?? [], "xy").map(pointAt)
}

function zoneOptions(node: SExpression[]) {
  const fill = findChild(node, "fill")
  const connect = findChild(node, "connect_pads")
  const solid = connect?.some((item) => atom(item) === "yes") ?? false
  return {
    priority: numberAt(findChild(node, "priority"), 1, 0),
    minThicknessMm: numberAt(findChild(node, "min_thickness"), 1, 0.1),
    clearanceMm: numberAt(findChild(connect ?? [], "clearance"), 1, 0),
    connection: solid ? "solid" as const : "thermal" as const,
    fill: { style: atom(fill?.[1]) === "hatch" || atom(findChild(fill ?? [], "mode")?.[1]) === "hatch" ? "hatched" as const : "solid" as const },
    padConnection: {
      mode: solid ? "solid" as const : "thermal" as const,
      thermalGapMm: numberAt(findChild(fill ?? [], "thermal_gap"), 1, 0.3),
      spokeWidthMm: numberAt(findChild(fill ?? [], "thermal_bridge_width"), 1, 0.3),
    },
  }
}

function importedKeepouts(root: SExpression[], available: readonly string[]) {
  return listChildren(root, "zone").flatMap((zone, index): RoutingBoard["keepouts"][number][] => {
    const specification = findChild(zone, "keepout")
    if (!specification) return []
    const rings = listChildren(zone, "polygon").map(polygonNode).filter((ring) => ring.length >= 3)
    if (!rings.length) return []
    const forbidden = (head: string) => atom(findChild(specification, head)?.[1]) === "not_allowed"
    return [{
      id: childText(zone, "uuid") ?? childText(zone, "tstamp") ?? `keepout-${index}`,
      layers: nodeLayers(zone, available).filter((layer) => available.includes(layer)),
      polygon: { outer: rings[0], ...(rings.length > 1 ? { holes: rings.slice(1) } : {}) },
      forbid: { tracks: forbidden("tracks"), vias: forbidden("vias"), zones: forbidden("copperpour") },
    }]
  })
}

function importedCopper(root: SExpression[], available: readonly string[]) {
  const nets = netMap(root)
  const tracks: Array<RoutedTrack & { sourceLocked: boolean }> = []
  for (const [index, segment] of listChildren(root, "segment").entries()) {
    const net = nodeNet(root, segment, nets)
    if (!net) continue
    tracks.push({
      id: childText(segment, "uuid") ?? childText(segment, "tstamp") ?? `segment-${index}`,
      net, layer: childText(segment, "layer") ?? "F.Cu", widthMm: numberAt(findChild(segment, "width"), 1, DEFAULT_TRACK_MM),
      points: [pointAt(findChild(segment, "start")), pointAt(findChild(segment, "end"))], sourceLocked: locked(segment),
    })
  }
  for (const [index, arc] of listChildren(root, "arc").entries()) {
    const net = nodeNet(root, arc, nets)
    if (!net) continue
    tracks.push({
      id: childText(arc, "uuid") ?? childText(arc, "tstamp") ?? `arc-${index}`,
      net, layer: childText(arc, "layer") ?? "F.Cu", widthMm: numberAt(findChild(arc, "width"), 1, DEFAULT_TRACK_MM),
      points: approximateKiCadArc(pointAt(findChild(arc, "start")), pointAt(findChild(arc, "mid")), pointAt(findChild(arc, "end"))),
      sourceLocked: locked(arc),
    })
  }
  const vias: Array<RoutedVia & { sourceLocked: boolean }> = []
  for (const [index, via] of listChildren(root, "via").entries()) {
    const net = nodeNet(root, via, nets)
    if (!net) continue
    const layers = nodeLayers(via, available)
    vias.push({
      id: childText(via, "uuid") ?? childText(via, "tstamp") ?? `via-${index}`,
      net, at: pointAt(findChild(via, "at")), diameterMm: numberAt(findChild(via, "size"), 1, DEFAULT_VIA_MM),
      drillMm: numberAt(findChild(via, "drill"), 1, DEFAULT_DRILL_MM), fromLayer: layers[0], toLayer: layers.at(-1)!,
      type: atom(via[1]) === "micro" ? "micro" : layers.length === available.length ? "through" : "blind-buried",
      sourceLocked: locked(via),
    })
  }
  const zones: Array<RoutedZone & { sourceLocked: boolean }> = []
  for (const [index, zone] of listChildren(root, "zone").entries()) {
    if (findChild(zone, "keepout")) continue
    const net = nodeNet(root, zone, nets) ?? childText(zone, "net_name")
    const layers = nodeLayers(zone, available)
    const outlineRings = listChildren(zone, "polygon").map(polygonNode).filter((ring) => ring.length >= 3)
    const filled = listChildren(zone, "filled_polygon").flatMap((polygon) => {
      const outer = polygonNode(polygon)
      const layer = childText(polygon, "layer") ?? layers[0]
      return outer.length >= 3 ? [{ outer, layer }] : []
    })
    const options = zoneOptions(zone)
    if (filled.length) for (const [fillIndex, item] of filled.entries()) zones.push({
      id: `${childText(zone, "uuid") ?? childText(zone, "tstamp") ?? `zone-${index}`}:fill-${fillIndex}`,
      ...(net ? { net } : {}), layers: [item.layer], outline: { outer: item.outer }, ...options, sourceLocked: locked(zone),
    })
    else if (outlineRings.length) zones.push({
      id: childText(zone, "uuid") ?? childText(zone, "tstamp") ?? `zone-${index}`,
      ...(net ? { net } : {}), layers,
      outline: { outer: outlineRings[0], ...(outlineRings.length > 1 ? { holes: outlineRings.slice(1) } : {}) },
      ...options, sourceLocked: locked(zone),
    })
  }
  return { tracks, vias, zones }
}

function rectangleAround(start: PointMm, end: PointMm, widthMm: number): PolygonMm {
  const dx = end.x - start.x; const dy = end.y - start.y; const length = Math.hypot(dx, dy)
  if (length < 1e-9) return { outer: circlePoints(start, widthMm / 2) }
  const ox = -dy / length * widthMm / 2; const oy = dx / length * widthMm / 2
  return { outer: [
    { x: start.x + ox, y: start.y + oy }, { x: end.x + ox, y: end.y + oy },
    { x: end.x - ox, y: end.y - oy }, { x: start.x - ox, y: start.y - oy },
  ] }
}

function circlePoints(center: PointMm, radius: number, count = 24) {
  return Array.from({ length: count }, (_, index) => ({
    x: center.x + Math.cos(Math.PI * 2 * index / count) * radius,
    y: center.y + Math.sin(Math.PI * 2 * index / count) * radius,
  }))
}

function graphicalCopper(root: SExpression[], available: readonly string[]) {
  const zones: RoutedZone[] = []
  const add = (layer: string | undefined, outline: PolygonMm, id: string) => {
    if (layer && available.includes(layer) && outline.outer.length >= 3) zones.push({ id, layers: [layer], outline })
  }
  for (const [index, node] of listChildren(root, "gr_line").entries()) add(
    childText(node, "layer"), rectangleAround(pointAt(findChild(node, "start")), pointAt(findChild(node, "end")), numberAt(findChild(findChild(node, "stroke") ?? [], "width"), 1, 0.15)), `gr-line-${index}`,
  )
  for (const [index, node] of listChildren(root, "gr_arc").entries()) {
    const layer = childText(node, "layer"); const width = numberAt(findChild(findChild(node, "stroke") ?? [], "width"), 1, 0.15)
    const points = approximateKiCadArc(pointAt(findChild(node, "start")), pointAt(findChild(node, "mid")), pointAt(findChild(node, "end")))
    for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) add(layer, rectangleAround(points[pointIndex], points[pointIndex + 1], width), `gr-arc-${index}-${pointIndex}`)
  }
  for (const [index, node] of listChildren(root, "gr_poly").entries()) add(childText(node, "layer"), { outer: polygonNode(node) }, `gr-poly-${index}`)
  for (const [index, node] of listChildren(root, "gr_rect").entries()) {
    const start = pointAt(findChild(node, "start")); const end = pointAt(findChild(node, "end"))
    add(childText(node, "layer"), { outer: [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }] }, `gr-rect-${index}`)
  }
  for (const [index, node] of listChildren(root, "gr_circle").entries()) {
    const center = pointAt(findChild(node, "center")); const end = pointAt(findChild(node, "end"))
    add(childText(node, "layer"), { outer: circlePoints(center, Math.hypot(end.x - center.x, end.y - center.y)) }, `gr-circle-${index}`)
  }
  for (const [index, node] of listChildren(root, "gr_text").entries()) {
    const layer = childText(node, "layer")
    if (!layer || !available.includes(layer)) continue
    const at = pointAt(findChild(node, "at")); const text = atom(node[1]) ?? ""
    const font = findChild(findChild(node, "effects") ?? [], "font")
    const size = findChild(font ?? [], "size")
    const height = numberAt(size, 2, numberAt(size, 1, 1))
    const width = Math.max(height * 0.6, text.length * numberAt(size, 1, 1) * 0.65)
    const local = [{ x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 }, { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 }]
    const rotation = numberAt(findChild(node, "at"), 3)
    add(layer, { outer: local.map((point) => { const value = rotate(point, -rotation); return { x: at.x + value.x, y: at.y + value.y } }) }, `gr-text-${index}`)
  }
  for (const [footprintIndex, footprint] of [...listChildren(root, "footprint"), ...listChildren(root, "module")].entries()) {
    const atNode = findChild(footprint, "at"); const origin = pointAt(atNode); const rotation = numberAt(atNode, 3)
    const bottom = childText(footprint, "layer") === "B.Cu"
    const transform = (point: PointMm) => placedPoint(point, origin, rotation, bottom)
    for (const [index, node] of listChildren(footprint, "fp_line").entries()) add(
      childText(node, "layer"), rectangleAround(transform(pointAt(findChild(node, "start"))), transform(pointAt(findChild(node, "end"))), numberAt(findChild(findChild(node, "stroke") ?? [], "width"), 1, 0.15)), `fp-${footprintIndex}-line-${index}`,
    )
    for (const [index, node] of listChildren(footprint, "fp_poly").entries()) add(childText(node, "layer"), { outer: polygonNode(node).map(transform) }, `fp-${footprintIndex}-poly-${index}`)
    for (const [index, node] of listChildren(footprint, "fp_rect").entries()) {
      const start = pointAt(findChild(node, "start")); const end = pointAt(findChild(node, "end"))
      add(childText(node, "layer"), { outer: [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }].map(transform) }, `fp-${footprintIndex}-rect-${index}`)
    }
    for (const [index, node] of listChildren(footprint, "fp_circle").entries()) {
      const center = pointAt(findChild(node, "center")); const end = pointAt(findChild(node, "end")); const radius = Math.hypot(end.x - center.x, end.y - center.y)
      add(childText(node, "layer"), { outer: circlePoints(center, radius).map(transform) }, `fp-${footprintIndex}-circle-${index}`)
    }
    for (const [index, node] of listChildren(footprint, "fp_arc").entries()) {
      const layer = childText(node, "layer"); const width = numberAt(findChild(findChild(node, "stroke") ?? [], "width"), 1, 0.15)
      const points = approximateKiCadArc(pointAt(findChild(node, "start")), pointAt(findChild(node, "mid")), pointAt(findChild(node, "end"))).map(transform)
      for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) add(layer, rectangleAround(points[pointIndex], points[pointIndex + 1], width), `fp-${footprintIndex}-arc-${index}-${pointIndex}`)
    }
    for (const [index, node] of listChildren(footprint, "fp_text").entries()) {
      const layer = childText(node, "layer")
      if (!layer || !available.includes(layer)) continue
      const localAt = findChild(node, "at"); const center = transform(pointAt(localAt)); const text = atom(node[2]) ?? ""
      const font = findChild(findChild(node, "effects") ?? [], "font"); const size = findChild(font ?? [], "size")
      const height = numberAt(size, 2, numberAt(size, 1, 1)); const width = Math.max(height * 0.6, text.length * numberAt(size, 1, 1) * 0.65)
      const textRotation = rotation + numberAt(localAt, 3)
      const local = [{ x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 }, { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 }]
      add(layer, { outer: local.map((point) => { const value = rotate(point, bottom ? textRotation : -textRotation); return { x: center.x + value.x, y: center.y + value.y } }) }, `fp-${footprintIndex}-text-${index}`)
    }
  }
  return zones
}

type ProjectRules = Readonly<{
  minimumClearance: number; minimumTrackWidth: number; minimumViaDiameter: number; minimumViaDrill: number; minimumAnnular: number; edgeClearance: number
  classes: readonly Readonly<{ name: string; clearance: number; track: number; via: number; drill: number; diffWidth: number; diffGap: number }>[]
  assignments: Readonly<Record<string, string>>
}>

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

async function projectPath(pcbPath: string) {
  const candidate = join(dirname(pcbPath), `${basename(pcbPath, extname(pcbPath))}.kicad_pro`)
  return readFile(candidate).then(() => candidate, () => undefined)
}

async function readProjectRules(pcbPath: string): Promise<ProjectRules> {
  const path = await projectPath(pcbPath)
  const root = path ? object(JSON.parse(await readFile(path, "utf8"))) : {}
  const netSettings = object(root.net_settings)
  const global = object(object(object(root.board).design_settings).rules)
  const classes = (Array.isArray(netSettings.classes) ? netSettings.classes : []).flatMap((entry) => {
    const item = object(entry); const name = typeof item.name === "string" ? item.name : ""
    return name ? [{ name, clearance: finite(item.clearance, DEFAULT_CLEARANCE_MM), track: finite(item.track_width, 0.25), via: finite(item.via_diameter, DEFAULT_VIA_MM), drill: finite(item.via_drill, DEFAULT_DRILL_MM), diffWidth: finite(item.diff_pair_width, 0.25), diffGap: finite(item.diff_pair_gap, DEFAULT_CLEARANCE_MM) }] : []
  })
  if (!classes.some((item) => item.name === "Default")) classes.push({ name: "Default", clearance: DEFAULT_CLEARANCE_MM, track: 0.25, via: DEFAULT_VIA_MM, drill: DEFAULT_DRILL_MM, diffWidth: 0.25, diffGap: DEFAULT_CLEARANCE_MM })
  const assignments = Object.fromEntries(Object.entries(object(netSettings.netclass_assignments)).flatMap(([net, value]) => typeof value === "string" ? [[net, value]] : []))
  return {
    minimumClearance: finite(global.min_clearance, 0), minimumTrackWidth: finite(global.min_track_width, 0),
    minimumViaDiameter: finite(global.min_via_diameter, 0), minimumViaDrill: finite(global.min_through_hole_diameter, 0),
    minimumAnnular: finite(global.min_via_annular_width, 0), edgeClearance: finite(global.min_copper_edge_clearance, 0), classes, assignments,
  }
}

function values(source: ProjectRules, rule: ProjectRules["classes"][number]): RoutingRuleValues {
  const minTrack = source.minimumTrackWidth > 0 ? source.minimumTrackWidth : DEFAULT_TRACK_MM
  const minDrill = source.minimumViaDrill > 0 ? source.minimumViaDrill : DEFAULT_DRILL_MM
  const declaredDiameter = source.minimumViaDiameter > 0 ? source.minimumViaDiameter : DEFAULT_VIA_MM
  const minDiameter = Math.max(declaredDiameter, minDrill + source.minimumAnnular * 2)
  const clearance = Math.max(source.minimumClearance, rule.clearance)
  return {
    clearanceMm: clearance, edgeClearanceMm: Math.max(source.edgeClearance, clearance), minTrackWidthMm: minTrack,
    preferredTrackWidthMm: Math.max(minTrack, rule.track),
    via: { minDiameterMm: minDiameter, preferredDiameterMm: Math.max(minDiameter, rule.via), minDrillMm: minDrill, preferredDrillMm: Math.max(minDrill, rule.drill) },
    differential: { trackWidthMm: Math.max(minTrack, rule.diffWidth), gapMm: Math.max(source.minimumClearance, rule.diffGap) },
  }
}

function routingRules(source: ProjectRules, nets: readonly string[]): RoutingRules {
  const defaultClass = source.classes.find((item) => item.name === "Default") ?? source.classes[0]
  const byName = new Map(source.classes.map((item) => [item.name, item]))
  return {
    default: values(source, defaultClass),
    nets: nets.map((net) => ({ net, values: values(source, byName.get(source.assignments[net] ?? "Default") ?? defaultClass) })),
  }
}

function stackup(root: SExpression[], available: readonly string[]): RoutingBoard["stackup"] {
  const stack = findChild(findChild(root, "setup") ?? [], "stackup")
  if (!stack) return { fallbackCopperThicknessOz: 1, layers: available.map((layer) => ({ kind: "copper", layer, thicknessMm: 0.03479 })) }
  const layers: NonNullable<RoutingBoard["stackup"]>["layers"][number][] = []
  for (const item of listChildren(stack, "layer")) {
    const name = atom(item[1]) ?? ""
    const thicknessMm = numberAt(findChild(item, "thickness"), 1, name.endsWith(".Cu") ? 0.03479 : 0)
    if (name.endsWith(".Cu")) layers.push({ kind: "copper", layer: name, thicknessMm })
    else if (thicknessMm > 0) layers.push({ kind: "dielectric", thicknessMm, relativePermittivity: numberAt(findChild(item, "epsilon_r"), 1, 4.2), material: childText(item, "material") })
  }
  return layers.length ? { fallbackCopperThicknessOz: 1, layers } : undefined
}

function splitCopper(source: ReturnType<typeof importedCopper>, ownership: "fixed" | "editable", graphics: readonly RoutedZone[]) {
  const fixed: RoutingCopper = {
    tracks: source.tracks.filter((item) => item.sourceLocked || ownership === "fixed").map(({ sourceLocked: _, ...item }) => item),
    vias: source.vias.filter((item) => item.sourceLocked || ownership === "fixed").map(({ sourceLocked: _, ...item }) => item),
    zones: [...source.zones.filter((item) => item.sourceLocked || ownership === "fixed").map(({ sourceLocked: _, ...item }) => item), ...graphics],
  }
  const editable: RoutingCopper = {
    tracks: source.tracks.filter((item) => !item.sourceLocked && ownership === "editable").map(({ sourceLocked: _, ...item }) => item),
    vias: source.vias.filter((item) => !item.sourceLocked && ownership === "editable").map(({ sourceLocked: _, ...item }) => item),
    zones: source.zones.filter((item) => !item.sourceLocked && ownership === "editable").map(({ sourceLocked: _, ...item }) => item),
  }
  return { fixed, editable }
}

export async function importKiCadRoutingBoard(path: string, options: KiCadRouterImportOptions = {}): Promise<KiCadRoutingImport> {
  const diagnostics: RoutingDiagnostic[] = []
  try {
    const absolute = resolve(path); const source = await readFile(absolute, "utf8"); const root = parsePcbSource(source)
    const version = Number(childText(root, "version") ?? 0)
    const layerNames = copperLayers(root)
    const layers = layerNames.map((name, index) => ({ name, index, side: index === 0 ? "top" as const : index === layerNames.length - 1 ? "bottom" as const : "inner" as const }))
    const components: RoutingBoard["components"][number][] = []
    const pads: RoutingBoard["pads"][number][] = []
    const nets = new Set<string>([...netMap(root).values()])
    for (const [componentIndex, footprint] of [...listChildren(root, "footprint"), ...listChildren(root, "module")].entries()) {
      const footprintAt = findChild(footprint, "at"); const origin = pointAt(footprintAt); const footprintRotation = numberAt(footprintAt, 3)
      const footprintLayer = childText(footprint, "layer") ?? "F.Cu"; const bottom = footprintLayer === "B.Cu"
      const reference = listChildren(footprint, "property").find((item) => atom(item[1]) === "Reference")
      const legacyReference = listChildren(footprint, "fp_text").find((item) => atom(item[1]) === "reference")
      const designator = atom(reference?.[2]) ?? atom(legacyReference?.[2]) ?? `FP${componentIndex + 1}`
      components.push({ designator, at: origin, rotationDeg: footprintRotation, side: bottom ? "bottom" : "top" })
      for (const [padIndex, pad] of listChildren(footprint, "pad").entries()) {
        const localAt = findChild(pad, "at"); const net = nodeNet(root, pad)
        if (net) nets.add(net)
        const hole = padHole(pad)
        const portableHole = hole?.offset && bottom
          ? { ...hole, offset: { x: -hole.offset.x, y: hole.offset.y } }
          : hole
        pads.push({
          id: `${childText(pad, "uuid") ?? childText(pad, "tstamp") ?? `${designator}:${padIndex}`}:${componentIndex}:${padIndex}`,
          component: designator, number: atom(pad[1]) ?? String(padIndex + 1), ...(net ? { net } : {}),
          at: placedPoint(pointAt(localAt), origin, footprintRotation, bottom),
          rotationDeg: bottom ? footprintRotation - numberAt(localAt, 3) : footprintRotation + numberAt(localAt, 3),
          layers: nodeLayers(pad, layerNames, footprintLayer), shape: padShape(pad, diagnostics, `pads.${designator}.${padIndex}`),
          ...(portableHole ? { hole: portableHole } : {}),
        })
      }
    }
    const rings = edgeCutRings(root); const sortedNets = [...nets].filter(Boolean).sort(); const ownership = options.existingCopper ?? "fixed"
    const board: RoutingBoard = {
      outline: rings[0], cutouts: rings.slice(1), layers, nets: sortedNets.map((name) => ({ name })), components, pads,
      keepouts: importedKeepouts(root, layerNames), stackup: stackup(root, layerNames), rules: routingRules(await readProjectRules(absolute), sortedNets),
      copper: splitCopper(importedCopper(root, layerNames), ownership, graphicalCopper(root, layerNames)),
    }
    const validation = validateRoutingBoard(board); diagnostics.push(...validation.diagnostics)
    return validation.ok ? { board, context: { path: absolute, source, root, version, existingCopper: ownership }, diagnostics } : { diagnostics }
  } catch (error) {
    diagnostics.push({ code: "KICAD_ROUTING_IMPORT_FAILED", severity: "error", message: error instanceof Error ? error.message : String(error) })
    return { diagnostics }
  }
}

function netForm(root: SExpression[], version: number, name: string) {
  if (version >= 20250000) return [token("net"), token(name, true)] as SExpression[]
  const existing = listChildren(root, "net").find((item) => atom(item[2]) === name)
  if (!existing) throw new TypeError(`KiCad net not found: ${name}`)
  return [token("net"), token(atom(existing[1]) ?? "0")] as SExpression[]
}

function removeEditableCopper(root: SExpression[], ownership: "fixed" | "editable") {
  if (ownership !== "editable") return
  for (let index = root.length - 1; index >= 0; index -= 1) {
    const node = root[index]
    if (isSExpressionList(node) && ["segment", "arc", "via", "zone"].includes(listHead(node) ?? "") && !locked(node)) root.splice(index, 1)
  }
}

function n(value: number) { return token(String(Number(value.toFixed(6)))) }
function pointForm(head: string, point: PointMm): SExpression[] { return [token(head), n(point.x), n(point.y)] }

function appendCopper(root: SExpression[], version: number, copper: RoutingCopper) {
  for (const track of copper.tracks) for (let index = 0; index < track.points.length - 1; index += 1) {
    const start = track.points[index]; const end = track.points[index + 1]
    if (samePoint(start, end)) continue
    root.push([token("segment"), pointForm("start", start), pointForm("end", end), [token("width"), n(track.widthMm)], [token("layer"), token(track.layer, true)], netForm(root, version, track.net), [token("uuid"), token(randomUUID(), true)]])
  }
  for (const via of copper.vias) root.push([
    token("via"), ...(via.type === "micro" ? [[token("micro")] as SExpression[]] : []), pointForm("at", via.at),
    [token("size"), n(via.diameterMm)], [token("drill"), n(via.drillMm)], [token("layers"), token(via.fromLayer, true), token(via.toLayer, true)],
    netForm(root, version, via.net), [token("uuid"), token(randomUUID(), true)],
  ])
  for (const [sequence, zone] of copper.zones.entries()) for (const layer of zone.layers) {
    if (!zone.net) continue
    const clearance = zone.clearanceMm ?? DEFAULT_CLEARANCE_MM
    root.push([
      token("zone"), ...(version >= 20250000 ? [[token("net"), token(zone.net, true)] as SExpression[]] : [netForm(root, version, zone.net), [token("net_name"), token(zone.net, true)] as SExpression[]]),
      [token("layer"), token(layer, true)], [token("uuid"), token(randomUUID(), true)], [token("name"), token(`copilot-router:${zone.id ?? sequence}`, true)],
      [token("hatch"), token("edge"), token("0.5")], ...(zone.priority ? [[token("priority"), n(zone.priority)] as SExpression[]] : []),
      [token("connect_pads"), ...(zone.padConnection?.mode === "solid" ? [token("yes")] : []), [token("clearance"), n(clearance)]],
      [token("min_thickness"), n(zone.minThicknessMm ?? 0.1)],
      [token("fill"), token("yes"), [token("thermal_gap"), n(zone.padConnection?.thermalGapMm ?? Math.max(clearance, 0.3))], [token("thermal_bridge_width"), n(zone.padConnection?.spokeWidthMm ?? 0.3)], [token("island_removal_mode"), token("0")]],
      ...[zone.outline.outer, ...(zone.outline.holes ?? [])].map((ring) => [token("polygon"), [token("pts"), ...ring.map((point) => pointForm("xy", point))]] as SExpression[]),
    ])
  }
}

async function atomicCreate(path: string, source: string) {
  await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, source, { encoding: "utf8", flag: "wx" }); await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
}

function applyProjectRules(project: Record<string, unknown>, rules: RoutingRules) {
  const board = object(project.board)
  if (!project.board || typeof project.board !== "object") project.board = board
  const designSettings = object(board.design_settings)
  if (!board.design_settings || typeof board.design_settings !== "object") board.design_settings = designSettings
  const global = object(designSettings.rules)
  if (!designSettings.rules || typeof designSettings.rules !== "object") designSettings.rules = global
  const values = [rules.default, ...rules.nets.map((entry) => entry.values)]
  global.min_track_width = Math.min(...values.map((value) => value.minTrackWidthMm))
  global.min_clearance = Math.min(...values.map((value) => value.clearanceMm))
  global.min_copper_edge_clearance = Math.min(...values.map((value) => value.edgeClearanceMm))
  global.min_via_diameter = Math.min(...values.map((value) => value.via.minDiameterMm))
  global.min_through_hole_diameter = Math.min(...values.map((value) => value.via.minDrillMm))
  const netSettings = object(project.net_settings)
  if (!project.net_settings || typeof project.net_settings !== "object") project.net_settings = netSettings
  const groups = new Map<string, { values: RoutingRuleValues; nets: string[] }>()
  for (const entry of rules.nets) {
    const key = JSON.stringify(entry.values)
    const group = groups.get(key) ?? { values: entry.values, nets: [] }
    group.nets.push(entry.net); groups.set(key, group)
  }
  const grouped = [...groups.values()]
  netSettings.classes = grouped.map((group, index) => ({
    name: index === 0 ? "Router_Default" : `Router_${index}`,
    clearance: group.values.clearanceMm,
    track_width: group.values.preferredTrackWidthMm,
    via_diameter: group.values.via.preferredDiameterMm,
    via_drill: group.values.via.preferredDrillMm,
    diff_pair_width: group.values.differential?.trackWidthMm ?? group.values.preferredTrackWidthMm,
    diff_pair_gap: group.values.differential?.gapMm ?? group.values.clearanceMm,
  }))
  netSettings.netclass_assignments = Object.fromEntries(grouped.flatMap((group, index) => (
    group.nets.map((net) => [net, index === 0 ? "Router_Default" : `Router_${index}`])
  )))
  netSettings.netclass_patterns = []
}

async function copyProject(sourceBoard: string, targetBoard: string, rules: RoutingRules) {
  const source = await projectPath(sourceBoard)
  if (!source) return
  const target = `${targetBoard.slice(0, -extname(targetBoard).length)}.kicad_pro`
  const project = object(JSON.parse(await readFile(source, "utf8")))
  applyProjectRules(project, rules)
  await writeFile(target, `${JSON.stringify(project, null, 2)}\n`, "utf8")
  const sourceDru = source.replace(/\.kicad_pro$/i, ".kicad_dru")
  await copyFile(sourceDru, target.replace(/\.kicad_pro$/i, ".kicad_dru")).catch(() => undefined)
}

export async function applyKiCadRoutingResult(context: KiCadRoutingContext, result: RoutingResult, outputPath: string): Promise<KiCadRoutingApplyResult> {
  const diagnostics: RoutingDiagnostic[] = [...result.diagnostics]
  const target = resolve(outputPath)
  if (target === context.path) return { diagnostics: [...diagnostics, { code: "KICAD_SOURCE_OVERWRITE_FORBIDDEN", severity: "error", message: "Standalone KiCad apply never overwrites its source board." }], nativeVerification: "not-run" }
  try {
    if (await readFile(context.path, "utf8") !== context.source) throw new TypeError("KiCad source changed after routing capture")
    const root = structuredClone(context.root); removeEditableCopper(root, context.existingCopper)
    if (result.copper) appendCopper(root, context.version, result.copper)
    await atomicCreate(target, `${printSExpression(root)}\n`); await copyProject(context.path, target, result.rules.effective)
    return { outputPath: target, diagnostics, nativeVerification: "not-run" }
  } catch (error) {
    return { diagnostics: [...diagnostics, { code: "KICAD_ROUTING_APPLY_FAILED", severity: "error", message: error instanceof Error ? error.message : String(error) }], nativeVerification: "not-run" }
  }
}

export const emptyKiCadEditableCopper = EMPTY_COPPER
