import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { Worker } from "node:worker_threads"
import type {
  PointMm,
  RoutedTrack,
  RoutedVia,
  RoutedZone,
  RoutingBoard,
  RoutingCopper,
  RoutingDiagnostic,
  RoutingPad,
  RoutingRuleValues,
} from "../core/contracts.js"
import { EMPTY_ROUTING_COPPER } from "../core/contracts.js"
import type {
  BackendRouteRequest,
  BackendRouteResult,
  RouterBackendAdapter,
} from "../adapters/contracts.js"

export type EasyEdaWasmRouterInput = Readonly<{
  boardOutline: Readonly<{ bbox: readonly number[]; path: readonly (readonly number[])[] }>
  layers: Readonly<{ route: readonly number[]; notRoute: readonly number[] }>
  routingCorner: "45"
  rules: Readonly<Record<string, unknown>>
  classes: Readonly<Record<string, unknown>>
  nets: readonly Readonly<Record<string, unknown>>[]
  components: Readonly<Record<string, unknown>>
  footprints: Readonly<Record<string, unknown>>
  constraintRegions: Readonly<Record<string, unknown>>
  tracks: readonly Readonly<Record<string, unknown>>[]
  vias: readonly Readonly<Record<string, unknown>>[]
  fillRegions: readonly Readonly<Record<string, unknown>>[]
  prohibitedRegions: readonly Readonly<Record<string, unknown>>[]
  iterationCount?: number
}>

export type EasyEdaWasmRouterOutput = Readonly<{
  progress?: number
  routabitity?: number
  traces?: readonly Readonly<{
    id?: number | string
    layer: number
    net: string
    path: readonly (readonly number[])[]
    width: number
  }>[]
  vias?: readonly Readonly<{
    id?: number | string
    location: readonly number[]
    net: string
    size: readonly number[]
  }>[]
  [key: string]: unknown
}>

export type EasyEdaWasmEngineContext = Readonly<{
  signal?: AbortSignal
  onProgress?: (progress: number) => void
}>

export type EasyEdaWasmEngine = (
  input: EasyEdaWasmRouterInput,
  context: EasyEdaWasmEngineContext,
) => Promise<EasyEdaWasmRouterOutput>

export type EasyEdaWasmBackendOptions = Readonly<{
  engine: EasyEdaWasmEngine
  /** Defaults to all board copper layers. */
  routeLayers?: readonly string[]
  /** @deprecated Ignored. Cancel routing through BackendRouteRequest.signal. */
  timeoutMs?: number
  onProgress?: (progress: number) => void
}>

type Transform = Readonly<{ centerX: number; centerY: number }>
type LayerMap = Readonly<{
  byName: ReadonlyMap<string, number>
  byId: ReadonlyMap<number, string>
  allIds: readonly number[]
  top: string
  bottom: string
}>

type ProxyTrack = RoutedTrack & Readonly<{ id: string }>

function diagnostic(
  code: string,
  severity: RoutingDiagnostic["severity"],
  message: string,
  details?: unknown,
): RoutingDiagnostic {
  return { code, severity, message, ...(details === undefined ? {} : { details }) }
}

function closed(points: readonly (readonly number[])[]) {
  if (!points.length) return []
  const result = points.map((point) => [Number(point[0]), Number(point[1])])
  const first = result[0]
  const last = result.at(-1)!
  if (first[0] !== last[0] || first[1] !== last[1]) result.push([...first])
  const open = result.slice(0, -1)
  const signedArea = open.reduce((sum, point, index) => {
    const next = open[(index + 1) % open.length]
    return sum + point[0] * next[1] - next[0] * point[1]
  }, 0) / 2
  // The WASM input uses y-up coordinates and clockwise rings.
  if (signedArea <= 0) return result
  const reversed = open.reverse()
  return [...reversed, [...reversed[0]]]
}

function transformFor(board: RoutingBoard): Transform {
  const xs = board.outline.map((point) => point.x)
  const ys = board.outline.map((point) => point.y)
  return {
    centerX: (Math.min(...xs) + Math.max(...xs)) / 2,
    centerY: (Math.min(...ys) + Math.max(...ys)) / 2,
  }
}

function toRouter(point: PointMm, transform: Transform) {
  return [point.x - transform.centerX, transform.centerY - point.y] as const
}

