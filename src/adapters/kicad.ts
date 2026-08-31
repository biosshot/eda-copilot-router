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
import { canonicalizeRoutingBoard } from "../core/layers.js"
import { stackupThicknessMm } from "../core/stackup.js"
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
  editableCopper: RoutingCopper
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

function placedPoint(point: PointMm, origin: PointMm, rotationDeg: number) {
  // KiCad stores B-side footprint-local coordinates already pre-mirrored in
  // the board file. pcbnew and KRT consequently apply the same negated
  // footprint rotation to pad positions on both sides.
  const value = rotate(point, -rotationDeg)
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

/** Translate the core's canonical layer namespace at the KiCad boundary. */
function nativeCopperLayer(root: SExpression[], name: string) {
  const available = copperLayers(root)
  if (available.includes(name)) return name
  if (name === "TOP") return available[0] ?? "F.Cu"
  if (name === "BOTTOM") return available.at(-1) ?? "B.Cu"
  const inner = /^INNER_(\d+)$/.exec(name)
  return inner ? available[Number(inner[1])] ?? name : name
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

function truthyChild(node: SExpression[] | undefined, head: string) {
  const child = node ? findChild(node, head) : undefined
  if (!child) return false
  const value = atom(child[1])
  return value === undefined || value !== "no"
}

function textIsHidden(node: SExpression[]) {
  return truthyChild(node, "hide")
}

/**
 * Portable conservative envelope for KiCad text when pcbnew's font renderer is
 * unavailable. KiCad stores (size height width), while electrical clearance is
 * deliberately left to KRT's obstacle expansion.
 */
function textCopperEnvelope(
  node: SExpression[],
  text: string,
  anchor: PointMm,
  rotationDeg: number,
): PolygonMm {
  const effects = findChild(node, "effects")
  const font = findChild(effects ?? [], "font")
  const size = findChild(font ?? [], "size")
  const height = Math.max(0.001, numberAt(size, 1, 1))
  const characterWidth = Math.max(0.001, numberAt(size, 2, height))
  const thickness = Math.max(0.001, numberAt(findChild(font ?? [], "thickness"), 1, height * 0.15))
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const maximumCharacters = Math.max(1, ...lines.map((line) => Array.from(line).length))
  const unresolvedVariable = /\$\{[^}]+\}/.test(text)
  const nonAscii = /[^\x20-\x7e]/.test(text)
  const customFont = Boolean(childText(font ?? [], "face"))
    || truthyChild(font, "bold") || truthyChild(font, "italic")
  const advance = Math.max(height, characterWidth)
    * (unresolvedVariable || customFont ? 2 : nonAscii ? 1.25 : 1)
  const contentWidth = maximumCharacters * advance
  const blockHeight = height + Math.max(0, lines.length - 1) * height * 1.75
  const justify = new Set((findChild(effects ?? [], "justify")?.slice(1) ?? [])
    .map(atom).filter((item): item is string => item !== undefined))
  let minX = justify.has("left") ? 0 : justify.has("right") ? -contentWidth : -contentWidth / 2
  let maxX = justify.has("left") ? contentWidth : justify.has("right") ? 0 : contentWidth / 2
  let minY = justify.has("top") ? 0 : justify.has("bottom") ? -blockHeight : -blockHeight / 2
  let maxY = justify.has("top") ? blockHeight : justify.has("bottom") ? 0 : blockHeight / 2
  minX -= thickness
  maxX += thickness
  const verticalEnvelope = height / 2 + thickness
  minY -= verticalEnvelope
  maxY += verticalEnvelope
  if (justify.has("mirror")) [minX, maxX] = [-maxX, -minX]
  const local = [
    { x: minX, y: minY }, { x: maxX, y: minY },
    { x: maxX, y: maxY }, { x: minX, y: maxY },
  ]
  return {
    outer: local.map((point) => {
      const value = rotate(point, -rotationDeg)
      return { x: anchor.x + value.x, y: anchor.y + value.y }
    }),
  }
}

function textBoxCopperEnvelope(node: SExpression[], transform: (point: PointMm) => PointMm): PolygonMm | undefined {
  if (textIsHidden(node)) return undefined
  const startNode = findChild(node, "start")
  const endNode = findChild(node, "end")
  if (!startNode || !endNode) return undefined
  const start = pointAt(startNode)
  const end = pointAt(endNode)
  return {
    outer: [
      start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y },
    ].map(transform),
  }
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
    if (!layer || !available.includes(layer) || textIsHidden(node)) continue
    const at = pointAt(findChild(node, "at")); const text = atom(node[1]) ?? ""
    const rotation = numberAt(findChild(node, "at"), 3)
    add(layer, textCopperEnvelope(node, text, at, rotation), `gr-text-${index}`)
  }
  for (const [index, node] of listChildren(root, "gr_text_box").entries()) {
    const layer = childText(node, "layer")
    const outline = textBoxCopperEnvelope(node, (point) => point)
    if (layer && outline) add(layer, outline, `gr-text-box-${index}`)
  }
  for (const [footprintIndex, footprint] of [...listChildren(root, "footprint"), ...listChildren(root, "module")].entries()) {
    const atNode = findChild(footprint, "at"); const origin = pointAt(atNode); const rotation = numberAt(atNode, 3)
    const transform = (point: PointMm) => placedPoint(point, origin, rotation)
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
      if (!layer || !available.includes(layer) || textIsHidden(node)) continue
      const localAt = findChild(node, "at"); const center = transform(pointAt(localAt)); const text = atom(node[2]) ?? ""
      // KiCad v9/v10 stores fp_text angle in board files as the absolute text
      // angle; adding the footprint rotation a second time rotates the obstacle
      // away from the actual glyphs.
      add(layer, textCopperEnvelope(node, text, center, numberAt(localAt, 3)), `fp-${footprintIndex}-text-${index}`)
    }
    for (const [index, node] of listChildren(footprint, "property").entries()) {
      const layer = childText(node, "layer")
      if (!layer || !available.includes(layer) || textIsHidden(node)) continue
      const localAt = findChild(node, "at")
      const center = transform(pointAt(localAt))
      add(
        layer,
        textCopperEnvelope(node, atom(node[2]) ?? "", center, numberAt(localAt, 3)),
        `fp-${footprintIndex}-property-${index}`,
      )
    }
    for (const [index, node] of listChildren(footprint, "fp_text_box").entries()) {
      const layer = childText(node, "layer")
      const outline = textBoxCopperEnvelope(node, transform)
      if (layer && outline) add(layer, outline, `fp-${footprintIndex}-text-box-${index}`)
    }
  }
  return zones
}

