import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { BackendRouteRequest } from "../adapters/contracts.js"
import type {
  PointMm,
  RoutedTrack,
  RoutedVia,
  RoutingCopper,
  RoutingPad,
} from "../core/contracts.js"
import {
  atom,
  findChild,
  listChildren,
  parsePcbSource,
  type SExpression,
} from "../internal/kicad-sexpr.js"

const EMPTY_COPPER: RoutingCopper = { tracks: [], vias: [], zones: [] }

function number(value: number) {
  if (!Number.isFinite(value)) throw new TypeError(`Cannot encode non-finite KiCad coordinate ${value}`)
  return String(Number(value.toFixed(6)))
}

function quote(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function xy(point: PointMm) {
  return `${number(point.x)} ${number(point.y)}`
}

function uuid() {
  return `(uuid ${quote(randomUUID())})`
}

function rotate(point: PointMm, degrees: number): PointMm {
  const radians = degrees * Math.PI / 180
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  }
}

function localPadPoint(pad: RoutingPad, component: BackendRouteRequest["board"]["components"][number]) {
  const local = rotate({ x: pad.at.x - component.at.x, y: pad.at.y - component.at.y }, -component.rotationDeg)
  return component.side === "bottom" ? { x: -local.x, y: local.y } : local
}

function padSize(pad: RoutingPad) {
  switch (pad.shape.kind) {
    case "circle": return { width: pad.shape.diameterMm, height: pad.shape.diameterMm }
    case "rect":
    case "oval":
    case "round-rect": return { width: pad.shape.widthMm, height: pad.shape.heightMm }
    case "polygon": {
      const xs = pad.shape.polygon.outer.map((point) => point.x)
      const ys = pad.shape.polygon.outer.map((point) => point.y)
      return {
        width: Math.max(0.001, Math.max(...xs) - Math.min(...xs)),
        height: Math.max(0.001, Math.max(...ys) - Math.min(...ys)),
      }
    }
  }
}

function padShape(pad: RoutingPad) {
  switch (pad.shape.kind) {
    case "circle": return "circle"
    case "rect": return "rect"
    case "oval": return "oval"
    case "round-rect": return "roundrect"
    case "polygon": return "custom"
  }
}

function padLayers(pad: RoutingPad, through: boolean) {
  if (through) return '"*.Cu" "*.Mask"'
  const copper = pad.layers.map(quote)
  const side = pad.layers.some((layer) => layer === "B.Cu") ? "B" : "F"
  return [...copper, quote(`${side}.Mask`), quote(`${side}.Paste`)].join(" ")
}

function padSource(
  pad: RoutingPad,
  component: BackendRouteRequest["board"]["components"][number],
) {
  const position = localPadPoint(pad, component)
  const through = Boolean(pad.hole?.plated)
  const type = through ? "thru_hole" : "smd"
  const size = padSize(pad)
  const localRotation = component.side === "bottom"
    ? component.rotationDeg - pad.rotationDeg
    : pad.rotationDeg - component.rotationDeg
  const hole = pad.hole
    ? pad.hole.shape === "slot"
      ? `(drill oval ${number(pad.hole.diameterMm + (pad.hole.slotLengthMm ?? 0))} ${number(pad.hole.diameterMm)})`
      : `(drill ${number(pad.hole.diameterMm)})`
    : ""
  const roundrect = pad.shape.kind === "round-rect"
    ? `(roundrect_rratio ${number(Math.min(0.5, pad.shape.cornerRadiusMm / Math.max(0.001, Math.min(size.width, size.height))))})`
    : ""
  const primitives = pad.shape.kind === "polygon"
    ? `(options (clearance outline) (anchor rect))
       (primitives (gr_poly (pts ${pad.shape.polygon.outer.map((point) => `(xy ${xy(point)})`).join(" ")}) (width 0) (fill yes)))`
    : ""
  return `(pad ${quote(pad.number)} ${type} ${padShape(pad)}
    (at ${xy(position)} ${number(localRotation)})
    (size ${number(size.width)} ${number(size.height)})
    ${hole}
    (layers ${padLayers(pad, through)})
    ${roundrect}
    ${pad.net ? `(net ${quote(pad.net)})` : ""}
    ${primitives}
    ${uuid()})`
}