function fromRouter(point: readonly number[], transform: Transform): PointMm {
  if (point.length < 2 || !point.slice(0, 2).every(Number.isFinite)) {
    throw new TypeError("EasyEDA WASM returned an invalid point")
  }
  return { x: point[0] + transform.centerX, y: transform.centerY - point[1] }
}

function layerMap(board: RoutingBoard): LayerMap {
  const ordered = [...board.layers].sort((left, right) => left.index - right.index)
  const top = ordered.find((layer) => layer.side === "top")?.name
  const bottom = ordered.find((layer) => layer.side === "bottom")?.name
  if (!top || !bottom) throw new TypeError("EasyEDA WASM needs top and bottom copper layers")
  const byName = new Map<string, number>([[top, 1], [bottom, 2]])
  let inner = 15
  for (const layer of ordered) if (layer.side === "inner") byName.set(layer.name, inner++)
  const byId = new Map([...byName].map(([name, id]) => [id, name]))
  return { byName, byId, allIds: [...byName.values()], top, bottom }
}

function rotate(point: PointMm, degrees: number): PointMm {
  const radians = degrees * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  return {
    x: point.x * cosine - point.y * sine,
    y: point.x * sine + point.y * cosine,
  }
}

function roundedRect(width: number, height: number, radius: number): PointMm[] {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  if (r <= 1e-9) return [
    { x: -width / 2, y: -height / 2 },
    { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 },
    { x: -width / 2, y: height / 2 },
  ]
  const points: PointMm[] = []
  for (const corner of [
    { x: width / 2 - r, y: -height / 2 + r, start: -90 },
    { x: width / 2 - r, y: height / 2 - r, start: 0 },
    { x: -width / 2 + r, y: height / 2 - r, start: 90 },
    { x: -width / 2 + r, y: -height / 2 + r, start: 180 },
  ]) for (let index = 0; index <= 3; index += 1) {
    const angle = (corner.start + index * 30) * Math.PI / 180
    points.push({ x: corner.x + Math.cos(angle) * r, y: corner.y + Math.sin(angle) * r })
  }
  return points
}

function padRing(pad: RoutingPad): PointMm[] {
  const shape = pad.shape
  let points: readonly PointMm[]
  if (shape.kind === "circle") points = Array.from({ length: 24 }, (_, index) => {
    const angle = Math.PI * 2 * index / 24
    return { x: Math.cos(angle) * shape.diameterMm / 2, y: Math.sin(angle) * shape.diameterMm / 2 }
  })
  else if (shape.kind === "rect") points = roundedRect(shape.widthMm, shape.heightMm, 0)
  else if (shape.kind === "round-rect") points = roundedRect(
    shape.widthMm, shape.heightMm, shape.cornerRadiusMm,
  )
  else if (shape.kind === "oval") points = roundedRect(
    shape.widthMm, shape.heightMm, Math.min(shape.widthMm, shape.heightMm) / 2,
  )
  else points = shape.polygon.outer
  // A synthetic zero-rotation component is used per pad, so pad rotation is
  // baked into its local footprint geometry before y is flipped to y-up.
  return points.map((point) => {
    const placed = rotate(point, pad.rotationDeg)
    return { x: placed.x, y: -placed.y }
  })
}

function valuesFor(board: RoutingBoard, net: string): RoutingRuleValues {
  return board.rules.nets.find((entry) => entry.net === net)?.values ?? board.rules.default
}

function ringIntervals(
  ring: readonly PointMm[],
  value: number,
  horizontal: boolean,
) {
  const crossings: number[] = []
  for (let index = 0; index < ring.length; index += 1) {
    const left = ring[index]
    const right = ring[(index + 1) % ring.length]
    const from = horizontal ? left.y : left.x
    const to = horizontal ? right.y : right.x
    if (!((from <= value && to > value) || (to <= value && from > value))) continue
    const ratio = (value - from) / (to - from)
    crossings.push((horizontal ? left.x : left.y)
      + ratio * ((horizontal ? right.x : right.y) - (horizontal ? left.x : left.y)))
  }
  crossings.sort((left, right) => left - right)
  const intervals: Array<[number, number]> = []
  for (let index = 0; index + 1 < crossings.length; index += 2) {
    if (crossings[index + 1] - crossings[index] > 1e-6) {
      intervals.push([crossings[index], crossings[index + 1]])
    }
  }
  return intervals
}