type ProjectRules = Readonly<{
  minimumClearance: number; minimumTrackWidth: number; minimumViaDiameter: number; minimumViaDrill: number; minimumAnnular: number; edgeClearance: number
  classes: readonly Readonly<{
    name: string
    priority: number
    clearance?: number
    track?: number
    via?: number
    drill?: number
    diffWidth?: number
    diffGap?: number
  }>[]
  assignments: Readonly<Record<string, readonly string[]>>
  patterns: readonly Readonly<{ pattern: string; className: string }>[]
}>

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** KiCad matches a pattern as anchored regex OR anchored `*`/`?` wildcard. */
function netclassPatternMatches(net: string, pattern: string) {
  let regexMatch = false
  try {
    regexMatch = new RegExp(`^(?:${pattern})$`, "u").test(net)
  } catch {
    // An invalid raw regex can still be a valid KiCad wildcard below.
  }
  let wildcard = "^"
  for (const character of pattern) {
    if (character === "*") wildcard += ".*"
    else if (character === "?") wildcard += "."
    else wildcard += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
  }
  return regexMatch || new RegExp(`${wildcard}$`, "u").test(net)
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
    const optional = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
    return name ? [{
      name,
      priority: typeof item.priority === "number" && Number.isFinite(item.priority) ? item.priority : 0,
      ...(optional(item.clearance) === undefined ? {} : { clearance: optional(item.clearance) }),
      ...(optional(item.track_width) === undefined ? {} : { track: optional(item.track_width) }),
      ...(optional(item.via_diameter) === undefined ? {} : { via: optional(item.via_diameter) }),
      ...(optional(item.via_drill) === undefined ? {} : { drill: optional(item.via_drill) }),
      ...(optional(item.diff_pair_width) === undefined ? {} : { diffWidth: optional(item.diff_pair_width) }),
      ...(optional(item.diff_pair_gap) === undefined ? {} : { diffGap: optional(item.diff_pair_gap) }),
    }] : []
  })
  if (!classes.some((item) => item.name === "Default")) classes.push({ name: "Default", priority: Number.MAX_SAFE_INTEGER, clearance: DEFAULT_CLEARANCE_MM, track: 0.25, via: DEFAULT_VIA_MM, drill: DEFAULT_DRILL_MM, diffWidth: 0.25, diffGap: DEFAULT_CLEARANCE_MM })
  const assignments = Object.fromEntries(Object.entries(object(netSettings.netclass_assignments)).flatMap(([net, value]) => {
    const names = typeof value === "string"
      ? [value]
      : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
    return names.length ? [[net, names]] : []
  }))
  const patterns = (Array.isArray(netSettings.netclass_patterns) ? netSettings.netclass_patterns : []).flatMap((entry) => {
    const item = object(entry)
    return typeof item.pattern === "string" && typeof item.netclass === "string"
      ? [{ pattern: item.pattern, className: item.netclass }]
      : []
  })
  return {
    minimumClearance: finite(global.min_clearance, 0), minimumTrackWidth: finite(global.min_track_width, 0),
    minimumViaDiameter: finite(global.min_via_diameter, 0), minimumViaDrill: finite(global.min_through_hole_diameter, 0),
    minimumAnnular: finite(global.min_via_annular_width, 0), edgeClearance: finite(global.min_copper_edge_clearance, 0), classes, assignments, patterns,
  }
}

