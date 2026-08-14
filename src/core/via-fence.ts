import type { ViaFenceIntent } from "../intent/types.js"
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

function padRadius(board: RoutingBoard, index: number) {
  const shape = board.pads[index].shape
  if (shape.kind === "circle") return shape.diameterMm / 2
  if (shape.kind === "polygon") return Math.max(...shape.polygon.outer.map((point) => Math.hypot(point.x, point.y)), 0)
  return Math.hypot(shape.widthMm, shape.heightMm) / 2
}

function rulesForNet(rules: RoutingRules, net: string) {
  return rules.nets.find((item) => item.net === net)?.values ?? rules.default
}

function physicalLayers(board: RoutingBoard, fence: ViaFenceIntent) {
  const resolve = (name: string | undefined, fallback: string | undefined) => {
    if (!name) return fallback
    if (name === "TOP") return board.layers.find((layer) => layer.side === "top")?.name
    if (name === "BOTTOM") return board.layers.find((layer) => layer.side === "bottom")?.name
    const match = /^INNER_(\d+)$/.exec(name)
    return match ? board.layers.filter((layer) => layer.side === "inner")
      .sort((left, right) => left.index - right.index)[Number(match[1]) - 1]?.name : undefined
  }
  const from = resolve(fence.via?.from, board.layers[0]?.name)
  const to = resolve(fence.via?.to, board.layers.at(-1)?.name)
  return from && to ? [from, to] as const : undefined
}

function segmentSamples(track: RoutedTrack, pitch: number, offset: number) {
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
    const count = Math.max(1, Math.floor(length / pitch))
    for (let sample = 0; sample <= count; sample += 1) {
      const distance = Math.min(length, sample * length / count)
      const center = { x: start.x + dx * distance / length, y: start.y + dy * distance / length }
      output.push(
        { x: center.x + nx * offset, y: center.y + ny * offset },
        { x: center.x - nx * offset, y: center.y - ny * offset },
      )
    }
  }
  return output
}

export type ViaFencePlan = Readonly<{
  vias: readonly RoutedVia[]
  diagnostics: readonly RoutingDiagnostic[]
}>

export type ViaFenceSourceCompletion = Readonly<{
  /** Nets proven complete by the routing backend that produced the source. */
  completedNets: readonly string[]
}>

/** Materialize two-sided via fences around the retained routed centerlines. */
export function planViaFences(
  board: RoutingBoard,
  routed: RoutingCopper,
  fences: readonly ViaFenceIntent[],
  rules: RoutingRules,
  completion: ViaFenceSourceCompletion,
): ViaFencePlan {
  const vias: RoutedVia[] = []
  const diagnostics: RoutingDiagnostic[] = []
  const completedNets = new Set(completion.completedNets)
  const tracks = [...board.copper.fixed.tracks, ...board.copper.editable.tracks, ...routed.tracks]
  const existingVias = [...board.copper.fixed.vias, ...board.copper.editable.vias, ...routed.vias]
  for (const fence of fences) {
    const incomplete = fence.along.filter((net) => !completedNets.has(net))
    if (incomplete.length) {
      diagnostics.push({
        code: "VIA_FENCE_SOURCE_INCOMPLETE", severity: "error",
        message: `Via fence ${fence.id} was not created because its source routing is incomplete.`,
        details: { id: fence.id, along: fence.along, incompleteNets: incomplete },
      })
      continue
    }
    const source = tracks.filter((track) => fence.along.includes(track.net))
    if (!source.length) {
      diagnostics.push({
        code: "VIA_FENCE_SOURCE_MISSING", severity: "error",
        message: `Via fence ${fence.id} has no retained source track to follow despite a complete routing report.`,
        details: { id: fence.id, along: fence.along },
      })
      continue
    }
    const layers = physicalLayers(board, fence)
    const value = rulesForNet(rules, fence.net)
    if (!layers || !board.layers.some((layer) => layer.name === layers[0])
      || !board.layers.some((layer) => layer.name === layers[1])) {
      diagnostics.push({ code: "VIA_FENCE_LAYER_INVALID", severity: "error", message: `Via fence ${fence.id} has invalid via layers.` })
      continue
    }
    const diameterMm = fence.via?.diameterMm ?? value.via.minDiameterMm
    const drillMm = fence.via?.drillMm ?? value.via.minDrillMm
    const radius = diameterMm / 2
    const pitch = fence.pitchMm ?? Math.max(diameterMm * 2, diameterMm + value.clearanceMm)
    const fenceVias: RoutedVia[] = []
    const accepted = [...existingVias, ...vias]
    for (const track of source) {
      const sourceRules = rulesForNet(rules, track.net)
      const offset = fence.offsetMm ?? track.widthMm / 2 + radius + Math.max(value.clearanceMm, sourceRules.clearanceMm)
      for (const point of segmentSamples(track, pitch, offset)) {
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
        if (accepted.some((other) => Math.hypot(point.x - other.at.x, point.y - other.at.y)
          < radius + other.diameterMm / 2 + (other.net === fence.net ? 0 : value.clearanceMm) - EPSILON)) continue
        const via: RoutedVia = {
          id: `via-fence:${fence.id}:${vias.length + fenceVias.length}`,
          net: fence.net, at: point, diameterMm, drillMm,
          fromLayer: layers[0], toLayer: layers[1], type: "through",
        }
        fenceVias.push(via)
        accepted.push(via)
      }
    }
    if (!fenceVias.length) diagnostics.push({
      code: "VIA_FENCE_NOT_PLACED", severity: "error",
      message: `Via fence ${fence.id} could not place a legal via.`,
      details: { id: fence.id, along: fence.along, net: fence.net },
    })
    else if (fenceVias.length < 2) diagnostics.push({
      code: "VIA_FENCE_INSUFFICIENT", severity: "error",
      message: `Via fence ${fence.id} produced only one via; a single via is not a fence and was discarded.`,
      details: { id: fence.id, along: fence.along, net: fence.net, produced: fenceVias.length, minimum: 2 },
    })
    else vias.push(...fenceVias)
  }
  return { vias, diagnostics }
}