function subtractIntervals(
  source: readonly [number, number][],
  removals: readonly [number, number][],
) {
  let output = [...source]
  for (const [removeFrom, removeTo] of removals) {
    output = output.flatMap(([from, to]) => {
      if (removeTo <= from || removeFrom >= to) return [[from, to] as [number, number]]
      return [
        ...(removeFrom > from ? [[from, Math.min(removeFrom, to)] as [number, number]] : []),
        ...(removeTo < to ? [[Math.max(removeTo, from), to] as [number, number]] : []),
      ]
    })
  }
  return output.filter(([from, to]) => to - from > 1e-6)
}

function polygonIntervals(zone: RoutedZone, value: number, horizontal: boolean) {
  return subtractIntervals(
    ringIntervals(zone.outline.outer, value, horizontal),
    (zone.outline.holes ?? []).flatMap((hole) => ringIntervals(hole, value, horizontal)),
  )
}

function gridValues(minimum: number, maximum: number, pitch: number) {
  const output: number[] = []
  const first = Math.ceil((minimum - 1e-9) / pitch) * pitch
  for (let value = first; value <= maximum + 1e-9; value += pitch) {
    output.push(Number(value.toFixed(6)))
  }
  return output
}

/**
 * The stock worker understands existing tracks but does not expose a native
 * filled-zone obstacle API. A temporary same-net mesh makes compact/fixed
 * copper visible to the router. The mesh never enters RoutingResult.
 */
function zoneProxyTracks(board: RoutingBoard) {
  const output: ProxyTrack[] = []
  let nextId = 0
  for (const zone of [...board.copper.fixed.zones, ...board.copper.editable.zones]) {
    const net = zone.net
    if (!net) continue
    const rules = valuesFor(board, net)
    const widthMm = Math.max(0.05, Math.min(0.1, rules.minTrackWidthMm))
    const pitchMm = Math.max(widthMm, Math.min(0.2, rules.clearanceMm))
    const xs = zone.outline.outer.map((point) => point.x)
    const ys = zone.outline.outer.map((point) => point.y)
    for (const layer of zone.layers) {
      const append = (points: readonly PointMm[]) => {
        if (points.length < 2) return
        output.push({
          id: `existing-zone-proxy-${nextId++}`,
          net,
          layer,
          widthMm,
          points,
        })
      }
      const rings = [zone.outline.outer, ...(zone.outline.holes ?? [])]
      for (const ring of rings) for (let index = 0; index < ring.length; index += 1) {
        append([ring[index], ring[(index + 1) % ring.length]])
      }
      for (const y of gridValues(Math.min(...ys), Math.max(...ys), pitchMm)) {
        for (const [from, to] of polygonIntervals(zone, y, true)) {
          append([{ x: from, y }, { x: to, y }])
        }
      }
      for (const x of gridValues(Math.min(...xs), Math.max(...xs), pitchMm)) {
        for (const [from, to] of polygonIntervals(zone, x, false)) {
          append([{ x, y: from }, { x, y: to }])
        }
      }
    }
  }
  return output
}

function ruleTables(
  board: RoutingBoard,
  routeNets: readonly string[],
  routeLayerIds: readonly number[],
) {
  const classes = routeNets.map((net, index) => ({ id: `routing_${index}`, net, values: valuesFor(board, net) }))
  return {
    classes,
    rules: {
      safeClearances: Object.fromEntries(classes.map(({ id, values }) => [id, [{
        layers: routeLayerIds,
        trackToTrack: values.clearanceMm,
        trackToVia: values.clearanceMm,
        trackToPad: values.clearanceMm,
        trackToFillRegion: values.clearanceMm,
        trackToProhibitedRegion: values.clearanceMm,
        trackToBoardOutline: values.edgeClearanceMm,
        viaToVia: values.clearanceMm,
        viaToPad: values.clearanceMm,
        viaToFillRegion: values.clearanceMm,
        viaToProhibitedRegion: values.clearanceMm,
        viaToBoardOutline: values.edgeClearanceMm,
      }]])),
      trackWidths: Object.fromEntries(classes.map(({ id, values }) => [id, [{
        layers: routeLayerIds,
        trackWidth: [values.minTrackWidthMm, values.preferredTrackWidthMm, values.preferredTrackWidthMm],
      }]])),
      viaSizes: Object.fromEntries(classes.map(({ id, values }) => [
        `via_${id}`, [values.via.preferredDiameterMm, values.via.preferredDrillMm],
      ])),
      differentialPairs: Object.fromEntries(classes.map(({ id, values }) => [
        `diff_${id}`, [{
          layers: routeLayerIds,
          lengthTolerance: values.differential?.maxSkewMm ?? 0.254,
          width: [
            values.minTrackWidthMm,
            values.differential?.trackWidthMm ?? values.preferredTrackWidthMm,
            values.differential?.trackWidthMm ?? values.preferredTrackWidthMm,
          ],
          clearance: [
            values.differential?.gapMm ?? values.clearanceMm,
            values.differential?.gapMm ?? values.clearanceMm,
          ],
        }],
      ])),
      trackLengths: { netLength: [0, 0] },
    },
  }
}