function values(source: ProjectRules, rule: Required<Omit<ProjectRules["classes"][number], "priority">>): RoutingRuleValues {
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
  const matchingClasses = (net: string) => source.patterns
    .filter((item) => item.pattern && netclassPatternMatches(net, item.pattern))
    .map((item) => item.className)
  const resolveClasses = (names: readonly string[]) => {
    const selected = [...new Set(names)].flatMap((name) => byName.get(name) ?? [])
      .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name))
    const cascade = selected.some((item) => item.name === defaultClass.name)
      ? selected
      : [...selected, defaultClass]
    const property = <K extends "clearance" | "track" | "via" | "drill" | "diffWidth" | "diffGap">(
      key: K,
      fallback: number,
    ) => cascade.find((item) => item[key] !== undefined)?.[key] ?? fallback
    return {
      name: cascade[0]?.name ?? "Default",
      clearance: property("clearance", DEFAULT_CLEARANCE_MM),
      track: property("track", 0.25),
      via: property("via", DEFAULT_VIA_MM),
      drill: property("drill", DEFAULT_DRILL_MM),
      diffWidth: property("diffWidth", 0.25),
      diffGap: property("diffGap", DEFAULT_CLEARANCE_MM),
    }
  }
  const valuesForNet = (net: string) => {
    const patternClasses = matchingClasses(net)
    const explicitClasses = source.assignments[net] ?? []
    return values(source, resolveClasses([...explicitClasses, ...patternClasses]))
  }
  return {
    default: values(source, resolveClasses([defaultClass.name])),
    nets: nets.map((net) => ({ net, values: valuesForNet(net) })),
  }
}

