import type { ViaStitchIntent } from "../intent/types.js"
import type {
  PointMm,
  RoutedTrack,
  RoutedVia,
  RoutingBoard,
  RoutingCopper,
  RoutingDiagnostic,
  RoutingRules,
} from "./contracts.js"

const EPSILON = 1e-7

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

function distanceToRing(point: PointMm, ring: readonly PointMm[]) {
  if (pointInRing(point, ring)) return 0
  return distanceToRingBoundary(point, ring)
}

function distanceToRingBoundary(point: PointMm, ring: readonly PointMm[]) {
  return ring.reduce((minimum, start, index) => Math.min(
    minimum,
    distanceToSegment(point, start, ring[(index + 1) % ring.length]),
  ), Infinity)
}

function shapeRadius(pad: RoutingBoard["pads"][number]) {
  const shape = pad.shape
  if (shape.kind === "circle") return shape.diameterMm / 2
  if (shape.kind === "polygon") return Math.max(...shape.polygon.outer.map((point) => Math.hypot(point.x, point.y)), 0)
  return Math.hypot(shape.widthMm, shape.heightMm) / 2
}

function padRadius(board: RoutingBoard, index: number) {
  return shapeRadius(board.pads[index])
}

function rulesForNet(rules: RoutingRules, net: string) {
  return rules.nets.find((item) => item.net === net)?.values ?? rules.default
}

function physicalLayers(board: RoutingBoard) {
  const from = board.layers[0]?.name
  const to = board.layers.at(-1)?.name
  return from && to ? [from, to] as const : undefined
}

function zoneContains(point: PointMm, zone: RoutingCopper["zones"][number]) {
  return pointInRing(point, zone.outline.outer)
    && !(zone.outline.holes ?? []).some((hole) => pointInRing(point, hole))
}

function viaGeometry(intent: ViaStitchIntent, rules: ReturnType<typeof rulesForNet>) {
  return intent.via === "drc-min" || !intent.via
    ? { diameterMm: rules.via.minDiameterMm, drillMm: rules.via.minDrillMm }
    : {
        diameterMm: intent.via.diameterMm ?? rules.via.minDiameterMm,
        drillMm: intent.via.drillMm ?? rules.via.minDrillMm,
      }
}

function legalVia(
  board: RoutingBoard,
  point: PointMm,
  net: string,
  layers: readonly string[],
  diameterMm: number,
  drillMm: number,
  rules: RoutingRules,
  tracks: readonly RoutedTrack[],
  existing: readonly RoutedVia[],
  ignoredPadIndex?: number,
) {
  const value = rulesForNet(rules, net)
  const radius = diameterMm / 2
  if (!pointInRing(point, board.outline) || board.cutouts.some((ring) => pointInRing(point, ring))) return false
  if (distanceToRingBoundary(point, board.outline) < radius + value.edgeClearanceMm - EPSILON) return false
  if (board.cutouts.some((ring) => distanceToRingBoundary(point, ring) < radius + value.edgeClearanceMm - EPSILON)) return false
  if (board.keepouts.some((keepout) => keepout.forbid.vias
    && keepout.layers.some((layer) => layers.includes(layer))
    && distanceToRing(point, keepout.polygon.outer) < radius - EPSILON)) return false
  if (board.pads.some((pad, index) => {
    if (index === ignoredPadIndex) return false
    const clearance = pad.net === net ? 0 : Math.max(value.clearanceMm, pad.net ? rulesForNet(rules, pad.net).clearanceMm : value.clearanceMm)
    return Math.hypot(point.x - pad.at.x, point.y - pad.at.y) < radius + padRadius(board, index) + clearance - EPSILON
  })) return false
  if (tracks.some((track) => track.net !== net && layers.includes(track.layer)
    && track.points.slice(1).some((end, index) => distanceToSegment(point, track.points[index], end)
      < radius + track.widthMm / 2 + Math.max(value.clearanceMm, rulesForNet(rules, track.net).clearanceMm) - EPSILON))) return false
  const zones = [...board.copper.fixed.zones, ...board.copper.editable.zones]
  if (zones.some((zone) => zone.net !== net && zone.layers.some((layer) => layers.includes(layer))
    && zoneContains(point, zone))) return false
  if (existing.some((via) => {
    const distance = Math.hypot(point.x - via.at.x, point.y - via.at.y)
    const copperSpacing = radius + via.diameterMm / 2
      + (via.net === net ? 0 : Math.max(value.clearanceMm, rulesForNet(rules, via.net).clearanceMm))
    const holeSpacing = drillMm / 2 + via.drillMm / 2 + (value.holeToHoleClearanceMm ?? 0)
    return distance < Math.max(copperSpacing, holeSpacing) - EPSILON
  })) return false
  return true
}

