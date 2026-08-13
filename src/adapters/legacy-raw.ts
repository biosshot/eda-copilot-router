import { createHash } from "node:crypto"

import {
  RAW_PCB_V1_COORDINATES,
  createPcbSnapshotV1,
  type ArcV1,
  type CompiledRulesV1,
  type ComponentV1,
  type CopperLayerV1,
  type PadV1,
  type PcbPointV1,
  type PcbPolygonV1,
  type PcbShapeV1,
  type PcbSnapshotV1,
  type PcbSourceV1,
  type RawPcbV1,
  type RoutingDiagnostic,
  type StackupV1,
  type TrackV1,
  type ViaV1,
  type ZoneV1,
} from "../core/contracts.js"
import { validateRawPcbV1 } from "../core/validation.js"

/**
 * Structural shape of the unversioned RawPcb DTO currently returned by both
 * copilots. It deliberately has no dependency on either EDA package.
 */
export type LegacyRawPcbLike = Readonly<{
  board?: Readonly<{ polygon: readonly Readonly<{ x: number; y: number }>[] }>
  components?: readonly Readonly<{
    designator: string
    x: number
    y: number
    rotate?: number
    layer: string
    bbox?: Readonly<{ left: number; right: number; top: number; bottom: number }>
  }>[]
  pads?: readonly Readonly<{
    id?: string
    component?: string
    x: number
    y: number
    net?: string
    padNumber: string
    layer: string
    shape?: readonly unknown[]
    rotation?: number
    hole?: Readonly<{
      data: readonly unknown[]
      offsetX?: number
      offsetY?: number
      rotation?: number
    }>
  }>[]
  tracks?: readonly Readonly<{
    x1: number
    y1: number
    x2: number
    y2: number
    width: number
    layer: string
    net?: string
  }>[]
  arcs?: readonly Readonly<{
    x1: number
    y1: number
    x2: number
    y2: number
    arcAngle: number
    width: number
    layer: string
    net?: string
  }>[]
  vias?: readonly Readonly<{
    x: number
    y: number
    diameter: number
    drill: number
    net?: string
  }>[]
  polygons?: readonly Readonly<{
    net?: string
    layer: string
    fill?: boolean
    lineWidth?: number
    sources: readonly (readonly unknown[])[]
  }>[]
}>

export type LegacyCaptureOptions = Readonly<{
  /** Exact provenance of the native capture. No timestamp is added implicitly. */
  source: PcbSourceV1
  /** Already compiled, conflict-free rules. Net ids may be legacy net names. */
  rules: CompiledRulesV1
  /** Prefer native layers. If omitted, a lossy layer table is inferred. */
  layers?: readonly CopperLayerV1[]
  /** Prefer the native stackup. If omitted, copper-only 1 oz fallback is used. */
  stackup?: StackupV1
  /** Legacy layer name -> RawPcbV1 layer id. */
  layerAliases?: Readonly<Record<string, string>>
  /** Required to interpret legacy POLYGON pad coordinates without guessing. */
  polygonPadCoordinates?: "absolute" | "local"
  /** Required when legacy pads contain holes because plating was not preserved. */
  holesArePlated?: boolean
  /** Legacy vias have no layer span. Defaults to the outermost layers with a warning. */
  viaSpan?: Readonly<{ fromLayerId: string; toLayerId: string }>
  /**
   * Legacy polygons normally contain only refill output, not zone authoring
   * outlines. `filled-zone` keeps them as explicitly lossy read-only proxies.
   */
  polygonMode?: "drop" | "filled-zone"
  copperThicknessOzFallback?: number
}>

export type LegacyCaptureResult = Readonly<{
  snapshot: PcbSnapshotV1 | undefined
  diagnostics: readonly RoutingDiagnostic[]
}>

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20)
}

function entityIds(prefix: string, fingerprints: readonly unknown[]) {
  const counts = new Map<string, number>()
  return fingerprints.map((fingerprint) => {
    const base = `${prefix}:${digest(fingerprint)}`
    const occurrence = (counts.get(base) ?? 0) + 1
    counts.set(base, occurrence)
    return occurrence === 1 ? base : `${base}:${occurrence}`
  })
}