function stackup(root: SExpression[], available: readonly string[]): RoutingBoard["stackup"] {
  const stack = findChild(findChild(root, "setup") ?? [], "stackup")
  const boardThicknessMm = numberAt(findChild(findChild(root, "general") ?? [], "thickness"), 1)
  if (!stack) return {
    ...(boardThicknessMm > 0 ? { boardThicknessMm } : {}),
    fallbackCopperThicknessOz: 1,
    layers: available.map((layer) => ({ kind: "copper", layer, thicknessMm: 0.03479 })),
  }
  const layers: NonNullable<RoutingBoard["stackup"]>["layers"][number][] = []
  let topMask: NonNullable<NonNullable<RoutingBoard["stackup"]>["solderMask"]>["top"]
  let bottomMask: NonNullable<NonNullable<RoutingBoard["stackup"]>["solderMask"]>["bottom"]
  for (const item of listChildren(stack, "layer")) {
    const name = atom(item[1]) ?? ""
    const thicknessMm = numberAt(findChild(item, "thickness"), 1, name.endsWith(".Cu") ? 0.03479 : 0)
    if (name === "F.Mask" || name === "B.Mask") {
      const relativePermittivity = numberAt(findChild(item, "epsilon_r"), 1)
      const value = {
        ...(thicknessMm > 0 ? { thicknessMm } : {}),
        ...(relativePermittivity > 0 ? { relativePermittivity } : {}),
      }
      if (name === "F.Mask") topMask = value
      else bottomMask = value
      continue
    }
    if (name.endsWith(".Cu")) {
      layers.push({ kind: "copper", layer: name, thicknessMm })
      continue
    }
    const type = childText(item, "type")
    if ((type === "core" || type === "prepreg") && thicknessMm > 0) {
      const relativePermittivity = numberAt(findChild(item, "epsilon_r"), 1)
      layers.push({
      kind: "dielectric",
      ...(name ? { name } : {}),
      thicknessMm,
      ...(relativePermittivity > 0 ? { relativePermittivity } : {}),
      ...(numberAt(findChild(item, "loss_tangent"), 1) > 0
        ? { lossTangent: numberAt(findChild(item, "loss_tangent"), 1) }
        : {}),
      ...(childText(item, "material") ? { material: childText(item, "material") } : {}),
      })
    }
  }
  return layers.length ? {
    ...(boardThicknessMm > 0 ? { boardThicknessMm } : {}),
    fallbackCopperThicknessOz: 1,
    layers,
    ...(topMask === undefined && bottomMask === undefined ? {} : {
      solderMask: {
        ...(topMask === undefined ? {} : { top: topMask }),
        ...(bottomMask === undefined ? {} : { bottom: bottomMask }),
      },
    }),
  } : undefined
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
          at: placedPoint(pointAt(localAt), origin, footprintRotation),
          // KiCad's pad angle is already absolute in the board frame; only
          // the pad x/y coordinates are footprint-local.
          rotationDeg: numberAt(localAt, 3),
          layers: nodeLayers(pad, layerNames, footprintLayer), shape: padShape(pad, diagnostics, `pads.${designator}.${padIndex}`),
          ...(portableHole ? { hole: portableHole } : {}),
        })
      }
    }
    const rings = edgeCutRings(root); const sortedNets = [...nets].filter(Boolean).sort(); const ownership = options.existingCopper ?? "editable"
    const board: RoutingBoard = {
      outline: rings[0], cutouts: rings.slice(1), layers, nets: sortedNets.map((name) => ({ name })), components, pads,
      keepouts: importedKeepouts(root, layerNames), stackup: stackup(root, layerNames), rules: routingRules(await readProjectRules(absolute), sortedNets),
      copper: splitCopper(importedCopper(root, layerNames), ownership, graphicalCopper(root, layerNames)),
    }
    const validation = validateRoutingBoard(board); diagnostics.push(...validation.diagnostics)
    const canonical = validation.ok ? canonicalizeRoutingBoard(board).board : undefined
    return validation.ok ? {
      board: canonical,
      context: { path: absolute, source, root, version, existingCopper: ownership, editableCopper: canonical!.copper.editable },
      diagnostics,
    } : { diagnostics }
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

function selectedByClearIntent(
  root: SExpression[],
  node: SExpression[],
  intent: RoutingResult["clearRouting"],
) {
  if (!intent || locked(node) || findChild(node, "keepout")) return false
  const head = listHead(node)
  const item = head === "segment" || head === "arc" ? "tracks" : head === "via" ? "vias" : head === "zone" ? "zones" : undefined
  if (!item) return false
  const nets = intent[item]
  if (!nets) return false
  if (nets === "all") return true
  const net = nodeNet(root, node) ?? childText(node, "net_name")
  return net !== undefined && nets.includes(net)
}