function contourSamples(ring: readonly PointMm[], pitch: number, offset: number, side: "inside" | "outside", rows: number) {
  const output: PointMm[] = []
  const signedArea = ring.reduce((area, point, index) => {
    const next = ring[(index + 1) % ring.length]
    return area + point.x * next.y - next.x * point.y
  }, 0) / 2
  const interiorSign = signedArea >= 0 ? 1 : -1
  for (let row = 0; row < rows; row += 1) {
    const rowOffset = offset + row * pitch * Math.sqrt(3) / 2
    for (let index = 0; index < ring.length; index += 1) {
      const start = ring[index]
      const end = ring[(index + 1) % ring.length]
      const length = Math.hypot(end.x - start.x, end.y - start.y)
      if (length <= EPSILON) continue
      const leftNormal = { x: -(end.y - start.y) / length, y: (end.x - start.x) / length }
      const direction = side === "inside" ? interiorSign : -interiorSign
      const count = Math.max(1, Math.ceil(length / pitch))
      for (let sample = 0; sample < count; sample += 1) {
        const t = sample / count
        const base = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }
        output.push({
          x: base.x + leftNormal.x * rowOffset * direction,
          y: base.y + leftNormal.y * rowOffset * direction,
        })
      }
    }
  }
  return output
}

function componentRings(board: RoutingBoard, designators: readonly string[]) {
  return designators.flatMap((designator) => {
    const component = board.components.find((item) => item.designator === designator)
    if (component?.bounds) return [component.bounds.outer]
    const pads = board.pads.filter((pad) => pad.component === designator)
    if (!pads.length) return []
    const margin = 0.5
    const xs = pads.flatMap((pad) => [pad.at.x - shapeRadius(pad), pad.at.x + shapeRadius(pad)])
    const ys = pads.flatMap((pad) => [pad.at.y - shapeRadius(pad), pad.at.y + shapeRadius(pad)])
    return [[
      { x: Math.min(...xs) - margin, y: Math.min(...ys) - margin },
      { x: Math.max(...xs) + margin, y: Math.min(...ys) - margin },
      { x: Math.max(...xs) + margin, y: Math.max(...ys) + margin },
      { x: Math.min(...xs) - margin, y: Math.max(...ys) + margin },
    ]]
  })
}

function targetRings(board: RoutingBoard, stitch: Extract<ViaStitchIntent, { mode: "around" }>) {
  const target = stitch.target
  if (target.kind === "board") return [board.outline]
  if (target.kind === "components") return componentRings(board, target.designators)
  if (target.kind === "component") return componentRings(board, [target.component])
  const pads = board.pads.filter((pad) => pad.component === target.component && pad.number === target.pad)
  return pads.map((pad) => {
    const index = board.pads.indexOf(pad)
    const radius = padRadius(board, index)
    return Array.from({ length: 24 }, (_, point) => ({
      x: pad.at.x + radius * Math.cos(2 * Math.PI * point / 24),
      y: pad.at.y + radius * Math.sin(2 * Math.PI * point / 24),
    }))
  })
}