function cleanPath(points: readonly Readonly<{ x: number; y: number }>[]) {
  const result: PcbPointV1[] = []
  for (const point of points) {
    if (!finite(point?.x) || !finite(point?.y)) return undefined
    const previous = result.at(-1)
    if (!previous || previous.x !== point.x || previous.y !== point.y) {
      result.push({ x: point.x, y: point.y })
    }
  }
  if (result.length > 1) {
    const first = result[0]
    const last = result.at(-1)!
    if (first.x === last.x && first.y === last.y) result.pop()
  }
  return result.length >= 3 ? result : undefined
}

function canonicalLayerName(value: string) {
  const layer = value.trim()
  if (/^(top|f\.cu|toplayer)$/i.test(layer)) return "F.Cu"
  if (/^(bottom|b\.cu|bottomlayer)$/i.test(layer)) return "B.Cu"
  const inner = /^(?:inner[_ -]?|in)(\d+)(?:\.cu)?$/i.exec(layer)
  return inner ? `In${Number(inner[1])}.Cu` : layer
}

function inferredLayers(raw: LegacyRawPcbLike): CopperLayerV1[] {
  const names = new Set<string>(["F.Cu", "B.Cu"])
  const add = (layer: unknown) => {
    const value = text(layer)
    if (!value || /^multi$/i.test(value)) return
    names.add(canonicalLayerName(value))
  }
  raw.components?.forEach((item) => add(item.layer))
  raw.pads?.forEach((item) => add(item.layer))
  raw.tracks?.forEach((item) => add(item.layer))
  raw.arcs?.forEach((item) => add(item.layer))
  raw.polygons?.forEach((item) => add(item.layer))

  const inner = [...names]
    .filter((name) => /^In\d+\.Cu$/i.test(name))
    .sort((left, right) => Number(/\d+/.exec(left)?.[0]) - Number(/\d+/.exec(right)?.[0]))
  const canonical = ["F.Cu", ...inner, "B.Cu"]
  const extras = [...names].filter((name) => !canonical.includes(name)).sort()
  const ordered = ["F.Cu", ...inner, ...extras, "B.Cu"]
  return ordered.map((name, index) => ({
    id: `layer:${name}`,
    name,
    index,
    side: name === "F.Cu" ? "top" : name === "B.Cu" ? "bottom" : "inner",
    role: "mixed",
  } satisfies CopperLayerV1))
}

function componentSide(layer: string): ComponentV1["side"] | undefined {
  const canonical = canonicalLayerName(layer)
  if (canonical === "F.Cu") return "top"
  if (canonical === "B.Cu") return "bottom"
  return undefined
}

function bboxPolygon(bbox: Readonly<{
  left: number
  right: number
  top: number
  bottom: number
}> | undefined): PcbPolygonV1 | undefined {
  if (!bbox || typeof bbox !== "object") return undefined
  const box = bbox as { left: number; right: number; top: number; bottom: number }
  if (![box.left, box.right, box.top, box.bottom].every(finite)) return undefined
  const left = Math.min(box.left, box.right)
  const right = Math.max(box.left, box.right)
  const top = Math.min(box.top, box.bottom)
  const bottom = Math.max(box.top, box.bottom)
  if (left === right || top === bottom) return undefined
  return {
    outer: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ],
  }
}

function rotate(point: PcbPointV1, center: PcbPointV1, degrees: number): PcbPointV1 {
  const radians = degrees * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const dx = point.x - center.x
  const dy = point.y - center.y
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  }
}

function ellipse(center: PcbPointV1, diameter: number) {
  return Array.from({ length: 32 }, (_, index) => {
    const angle = Math.PI * 2 * index / 32
    return {
      x: center.x + Math.cos(angle) * diameter / 2,
      y: center.y + Math.sin(angle) * diameter / 2,
    }
  })
}