function boardToRouterInput(
  board: RoutingBoard,
  routeLayers: readonly string[],
  routeScopeNets: readonly string[],
) {
  const transform = transformFor(board)
  const layers = layerMap(board)
  const routeLayerIds = routeLayers.map((name) => {
    const id = layers.byName.get(name)
    if (id === undefined) throw new TypeError(`EasyEDA WASM does not recognize copper layer ${name}`)
    return id
  })
  const padNets = new Set(board.pads.flatMap((pad) => pad.net ? [pad.net] : []))
  const visibleNets = board.nets.map((net) => net.name)
  const requestedNets = new Set(routeScopeNets)
  const routeNets = visibleNets.filter((net) => (
    requestedNets.has(net)
    && padNets.has(net)
    && net.toUpperCase() !== "GND"
  ))
  // Non-routed nets still need an entry and a rule class. In particular, the
  // worker otherwise sees GND pads/proxy tracks without a known net and may
  // route straight through them.
  const tables = ruleTables(board, visibleNets, routeLayerIds)
  const classByNet = new Map(tables.classes.map((item) => [item.net, item.id]))
  const differentialPairs = (board.rules.differentialPairs ?? []).filter((pair) => (
    routeNets.includes(pair.positive) && routeNets.includes(pair.negative)
  ))
  const pairByNet = new Map(differentialPairs.flatMap((pair) => [
    [pair.positive, pair.id] as const,
    [pair.negative, pair.id] as const,
  ]))
  const differentialPairRules = Object.fromEntries(differentialPairs.map((pair) => {
    const values = valuesFor(board, pair.positive)
    const differential = values.differential
    return [pair.id, [{
      layers: routeLayerIds,
      lengthTolerance: differential?.maxSkewMm ?? 0.254,
      width: [
        values.minTrackWidthMm,
        differential?.trackWidthMm ?? values.preferredTrackWidthMm,
        differential?.trackWidthMm ?? values.preferredTrackWidthMm,
      ],
      clearance: [
        differential?.gapMm ?? values.clearanceMm,
        differential?.gapMm ?? values.clearanceMm,
      ],
    }]]
  }))
  const components: Record<string, unknown> = {}
  const footprints: Record<string, unknown> = {}
  for (const [index, pad] of board.pads.entries()) {
    const padLayers = pad.layers.map((name) => layers.byName.get(name)).filter((id): id is number => id !== undefined)
    if (!padLayers.length) continue
    const componentKey = `routing_pad_${index}`
    const footprintKey = `routing_footprint_${index}`
    const ring = closed(padRing(pad).map((point) => [point.x, point.y]))
    const xs = ring.map((point) => point[0])
    const ys = ring.map((point) => point[1])
    components[componentKey] = {
      name: componentKey,
      footprint: footprintKey,
      // Every RoutingPad is exported as its own synthetic, already-positioned
      // footprint. Keep that carrier on the front side and express the pad's
      // physical copper layers only through `footprints[].pads[].layers`.
      //
      // EasyEDA mirrors a footprint's local layers when the component itself
      // is placed on layer 2. Marking both a bottom SMD carrier and its local
      // pad as layer 2 therefore double-flips the pad back to layer 1. The
      // maze then quite reasonably terminates a top trace at what it believes
      // is a top pad, while the returned trace is disconnected from the real
      // bottom pad. A front-side synthetic carrier also preserves inner and
      // through-hole layer sets verbatim.
      layer: 1,
      location: toRouter(pad.at, transform),
      rotation: 0,
      nets: { p0: pad.net ?? "" },
      pinName: { p0: pad.number },
      reuseModules: { moduleName: "", groupID: "", channelID: componentKey },
    }
    footprints[footprintKey] = {
      pads: { p0: { number: pad.number, layers: padLayers, location: [0, 0], path: ring, diameter: null } },
      bbox: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)],
    }
  }
  const inputTracks = [
    ...board.copper.fixed.tracks,
    ...board.copper.editable.tracks,
    ...zoneProxyTracks(board),
  ]
  const inputVias = [...board.copper.fixed.vias, ...board.copper.editable.vias]
  const routerOutline = closed(board.outline.map((point) => toRouter(point, transform)))
  const xs = routerOutline.map((point) => point[0])
  const ys = routerOutline.map((point) => point[1])
  const input: EasyEdaWasmRouterInput = {
    boardOutline: { bbox: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], path: routerOutline },
    layers: { route: routeLayerIds, notRoute: layers.allIds.filter((id) => !routeLayerIds.includes(id)) },
    routingCorner: "45",
    rules: {
      ...tables.rules,
      differentialPairs: {
        ...(tables.rules.differentialPairs as Readonly<Record<string, unknown>>),
        ...differentialPairRules,
      },
    },
    classes: {
      netClasses: Object.fromEntries(tables.classes.map((item) => [item.id, [item.net]])),
      differentialPairClasses: Object.fromEntries(differentialPairs.map((pair) => [
        pair.id, [pair.positive, pair.negative],
      ])),
      netClearancesClasses: Object.fromEntries(tables.classes.map((item) => [item.id, [item.net]])),
    },
    nets: visibleNets.map((net) => {
      const id = classByNet.get(net)!
      return {
        net, routing: routeNets.includes(net), safeClearance: id, trackWidth: id,
        viaSize: `via_${id}`,
        differentialPair: pairByNet.get(net) ?? `diff_${id}`,
        trackLength: "netLength",
      }
    }),
    components,
    footprints,
    constraintRegions: {},
    tracks: inputTracks.map((track, index) => ({
      id: track.id?.startsWith("existing-zone-proxy-") ? track.id : `existing-track-${index}`,
      layer: layers.byName.get(track.layer), net: track.net,
      path: track.points.map((point) => toRouter(point, transform)), width: track.widthMm,
    })),
    vias: inputVias.map((via, index) => ({
      id: `existing-via-${index}`, location: toRouter(via.at, transform), net: via.net,
      size: [via.diameterMm, via.drillMm],
    })),
    fillRegions: [],
    prohibitedRegions: [
      ...board.cutouts.map((cutout) => ({ path: closed(cutout.map((point) => toRouter(point, transform))), layers: layers.allIds })),
      ...board.keepouts.filter((keepout) => keepout.forbid.tracks || keepout.forbid.vias).map((keepout) => ({
        path: closed(keepout.polygon.outer.map((point) => toRouter(point, transform))),
        layers: keepout.layers.map((name) => layers.byName.get(name)).filter((id): id is number => id !== undefined),
      })),
      // The worker does not treat pads on routing:false nets as obstacles.
      // Export their copper bodies as ordinary prohibited regions so routed
      // nets still honor track/via clearance around GND and no-net pads.
      ...board.pads.filter((pad) => !pad.net || !routeNets.includes(pad.net)).flatMap((pad) => {
        const padLayers = pad.layers.map((name) => layers.byName.get(name))
          .filter((id): id is number => id !== undefined)
        if (!padLayers.length) return []
        const origin = toRouter(pad.at, transform)
        const path = closed(padRing(pad).map((point) => [origin[0] + point.x, origin[1] + point.y]))
        return [{ path, layers: padLayers }]
      }),
    ],
  }
  return { input, transform, layers, routeNets }
}