function segmentSamples(
  track: RoutedTrack,
  pitch: number,
  offset: number,
  rows: number,
  rowSpacing: number,
  stagger: boolean,
) {
  const output: PointMm[] = []
  for (let index = 1; index < track.points.length; index += 1) {
    const start = track.points[index - 1]
    const end = track.points[index]
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (length <= EPSILON) continue
    const nx = -dy / length
    const ny = dx / length
    for (const side of [-1, 1]) {
      for (let row = 0; row < rows; row += 1) {
        const lateral = offset + row * rowSpacing
        const phase = stagger && row % 2 === 1 ? pitch / 2 : 0
        const distances: number[] = []
        for (let distance = phase; distance <= length + EPSILON; distance += pitch) {
          distances.push(Math.min(length, distance))
        }
        if (!distances.length) distances.push(length / 2)
        else if (row === 0 && length - distances.at(-1)! > pitch / 2) distances.push(length)
        for (const distance of distances) output.push({
          x: start.x + dx * distance / length + nx * lateral * side,
          y: start.y + dy * distance / length + ny * lateral * side,
        })
      }
    }
  }
  return output
}

export type ViaStitchPlan = Readonly<{
  vias: readonly RoutedVia[]
  diagnostics: readonly RoutingDiagnostic[]
}>

export type ViaStitchSourceCompletion = Readonly<{
  /** Nets proven complete by the routing backend that produced the source. */
  completedNets: readonly string[]
  modes?: readonly ViaStitchIntent["mode"][]
  defaultReturnNets?: readonly string[]
}>