function clearSelectedNativeCopper(
  root: SExpression[],
  ownership: "fixed" | "editable",
  intent: RoutingResult["clearRouting"],
) {
  if (ownership !== "editable" || !intent) return
  for (let index = root.length - 1; index >= 0; index -= 1) {
    const node = root[index]
    if (isSExpressionList(node) && selectedByClearIntent(root, node, intent)) root.splice(index, 1)
  }
}

type CopperKind = "tracks" | "vias" | "zones"
type IdentifiedCopper = RoutedTrack | RoutedVia | RoutedZone

function copperIdentity(kind: CopperKind, item: IdentifiedCopper) {
  return item.id && kind === "zones" ? item.id.replace(/:fill-\d+$/, "") : item.id
}

function canonicalCopperValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCopperValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, item]) => key !== "id" && key !== "sourceLocked" && item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalCopperValue(item)]))
}

function copperSignatureGroups(copper: RoutingCopper) {
  const groups: Record<CopperKind, Map<string, string[]>> = {
    tracks: new Map(), vias: new Map(), zones: new Map(),
  }
  for (const kind of ["tracks", "vias", "zones"] as const) for (const item of copper[kind]) {
    const id = copperIdentity(kind, item)
    if (!id) continue
    const values = groups[kind].get(id) ?? []
    values.push(JSON.stringify(canonicalCopperValue(item)))
    groups[kind].set(id, values)
  }
  for (const kind of ["tracks", "vias", "zones"] as const) {
    for (const values of groups[kind].values()) values.sort()
  }
  return groups
}

function sameSignatureGroup(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  return Boolean(left && right && left.length === right.length
    && left.every((value, index) => value === right[index]))
}

/**
 * RoutingResult.copper is the complete editable replacement. Preserve native
 * AST nodes that survived by id (including arcs and zone metadata), but remove
 * transaction-owned nodes absent from the replacement before appending new
 * backend geometry. Locked/fixed copper is never eligible.
 */
function removeSupersededNativeCopper(
  root: SExpression[],
  ownership: "fixed" | "editable",
  original: RoutingCopper,
  replacement: RoutingCopper,
) {
  if (ownership !== "editable") return
  const originalGroups = copperSignatureGroups(original)
  const replacementGroups = copperSignatureGroups(replacement)
  for (let index = root.length - 1; index >= 0; index -= 1) {
    const node = root[index]
    if (!isSExpressionList(node) || locked(node) || findChild(node, "keepout")) continue
    const head = listHead(node)
    const kind = head === "segment" || head === "arc" ? "tracks"
      : head === "via" ? "vias"
        : head === "zone" ? "zones" : undefined
    if (!kind) continue
    const nativeId = childText(node, "uuid") ?? childText(node, "tstamp")
    const originalGroup = nativeId ? originalGroups[kind].get(nativeId) : undefined
    if (!nativeId || !originalGroup
      || sameSignatureGroup(originalGroup, replacementGroups[kind].get(nativeId))) continue
    root.splice(index, 1)
  }
}

function newCopperOnly(copper: RoutingCopper, original: RoutingCopper): RoutingCopper {
  const originalGroups = copperSignatureGroups(original)
  const replacementGroups = copperSignatureGroups(copper)
  const unchanged = Object.fromEntries((["tracks", "vias", "zones"] as const).map((kind) => [
    kind,
    new Set([...replacementGroups[kind]].flatMap(([id, values]) => (
      sameSignatureGroup(values, originalGroups[kind].get(id)) ? [id] : []
    ))),
  ])) as Record<CopperKind, Set<string>>
  const isNew = (kind: CopperKind, item: IdentifiedCopper) => {
    const id = copperIdentity(kind, item)
    return !id || !unchanged[kind].has(id)
  }
  return {
    tracks: copper.tracks.filter((item) => isNew("tracks", item)),
    vias: copper.vias.filter((item) => isNew("vias", item)),
    zones: copper.zones.filter((item) => isNew("zones", item)),
  }
}