function footprintSource(request: BackendRouteRequest) {
  const padsByComponent = new Map<string, RoutingPad[]>()
  for (const pad of request.board.pads) padsByComponent.set(
    pad.component,
    [...(padsByComponent.get(pad.component) ?? []), pad],
  )
  return request.board.components.map((component) => {
    const layer = component.side === "bottom" ? "B.Cu" : "F.Cu"
    const pads = padsByComponent.get(component.designator) ?? []
    return `(footprint "copilot-router:generated"
      (layer ${quote(layer)})
      ${uuid()}
      (at ${xy(component.at)} ${number(component.rotationDeg)})
      (property "Reference" ${quote(component.designator)}
        (at 0 0 0) (layer ${quote(component.side === "bottom" ? "B.SilkS" : "F.SilkS")}) (hide yes)
        ${uuid()} (effects (font (size 1 1) (thickness 0.15))))
      (property "Value" "generated" (at 0 0 0) (layer ${quote(component.side === "bottom" ? "B.Fab" : "F.Fab")}) (hide yes)
        ${uuid()} (effects (font (size 1 1) (thickness 0.15))))
      ${pads.map((pad) => padSource(pad, component)).join("\n")}
      (embedded_fonts no))`
  }).join("\n")
}

function trackSource(track: RoutedTrack, locked: boolean) {
  return track.points.slice(1).map((end, index) => `(segment
    (start ${xy(track.points[index])}) (end ${xy(end)})
    (width ${number(track.widthMm)}) (layer ${quote(track.layer)}) (net ${quote(track.net)})
    ${locked ? "(locked yes)" : ""} ${uuid()})`).join("\n")
}

function viaSource(via: RoutedVia, locked: boolean) {
  const kind = via.type === "micro" ? "micro" : via.type === "blind-buried" ? "blind" : ""
  return `(via ${kind} (at ${xy(via.at)}) (size ${number(via.diameterMm)}) (drill ${number(via.drillMm)})
    (layers ${quote(via.fromLayer)} ${quote(via.toLayer)}) (net ${quote(via.net)})
    ${locked ? "(locked yes)" : ""} ${uuid()})`
}

function polygonPoints(points: readonly PointMm[]) {
  return `(pts ${points.map((point) => `(xy ${xy(point)})`).join(" ")})`
}

function zoneSource(zone: RoutingCopper["zones"][number], layer: string) {
  const clearance = zone.clearanceMm ?? 0
  const thickness = zone.minThicknessMm ?? 0.1
  return `(zone
    ${zone.net ? `(net ${quote(zone.net)})` : ""}
    (layer ${quote(layer)}) ${uuid()} (hatch edge 0.5)
    (connect_pads yes (clearance ${number(clearance)}))
    (min_thickness ${number(thickness)})
    (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.3) (island_removal_mode 0))
    (polygon ${polygonPoints(zone.outline.outer)})
    (filled_polygon (layer ${quote(layer)}) ${polygonPoints(zone.outline.outer)}))`
}

function keepoutSource(keepout: BackendRouteRequest["board"]["keepouts"][number], layer: string) {
  return `(zone (layer ${quote(layer)}) ${uuid()} (hatch edge 0.5)
    (keepout
      (tracks ${keepout.forbid.tracks ? "not_allowed" : "allowed"})
      (vias ${keepout.forbid.vias ? "not_allowed" : "allowed"})
      (pads allowed) (copperpour ${keepout.forbid.zones ? "not_allowed" : "allowed"}) (footprints allowed))
    (polygon ${polygonPoints(keepout.polygon.outer)}))`
}

function layerSource(request: BackendRouteRequest) {
  const copper = request.board.layers.map((layer, index) => {
    const id = layer.side === "top" ? 0 : layer.side === "bottom" ? 2 : 4 + index * 2
    return `(${id} ${quote(layer.name)} signal)`
  })
  return [...copper,
    '(9 "F.Adhes" user "F.Adhesive")', '(11 "B.Adhes" user "B.Adhesive")',
    '(13 "F.Paste" user)', '(15 "B.Paste" user)', '(5 "F.SilkS" user "F.Silkscreen")',
    '(7 "B.SilkS" user "B.Silkscreen")', '(1 "F.Mask" user)', '(3 "B.Mask" user)',
    '(25 "Edge.Cuts" user)', '(31 "F.CrtYd" user "F.Courtyard")',
    '(29 "B.CrtYd" user "B.Courtyard")', '(35 "F.Fab" user)', '(33 "B.Fab" user)',
  ].join("\n")
}

function boardSource(request: BackendRouteRequest) {
  const copper = [request.board.copper.fixed, request.board.copper.editable]
  const tracks = copper.flatMap((scope) => scope.tracks.map((track) => trackSource(track, true))).join("\n")
  const vias = copper.flatMap((scope) => scope.vias.map((via) => viaSource(via, true))).join("\n")
  const zones = copper.flatMap((scope) => scope.zones.flatMap((zone) => zone.layers.map((layer) => zoneSource(zone, layer)))).join("\n")
  const outlines = [request.board.outline, ...request.board.cutouts].flatMap((ring) => ring.map((start, index) => {
    const end = ring[(index + 1) % ring.length]
    return `(gr_line (start ${xy(start)}) (end ${xy(end)}) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts") ${uuid()})`
  })).join("\n")
  const keepouts = request.board.keepouts.flatMap((keepout) => keepout.layers.map((layer) => keepoutSource(keepout, layer))).join("\n")
  return `(kicad_pcb
    (version 20260206) (generator "copilot-router") (generator_version "0.1")
    (general (thickness 1.6) (legacy_teardrops no)) (paper "A4")
    (layers ${layerSource(request)})
    (setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no))
    ${footprintSource(request)}
    ${tracks}
    ${vias}
    ${zones}
    ${keepouts}
    ${outlines})\n`
}

