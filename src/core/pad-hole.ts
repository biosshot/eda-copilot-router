import type { PointMm, RoutingPad } from "./contracts.js"

export type PadHoleGeometry = Readonly<{
  start: PointMm
  end: PointMm
  radiusMm: number
}>

function rotate(point: PointMm, degrees: number): PointMm {
  const radians = degrees * Math.PI / 180
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  }
}

/** Exact round/slot hole centerline in board coordinates. */
export function padHoleGeometry(pad: RoutingPad): PadHoleGeometry | undefined {
  if (!pad.hole) return undefined
  const offset = rotate(pad.hole.offset ?? { x: 0, y: 0 }, pad.rotationDeg)
  const center = { x: pad.at.x + offset.x, y: pad.at.y + offset.y }
  const halfCenterline = pad.hole.shape === "slot" ? (pad.hole.slotLengthMm ?? 0) / 2 : 0
  const direction = rotate({ x: halfCenterline, y: 0 }, pad.rotationDeg + (pad.hole.rotationDeg ?? 0))
  return {
    start: { x: center.x - direction.x, y: center.y - direction.y },
    end: { x: center.x + direction.x, y: center.y + direction.y },
    radiusMm: pad.hole.diameterMm / 2,
  }
}

export function distanceToPadHoleCenterline(point: PointMm, hole: PadHoleGeometry) {
  const dx = hole.end.x - hole.start.x
  const dy = hole.end.y - hole.start.y
  const length2 = dx * dx + dy * dy
  if (length2 === 0) return Math.hypot(point.x - hole.start.x, point.y - hole.start.y)
  const t = Math.max(0, Math.min(1,
    ((point.x - hole.start.x) * dx + (point.y - hole.start.y) * dy) / length2,
  ))
  return Math.hypot(point.x - hole.start.x - t * dx, point.y - hole.start.y - t * dy)
}
