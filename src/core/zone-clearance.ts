import type { PointMm, RoutedZone } from "./contracts.js"

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

function distanceToRingBoundary(point: PointMm, ring: readonly PointMm[]) {
  return ring.reduce((minimum, start, index) => Math.min(
    minimum,
    distanceToSegment(point, start, ring[(index + 1) % ring.length]),
  ), Infinity)
}

/** Distance from a point to actual zone copper; holes contain no copper. */
function distanceToZoneCopper(point: PointMm, zone: RoutedZone) {
  if (!pointInRing(point, zone.outline.outer)) {
    return distanceToRingBoundary(point, zone.outline.outer)
  }
  const containingHole = (zone.outline.holes ?? []).find((hole) => pointInRing(point, hole))
  return containingHole ? distanceToRingBoundary(point, containingHole) : 0
}

/**
 * Reject a circular copper feature when its complete disk plus clearance would
 * touch a foreign-net zone on any layer crossed by that feature.
 */
export function foreignZoneBlocksCircle(
  point: PointMm,
  net: string,
  layers: readonly string[],
  radiusMm: number,
  clearanceMm: number,
  zones: readonly RoutedZone[],
) {
  return zones.some((zone) => {
    if (zone.net === net || !zone.layers.some((layer) => layers.includes(layer))) return false
    const requiredDistance = radiusMm + Math.max(clearanceMm, zone.clearanceMm ?? 0)
    return distanceToZoneCopper(point, zone) < requiredDistance - EPSILON
  })
}