function childNumber(expression: SExpression[], name: string) {
  const value = atom(findChild(expression, name)?.[1])
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function childPoint(expression: SExpression[], name: string): PointMm | undefined {
  const item = findChild(expression, name)
  const x = Number(atom(item?.[1]))
  const y = Number(atom(item?.[2]))
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
}

function netMap(root: SExpression[]) {
  return new Map(listChildren(root, "net").flatMap((item) => {
    const id = atom(item[1])
    const name = atom(item[2])
    return id !== undefined && name !== undefined ? [[id, name] as const] : []
  }))
}

function expressionNet(expression: SExpression[], nets: Map<string, string>) {
  const value = atom(findChild(expression, "net")?.[1])
  return value === undefined ? undefined : nets.get(value) ?? value
}

function parseCopper(source: string): RoutingCopper {
  const root = parsePcbSource(source)
  const nets = netMap(root)
  const tracks: RoutedTrack[] = []
  for (const expression of [...listChildren(root, "segment"), ...listChildren(root, "arc")]) {
    const net = expressionNet(expression, nets)
    const layer = atom(findChild(expression, "layer")?.[1])
    const widthMm = childNumber(expression, "width")
    const points = [childPoint(expression, "start"), childPoint(expression, "mid"), childPoint(expression, "end")]
      .filter((point): point is PointMm => point !== undefined)
    if (net && layer && widthMm && points.length >= 2) tracks.push({ net, layer, widthMm, points })
  }
  const vias: RoutedVia[] = []
  for (const expression of listChildren(root, "via")) {
    const net = expressionNet(expression, nets)
    const at = childPoint(expression, "at")
    const diameterMm = childNumber(expression, "size")
    const drillMm = childNumber(expression, "drill")
    const layers = findChild(expression, "layers")?.slice(1).map(atom).filter((item): item is string => item !== undefined) ?? []
    if (net && at && diameterMm && drillMm && layers.length >= 2) vias.push({
      net, at, diameterMm, drillMm, fromLayer: layers[0], toLayer: layers.at(-1)!, type: "through",
    })
  }
  return { tracks, vias, zones: [] }
}

function rounded(value: number) {
  return Number(value.toFixed(5))
}

function trackKey(track: RoutedTrack) {
  return JSON.stringify([track.net, track.layer, rounded(track.widthMm), track.points.map((point) => [rounded(point.x), rounded(point.y)])])
}

function viaKey(via: RoutedVia) {
  return JSON.stringify([via.net, rounded(via.at.x), rounded(via.at.y), rounded(via.diameterMm), rounded(via.drillMm), via.fromLayer, via.toLayer])
}

function subtractCopper(before: RoutingCopper, after: RoutingCopper): RoutingCopper {
  const tracks = new Map<string, number>()
  const vias = new Map<string, number>()
  for (const track of before.tracks) tracks.set(trackKey(track), (tracks.get(trackKey(track)) ?? 0) + 1)
  for (const via of before.vias) vias.set(viaKey(via), (vias.get(viaKey(via)) ?? 0) + 1)
  return {
    tracks: after.tracks.filter((track) => {
      const key = trackKey(track)
      const count = tracks.get(key) ?? 0
      if (count <= 0) return true
      tracks.set(key, count - 1)
      return false
    }),
    vias: after.vias.filter((via) => {
      const key = viaKey(via)
      const count = vias.get(key) ?? 0
      if (count <= 0) return true
      vias.set(key, count - 1)
      return false
    }),
    zones: [],
  }
}

export async function writeKrtBoard(request: BackendRouteRequest, directory: string) {
  const inputBoard = join(directory, "routing-board.kicad_pcb")
  await writeFile(inputBoard, boardSource(request), "utf8")
  return { inputBoard }
}

export async function readKrtBoard(preparedBoard: string, routedBoard: string) {
  if (preparedBoard === routedBoard) return { copper: EMPTY_COPPER }
  const [before, after] = await Promise.all([
    readFile(preparedBoard, "utf8").then(parseCopper),
    readFile(routedBoard, "utf8").then(parseCopper),
  ])
  return { copper: subtractCopper(before, after) }
}