function n(value: number) { return token(String(Number(value.toFixed(6)))) }
function pointForm(head: string, point: PointMm): SExpression[] { return [token(head), n(point.x), n(point.y)] }

function replaceChild(parent: SExpression[], head: string, replacement: SExpression[]) {
  const index = parent.findIndex((item) => isSExpressionList(item) && listHead(item) === head)
  if (index >= 0) parent[index] = replacement
  else parent.push(replacement)
}

function applyPhysicalStackup(root: SExpression[], stackup: NonNullable<RoutingResult["stackup"]>["effective"]) {
  const copper = stackup.layers.filter((layer) => layer.kind === "copper")
  if (copper.length < 2) throw new TypeError("Applied stackup needs at least top and bottom copper layers")
  const nativeLayerNames = copper.map((_, index) => (
    index === 0 ? "F.Cu" : index === copper.length - 1 ? "B.Cu" : `In${index}.Cu`
  ))
  const nativeLayerByCanonical = new Map(copper.map((layer, index) => [layer.layer, nativeLayerNames[index]]))
  const currentLayers = findChild(root, "layers")
  const nonCopper = currentLayers?.slice(1).filter((item) => (
    !isSExpressionList(item) || !atom(item[1])?.endsWith(".Cu")
  )) ?? []
  const copperForms = copper.map((layer, index) => {
    const id = index === 0 ? 0 : index === copper.length - 1 ? 2 : 4 + (index - 1) * 2
    return [token(String(id)), token(nativeLayerNames[index], true), token("signal")] as SExpression[]
  })
  replaceChild(root, "layers", [token("layers"), ...copperForms, ...nonCopper])

  const setup = findChild(root, "setup") ?? (() => {
    const value: SExpression[] = [token("setup")]
    root.push(value)
    return value
  })()
  const existingStack = findChild(setup, "stackup")
  const existingSurfaceLayers = existingStack === undefined ? [] : listChildren(existingStack, "layer")
  const namedSurfaceLayers = (names: readonly string[]) => existingSurfaceLayers.filter((item) => names.includes(atom(item[1]) ?? ""))
  let dielectricIndex = 0
  const stackForms = stackup.layers.map((layer): SExpression[] => {
    if (layer.kind === "copper") return [
      token("layer"), token(nativeLayerByCanonical.get(layer.layer) ?? layer.layer, true),
      [token("type"), token("copper", true)],
      [token("thickness"), n(layer.thicknessMm)],
    ]
    dielectricIndex += 1
    return [
      token("layer"), token(layer.name ?? `dielectric ${dielectricIndex}`, true),
      [token("type"), token("core", true)],
      [token("thickness"), n(layer.thicknessMm)],
      ...(layer.material === undefined ? [] : [[token("material"), token(layer.material, true)] as SExpression[]]),
      ...(layer.relativePermittivity === undefined ? [] : [[token("epsilon_r"), n(layer.relativePermittivity)] as SExpression[]]),
      ...(layer.lossTangent === undefined ? [] : [[token("loss_tangent"), n(layer.lossTangent)] as SExpression[]]),
    ]
  })
  const maskForm = (
    name: "F.Mask" | "B.Mask",
    type: "Top Solder Mask" | "Bottom Solder Mask",
    values: { thicknessMm?: number; relativePermittivity?: number } | undefined,
  ): SExpression[] | undefined => values === undefined ? undefined : [
    token("layer"), token(name, true), [token("type"), token(type, true)],
    ...(values.thicknessMm === undefined ? [] : [[token("thickness"), n(values.thicknessMm)] as SExpression[]]),
    ...(values.relativePermittivity === undefined ? [] : [[token("epsilon_r"), n(values.relativePermittivity)] as SExpression[]]),
  ]
  const topMask = maskForm("F.Mask", "Top Solder Mask", stackup.solderMask?.top)
  const bottomMask = maskForm("B.Mask", "Bottom Solder Mask", stackup.solderMask?.bottom)
  replaceChild(setup, "stackup", [
    token("stackup"),
    ...namedSurfaceLayers(["F.SilkS", "F.Paste"]),
    ...(topMask === undefined ? [] : [topMask]),
    ...stackForms,
    ...(bottomMask === undefined ? [] : [bottomMask]),
    ...namedSurfaceLayers(["B.Paste", "B.SilkS"]),
  ])

  const thicknessMm = stackup.boardThicknessMm ?? stackupThicknessMm(stackup)
  const general = findChild(root, "general") ?? (() => {
    const value: SExpression[] = [token("general")]
    root.push(value)
    return value
  })()
  replaceChild(general, "thickness", [token("thickness"), n(thicknessMm)])
}