function pointKey(point: PointMm) {
  return `${point.x.toFixed(6)},${point.y.toFixed(6)}`
}

function trackKey(track: RoutedTrack) {
  return `${track.net}\u0000${track.layer}\u0000${track.widthMm.toFixed(6)}\u0000${track.points.map(pointKey).join(";")}`
}

function viaKey(via: RoutedVia) {
  return `${via.net}\u0000${pointKey(via.at)}\u0000${via.diameterMm.toFixed(6)}\u0000${via.drillMm.toFixed(6)}`
}

function outputCopper(
  board: RoutingBoard,
  output: EasyEdaWasmRouterOutput,
  transform: Transform,
  layers: LayerMap,
  routeNets: readonly string[],
): RoutingCopper {
  const allowedNets = new Set(routeNets)
  const knownTrackKeys = new Set(
    [...board.copper.fixed.tracks, ...board.copper.editable.tracks].map(trackKey),
  )
  const knownViaKeys = new Set([...board.copper.fixed.vias, ...board.copper.editable.vias].map(viaKey))
  const additions: RoutedTrack[] = []
  for (const [index, trace] of (output.traces ?? []).entries()) {
    if (String(trace.id ?? "").startsWith("existing-")) continue
    if (!allowedNets.has(trace.net)) throw new TypeError(`EasyEDA WASM returned out-of-scope net ${trace.net}`)
    const layer = layers.byId.get(Number(trace.layer))
    if (!layer) throw new TypeError(`EasyEDA WASM returned unknown layer ${trace.layer}`)
    if (!(Number.isFinite(trace.width) && trace.width > 0) || !Array.isArray(trace.path) || trace.path.length < 2) {
      throw new TypeError(`EasyEDA WASM trace ${index} is invalid`)
    }
    const track: RoutedTrack = {
      id: `easyeda-wasm-track-${index}`, net: trace.net, layer, widthMm: trace.width,
      points: trace.path.map((point) => fromRouter(point, transform)),
    }
    const key = trackKey(track)
    if (!knownTrackKeys.has(key)) {
      additions.push(track)
      knownTrackKeys.add(key)
    }
  }
  const addedVias: RoutedVia[] = []
  for (const [index, via] of (output.vias ?? []).entries()) {
    if (String(via.id ?? "").startsWith("existing-")) continue
    if (!allowedNets.has(via.net)) throw new TypeError(`EasyEDA WASM returned out-of-scope net ${via.net}`)
    if (!Array.isArray(via.size) || via.size.length < 2
      || !via.size.slice(0, 2).every((value) => Number.isFinite(value) && value > 0)
      || via.size[1] >= via.size[0]) throw new TypeError(`EasyEDA WASM via ${index} is invalid`)
    const routed: RoutedVia = {
      id: `easyeda-wasm-via-${index}`, net: via.net, at: fromRouter(via.location, transform),
      diameterMm: via.size[0], drillMm: via.size[1],
      fromLayer: layers.top, toLayer: layers.bottom, type: "through",
    }
    const key = viaKey(routed)
    if (!knownViaKeys.has(key)) {
      addedVias.push(routed)
      knownViaKeys.add(key)
    }
  }
  return {
    tracks: [...board.copper.editable.tracks, ...additions],
    vias: [...board.copper.editable.vias, ...addedVias],
    zones: board.copper.editable.zones,
  }
}