function sourceRings(source: readonly unknown[]): PcbPointV1[][] {
  const rings: PcbPointV1[][] = []
  let ring: PcbPointV1[] = []
  let index = 0
  const flush = () => {
    const cleaned = cleanPath(ring)
    if (cleaned) rings.push(cleaned)
    ring = []
  }
  if (finite(source[0]) && finite(source[1])) {
    ring.push({ x: source[0], y: source[1] })
    index = 2
  }
  while (index < source.length) {
    const rawCommand = source[index]
    const command = typeof rawCommand === "string" ? rawCommand.toUpperCase() : rawCommand
    index += 1
    if (command === "M") {
      flush()
      if (finite(source[index]) && finite(source[index + 1])) {
        ring.push({ x: source[index] as number, y: source[index + 1] as number })
        index += 2
      }
      continue
    }
    if (command === "L") {
      while (finite(source[index]) && finite(source[index + 1])) {
        ring.push({ x: source[index] as number, y: source[index + 1] as number })
        index += 2
      }
      continue
    }
    if (command === "Z") {
      flush()
      continue
    }
    if (command === "CIRCLE") {
      const x = source[index]
      const y = source[index + 1]
      const radius = source[index + 2]
      if (finite(x) && finite(y) && positive(radius)) rings.push(ellipse({ x, y }, radius * 2))
      index += 3
      continue
    }
    while (finite(source[index])) index += 1
  }
  flush()
  return rings
}

function polygonPadShape(
  pad: NonNullable<LegacyRawPcbLike["pads"]>[number],
  coordinates: LegacyCaptureOptions["polygonPadCoordinates"],
): PcbShapeV1 | undefined {
  if (!coordinates || !Array.isArray(pad.shape?.[1])) return undefined
  const complex = pad.shape[1] as readonly unknown[]
  const sources = Array.isArray(complex[0]) ? complex as readonly (readonly unknown[])[] : [complex]
  const rings = sources.flatMap(sourceRings)
  if (rings.length !== 1) return undefined
  const outer = coordinates === "absolute"
    ? rings[0].map((point) => ({ x: point.x - pad.x, y: point.y - pad.y }))
    : rings[0]
  return { kind: "polygon", polygon: { outer } }
}

function padShape(
  pad: NonNullable<LegacyRawPcbLike["pads"]>[number],
  options: LegacyCaptureOptions,
): PcbShapeV1 | undefined {
  const shape = pad.shape
  const kind = text(shape?.[0]).toUpperCase().replace(/[ _]/g, "-")
  if (kind === "POLYGON") return polygonPadShape(pad, options.polygonPadCoordinates)
  const width = Number(shape?.[1])
  const height = Number(shape?.[2] ?? shape?.[1])
  if (!positive(width) || !positive(height)) return undefined
  if (["CIRCLE", "ELLIPSE", "OVAL", "ROUND"].includes(kind)) {
    return Math.abs(width - height) <= 1e-9
      ? { kind: "circle", diameterMm: width }
      : { kind: "oval", widthMm: width, heightMm: height }
  }
  if (["RECT", "RECTANGLE"].includes(kind)) return { kind: "rect", widthMm: width, heightMm: height }
  if (["ROUND-RECT", "ROUNDRECT", "ROUNDED-RECT"].includes(kind)) {
    const radius = Number(shape?.[3])
    if (!finite(radius) || radius < 0 || radius > Math.min(width, height) / 2) return undefined
    return { kind: "round-rect", widthMm: width, heightMm: height, cornerRadiusMm: radius }
  }
  return undefined
}

function arcMidpoint(
  start: PcbPointV1,
  end: PcbPointV1,
  angleDeg: number,
): PcbPointV1 | undefined {
  if (!finite(angleDeg) || Math.abs(angleDeg) < 1e-9 || Math.abs(angleDeg) >= 360) return undefined
  const dx = end.x - start.x
  const dy = end.y - start.y
  const chord = Math.hypot(dx, dy)
  if (chord <= 1e-12) return undefined
  const radians = angleDeg * Math.PI / 180
  const tangent = Math.tan(radians / 2)
  if (Math.abs(tangent) < 1e-12) return undefined
  const chordMid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const offset = chord / (2 * tangent)
  const center = {
    x: chordMid.x - dy / chord * offset,
    y: chordMid.y + dx / chord * offset,
  }
  return rotate(start, center, angleDeg / 2)
}