/** Materialize staggered, multi-row, two-sided via fences around retained routed centerlines. */
export function planViaStitches(
  board: RoutingBoard,
  routed: RoutingCopper,
  stitches: readonly ViaStitchIntent[],
  rules: RoutingRules,
  completion: ViaStitchSourceCompletion,
): ViaStitchPlan {
  const vias: RoutedVia[] = []
  const diagnostics: RoutingDiagnostic[] = []
  const completedNets = new Set(completion.completedNets)
  const modes = new Set(completion.modes ?? ["grid", "along", "around", "return"])
  const tracks = [...board.copper.fixed.tracks, ...board.copper.editable.tracks, ...routed.tracks]
  const existingVias = [...board.copper.fixed.vias, ...board.copper.editable.vias, ...routed.vias]
  for (const fence of stitches.filter((item): item is Extract<ViaStitchIntent, { mode: "along" }> => modes.has("along") && item.mode === "along")) {
    const incomplete = fence.routes.filter((net) => !completedNets.has(net))
    if (incomplete.length) {
      diagnostics.push({
        code: "VIA_STITCH_ALONG_SOURCE_INCOMPLETE", severity: "error",
        message: `Along-via stitch ${fence.id} was not created because its source routing is incomplete.`,
        details: { id: fence.id, routes: fence.routes, incompleteNets: incomplete },
      })
      continue
    }
    const source = tracks.filter((track) => fence.routes.includes(track.net))
    if (!source.length) {
      diagnostics.push({
        code: "VIA_STITCH_ALONG_SOURCE_MISSING", severity: "error",
        message: `Along-via stitch ${fence.id} has no retained source track to follow despite a complete routing report.`,
        details: { id: fence.id, routes: fence.routes },
      })
      continue
    }
    const layers = physicalLayers(board)
    const value = rulesForNet(rules, fence.net)
    if (!layers || !board.layers.some((layer) => layer.name === layers[0])
      || !board.layers.some((layer) => layer.name === layers[1])) {
      diagnostics.push({ code: "VIA_STITCH_ALONG_LAYER_INVALID", severity: "error", message: `Along-via stitch ${fence.id} has invalid via layers.` })
      continue
    }
    const diameterMm = fence.via === "drc-min" || !fence.via ? value.via.minDiameterMm : fence.via.diameterMm ?? value.via.minDiameterMm
    const drillMm = fence.via === "drc-min" || !fence.via ? value.via.minDrillMm : fence.via.drillMm ?? value.via.minDrillMm
    const radius = diameterMm / 2
    const pitch = fence.pitchMm ?? Math.max(diameterMm * 2, diameterMm + value.clearanceMm)
    const rows = fence.rows ?? 2
    const rowSpacing = fence.rowSpacingMm ?? pitch * Math.sqrt(3) / 2
    const stagger = fence.stagger ?? true
    const fenceVias: RoutedVia[] = []
    const accepted = [...existingVias, ...vias]
    for (const track of source) {
      const sourceRules = rulesForNet(rules, track.net)
      const offset = fence.offsetMm ?? track.widthMm / 2 + radius + Math.max(value.clearanceMm, sourceRules.clearanceMm)
      for (const point of segmentSamples(track, pitch, offset, rows, rowSpacing, stagger)) {
        if (fenceVias.length >= (fence.maxVias ?? Number.MAX_SAFE_INTEGER)) break
        if (!pointInRing(point, board.outline) || board.cutouts.some((ring) => pointInRing(point, ring))) continue
        if (distanceToRingBoundary(point, board.outline) < radius + value.edgeClearanceMm - EPSILON) continue
        if (board.cutouts.some((ring) => distanceToRingBoundary(point, ring) < radius + value.edgeClearanceMm - EPSILON)) continue
        if (board.keepouts.some((keepout) => keepout.forbid.vias
          && keepout.layers.some((layer) => layers.includes(layer))
          && distanceToRing(point, keepout.polygon.outer) < radius - EPSILON)) continue
        if (board.pads.some((pad, index) => {
          const clearance = pad.net === fence.net ? 0 : value.clearanceMm
          return Math.hypot(point.x - pad.at.x, point.y - pad.at.y) < radius + padRadius(board, index) + clearance - EPSILON
        })) continue
        if (tracks.some((other) => other.net !== fence.net && layers.includes(other.layer)
          && other.points.slice(1).some((end, index) => distanceToSegment(point, other.points[index], end)
            < radius + other.widthMm / 2 + value.clearanceMm - EPSILON))) continue
        if (accepted.some((other) => {
          const copperSpacing = radius + other.diameterMm / 2 + (other.net === fence.net ? 0 : value.clearanceMm)
          const holeSpacing = drillMm / 2 + other.drillMm / 2 + (value.holeToHoleClearanceMm ?? 0)
          return Math.hypot(point.x - other.at.x, point.y - other.at.y) < Math.max(copperSpacing, holeSpacing) - EPSILON
        })) continue
        const via: RoutedVia = {
          id: `via-stitch:${fence.id}:${vias.length + fenceVias.length}`,
          net: fence.net, at: point, diameterMm, drillMm,
          fromLayer: layers[0], toLayer: layers[1], type: "through",
        }
        fenceVias.push(via)
        accepted.push(via)
      }
    }
    if (!fenceVias.length) diagnostics.push({
      code: "VIA_STITCH_ALONG_NOT_PLACED", severity: "error",
      message: `Along-via stitch ${fence.id} could not place a legal via.`,
      details: { id: fence.id, routes: fence.routes, net: fence.net },
    })
    else if (fenceVias.length < 2) diagnostics.push({
      code: "VIA_STITCH_ALONG_INSUFFICIENT", severity: "error",
      message: `Along-via stitch ${fence.id} produced only one via; at least two are required and it was discarded.`,
      details: { id: fence.id, routes: fence.routes, net: fence.net, produced: fenceVias.length, minimum: 2 },
    })
    else vias.push(...fenceVias)
  }

  for (const stitch of stitches.filter((item): item is Extract<ViaStitchIntent, { mode: "return" }> => modes.has("return") && item.mode === "return")) {
    const sourceNets = new Set(stitch.forNets ?? completion.defaultReturnNets ?? [])
    const sourceVias = existingVias.filter((via) => sourceNets.has(via.net))
    const limit = stitch.maxVias ?? Number.MAX_SAFE_INTEGER
    let generatedCount = 0
    for (const source of sourceVias) {
      if (generatedCount >= limit) break
      const sourceRule = rulesForNet(rules, source.net)
      let referenceNet = stitch.referenceNet === "auto" ? sourceRule.impedanceReferenceNet : stitch.referenceNet
      if (!referenceNet) {
        const actual = new Set([...board.copper.fixed.zones, ...board.copper.editable.zones]
          .filter((zone) => zone.fill?.style !== "hatched" && zoneContains(source.at, zone)
            && zone.layers.some((layer) => layer === source.fromLayer || layer === source.toLayer))
          .map((zone) => zone.net))
        if (actual.size === 1) referenceNet = [...actual][0]
      }
      if (!referenceNet) {
        diagnostics.push({
          code: "VIA_STITCH_RETURN_REFERENCE_AMBIGUOUS", severity: "error",
          message: `Return-via stitch ${stitch.id} cannot resolve a reference net for ${source.net}.`,
          details: { id: stitch.id, sourceNet: source.net, at: source.at },
        })
        continue
      }
      const referenceRule = rulesForNet(rules, referenceNet)
      const geometry = viaGeometry(stitch, referenceRule)
      const maximumDistance = stitch.maxDistanceMm ?? 1
      const allExisting = [...existingVias, ...vias]
      if (allExisting.some((via) => via.net === referenceNet
        && Math.hypot(via.at.x - source.at.x, via.at.y - source.at.y) <= maximumDistance + EPSILON)) continue
      const minimumDistance = Math.max(
        source.diameterMm / 2 + geometry.diameterMm / 2 + Math.max(sourceRule.clearanceMm, referenceRule.clearanceMm),
        source.drillMm / 2 + geometry.drillMm / 2 + (referenceRule.holeToHoleClearanceMm ?? 0),
      )
      let placed: RoutedVia | undefined
      for (let radius = minimumDistance; radius <= maximumDistance + EPSILON && !placed; radius += Math.max(0.1, geometry.diameterMm / 2)) {
        for (let direction = 0; direction < 8; direction += 1) {
          const angle = 2 * Math.PI * direction / 8
          const at = { x: source.at.x + radius * Math.cos(angle), y: source.at.y + radius * Math.sin(angle) }
          if (!legalVia(board, at, referenceNet, [source.fromLayer, source.toLayer], geometry.diameterMm, geometry.drillMm,
            rules, tracks, allExisting)) continue
          placed = {
            id: `via-stitch:${stitch.id}:${vias.length}`, net: referenceNet, at,
            diameterMm: geometry.diameterMm, drillMm: geometry.drillMm,
            fromLayer: board.layers[0]?.name ?? source.fromLayer,
            toLayer: board.layers.at(-1)?.name ?? source.toLayer, type: "through",
          }
          break
        }
      }
      if (placed) { vias.push(placed); generatedCount += 1 }
      else diagnostics.push({
        code: "VIA_STITCH_RETURN_NOT_PLACED", severity: "warning",
        message: `Return-via stitch ${stitch.id} could not place a legal via within ${maximumDistance} mm.`,
        details: { id: stitch.id, sourceNet: source.net, referenceNet, at: source.at },
      })
    }
  }

  for (const stitch of stitches.filter((item): item is Extract<ViaStitchIntent, { mode: "around" }> => modes.has("around") && item.mode === "around")) {
    const value = rulesForNet(rules, stitch.net)
    const geometry = viaGeometry(stitch, value)
    const layers = physicalLayers(board)
    if (!layers) continue
    const pitch = stitch.pitchMm ?? Math.max(geometry.diameterMm * 2, geometry.diameterMm + value.clearanceMm)
    const side = stitch.side ?? (stitch.target.kind === "board" ? "inside" : "outside")
    const offset = stitch.offsetMm ?? geometry.diameterMm / 2 + value.edgeClearanceMm
    const accepted = [...existingVias, ...vias]
    const generated: RoutedVia[] = []
    for (const ring of targetRings(board, stitch)) {
      for (const at of contourSamples(ring, pitch, offset, side, stitch.rows ?? 1)) {
        if (generated.length >= (stitch.maxVias ?? Number.MAX_SAFE_INTEGER)) break
        if (!legalVia(board, at, stitch.net, layers, geometry.diameterMm, geometry.drillMm, rules, tracks, accepted)) continue
        const via: RoutedVia = {
          id: `via-stitch:${stitch.id}:${vias.length + generated.length}`, net: stitch.net, at,
          diameterMm: geometry.diameterMm, drillMm: geometry.drillMm,
          fromLayer: layers[0], toLayer: layers[1], type: "through",
        }
        generated.push(via); accepted.push(via)
      }
    }
    if (!generated.length) diagnostics.push({
      code: "VIA_STITCH_AROUND_NOT_PLACED", severity: "warning",
      message: `Around-via stitch ${stitch.id} could not place a legal via.`, details: { id: stitch.id },
    })
    vias.push(...generated)
  }

  for (const stitch of stitches.filter((item): item is Extract<ViaStitchIntent, { mode: "grid" }> => modes.has("grid") && item.mode === "grid")) {
    const value = rulesForNet(rules, stitch.net)
    const geometry = viaGeometry(stitch, value)
    const layers = physicalLayers(board)
    if (!layers) continue
    const regions = stitch.region.kind === "board" ? [board.outline] : componentRings(board, stitch.region.designators)
    const zones = [...board.copper.fixed.zones, ...board.copper.editable.zones, ...routed.zones]
      .filter((zone) => zone.net === stitch.net && zone.fill?.style !== "hatched")
    const accepted = [...existingVias, ...vias]
    const generated: RoutedVia[] = []
    if (stitch.viaInPad) {
      for (const [padIndex, pad] of board.pads.entries()) {
        if (pad.net !== stitch.net || pad.hole?.plated
          || !regions.some((region) => pointInRing(pad.at, region))) continue
        if (generated.length >= (stitch.maxVias ?? Number.MAX_SAFE_INTEGER)) break
        const copperLayers = new Set(zones.filter((zone) => zoneContains(pad.at, zone)).flatMap((zone) => zone.layers))
        if (copperLayers.size < 2) continue
        if (accepted.some((via) => via.net === stitch.net
          && Math.hypot(via.at.x - pad.at.x, via.at.y - pad.at.y) < EPSILON)) continue
        if (!legalVia(board, pad.at, stitch.net, layers, geometry.diameterMm, geometry.drillMm,
          rules, tracks, accepted, padIndex)) continue
        const via: RoutedVia = {
          id: `via-stitch:${stitch.id}:${vias.length + generated.length}`, net: stitch.net, at: pad.at,
          diameterMm: geometry.diameterMm, drillMm: geometry.drillMm,
          fromLayer: layers[0], toLayer: layers[1], type: "through",
        }
        generated.push(via); accepted.push(via)
      }
    }
    for (const region of regions) {
      const xs = region.map((point) => point.x)
      const ys = region.map((point) => point.y)
      for (let y = Math.min(...ys) + stitch.pitchMm / 2; y <= Math.max(...ys); y += stitch.pitchMm) {
        for (let x = Math.min(...xs) + stitch.pitchMm / 2; x <= Math.max(...xs); x += stitch.pitchMm) {
          if (generated.length >= (stitch.maxVias ?? Number.MAX_SAFE_INTEGER)) break
          const at = { x, y }
          if (!pointInRing(at, region)) continue
          const copperLayers = new Set(zones.filter((zone) => zoneContains(at, zone)).flatMap((zone) => zone.layers))
          if (copperLayers.size < 2) continue
          if (!legalVia(board, at, stitch.net, layers, geometry.diameterMm, geometry.drillMm, rules, tracks, accepted)) continue
          const via: RoutedVia = {
            id: `via-stitch:${stitch.id}:${vias.length + generated.length}`, net: stitch.net, at,
            diameterMm: geometry.diameterMm, drillMm: geometry.drillMm,
            fromLayer: layers[0], toLayer: layers[1], type: "through",
          }
          generated.push(via); accepted.push(via)
        }
      }
    }
    if (!generated.length) diagnostics.push({
      code: "VIA_STITCH_GRID_NOT_PLACED", severity: "warning",
      message: `Grid-via stitch ${stitch.id} found no legal point with solid ${stitch.net} copper on two layers.`,
      details: { id: stitch.id, net: stitch.net },
    })
    vias.push(...generated)
  }
  return { vias, diagnostics }
}