export function createEasyEdaWasmBackend(options: EasyEdaWasmBackendOptions): RouterBackendAdapter {
  return {
    id: "easyeda-wasm",
    capabilities: {
      // Fixed zones are represented by a staging-only same-net track mesh.
      // The worker sees obstacle/connectivity copper; the mesh is filtered
      // from output and native EDA refill remains authoritative.
      supported: [
        "ordinary-routing", "vias", "differential-pairs", "preserve-fixed-copper",
        "fixed-zone-obstacles", "preconnected-pad-groups",
      ],
      maxCopperLayers: 32,
    },
    preflight(request) {
      const diagnostics: RoutingDiagnostic[] = []
      const top = request.board.layers.find((layer) => layer.side === "top")?.name
      const bottom = request.board.layers.find((layer) => layer.side === "bottom")?.name
      for (const via of [...request.board.copper.fixed.vias, ...request.board.copper.editable.vias]) {
        if (via.fromLayer !== top || via.toLayer !== bottom) diagnostics.push(diagnostic(
          "EASYEDA_WASM_VIA_SPAN_UNSUPPORTED", "error",
          `EasyEDA WASM cannot preserve non-through via ${via.id ?? "without id"}.`,
        ))
      }
      return diagnostics
    },
    async route(request): Promise<BackendRouteResult> {
      const startedAt = performance.now()
      try {
        const selected = options.routeLayers ?? request.board.layers.map((layer) => layer.name)
        // The compiled request rules may differ from the imported board rules
        // for runAll(). The engine must see the effective values, while the
        // immutable caller-owned board object remains untouched.
        const effectiveBoard: RoutingBoard = { ...request.board, rules: request.rules }
        const exported = boardToRouterInput(effectiveBoard, selected, request.plan.scopeNets)
        const output = await options.engine(exported.input, {
          ...(request.signal ? { signal: request.signal } : {}),
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        })
        const progress = Number(output.progress ?? 0)
        const routability = Number(output.routabitity)
        const completionRatio = Number.isFinite(routability)
          ? Math.max(0, Math.min(1, routability))
          : progress >= 1 ? 1 : Math.max(0, Math.min(1, progress))
        const estimatedOpenNetCount = Math.min(
          exported.routeNets.length,
          Math.max(0, Math.ceil((1 - completionRatio) * exported.routeNets.length - 1e-9)),
        )
        const diagnostics: RoutingDiagnostic[] = []
        if (progress < 1) diagnostics.push(diagnostic(
          "EASYEDA_WASM_INCOMPLETE", "error", `EasyEDA WASM stopped at ${(progress * 100).toFixed(1)}%.`,
        ))
        if (Number.isFinite(routability) && routability < 1) diagnostics.push(diagnostic(
          "EASYEDA_WASM_PARTIAL_ROUTABILITY", "warning", `EasyEDA WASM routability is ${routability}.`,
        ))
        const copper = outputCopper(effectiveBoard, output, exported.transform, exported.layers, exported.routeNets)
        const length = copper.tracks.reduce((sum, track) => sum + track.points.slice(1).reduce((trackSum, point, index) => {
          const previous = track.points[index]
          return trackSum + Math.hypot(point.x - previous.x, point.y - previous.y)
        }, 0), 0)
        return {
          status: diagnostics.some((item) => item.severity === "error")
            ? "partial"
            : Number.isFinite(routability) && routability < 1 ? "partial" : "complete",
          copper,
          diagnostics,
          metrics: {
            elapsedMs: performance.now() - startedAt,
            routedNetCount: Math.max(0, exported.routeNets.length - estimatedOpenNetCount),
            openNetCount: estimatedOpenNetCount,
            ...(estimatedOpenNetCount === 0 ? { openNets: [] } : {}),
            connectivityComponentCount: request.plan.scopeNets.length + estimatedOpenNetCount,
            trackLengthMm: length,
            viaCount: copper.vias.length,
            details: {
              progress,
              routability: Number.isFinite(routability) ? routability : null,
              connectivityEvidence: "easyeda-wasm-routability",
              routeNets: exported.routeNets,
            },
          },
        }
      } catch (error) {
        return {
          // Backend failure must preserve the current editable checkpoint. The
          // outer Hybrid backend may still recover with KRT, and the core may
          // retain this snapshot as a useful partial result.
          status: "partial",
          copper: request.board.copper.editable ?? EMPTY_ROUTING_COPPER,
          diagnostics: [diagnostic(
            "EASYEDA_WASM_ROUTE_FAILED", "error", "EasyEDA WASM routing failed.",
            error instanceof Error ? error.message : String(error),
          )],
          metrics: {
            elapsedMs: performance.now() - startedAt,
            openNetCount: request.plan.scopeNets.length,
            openNets: request.plan.scopeNets,
            connectivityComponentCount: request.plan.scopeNets.reduce((sum, net) => (
              sum + Math.max(1, request.board.pads.filter((pad) => pad.net === net).length)
            ), 0),
          },
        }
      }
    },
  }
}