function diagnostic(
  diagnostics: RoutingDiagnostic[],
  code: string,
  severity: RoutingDiagnostic["severity"],
  message: string,
  path?: string,
  details?: unknown,
) {
  diagnostics.push({ code, severity, message, ...(path ? { path } : {}), ...(details === undefined ? {} : { details }) })
}

export function captureLegacyRawPcbV1(
  legacy: LegacyRawPcbLike,
  options: LegacyCaptureOptions,
): LegacyCaptureResult {
  const diagnostics: RoutingDiagnostic[] = []
  diagnostic(
    diagnostics,
    "LEGACY_RAWPCB_LOSSY",
    "warning",
    "The unversioned RawPcb DTO omits native identities, keepouts, cutouts, layer spans and zone authoring outlines; this capture is not round-trip safe.",
  )

  const boardOutline = cleanPath(legacy.board?.polygon ?? [])
  if (!boardOutline) {
    diagnostic(diagnostics, "LEGACY_RAWPCB_BOARD_REQUIRED", "error", "Legacy RawPcb has no valid board outline.", "board.polygon")
    return { snapshot: undefined, diagnostics }
  }

  const layers = options.layers ? [...options.layers] : inferredLayers(legacy)
  if (!options.layers) {
    diagnostic(diagnostics, "LEGACY_RAWPCB_LAYERS_INFERRED", "warning", "Copper layers were inferred from legacy layer labels.", "layers")
  }
  const layerIds = new Set(layers.map((layer) => layer.id))
  if (!layers.length || layerIds.size !== layers.length) {
    diagnostic(diagnostics, "LEGACY_RAWPCB_INVALID_LAYERS", "error", "Capture layers must be non-empty with unique ids.", "layers")
    return { snapshot: undefined, diagnostics }
  }
  const topLayer = layers.find((layer) => layer.side === "top") ?? layers[0]
  const bottomLayer = [...layers].reverse().find((layer) => layer.side === "bottom") ?? layers.at(-1)!
  const aliasMap = new Map<string, string>()
  for (const layer of layers) {
    aliasMap.set(layer.id.toLowerCase(), layer.id)
    aliasMap.set(layer.name.toLowerCase(), layer.id)
    aliasMap.set(canonicalLayerName(layer.name).toLowerCase(), layer.id)
  }
  aliasMap.set("top", topLayer.id)
  aliasMap.set("f.cu", topLayer.id)
  aliasMap.set("bottom", bottomLayer.id)
  aliasMap.set("b.cu", bottomLayer.id)
  for (const [alias, layerId] of Object.entries(options.layerAliases ?? {})) aliasMap.set(alias.toLowerCase(), layerId)
  const resolveLayer = (label: string) => aliasMap.get(label.toLowerCase())

  const netNames = new Set<string>()
  const addNet = (value: unknown) => {
    const name = text(value)
    if (name) netNames.add(name)
  }
  legacy.pads?.forEach((item) => addNet(item.net))
  legacy.tracks?.forEach((item) => addNet(item.net))
  legacy.arcs?.forEach((item) => addNet(item.net))
  legacy.vias?.forEach((item) => addNet(item.net))
  legacy.polygons?.forEach((item) => addNet(item.net))
  const nets = [...netNames].sort().map((name) => ({ id: name, name }))

  const specificRules = new Map<string, CompiledRulesV1["byNet"][number]["values"]>()
  let ruleConflict = false
  for (const entry of options.rules.byNet) {
    if (specificRules.has(entry.netId)) {
      diagnostic(diagnostics, "RULE_CONFLICT", "error", `More than one compiled rule exists for ${entry.netId}.`, "rules.byNet")
      ruleConflict = true
    } else specificRules.set(entry.netId, entry.values)
  }
  if (ruleConflict) return { snapshot: undefined, diagnostics }
  for (const netId of specificRules.keys()) {
    if (!netNames.has(netId)) {
      diagnostic(diagnostics, "LEGACY_RAWPCB_UNUSED_NET_RULE", "warning", `Compiled rule for unknown net ${netId} was ignored.`, "rules.byNet")
    }
  }
  const rules: CompiledRulesV1 = {
    global: options.rules.global,
    byNet: nets.map((net) => ({ netId: net.id, values: specificRules.get(net.id) ?? options.rules.global })),
  }

  const componentInput = legacy.components ?? []
  const designatorCounts = new Map<string, number>()
  componentInput.forEach((item) => designatorCounts.set(text(item.designator), (designatorCounts.get(text(item.designator)) ?? 0) + 1))
  const components: ComponentV1[] = []
  const componentByDesignator = new Map<string, string>()
  componentInput.forEach((item, index) => {
    const designator = text(item.designator)
    const side = componentSide(item.layer)
    if (!designator || !finite(item.x) || !finite(item.y) || !finite(item.rotate ?? 0) || !side) {
      diagnostic(diagnostics, "LEGACY_RAWPCB_COMPONENT_DROPPED", "error", "Component has invalid geometry or a non-copper side.", `components[${index}]`)
      return
    }
    if (designatorCounts.get(designator) !== 1) {
      diagnostic(diagnostics, "LEGACY_RAWPCB_DUPLICATE_DESIGNATOR", "error", `Component designator ${designator} is not unique.`, `components[${index}].designator`)
      return
    }
    const id = `component:native-designator:${encodeURIComponent(designator)}`
    componentByDesignator.set(designator, id)
    const bounds = bboxPolygon(item.bbox)
    components.push({
      id,
      designator,
      at: { x: item.x, y: item.y },
      rotationDeg: item.rotate ?? 0,
      side,
      ...(bounds ? { bounds } : {}),
    })
  })

  const padInput = legacy.pads ?? []
  const needsOrphan = padInput.some((pad) => !componentByDesignator.has(text(pad.component)))
  const orphanComponentId = "component:synthetic:unowned-pads"
  if (needsOrphan) {
    components.push({
      id: orphanComponentId,
      designator: "__LEGACY_UNOWNED_PADS__",
      at: { x: 0, y: 0 },
      rotationDeg: 0,
      side: "top",
    })
    diagnostic(diagnostics, "LEGACY_RAWPCB_PAD_OWNER_MISSING", "warning", "Pads without an unambiguous owner use an explicit synthetic component.", "pads")
  }
  const padFingerprints = padInput.map((pad) => [pad.id, pad.component, pad.padNumber, pad.x, pad.y, pad.layer])
  const padIds = entityIds("pad:legacy", padFingerprints)
  const sourcePadIdCounts = new Map<string, number>()
  padInput.forEach((pad) => {
    const id = text(pad.id)
    if (id) sourcePadIdCounts.set(id, (sourcePadIdCounts.get(id) ?? 0) + 1)
  })
  const pads: PadV1[] = []
  padInput.forEach((pad, index) => {
    const shape = padShape(pad, options)
    const rotationDeg = pad.rotation ?? 0
    const padLayers = /^multi$/i.test(pad.layer)
      ? layers.map((layer) => layer.id)
      : [resolveLayer(pad.layer)].filter((value): value is string => Boolean(value))
    if (!finite(pad.x) || !finite(pad.y) || !finite(rotationDeg) || !text(pad.padNumber) || !shape || !padLayers.length) {
      const shapeHint = text(pad.shape?.[0]) || "missing"
      diagnostic(
        diagnostics,
        "LEGACY_RAWPCB_PAD_DROPPED",
        "error",
        `Pad could not be represented exactly (shape ${shapeHint}, layer ${pad.layer}). POLYGON pads require polygonPadCoordinates.`,
        `pads[${index}]`,
      )
      return
    }
    let hole: PadV1["hole"]
    if (pad.hole) {
      const numbers = pad.hole.data.filter(finite)
      const tag = text(pad.hole.data[0]).toUpperCase()
      const diameter = tag ? numbers[0] : numbers.length === 1 ? numbers[0] : undefined
      if (options.holesArePlated === undefined || !positive(diameter)
        || !finite(pad.hole.offsetX ?? 0) || !finite(pad.hole.offsetY ?? 0)
        || !finite(pad.hole.rotation ?? 0)) {
        diagnostic(
          diagnostics,
          "LEGACY_RAWPCB_PAD_DROPPED",
          "error",
          "Pad hole plating/shape is unavailable. Set holesArePlated only when the source adapter knows it; only round legacy holes are supported.",
          `pads[${index}].hole`,
        )
        return
      }
      hole = {
        shape: "round",
        diameterMm: diameter,
        offset: { x: pad.hole.offsetX ?? 0, y: pad.hole.offsetY ?? 0 },
        rotationDeg: pad.hole.rotation ?? 0,
        plated: options.holesArePlated,
      }
    }
    const owner = componentByDesignator.get(text(pad.component)) ?? orphanComponentId
    const sourceId = text(pad.id)
    if (sourceId && sourcePadIdCounts.get(sourceId)! > 1) {
      diagnostic(diagnostics, "LEGACY_RAWPCB_DUPLICATE_PAD_ID", "warning", `Duplicate native pad id ${sourceId}; a deterministic synthesized id was used.`, `pads[${index}].id`)
    }
    pads.push({
      id: sourceId && sourcePadIdCounts.get(sourceId) === 1
        ? `pad:native:${encodeURIComponent(sourceId)}`
        : padIds[index],
      componentId: owner,
      number: text(pad.padNumber),
      ...(text(pad.net) ? { netId: text(pad.net) } : {}),
      at: { x: pad.x, y: pad.y },
      rotationDeg,
      layers: padLayers,
      shape,
      ...(hole ? { hole } : {}),
    })
  })

  const trackInput = legacy.tracks ?? []
  const trackIds = entityIds("track", trackInput)
  const tracks: TrackV1[] = []
  trackInput.forEach((track, index) => {
    const netId = text(track.net)
    const layerId = resolveLayer(track.layer)
    if (!netId || !layerId || ![track.x1, track.y1, track.x2, track.y2].every(finite) || !positive(track.width)) {
      diagnostic(diagnostics, "LEGACY_RAWPCB_TRACK_DROPPED", "error", "Track has no net, invalid geometry, width or layer.", `tracks[${index}]`)
      return
    }
    tracks.push({
      kind: "track",
      id: trackIds[index],
      netId,
      layerId,
      start: { x: track.x1, y: track.y1 },
      end: { x: track.x2, y: track.y2 },
      widthMm: track.width,
    })
  })

  const arcInput = legacy.arcs ?? []
  const arcIds = entityIds("arc", arcInput)
  const arcs: ArcV1[] = []
  arcInput.forEach((arc, index) => {
    const netId = text(arc.net)
    const layerId = resolveLayer(arc.layer)
    const start = { x: arc.x1, y: arc.y1 }
    const end = { x: arc.x2, y: arc.y2 }
    const mid = arcMidpoint(start, end, arc.arcAngle)
    if (!netId || !layerId || ![arc.x1, arc.y1, arc.x2, arc.y2].every(finite) || !positive(arc.width) || !mid) {
      diagnostic(diagnostics, "LEGACY_RAWPCB_ARC_DROPPED", "error", "Arc has no net or cannot be reconstructed from its legacy endpoint/angle form.", `arcs[${index}]`)
      return
    }
    arcs.push({ kind: "arc", id: arcIds[index], netId, layerId, start, mid, end, widthMm: arc.width })
  })

  const viaInput = legacy.vias ?? []
  const viaIds = entityIds("via", viaInput)
  const vias: ViaV1[] = []
  if (viaInput.length && !options.viaSpan) {
    diagnostic(diagnostics, "LEGACY_RAWPCB_VIA_SPAN_ASSUMED", "warning", "Legacy vias have no span; the outermost copper layers were used.", "vias")
  }
  const viaSpan = options.viaSpan ?? { fromLayerId: topLayer.id, toLayerId: bottomLayer.id }
  viaInput.forEach((via, index) => {
    const netId = text(via.net)
    if (!netId || !finite(via.x) || !finite(via.y) || !positive(via.diameter) || !positive(via.drill)
      || via.drill >= via.diameter || !layerIds.has(viaSpan.fromLayerId) || !layerIds.has(viaSpan.toLayerId)) {
      diagnostic(diagnostics, "LEGACY_RAWPCB_VIA_DROPPED", "error", "Via has no net or invalid geometry/span.", `vias[${index}]`)
      return
    }
    vias.push({
      kind: "via",
      id: viaIds[index],
      netId,
      at: { x: via.x, y: via.y },
      diameterMm: via.diameter,
      drillMm: via.drill,
      fromLayerId: viaSpan.fromLayerId,
      toLayerId: viaSpan.toLayerId,
      viaType: "through",
    })
  })

  const zones: ZoneV1[] = []
  const zoneIdCounts = new Map<string, number>()
  const polygonInput = legacy.polygons ?? []
  if (polygonInput.length && options.polygonMode !== "filled-zone") {
    diagnostic(diagnostics, "LEGACY_RAWPCB_POLYGONS_DROPPED", "warning", "Legacy filled polygons were dropped because their authoring outlines and holes are unavailable.", "polygons")
  } else if (polygonInput.length) {
    diagnostic(diagnostics, "LEGACY_RAWPCB_FILLED_ZONE_PROXY", "warning", "Legacy fill contours are represented as zone proxies; do not write these outlines back to an EDA.", "polygons")
    polygonInput.forEach((polygon, polygonIndex) => {
      const netId = text(polygon.net)
      const layerId = resolveLayer(polygon.layer)
      if (!netId || !layerId) {
        diagnostic(diagnostics, "LEGACY_RAWPCB_POLYGON_DROPPED", "error", "Polygon has no net or an unknown layer.", `polygons[${polygonIndex}]`)
        return
      }
      const rings = polygon.sources.flatMap(sourceRings)
      if (!rings.length) {
        diagnostic(diagnostics, "LEGACY_RAWPCB_POLYGON_DROPPED", "error", "Polygon source contains no supported linear contour.", `polygons[${polygonIndex}].sources`)
        return
      }
      rings.forEach((outer) => {
        const geometry: PcbPolygonV1 = { outer }
        const zoneIdBase = `legacy-filled-zone:${digest([netId, layerId, polygon.lineWidth, outer])}`
        const occurrence = (zoneIdCounts.get(zoneIdBase) ?? 0) + 1
        zoneIdCounts.set(zoneIdBase, occurrence)
        zones.push({
          kind: "zone",
          id: occurrence === 1 ? zoneIdBase : `${zoneIdBase}:${occurrence}`,
          netId,
          layerId,
          outline: geometry,
          filled: [geometry],
          fillState: "filled",
          ...(positive(polygon.lineWidth) ? { minThicknessMm: polygon.lineWidth } : {}),
          connection: "solid",
        })
      })
    })
  }

  const fallbackOz = positive(options.copperThicknessOzFallback) ? options.copperThicknessOzFallback : 1
  const stackup: StackupV1 = options.stackup ?? {
    copperThicknessOzFallback: fallbackOz,
    layers: layers.map((layer) => ({
      kind: "copper" as const,
      layerId: layer.id,
      thicknessMm: 0.0348 * fallbackOz,
    })),
  }
  if (!options.stackup) {
    diagnostic(diagnostics, "LEGACY_RAWPCB_STACKUP_ASSUMED", "warning", `${fallbackOz} oz copper-only fallback stackup was used.`, "stackup")
  }

  const rawPcb: RawPcbV1 = {
    schema: "raw-pcb",
    version: 1,
    coordinates: RAW_PCB_V1_COORDINATES,
    source: options.source,
    board: { outline: boardOutline, cutouts: [] },
    layers,
    stackup,
    nets,
    components,
    pads,
    copper: { tracks, arcs, vias, zones },
    keepouts: [],
    rules,
  }
  const validation = validateRawPcbV1(rawPcb)
  if (!validation.ok) {
    return { snapshot: undefined, diagnostics: [...diagnostics, ...validation.diagnostics] }
  }
  return { snapshot: createPcbSnapshotV1(rawPcb), diagnostics }
}
