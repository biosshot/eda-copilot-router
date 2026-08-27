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
  // KRT and pcbnew read footprint-local coordinates from the board file as
  // already pre-mirrored for B-side footprints. Both sides therefore use the
  // same inverse of KiCad's negated footprint rotation here; adding another
  // bottom mirror reflects every routed pad across the component's global X.
  return rotate(
    { x: pad.at.x - component.at.x, y: pad.at.y - component.at.y },
    component.rotationDeg,
  )
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

function localHoleOffset(pad: RoutingPad, component: BackendRouteRequest["board"]["components"][number]) {
  if (!pad.hole?.offset) return undefined
  // Hole offsets are expressed in the pad-local frame by both RoutingBoard and
  // KiCad. Mirroring a bottom footprint is already handled by the footprint.
  return component.side === "bottom"
    ? { x: -pad.hole.offset.x, y: pad.hole.offset.y }
    : pad.hole.offset
}

function padSource(
  pad: RoutingPad,
  component: BackendRouteRequest["board"]["components"][number],
) {
  const position = localPadPoint(pad, component)
  const through = Boolean(pad.hole)
  const type = pad.hole ? pad.hole.plated ? "thru_hole" : "np_thru_hole" : "smd"
  const size = padSize(pad)
  // KiCad stores the pad `(at x y angle)` angle in the board frame: unlike
  // the x/y offset, it already includes the footprint rotation.  RoutingPad
  // also carries an absolute board orientation, so subtracting the component
  // rotation here made every pad on a rotated portable footprint appear
  // axis-aligned to KRT (and could make adjacent pads overlap as obstacles).
  const fileRotation = pad.rotationDeg
  const holeOffset = localHoleOffset(pad, component)
  const hole = pad.hole
    ? pad.hole.shape === "slot"
      ? `(drill oval ${number(pad.hole.diameterMm + (pad.hole.slotLengthMm ?? 0))} ${number(pad.hole.diameterMm)}${holeOffset ? ` (offset ${xy(holeOffset)})` : ""})`
      : `(drill ${number(pad.hole.diameterMm)}${holeOffset ? ` (offset ${xy(holeOffset)})` : ""})`
    : ""
  const roundrect = pad.shape.kind === "round-rect"
    ? `(roundrect_rratio ${number(Math.min(0.5, pad.shape.cornerRadiusMm / Math.max(0.001, Math.min(size.width, size.height))))})`
    : ""
  const primitives = pad.shape.kind === "polygon"
    ? `(options (clearance outline) (anchor rect))
       (primitives (gr_poly (pts ${pad.shape.polygon.outer.map((point) => `(xy ${xy(point)})`).join(" ")}) (width 0) (fill yes)))`
    : ""
  return `(pad ${quote(pad.number)} ${type} ${padShape(pad)}
    (at ${xy(position)} ${number(fileRotation)})
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

function zonePolygons(outline: RoutingCopper["zones"][number]["outline"]) {
  return [outline.outer, ...(outline.holes ?? [])]
    .map((ring) => `(polygon ${polygonPoints(ring)})`)
    .join("\n")
}

function zoneSource(zone: RoutingCopper["zones"][number], layer: string) {
  if (!zone.net) return `(zone (layer ${quote(layer)}) ${uuid()} (hatch edge 0.5)
    (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
    ${zonePolygons(zone.outline)})`
  const clearance = zone.clearanceMm ?? 0
  const thickness = zone.minThicknessMm ?? 0.1
  const padMode = zone.padConnection?.mode ?? zone.connection ?? "thermal"
  const thermalGap = zone.padConnection?.thermalGapMm ?? Math.max(clearance, 0.3)
  const spokeWidth = zone.padConnection?.spokeWidthMm ?? 0.3
  const spokeCount = zone.padConnection?.spokeCount
  const spokeAngle = zone.padConnection?.spokeAngleDeg
  const fill = zone.fill?.style === "hatched"
    ? `(fill yes (mode hatch) (thermal_gap ${number(thermalGap)}) (thermal_bridge_width ${number(spokeWidth)})
        ${spokeCount === undefined ? "" : `(thermal_bridge_count ${spokeCount})`}
        ${spokeAngle === undefined ? "" : `(thermal_bridge_angle ${number(spokeAngle)})`}
        (island_removal_mode 1) (island_area_min ${number(zone.removeIslandsBelowMm2 ?? 0)})
        (hatch_thickness ${number(zone.fill.hatchThicknessMm ?? 0.5)})
        (hatch_gap ${number(zone.fill.hatchGapMm ?? 0.5)})
        (hatch_orientation ${number(zone.fill.hatchOrientationDeg ?? 0)}))`
    : `(fill yes (thermal_gap ${number(thermalGap)}) (thermal_bridge_width ${number(spokeWidth)})
        ${spokeCount === undefined ? "" : `(thermal_bridge_count ${spokeCount})`}
        ${spokeAngle === undefined ? "" : `(thermal_bridge_angle ${number(spokeAngle)})`}
        (island_removal_mode 1) (island_area_min ${number(zone.removeIslandsBelowMm2 ?? 0)}))`
  return `(zone
    ${zone.net ? `(net ${quote(zone.net)})` : ""}
    (layer ${quote(layer)}) ${uuid()} (hatch edge 0.5)
    ${zone.priority === undefined ? "" : `(priority ${number(zone.priority)})`}
    ${padMode === "none" ? "(connect_pads (clearance 0))" : `(connect_pads ${padMode === "solid" ? "yes " : ""}(clearance ${number(clearance)}))`}
    (min_thickness ${number(thickness)})
    ${fill}
    ${zonePolygons(zone.outline)}
    (filled_polygon (layer ${quote(layer)}) ${polygonPoints(zone.outline.outer)}))`
}

function keepoutSource(keepout: BackendRouteRequest["board"]["keepouts"][number], layer: string) {
  return `(zone (layer ${quote(layer)}) ${uuid()} (hatch edge 0.5)
    (keepout
      (tracks ${keepout.forbid.tracks ? "not_allowed" : "allowed"})
      (vias ${keepout.forbid.vias ? "not_allowed" : "allowed"})
      (pads allowed) (copperpour ${keepout.forbid.zones ? "not_allowed" : "allowed"}) (footprints allowed))
    ${zonePolygons(keepout.polygon)})`
}

function layerSource(request: BackendRouteRequest) {
  let innerIndex = 0
  const copper = request.board.layers.map((layer) => {
    const id = layer.side === "top" ? 0 : layer.side === "bottom" ? 2 : 4 + innerIndex++ * 2
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

function stackupSource(request: BackendRouteRequest) {
  if (!request.board.stackup) return ""
  let dielectricIndex = 0
  const layers = request.board.stackup.layers.map((layer) => {
    if (layer.kind === "copper") return `(layer ${quote(layer.layer)} (type "copper") (thickness ${number(layer.thicknessMm)}))`
    dielectricIndex += 1
    return `(layer ${quote(layer.name ?? `dielectric ${dielectricIndex}`)} (type "core") (thickness ${number(layer.thicknessMm)})${
      layer.material === undefined ? "" : ` (material ${quote(layer.material)})`
    }${layer.relativePermittivity === undefined ? "" : ` (epsilon_r ${number(layer.relativePermittivity)})`}${
      layer.lossTangent === undefined ? "" : ` (loss_tangent ${number(layer.lossTangent)})`
    })`
  })
  return `(stackup ${layers.join(" ")})`
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
  const thicknessMm = request.board.stackup?.boardThicknessMm
    ?? request.board.stackup?.layers.reduce((total, layer) => total + layer.thicknessMm, 0) ?? 1.6
  return `(kicad_pcb
    (version 20260206) (generator "copilot-router") (generator_version "0.1")
    (general (thickness ${number(thicknessMm)}) (legacy_teardrops no)) (paper "A4")
    (layers ${layerSource(request)})
    (setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no) ${stackupSource(request)})
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

export function approximateKiCadArc(start: PointMm, mid: PointMm, end: PointMm, toleranceMm = 0.01) {
  const determinant = 2 * (start.x * (mid.y - end.y) + mid.x * (end.y - start.y) + end.x * (start.y - mid.y))
  if (Math.abs(determinant) < 1e-9) return [start, end]
  const start2 = start.x ** 2 + start.y ** 2
  const mid2 = mid.x ** 2 + mid.y ** 2
  const end2 = end.x ** 2 + end.y ** 2
  const center = {
    x: (start2 * (mid.y - end.y) + mid2 * (end.y - start.y) + end2 * (start.y - mid.y)) / determinant,
    y: (start2 * (end.x - mid.x) + mid2 * (start.x - end.x) + end2 * (mid.x - start.x)) / determinant,
  }
  const angle = (point: PointMm) => Math.atan2(point.y - center.y, point.x - center.x)
  const tau = Math.PI * 2
  const normalized = (value: number) => ((value % tau) + tau) % tau
  const from = angle(start)
  let to = angle(end)
  const ccwSpan = normalized(to - from)
  if (normalized(angle(mid) - from) > ccwSpan) while (to >= from) to -= tau
  else while (to <= from) to += tau
  const radius = Math.hypot(start.x - center.x, start.y - center.y)
  const safeTolerance = Math.max(0.0001, Math.min(toleranceMm, radius))
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - safeTolerance / radius)))
  const count = Math.max(2, Math.min(1024, Math.ceil(Math.abs(to - from) / Math.max(maxStep, Math.PI / 180))))
  const points = Array.from({ length: count + 1 }, (_, index) => {
    const current = from + (to - from) * index / count
    return { x: center.x + Math.cos(current) * radius, y: center.y + Math.sin(current) * radius }
  })
  points[0] = start
  points[points.length - 1] = end
  return points
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
    const start = childPoint(expression, "start")
    const mid = childPoint(expression, "mid")
    const end = childPoint(expression, "end")
    const points = start && end ? mid ? approximateKiCadArc(start, mid, end) : [start, end] : []
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