export type EasyEdaWasmWorkerEngineOptions = Readonly<{
  workerPath: string
  wasmPath: string
}>

export type BundledEasyEdaWasmBackendOptions = Readonly<
  Omit<EasyEdaWasmBackendOptions, "engine">
  & { assets?: EasyEdaWasmWorkerEngineOptions }
>

export function bundledEasyEdaWasmAssets(): EasyEdaWasmWorkerEngineOptions {
  const packageRoot = dirname(createRequire(import.meta.url).resolve("eda-copilot-router/package.json"))
  return {
    workerPath: join(packageRoot, "assets", "legacy-easyeda-wasm", "pcbRouterWorker.js"),
    wasmPath: join(packageRoot, "assets", "legacy-easyeda-wasm", "PCBRouter-YFDILLBW-YFDILLBW.wasm"),
  }
}

const workerWrapper = String.raw`
const fs = require("fs");
const { parentPort, workerData } = require("worker_threads");
globalThis.self = globalThis;
self.location = { href: "file:///" + workerData.workerPath.replace(/\\/g, "/"), origin: "file://" };
self.postMessage = message => parentPort.postMessage(message);
parentPort.on("message", message => {
  if (typeof self.onmessage === "function") self.onmessage({ data: message });
});
const nativeFetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;
const wasmBytes = fs.readFileSync(workerData.wasmPath);
globalThis.fetch = async (url, init) => {
  if (String(url).includes("PCBRouter-YFDILLBW-YFDILLBW.wasm")) {
    return new Response(wasmBytes, { status: 200, headers: { "content-type": "application/wasm" } });
  }
  if (!nativeFetch) throw new Error("No fetch implementation for " + String(url));
  return nativeFetch(url, init);
};
require(workerData.workerPath);
`