function appendCopper(root: SExpression[], version: number, copper: RoutingCopper) {
  for (const track of copper.tracks) for (let index = 0; index < track.points.length - 1; index += 1) {
    const start = track.points[index]; const end = track.points[index + 1]
    if (samePoint(start, end)) continue
    root.push([token("segment"), pointForm("start", start), pointForm("end", end), [token("width"), n(track.widthMm)], [token("layer"), token(nativeCopperLayer(root, track.layer), true)], netForm(root, version, track.net), [token("uuid"), token(randomUUID(), true)]])
  }
  for (const via of copper.vias) root.push([
    token("via"), ...(via.type === "micro"
      ? [token("micro")]
      : via.type === "blind-buried" ? [token("blind")] : []), pointForm("at", via.at),
    [token("size"), n(via.diameterMm)], [token("drill"), n(via.drillMm)], [token("layers"), token(nativeCopperLayer(root, via.fromLayer), true), token(nativeCopperLayer(root, via.toLayer), true)],
    netForm(root, version, via.net), [token("uuid"), token(randomUUID(), true)],
  ])
  for (const [sequence, zone] of copper.zones.entries()) for (const layer of zone.layers) {
    if (!zone.net) continue
    const clearance = zone.clearanceMm ?? DEFAULT_CLEARANCE_MM
    root.push([
      token("zone"), ...(version >= 20250000 ? [[token("net"), token(zone.net, true)] as SExpression[]] : [netForm(root, version, zone.net), [token("net_name"), token(zone.net, true)] as SExpression[]]),
      [token("layer"), token(nativeCopperLayer(root, layer), true)], [token("uuid"), token(randomUUID(), true)], [token("name"), token(`copilot-router:${zone.id ?? sequence}`, true)],
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

async function copyProject(sourceBoard: string, targetBoard: string, rules: RoutingRules, applyRules: boolean) {
  const source = await projectPath(sourceBoard)
  if (!source) return
  const target = `${targetBoard.slice(0, -extname(targetBoard).length)}.kicad_pro`
  const project = object(JSON.parse(await readFile(source, "utf8")))
  if (applyRules) applyProjectRules(project, rules)
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
    const root = structuredClone(context.root)
    if (result.stackup?.applyRequested) {
      applyPhysicalStackup(root, result.stackup.effective)
    }
    if (result.copper) {
      clearSelectedNativeCopper(root, context.existingCopper, result.clearRouting)
      removeSupersededNativeCopper(root, context.existingCopper, context.editableCopper, result.copper)
      appendCopper(root, context.version, newCopperOnly(result.copper, context.editableCopper))
    }
    await atomicCreate(target, `${printSExpression(root)}\n`)
    await copyProject(
      context.path,
      target,
      result.rules,
      result.operation === "apply-drc" || result.operation === "all",
    )
    return { outputPath: target, diagnostics, nativeVerification: "not-run" }
  } catch (error) {
    return { diagnostics: [...diagnostics, { code: "KICAD_ROUTING_APPLY_FAILED", severity: "error", message: error instanceof Error ? error.message : String(error) }], nativeVerification: "not-run" }
  }
}

export const emptyKiCadEditableCopper = EMPTY_COPPER