function projectSource(rules: BackendRouteRequest["rules"]) {
  const values = [rules.default, ...rules.nets.map((entry) => entry.values)]
  const groups = new Map<string, { values: typeof rules.default; nets: string[] }>()
  const defaultKey = JSON.stringify(rules.default)
  groups.set(defaultKey, { values: rules.default, nets: [] })
  for (const entry of rules.nets) {
    const key = JSON.stringify(entry.values)
    const group = groups.get(key) ?? { values: entry.values, nets: [] }
    group.nets.push(entry.net)
    groups.set(key, group)
  }
  const grouped = [...groups.values()]
  const className = (index: number) => index === 0 ? "Default" : `Router_${index}`
  const holeToHoleClearances = values.flatMap((value) => (
    value.holeToHoleClearanceMm === undefined ? [] : [value.holeToHoleClearanceMm]
  ))
  return `${JSON.stringify({
    board: {
      design_settings: {
        rules: {
          min_track_width: Math.min(...values.map((value) => value.minTrackWidthMm)),
          min_clearance: Math.min(...values.map((value) => value.clearanceMm)),
          min_copper_edge_clearance: Math.min(...values.map((value) => value.edgeClearanceMm)),
          min_via_diameter: Math.min(...values.map((value) => value.via.minDiameterMm)),
          min_through_hole_diameter: Math.min(...values.map((value) => value.via.minDrillMm)),
          ...(holeToHoleClearances.length
            ? { min_hole_to_hole: Math.min(...holeToHoleClearances) }
            : {}),
        },
      },
    },
    net_settings: {
      classes: grouped.map((group, index) => ({
        name: className(index),
        clearance: group.values.clearanceMm,
        track_width: group.values.preferredTrackWidthMm,
        via_diameter: group.values.via.preferredDiameterMm,
        via_drill: group.values.via.preferredDrillMm,
        diff_pair_width: group.values.differential?.trackWidthMm ?? group.values.preferredTrackWidthMm,
        diff_pair_gap: group.values.differential?.gapMm ?? group.values.clearanceMm,
      })),
      netclass_assignments: Object.fromEntries(grouped.flatMap((group, index) => (
        group.nets.map((net) => [net, className(index)])
      ))),
      netclass_patterns: [],
    },
  }, null, 2)}\n`
}

export async function writeKrtBoard(request: BackendRouteRequest, directory: string) {
  const inputBoard = join(directory, "routing-board.kicad_pcb")
  const inputProject = join(directory, "routing-board.kicad_pro")
  await Promise.all([
    writeFile(inputBoard, boardSource(request), "utf8"),
    writeFile(inputProject, projectSource(request.rules), "utf8"),
  ])
  return { inputBoard, inputProject }
}

export async function readKrtBoard(preparedBoard: string, routedBoard: string) {
  if (preparedBoard === routedBoard) return { copper: EMPTY_COPPER }
  const [before, after] = await Promise.all([
    readFile(preparedBoard, "utf8").then(parseCopper),
    readFile(routedBoard, "utf8").then(parseCopper),
  ])
  return { copper: subtractCopper(before, after) }
}