/** Build a local Node worker engine from explicitly supplied, host-owned assets. */
export function createEasyEdaWasmWorkerEngine(options: EasyEdaWasmWorkerEngineOptions): EasyEdaWasmEngine {
  return (input, context) => new Promise((resolve, reject) => {
    if (context.signal?.aborted) {
      reject(new Error("EasyEDA WASM routing aborted"))
      return
    }
    const worker = new Worker(workerWrapper, {
      eval: true,
      workerData: { workerPath: options.workerPath, wasmPath: options.wasmPath },
      // `--input-type=module` applies to eval workers as well and would turn
      // this deliberately CommonJS compatibility wrapper into ESM. Hosts may
      // legitimately launch Node with that flag, so do not inherit it here.
      execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
    })
    let settled = false
    let lastResult: EasyEdaWasmRouterOutput | undefined
    const finish = (error?: Error, result?: EasyEdaWasmRouterOutput) => {
      if (settled) return
      settled = true
      context.signal?.removeEventListener("abort", abort)
      void worker.terminate().catch(() => undefined)
      if (error) reject(error)
      else resolve(result ?? {})
    }
    const abort = () => finish(new Error("EasyEDA WASM routing aborted"))
    context.signal?.addEventListener("abort", abort, { once: true })
    worker.on("message", (message) => {
      if (message?.topic === "pcb/routerProgress") {
        const progress = Number(message.message?.progress ?? 0)
        if (Number.isFinite(progress)) context.onProgress?.(progress)
      } else if (message?.topic === "pcb/routerResult") {
        lastResult = message.message as EasyEdaWasmRouterOutput
        const progress = Number(lastResult?.progress ?? 0)
        if (Number.isFinite(progress)) context.onProgress?.(progress)
        if (progress >= 1) finish(undefined, lastResult)
      } else if (message?.topic === "pcb/routerInterrupt") {
        finish(new Error(String(message.message?.message ?? message.message ?? "EasyEDA WASM interrupted")))
      }
    })
    worker.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))))
    worker.on("exit", (code) => {
      if (settled) return
      if (lastResult) finish(undefined, lastResult)
      else finish(new Error(`EasyEDA WASM exited without a result${code ? ` (${code})` : ""}`))
    })
    worker.postMessage({
      topic: "pangolin/autoRouting_wasm",
      type: "publish",
      message: { json: input, options: {} },
    })
  })
}

/** Create the production WASM backend from the router-owned pinned assets. */
export function createBundledEasyEdaWasmBackend(
  options: BundledEasyEdaWasmBackendOptions = {},
): RouterBackendAdapter {
  const assets = options.assets ?? bundledEasyEdaWasmAssets()
  const backend = createEasyEdaWasmBackend({
    engine: createEasyEdaWasmWorkerEngine(assets),
    ...(options.routeLayers ? { routeLayers: options.routeLayers } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  })
  return {
    ...backend,
    async preflight(request) {
      const diagnostics = [...(await backend.preflight?.(request) ?? [])]
      for (const [kind, path] of [["worker", assets.workerPath], ["WASM", assets.wasmPath]] as const) {
        if (!existsSync(path)) diagnostics.push(diagnostic(
          "EASYEDA_WASM_ASSET_MISSING",
          "error",
          `Bundled EasyEDA ${kind} asset was not found.`,
          { kind, path },
        ))
      }
      return diagnostics
    },
  }
}
