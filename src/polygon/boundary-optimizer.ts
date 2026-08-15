import type { PcbPoint, PolygonScenePad } from "./scene.js"
import ClipperLib from "clipper-lib"

// Clipper is used only to union rough target-pad/corridor outlines. It does
// not calculate DRC clearance, obstacle avoidance, thermals, or the EDA fill.

const SCALE = 1_000_000
export const MAX_PAD_FREE_GAP_WIDTHS = 4.5
export const PAD_ENVELOPE_EXPANSION_RATIO = 0.20
export const DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM = 0.254
export const DEFAULT_OBSTACLE_CLEARANCE_MM = 0.20
export const DEFAULT_MAX_POLYGON_SEARCH_WORK_UNITS = 250_000
export const MIN_BOUNDARY_FEATURE_WIDTH_RATIO = 0.12
export const MAX_OCTILINEAR_ENVELOPE_AREA_RATIO = 1.12
export const MAX_ADAPTIVE_CORRIDOR_WIDTH_RATIO = 2.5

// Final outline regularization is deliberately conservative. It may fill a
// narrow concave bay or shave an unsupported outer ear, but it must not turn a
// compact connection into a large convex hull or fall back to a thin trace.
const MAX_REGULARIZED_AREA_RATIO = 1.02
const MIN_REGULARIZED_AREA_RATIO = 0.98
const POCKET_RADIUS_MULTIPLIERS = [1, 2, 3] as const
const MAX_SHORT_FEATURE_CLEANUP_ASPECT_RATIO = 10

const ADAPTIVE_WIDTH_SEARCH_STEPS = 14
// KiCad's generated zones currently use 0.1 mm minimum thickness. Keep bank
// contraction conservative at that scale; narrower engines automatically
// clamp this to their requested minimum corridor width.
const DEFAULT_MIN_BANK_CONNECTIVITY_NECK_MM = 0.10

class PolygonSearchBudgetExceeded extends Error {
  readonly code = "POLYGON_SEARCH_BUDGET_EXCEEDED"

  constructor(
    readonly usedWorkUnits: number,
    readonly maxWorkUnits: number,
    readonly operation: string,
  ) {
    super(`polygon search exhausted ${maxWorkUnits} work units while ${operation}`)
    this.name = "PolygonSearchBudgetExceeded"
  }
}

type PolygonSearchBudget = {
  readonly maxWorkUnits: number
  usedWorkUnits: number
  spend(workUnits: number, operation: string): void
}

function createPolygonSearchBudget(maxWorkUnits: number): PolygonSearchBudget {
  const normalizedMaximum = Math.max(1, Math.floor(maxWorkUnits))
  return {
    maxWorkUnits: normalizedMaximum,
    usedWorkUnits: 0,
    spend(workUnits, operation) {
      const normalizedWork = Math.max(0, Math.ceil(workUnits))
      if (this.usedWorkUnits + normalizedWork > this.maxWorkUnits) {
        throw new PolygonSearchBudgetExceeded(this.usedWorkUnits, this.maxWorkUnits, operation)
      }
      this.usedWorkUnits += normalizedWork
    },
  }
}

type PadGeometry = {
  pad: PolygonScenePad
  points: PcbPoint[]
  areaMm2: number
  characteristicWidthMm: number
}

type Edge = {
  a: number
  b: number
  distanceMm: number
  gapMm: number
  gapWidths: number
  bottleneckWidthMm: number
  widthAtAMm: number
  widthAtBMm: number
}

type Bounds = { left: number; right: number; top: number; bottom: number }

type RoutedEdge = {
  edge: Edge
  points: PcbPoint[]
  widthMm: number
  bodyWidthMm: number
  segmentBodyWidthsMm: number[]
  lengthMm: number
  avoidedObstacleCount: number
  remainingObstacleCount: number
}

export type CompactBoundaryOptimization = {
  pads: PolygonScenePad[]
  boundary: PcbPoint[]
  strategy: "mst_corridor" | "octilinear_envelope"
  mstLengthMm: number
  routedLengthMm: number
  routeDetourMm: number
  avoidedObstacleCount: number
  corridorWidthMinMm: number
  corridorBodyWidthMaxMm: number
  maxPadFreeGapMm: number
  maxPadFreeGapWidths: number
  targetPadAreaMm2: number
  boundaryAreaMm2: number
  copperEfficiency: number
  angleMode: "octilinear"
  boundaryVertexCount: number
  removedVertexCount: number
  minimumFeatureMm: number
  pocketClosingRadiusMm: number
  filledPocketAreaMm2: number
}

export type CompactBoundaryOptimizationResult = {
  boundaries: CompactBoundaryOptimization[]
  maxPadFreeGapMm: number
  maxPadFreeGapWidths: number
  isolatedPads: Array<{
    pad: PolygonScenePad
    nearestPadFreeGapWidths: number
  }>
  searchWorkUnits: number
  failure?: {
    code: "POLYGON_SEARCH_BUDGET_EXCEEDED"
    message: string
    usedWorkUnits: number
    maxWorkUnits: number
    operation: string
  }
}

function signedArea(points: PcbPoint[]) {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return area / 2
}

export function boundaryArea(points: PcbPoint[]) {
  return Math.abs(signedArea(points))
}

function normalizeRing(points: PcbPoint[]) {
  const ring = points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length]
    return Math.hypot(point.x - previous.x, point.y - previous.y) > 1e-9
  })
  return signedArea(ring) < 0 ? [...ring].reverse() : ring
}

function toClipper(points: PcbPoint[]) {
  return normalizeRing(points).map((point) => ({ X: Math.round(point.x * SCALE), Y: Math.round(point.y * SCALE) }))
}

function fromClipper(path: Array<{ X: number; Y: number }>): PcbPoint[] {
  return path.map((point) => ({ x: point.X / SCALE, y: point.Y / SCALE }))
}

const ANGLE_TOLERANCE_MM = 2 / SCALE

function segmentIsOctilinear(first: PcbPoint, second: PcbPoint) {
  const dx = Math.abs(second.x - first.x)
  const dy = Math.abs(second.y - first.y)
  return dx <= ANGLE_TOLERANCE_MM
    || dy <= ANGLE_TOLERANCE_MM
    || Math.abs(dx - dy) <= ANGLE_TOLERANCE_MM
}

export function isOctilinearBoundary(points: PcbPoint[]) {
  return points.length >= 3 && points.every((point, index) =>
    segmentIsOctilinear(point, points[(index + 1) % points.length]))
}

function simplifyCollinear(points: PcbPoint[]) {
  let simplified = normalizeRing(points)
  let changed = true
  while (changed && simplified.length > 3) {
    changed = false
    const next = simplified.filter((current, index) => {
      const previous = simplified[(index + simplified.length - 1) % simplified.length]
      const following = simplified[(index + 1) % simplified.length]
      const cross = (current.x - previous.x) * (following.y - current.y)
        - (current.y - previous.y) * (following.x - current.x)
      const scale = Math.max(
        1,
        Math.hypot(current.x - previous.x, current.y - previous.y),
        Math.hypot(following.x - current.x, following.y - current.y),
      )
      if (Math.abs(cross) <= ANGLE_TOLERANCE_MM * scale) {
        changed = true
        return false
      }
      return true
    })
    if (next.length >= 3) simplified = next
  }
  return simplified
}

function lineIntersection(a: PcbPoint, b: PcbPoint, c: PcbPoint, d: PcbPoint) {
  const ab = { x: b.x - a.x, y: b.y - a.y }
  const cd = { x: d.x - c.x, y: d.y - c.y }
  const determinant = ab.x * cd.y - ab.y * cd.x
  if (Math.abs(determinant) < 1e-12) return undefined
  const ac = { x: c.x - a.x, y: c.y - a.y }
  const t = (ac.x * cd.y - ac.y * cd.x) / determinant
  return { x: a.x + ab.x * t, y: a.y + ab.y * t }
}

function collapseShortEdges(
  points: PcbPoint[],
  minimumFeatureMm: number,
  maximumCleanupAreaChangeMm2 = minimumFeatureMm * minimumFeatureMm
    * MAX_SHORT_FEATURE_CLEANUP_ASPECT_RATIO,
) {
  let collapsed = points
  const cleanupSnapDistanceMm = minimumFeatureMm * 1.5
  let changed = true
  while (changed && collapsed.length > 4) {
    changed = false
    for (let index = 0; index < collapsed.length; index += 1) {
      const nextIndex = (index + 1) % collapsed.length
      const length = Math.hypot(
        collapsed[nextIndex].x - collapsed[index].x,
        collapsed[nextIndex].y - collapsed[index].y,
      )
      if (length >= minimumFeatureMm) continue
      const rotated = [...collapsed.slice(index), ...collapsed.slice(0, index)]
      const intersection = lineIntersection(rotated.at(-1)!, rotated[0], rotated[1], rotated[2])
      const candidates: PcbPoint[][] = []
      if (intersection
        && Math.hypot(intersection.x - rotated[0].x, intersection.y - rotated[0].y) <= cleanupSnapDistanceMm
        && Math.hypot(intersection.x - rotated[1].x, intersection.y - rotated[1].y) <= cleanupSnapDistanceMm) {
        candidates.push(simplifyCollinear([intersection, ...rotated.slice(2)]))
      }
      // A short connector between two parallel runs has no local line
      // intersection. Snap the step into the preceding or following corner;
      // this removes the two-point tooth while keeping every new edge in the
      // 0/45/90 direction set.
      if (rotated.length >= 6) {
        const backward = lineIntersection(
          rotated.at(-2)!,
          rotated.at(-1)!,
          rotated[1],
          rotated[2],
        )
        if (backward
          && Math.hypot(backward.x - rotated.at(-1)!.x, backward.y - rotated.at(-1)!.y) <= cleanupSnapDistanceMm) {
          candidates.push(simplifyCollinear([backward, ...rotated.slice(2, -1)]))
        }
        const forward = lineIntersection(
          rotated.at(-1)!,
          rotated[0],
          rotated[2],
          rotated[3],
        )
        if (forward
          && Math.hypot(forward.x - rotated[2].x, forward.y - rotated[2].y) <= cleanupSnapDistanceMm) {
          candidates.push(simplifyCollinear([forward, ...rotated.slice(3)]))
        }
      }
      const currentAreaMm2 = boundaryArea(collapsed)
      const candidate = candidates
        .filter((item) => item.length >= 3
          && isOctilinearBoundary(item)
          // A microscopic outward ear must be removable too, but snapping one
          // short shoulder must not move a long wall outward and add a large
          // unsupported strip. Bound both copper loss and gain by one
          // minimum-feature square; envelopes retain 20% margin.
          && Math.abs(boundaryArea(item) - currentAreaMm2)
            <= maximumCleanupAreaChangeMm2 + 1e-9)
        .sort((left, right) =>
          Math.abs(boundaryArea(left) - currentAreaMm2) - Math.abs(boundaryArea(right) - currentAreaMm2))[0]
      if (candidate) {
        collapsed = candidate
        changed = true
        break
      }
    }
  }
  return collapsed
}

function simplifyBoundaryFeatures(
  points: PcbPoint[],
  minimumFeatureMm: number,
  maximumCleanupAreaChangeMm2?: number,
) {
  // Complexity is not a defect by itself. Remove only sub-width notches and
  // Clipper noise; never simplify merely to satisfy a vertex-count budget.
  return collapseShortEdges(points, minimumFeatureMm, maximumCleanupAreaChangeMm2)
}

function octilinearEnvelope(points: PcbPoint[], minimumFeatureMm: number) {
  if (points.length < 3) return undefined
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const sums = points.map((point) => point.x + point.y)
  const differences = points.map((point) => point.x - point.y)
  const constraints = [
    { a: 1, b: 0, c: Math.max(...xs) },
    { a: -1, b: 0, c: -Math.min(...xs) },
    { a: 0, b: 1, c: Math.max(...ys) },
    { a: 0, b: -1, c: -Math.min(...ys) },
    { a: 1, b: 1, c: Math.max(...sums) },
    { a: -1, b: -1, c: -Math.min(...sums) },
    { a: 1, b: -1, c: Math.max(...differences) },
    { a: -1, b: 1, c: -Math.min(...differences) },
  ]
  const candidates: PcbPoint[] = []
  for (let left = 0; left < constraints.length; left += 1) {
    for (let right = left + 1; right < constraints.length; right += 1) {
      const first = constraints[left]
      const second = constraints[right]
      const determinant = first.a * second.b - second.a * first.b
      if (Math.abs(determinant) < 1e-12) continue
      const point = {
        x: (first.c * second.b - second.c * first.b) / determinant,
        y: (first.a * second.c - second.a * first.c) / determinant,
      }
      if (constraints.every((constraint) =>
        constraint.a * point.x + constraint.b * point.y <= constraint.c + ANGLE_TOLERANCE_MM)) {
        if (!candidates.some((candidate) =>
          Math.hypot(candidate.x - point.x, candidate.y - point.y) <= ANGLE_TOLERANCE_MM)) {
          candidates.push(point)
        }
      }
    }
  }
  if (candidates.length < 3) return undefined
  const center = {
    x: candidates.reduce((sum, point) => sum + point.x, 0) / candidates.length,
    y: candidates.reduce((sum, point) => sum + point.y, 0) / candidates.length,
  }
  const envelope = collapseShortEdges(simplifyCollinear(candidates.sort((first, second) =>
    Math.atan2(first.y - center.y, first.x - center.x)
      - Math.atan2(second.y - center.y, second.x - center.x))), minimumFeatureMm)
  return isOctilinearBoundary(envelope) ? envelope : undefined
}

function offsetPaths(paths: any[], deltaMm: number) {
  // A 45-degree corner needs a miter ratio of 1/sin(22.5deg)=2.613.
  // The Clipper default limit of 2 bevels it and can introduce 22.5-degree
  // edges, so keep the limit just above that exact octilinear requirement.
  const offsetter = new ClipperLib.ClipperOffset(3, 0.25 * SCALE)
  offsetter.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const result = new ClipperLib.Paths()
  offsetter.Execute(result, deltaMm * SCALE)
  return result
}

function clipPaths(subjects: any[], clips: any[], clipType: number) {
  if (!subjects.length) return []
  const clipper = new ClipperLib.Clipper()
  clipper.StrictlySimple = true
  clipper.AddPaths(subjects, ClipperLib.PolyType.ptSubject, true)
  if (clips.length) clipper.AddPaths(clips, ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    clipType,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution
}

function unionPaths(paths: any[]) {
  return clipPaths(paths, [], ClipperLib.ClipType.ctUnion)
}

function differencePaths(subjects: any[], clips: any[]) {
  return clips.length
    ? clipPaths(subjects, clips, ClipperLib.ClipType.ctDifference)
    : subjects
}

function intersectPaths(subjects: any[], clips: any[]) {
  return subjects.length && clips.length
    ? clipPaths(subjects, clips, ClipperLib.ClipType.ctIntersection)
    : []
}

function clipperPathsAreaMm2(paths: any[]) {
  return paths.reduce((sum, path) =>
    sum + Math.abs(ClipperLib.Clipper.Area(path)) / (SCALE * SCALE), 0)
}

function boundaryPerimeterMm(points: PcbPoint[]) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]
    return sum + Math.hypot(next.x - point.x, next.y - point.y)
  }, 0)
}

function reflexVertexCount(points: PcbPoint[]) {
  const orientation = Math.sign(signedArea(points)) || 1
  return points.filter((current, index) => {
    const previous = points[(index + points.length - 1) % points.length]
    const next = points[(index + 1) % points.length]
    const cross = (current.x - previous.x) * (next.y - current.y)
      - (current.y - previous.y) * (next.x - current.x)
    return cross * orientation < -1e-9
  }).length
}

function canonicalizeNearlyOctilinear(points: PcbPoint[], toleranceMm: number) {
  type Line = { a: number; b: number; c: number }
  const lineForEdge = (first: PcbPoint, second: PcbPoint): Line | undefined => {
    const dx = second.x - first.x
    const dy = second.y - first.y
    if (Math.abs(dx) <= toleranceMm) return { a: 1, b: 0, c: (first.x + second.x) / 2 }
    if (Math.abs(dy) <= toleranceMm) return { a: 0, b: 1, c: (first.y + second.y) / 2 }
    if (Math.abs(Math.abs(dx) - Math.abs(dy)) > toleranceMm) return undefined
    if (dx * dy > 0) {
      return { a: -1, b: 1, c: ((first.y - first.x) + (second.y - second.x)) / 2 }
    }
    return { a: 1, b: 1, c: ((first.x + first.y) + (second.x + second.y)) / 2 }
  }
  const lines = points.map((point, index) => lineForEdge(point, points[(index + 1) % points.length]))
  if (lines.some((line) => !line)) return undefined
  const snapped = points.map((point, index) => {
    const previous = lines[(index + lines.length - 1) % lines.length]!
    const current = lines[index]!
    const determinant = previous.a * current.b - current.a * previous.b
    if (Math.abs(determinant) < 1e-12) return undefined
    const candidate = {
      x: (previous.c * current.b - current.c * previous.b) / determinant,
      y: (previous.a * current.c - current.a * previous.c) / determinant,
    }
    return Math.hypot(candidate.x - point.x, candidate.y - point.y) <= toleranceMm * 2
      ? candidate
      : undefined
  })
  if (snapped.some((point) => !point)) return undefined
  const canonical = simplifyCollinear(snapped as PcbPoint[])
  return isOctilinearBoundary(canonical) ? canonical : undefined
}

function cleanOctilinearBoundaries(
  paths: any[],
  minimumFeatureMm: number,
  cleanupScaleMm = minimumFeatureMm,
) {
  const snapToleranceMm = Math.max(ANGLE_TOLERANCE_MM, Math.min(0.01, minimumFeatureMm / 4))
  // A short step may run along a pad/corridor flank for roughly a corridor
  // width. Permit that local cleanup, but not a many-millimetre wall shift.
  const maximumCleanupAreaChangeMm2 = minimumFeatureMm
    * Math.max(minimumFeatureMm, cleanupScaleMm) * 2
  return paths
    .map((path: Array<{ X: number; Y: number }>) =>
      // Larger CleanPolygon tolerances can replace an octilinear corner chain
      // with one arbitrary-angle chord. Remove only integer-rounding noise;
      // feature cleanup below owns the physical minimum-feature policy.
      ClipperLib.Clipper.CleanPolygon(path, 2))
    .map(fromClipper)
    .map(simplifyCollinear)
    .map((ring: PcbPoint[]) => canonicalizeNearlyOctilinear(ring, snapToleranceMm) ?? ring)
    .map((ring: PcbPoint[]) => simplifyBoundaryFeatures(
      ring,
      minimumFeatureMm,
      maximumCleanupAreaChangeMm2,
    ))
    .filter((ring: PcbPoint[]) => ring.length >= 3 && isOctilinearBoundary(ring))
    .sort((a: PcbPoint[], b: PcbPoint[]) => boundaryArea(b) - boundaryArea(a))
}

function unionBoundary(
  rings: PcbPoint[][],
  protectedRings: PcbPoint[][],
  foreignPadRings: PcbPoint[][],
  minimumFeatureMm: number,
  pocketClosingRadiusMm: number,
  regularizationWidthMm: number,
) {
  const paths = rings.filter((ring) => ring.length >= 3 && boundaryArea(ring) > 1e-9).map(toClipper)
  if (!paths.length) return undefined
  const solution = unionPaths(paths)
  const raw = solution
    .map(fromClipper)
    .map(simplifyCollinear)
    .filter((ring: PcbPoint[]) => ring.length >= 3)
    .sort((a: PcbPoint[], b: PcbPoint[]) => boundaryArea(b) - boundaryArea(a))
  if (!raw.length) return undefined

  const rawAreaMm2 = boundaryArea(raw[0])
  const protectedPaths = unionPaths(protectedRings
    .filter((ring) => ring.length >= 3 && boundaryArea(ring) > 1e-9)
    .map(toClipper))
  // The protected pad bodies and minimum-width corridors are the electrical
  // connectivity invariant. Never let the later "largest contour" fallback
  // hide a disconnected target island.
  if (protectedPaths.length !== 1) return undefined
  const foreignPaths = unionPaths(foreignPadRings
    .filter((ring) => ring.length >= 3 && boundaryArea(ring) > 1e-9)
    .map(toClipper))
  const baseBoundary = cleanOctilinearBoundaries(
    solution,
    minimumFeatureMm,
    regularizationWidthMm,
  )[0] ?? raw[0]
  // Morphology must operate on the canonical 0/45/90 boundary, not on the
  // pre-snap Clipper subject union. Otherwise a few micrometres of rounding
  // noise are magnified by a millimetre-scale close/open pass.
  const basePaths = unionPaths([toClipper(baseBoundary), ...protectedPaths])
  const canonicalBaseBoundary = cleanOctilinearBoundaries(
    basePaths,
    minimumFeatureMm,
    regularizationWidthMm,
  )[0] ?? baseBoundary
  const baseAreaMm2 = boundaryArea(canonicalBaseBoundary)
  const basePerimeterMm = boundaryPerimeterMm(canonicalBaseBoundary)
  const compactnessScaleMm = Math.max(minimumFeatureMm, regularizationWidthMm)
  const baseEnergy = baseAreaMm2 + compactnessScaleMm * basePerimeterMm
  let filteredPaths: any[] = basePaths
  let bestBoundary = canonicalBaseBoundary
  let bestEnergy = baseEnergy

  const candidateIsSafe = (candidatePaths: any[]) => {
    const normalized = unionPaths(candidatePaths)
    const boundaries = cleanOctilinearBoundaries(
      normalized,
      minimumFeatureMm,
      regularizationWidthMm,
    )
    if (boundaries.length !== 1) return undefined
    const boundary = boundaries[0]
    const areaMm2 = boundaryArea(boundary)
    const areaRatio = areaMm2 / Math.max(1e-9, baseAreaMm2)
    if (areaRatio < MIN_REGULARIZED_AREA_RATIO - 1e-9
      || areaRatio > MAX_REGULARIZED_AREA_RATIO + 1e-9) return undefined
    if (protectedPaths.length
      && clipperPathsAreaMm2(differencePaths(protectedPaths, normalized)) > 1e-8) return undefined
    // Exact clearance and thermals remain backend-owned. This check merely
    // prevents a smoothing patch from engulfing the body of a foreign pad;
    // it never cuts a pad-shaped notch into the outline.
    const added = differencePaths(normalized, basePaths)
    if (foreignPaths.length
      && clipperPathsAreaMm2(intersectPaths(added, foreignPaths)) > 1e-8) return undefined
    const perimeterMm = boundaryPerimeterMm(boundary)
    if (perimeterMm > basePerimeterMm - minimumFeatureMm + 1e-9) return undefined
    const energy = areaMm2 + compactnessScaleMm * perimeterMm
    if (energy >= baseEnergy - minimumFeatureMm * minimumFeatureMm) return undefined
    return { normalized, boundary, energy, areaMm2 }
  }

  const radii = [...new Set([
    ...POCKET_RADIUS_MULTIPLIERS.map((multiplier) => pocketClosingRadiusMm * multiplier),
    regularizationWidthMm / 2,
  ].filter((radius) => radius > minimumFeatureMm / 2)
    .map((radius) => Number(radius.toFixed(6))))].sort((a, b) => a - b)

  const consider = (candidatePaths: any[]) => {
    const candidate = candidateIsSafe(candidatePaths)
    if (!candidate) return
    if (candidate.energy < bestEnergy - 1e-9
      || (Math.abs(candidate.energy - bestEnergy) <= 1e-9
        && candidate.areaMm2 < boundaryArea(bestBoundary))) {
      filteredPaths = candidate.normalized
      bestBoundary = candidate.boundary
      bestEnergy = candidate.energy
    }
  }

  for (const radiusMm of radii) {
    // Closing only fills concave bays. Unioning B back in makes the operation
    // extensive even when a large Clipper offset would otherwise lose a thin
    // neck numerically.
    const expanded = offsetPaths(basePaths, radiusMm)
    if (expanded.length) {
      const closed = offsetPaths(expanded, -radiusMm)
      if (closed.length) {
        const extensiveClosed = unionPaths([...basePaths, ...closed])
        consider(extensiveClosed)
        // A same-scale opening after closing is a useful independent shape
        // candidate for a chain of overlapping wide flares: closing removes
        // the inner bays, then opening removes the matching outer staircase.
        // The core/area/foreign-pad gates below keep this from collapsing to
        // a minimum-width trace or paying for an oversized fill patch.
        const closedInset = offsetPaths(closed, -radiusMm)
        if (closedInset.length) {
          const closedThenOpened = offsetPaths(closedInset, radiusMm)
          if (closedThenOpened.length) consider(unionPaths([
            ...closedThenOpened,
            ...protectedPaths,
          ]))
        }
      }
    }

    // Opening removes unsupported outer ears. Intersect with B, then restore
    // the mandatory pad + minimum-width route core before evaluating it.
    const openingRadiusMm = radiusMm / 2
    const inset = offsetPaths(basePaths, -openingRadiusMm)
    if (!inset.length) continue
    const opened = offsetPaths(inset, openingRadiusMm)
    if (!opened.length) continue
    const coreRestored = unionPaths([
      ...intersectPaths(opened, basePaths),
      ...protectedPaths,
    ])
    consider(coreRestored)
    const reopenedExpanded = offsetPaths(coreRestored, radiusMm)
    if (reopenedExpanded.length) {
      const openedThenClosed = offsetPaths(reopenedExpanded, -radiusMm)
      if (openedThenClosed.length) consider(unionPaths([
        ...openedThenClosed,
        ...protectedPaths,
      ]))
    }
  }

  // Morphology handles rounded groups of bays well, but a long staircase can
  // remain because every individual step is wider than minimumFeatureMm. Try
  // replacing each boundary chain with the shortest one/two-segment
  // octilinear shortcut between the same endpoints. This is not a point
  // budget: all chain lengths are considered, and a shortcut survives only
  // the same core, foreign-pad, area, perimeter and compactness gates above.
  const MAX_SHORTCUT_PASSES = 1
  const MAX_SHORTCUT_REMOVED_EDGES = 8
  const MAX_SHORTCUT_CLIPPER_CHECKS_PER_PASS = 2
  const needsLargeFeatureRegularization = bestBoundary.length >= 10
    && reflexVertexCount(bestBoundary) >= 3
  for (let pass = 0;
    needsLargeFeatureRegularization && pass < MAX_SHORTCUT_PASSES;
    pass += 1) {
    const passBoundary = bestBoundary
    const energyBeforePass = bestEnergy
    const shortcutCandidates = new Map<string, {
      boundary: PcbPoint[]
      energy: number
    }>()
    for (let removedEdgeCount = 2;
      removedEdgeCount < passBoundary.length - 1
        && removedEdgeCount <= MAX_SHORTCUT_REMOVED_EDGES;
      removedEdgeCount += 1) {
      for (let startIndex = 0; startIndex < passBoundary.length; startIndex += 1) {
        const rotated = [
          ...passBoundary.slice(startIndex),
          ...passBoundary.slice(0, startIndex),
        ]
        const removedChain = rotated.slice(0, removedEdgeCount + 1)
        const removedLengthMm = polylineLength(removedChain)
        for (const shortcut of octilinearCandidates(rotated[0], rotated[removedEdgeCount])) {
          if (polylineLength(shortcut) > removedLengthMm - minimumFeatureMm + 1e-9) continue
          const candidateBoundary = simplifyCollinear([
            ...shortcut.slice(0, -1),
            ...rotated.slice(removedEdgeCount),
          ])
          if (candidateBoundary.length < 3 || !isOctilinearBoundary(candidateBoundary)) continue
          const candidateAreaMm2 = boundaryArea(candidateBoundary)
          const areaRatio = candidateAreaMm2 / Math.max(1e-9, baseAreaMm2)
          if (areaRatio < MIN_REGULARIZED_AREA_RATIO - 1e-9
            || areaRatio > MAX_REGULARIZED_AREA_RATIO + 1e-9) continue
          const candidatePerimeterMm = boundaryPerimeterMm(candidateBoundary)
          if (candidatePerimeterMm > basePerimeterMm - minimumFeatureMm + 1e-9) continue
          const candidateEnergy = candidateAreaMm2 + compactnessScaleMm * candidatePerimeterMm
          if (candidateEnergy >= bestEnergy - minimumFeatureMm * minimumFeatureMm) continue
          const key = candidateBoundary
            .map((point) => `${point.x.toFixed(6)},${point.y.toFixed(6)}`)
            .join(";")
          const previous = shortcutCandidates.get(key)
          if (!previous || candidateEnergy < previous.energy) {
            shortcutCandidates.set(key, {
              boundary: candidateBoundary,
              energy: candidateEnergy,
            })
          }
        }
      }
    }
    const shortlisted = [...shortcutCandidates.values()]
      .sort((left, right) => left.energy - right.energy)
      .slice(0, MAX_SHORTCUT_CLIPPER_CHECKS_PER_PASS)
    for (const candidate of shortlisted) {
      consider([toClipper(candidate.boundary)])
    }
    if (bestEnergy >= energyBeforePass - minimumFeatureMm * minimumFeatureMm) break
  }

  const filtered = cleanOctilinearBoundaries(
    filteredPaths,
    minimumFeatureMm,
    regularizationWidthMm,
  )
  const boundary = filtered[0] ?? raw.find(isOctilinearBoundary)
  if (!boundary) return undefined
  return {
    boundary,
    baselineBoundary: raw[0],
    rawVertexCount: raw[0].length,
    removedVertexCount: Math.max(0, raw[0].length - boundary.length),
    filledPocketAreaMm2: Math.max(0, boundaryArea(boundary) - rawAreaMm2),
  }
}

export function mergeOctilinearBoundaries(rings: PcbPoint[][], minimumFeatureMm = 0) {
  const snapToleranceMm = Math.max(
    ANGLE_TOLERANCE_MM,
    Math.min(0.01, minimumFeatureMm > 0 ? minimumFeatureMm / 4 : 0.01),
  )
  const paths = rings
    .filter((ring) => ring.length >= 3 && boundaryArea(ring) > 1e-9)
    .map(toClipper)
  if (!paths.length) return []
  const clipper = new ClipperLib.Clipper()
  clipper.StrictlySimple = true
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution
    .map((path: Array<{ X: number; Y: number }>) =>
      ClipperLib.Clipper.CleanPolygon(path, 2))
    .map(fromClipper)
    .map(simplifyCollinear)
    // Every input is already octilinear. Independent branch cleanup can
    // leave micrometre-scale coordinate differences at a shared pad; snap
    // only that numerical seam before enforcing the strict angle invariant.
    .map((ring: PcbPoint[]) => canonicalizeNearlyOctilinear(ring, snapToleranceMm) ?? ring)
    .map((ring: PcbPoint[]) => minimumFeatureMm > 0
      ? simplifyBoundaryFeatures(ring, minimumFeatureMm)
      : ring)
    .filter((ring: PcbPoint[]) => ring.length >= 3 && isOctilinearBoundary(ring))
    .sort((left: PcbPoint[], right: PcbPoint[]) => boundaryArea(right) - boundaryArea(left))
}

function projectionWidth(points: PcbPoint[], normal: PcbPoint) {
  const values = points.map((point) => point.x * normal.x + point.y * normal.y)
  return Math.max(...values) - Math.min(...values)
}

function support(points: PcbPoint[], center: PcbPoint, direction: PcbPoint) {
  return Math.max(...points.map((point) => (point.x - center.x) * direction.x + (point.y - center.y) * direction.y))
}

function edgeBetween(geometries: PadGeometry[], a: number, b: number): Edge {
  const first = geometries[a]
  const second = geometries[b]
  const dx = second.pad.x - first.pad.x
  const dy = second.pad.y - first.pad.y
  const distanceMm = Math.hypot(dx, dy)
  if (distanceMm < 1e-9) {
    const width = Math.min(first.characteristicWidthMm, second.characteristicWidthMm)
    return {
      a,
      b,
      distanceMm: 0,
      gapMm: 0,
      gapWidths: 0,
      bottleneckWidthMm: width,
      widthAtAMm: width,
      widthAtBMm: width,
    }
  }
  const direction = { x: dx / distanceMm, y: dy / distanceMm }
  const normal = { x: -direction.y, y: direction.x }
  const widthAtAMm = Math.max(1e-6, projectionWidth(first.points, normal))
  const widthAtBMm = Math.max(1e-6, projectionWidth(second.points, normal))
  const bottleneckWidthMm = Math.max(1e-6, Math.min(widthAtAMm, widthAtBMm))
  const gapMm = Math.max(0, distanceMm
    - support(first.points, first.pad, direction)
    - support(second.points, second.pad, { x: -direction.x, y: -direction.y }))
  return {
    a,
    b,
    distanceMm,
    gapMm,
    gapWidths: gapMm / bottleneckWidthMm,
    bottleneckWidthMm,
    widthAtAMm,
    widthAtBMm,
  }
}

function minimumSpanningTree(geometries: PadGeometry[]) {
  if (geometries.length < 2) return []
  const visited = new Set<number>([0])
  const edges: Edge[] = []
  while (visited.size < geometries.length) {
    let best: Edge | undefined
    for (const a of visited) {
      for (let b = 0; b < geometries.length; b += 1) {
        if (visited.has(b)) continue
        const candidate = edgeBetween(geometries, a, b)
        if (!best
          || candidate.gapWidths < best.gapWidths - 1e-9
          || (Math.abs(candidate.gapWidths - best.gapWidths) < 1e-9 && candidate.distanceMm < best.distanceMm)) {
          best = candidate
        }
      }
    }
    if (!best) break
    visited.add(best.b)
    edges.push(best)
  }
  return edges
}

function groupsAfterCut(geometries: PadGeometry[], edges: Edge[], maxPadFreeGapWidths: number) {
  const parent = geometries.map((_, index) => index)
  const find = (value: number): number => parent[value] === value ? value : (parent[value] = find(parent[value]))
  const join = (a: number, b: number) => {
    const left = find(a)
    const right = find(b)
    if (left !== right) parent[right] = left
  }
  for (const edge of edges) {
    if (edge.gapWidths <= maxPadFreeGapWidths) join(edge.a, edge.b)
  }
  const groups = new Map<number, number[]>()
  for (let index = 0; index < geometries.length; index += 1) {
    const root = find(index)
    groups.set(root, [...(groups.get(root) ?? []), index])
  }
  return [...groups.values()].sort((a, b) => a[0] - b[0])
}

function adaptiveCorridorSegmentRing(
  first: PcbPoint,
  second: PcbPoint,
  startWidthMm: number,
  endWidthMm: number,
  desiredBodyWidthMm: number,
) {
  const distanceMm = Math.hypot(second.x - first.x, second.y - first.y)
  if (distanceMm < 1e-9) return undefined
  const direction = { x: (second.x - first.x) / distanceMm, y: (second.y - first.y) / distanceMm }
  const normal = { x: -direction.y, y: direction.x }
  const startHalf = startWidthMm / 2
  const endHalf = endWidthMm / 2
  // A width change of d/2 needs d/2 millimetres along the centerline to
  // preserve a 45-degree flank. On a short segment, reduce only its plateau;
  // never emit a shallow arbitrary-angle trapezoid.
  const feasibleBodyHalf = (distanceMm + startHalf + endHalf) / 2
  const bodyHalf = Math.max(
    startHalf,
    endHalf,
    Math.min(desiredBodyWidthMm / 2, feasibleBodyHalf),
  )
  const startFlareMm = Math.max(0, bodyHalf - startHalf)
  const endFlareMm = Math.max(0, bodyHalf - endHalf)
  const upperStart = { x: first.x + normal.x * startHalf, y: first.y + normal.y * startHalf }
  const upperBodyStart = {
    x: first.x + direction.x * startFlareMm + normal.x * bodyHalf,
    y: first.y + direction.y * startFlareMm + normal.y * bodyHalf,
  }
  const upperBodyEnd = {
    x: second.x - direction.x * endFlareMm + normal.x * bodyHalf,
    y: second.y - direction.y * endFlareMm + normal.y * bodyHalf,
  }
  const upperEnd = { x: second.x + normal.x * endHalf, y: second.y + normal.y * endHalf }
  const lowerEnd = { x: second.x - normal.x * endHalf, y: second.y - normal.y * endHalf }
  const lowerBodyEnd = {
    x: second.x - direction.x * endFlareMm - normal.x * bodyHalf,
    y: second.y - direction.y * endFlareMm - normal.y * bodyHalf,
  }
  const lowerBodyStart = {
    x: first.x + direction.x * startFlareMm - normal.x * bodyHalf,
    y: first.y + direction.y * startFlareMm - normal.y * bodyHalf,
  }
  const lowerStart = { x: first.x - normal.x * startHalf, y: first.y - normal.y * startHalf }
  return simplifyCollinear([
    upperStart,
    upperBodyStart,
    upperBodyEnd,
    upperEnd,
    lowerEnd,
    lowerBodyEnd,
    lowerBodyStart,
    lowerStart,
  ])
}

function expandedPadRings(geometry: PadGeometry, padExpansionRatio: number) {
  const bounds = geometryBounds(geometry)
  const xPadding = (bounds.right - bounds.left) * padExpansionRatio / 2
  const yPadding = (bounds.bottom - bounds.top) * padExpansionRatio / 2
  return [[
    { x: bounds.left - xPadding, y: bounds.top - yPadding },
    { x: bounds.right + xPadding, y: bounds.top - yPadding },
    { x: bounds.right + xPadding, y: bounds.bottom + yPadding },
    { x: bounds.left - xPadding, y: bounds.bottom + yPadding },
  ]]
}

function padBankPairAxis(
  first: PadGeometry,
  second: PadGeometry,
  padExpansionRatio: number,
  minimumCorridorWidthMm: number,
  obstacleClearanceMm: number,
) {
  if (!first.pad.component || first.pad.component !== second.pad.component) return undefined
  const firstBounds = geometryBounds(first)
  const secondBounds = geometryBounds(second)
  const firstExpanded = geometryBounds({
    ...first,
    points: expandedPadRings(first, padExpansionRatio)[0],
  })
  const secondExpanded = geometryBounds({
    ...second,
    points: expandedPadRings(second, padExpansionRatio)[0],
  })
  const firstWidth = firstBounds.right - firstBounds.left
  const secondWidth = secondBounds.right - secondBounds.left
  const firstHeight = firstBounds.bottom - firstBounds.top
  const secondHeight = secondBounds.bottom - secondBounds.top
  const ratio = (left: number, right: number) =>
    Math.max(left, right) / Math.max(1e-9, Math.min(left, right))
  if (ratio(firstWidth, secondWidth) > 1.25 || ratio(firstHeight, secondHeight) > 1.25) return undefined
  const axisGap = (firstLow: number, firstHigh: number, secondLow: number, secondHigh: number) => {
    if (firstHigh < secondLow) return secondLow - firstHigh
    if (secondHigh < firstLow) return firstLow - secondHigh
    return 0
  }
  const maximumBankGapMm = minimumCorridorWidthMm + obstacleClearanceMm * 2
  const rowAligned = Math.abs(first.pad.y - second.pad.y)
    <= Math.min(firstHeight, secondHeight) * 0.1 + ANGLE_TOLERANCE_MM
  const columnAligned = Math.abs(first.pad.x - second.pad.x)
    <= Math.min(firstWidth, secondWidth) * 0.1 + ANGLE_TOLERANCE_MM
  if (rowAligned && axisGap(
    firstExpanded.left,
    firstExpanded.right,
    secondExpanded.left,
    secondExpanded.right,
  ) <= maximumBankGapMm + 1e-9) return "row" as const
  if (columnAligned && axisGap(
    firstExpanded.top,
    firstExpanded.bottom,
    secondExpanded.top,
    secondExpanded.bottom,
  ) <= maximumBankGapMm + 1e-9) return "column" as const
  return undefined
}

type PadBankEnvelope = {
  members: number[]
  ring: PcbPoint[]
  connectivitySafe: boolean
}

function padBankEnvelopes(
  geometries: PadGeometry[],
  obstacles: PadGeometry[],
  padExpansionRatio: number,
  minimumCorridorWidthMm: number,
  obstacleClearanceMm: number,
): PadBankEnvelope[] {
  if (geometries.length < 2) return []
  const expandedBounds = geometries.map((geometry) => {
    const ring = expandedPadRings(geometry, padExpansionRatio)[0]
    return {
      left: Math.min(...ring.map((point) => point.x)),
      right: Math.max(...ring.map((point) => point.x)),
      top: Math.min(...ring.map((point) => point.y)),
      bottom: Math.max(...ring.map((point) => point.y)),
    }
  })
  // If this space cannot carry one future minimum-width route plus clearance
  // on both sides, preserving a notch between same-net pins has no routing
  // value. Treat a regular row/column of equal pins as one copper bank.
  // Rows and columns are clustered independently: an L-shaped or 2-D pad
  // array must not collapse into one large rectangular hull.
  const groupsForAxis = (axis: "row" | "column") => {
    const parent = geometries.map((_, index) => index)
    const find = (value: number): number => parent[value] === value
      ? value
      : (parent[value] = find(parent[value]))
    const join = (left: number, right: number) => {
      const leftRoot = find(left)
      const rightRoot = find(right)
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
    }
    for (let left = 0; left < geometries.length; left += 1) {
      for (let right = left + 1; right < geometries.length; right += 1) {
        if (padBankPairAxis(
          geometries[left],
          geometries[right],
          padExpansionRatio,
          minimumCorridorWidthMm,
          obstacleClearanceMm,
        ) === axis) join(left, right)
      }
    }
    const groups = new Map<number, number[]>()
    for (let index = 0; index < geometries.length; index += 1) {
      const root = find(index)
      groups.set(root, [...(groups.get(root) ?? []), index])
    }
    return [...groups.values()].filter((group) => group.length >= 2)
  }
  const groups = [...groupsForAxis("row"), ...groupsForAxis("column")]
  const foreignBounds = obstacles
    .filter((geometry) => geometry.pad.net !== geometries[0].pad.net)
    .map(geometryBounds)
  const overlapsWithArea = (left: Bounds, right: Bounds) =>
    Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1e-9
      && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1e-9
  const envelopes = groups
    .map((members) => ({
      members,
      bounds: {
        left: Math.min(...members.map((index) => expandedBounds[index].left)),
        right: Math.max(...members.map((index) => expandedBounds[index].right)),
        top: Math.min(...members.map((index) => expandedBounds[index].top)),
        bottom: Math.max(...members.map((index) => expandedBounds[index].bottom)),
      },
    }))
    // A foreign pad body is an absolute veto. Exact clearance and refill
    // remain backend-owned; the outline engine never cuts pad-shaped bays.
    .filter(({ bounds }) => !foreignBounds.some((foreign) => overlapsWithArea(bounds, foreign)))
  const unique = new Map<string, { members: Set<number>; bounds: Bounds }>()
  for (const envelope of envelopes) {
    const key = `${envelope.bounds.left.toFixed(9)}:${envelope.bounds.right.toFixed(9)}:${envelope.bounds.top.toFixed(9)}:${envelope.bounds.bottom.toFixed(9)}`
    const existing = unique.get(key)
    if (existing) {
      for (const member of envelope.members) existing.members.add(member)
    } else {
      unique.set(key, { members: new Set(envelope.members), bounds: envelope.bounds })
    }
  }
  const foreignClearancePaths = foreignBounds.map((bounds) =>
    toClipper(boundsRing(inflateBounds(bounds, obstacleClearanceMm + 2 / SCALE))))
  return [...unique.values()].map(({ members, bounds }) => {
    const orderedMembers = [...members].sort((left, right) => left - right)
    const rawMemberPaths = orderedMembers.map((member) =>
      toClipper(boundsRing(geometryBounds(geometries[member]))))
    // Contract a bank only when the copper that survives an approximate
    // native-clearance cut still contains every member in one connected
    // outer component. This avoids phantom connectivity without rejecting a
    // harmless shallow clearance bite at an edge of the bank.
    const clearanceCut = differencePaths(
      [toClipper(boundsRing(bounds))],
      foreignClearancePaths,
    )
    const requiredNeckMm = Math.min(
      DEFAULT_MIN_BANK_CONNECTIVITY_NECK_MM,
      minimumCorridorWidthMm,
    )
    const robustClearanceCut = requiredNeckMm > 1e-9
      ? offsetPaths(offsetPaths(clearanceCut, -requiredNeckMm / 2), requiredNeckMm / 2)
      : clearanceCut
    const refillApproximation = unionPaths([
      ...robustClearanceCut,
      ...rawMemberPaths,
    ])
    const connectivitySafe = refillApproximation.some((path: Array<{ X: number; Y: number }>) =>
      orderedMembers.every((member) => ClipperLib.Clipper.PointInPolygon({
        X: Math.round(geometries[member].pad.x * SCALE),
        Y: Math.round(geometries[member].pad.y * SCALE),
      }, path) !== 0))
    return {
      members: orderedMembers,
      ring: boundsRing(bounds),
      connectivitySafe,
    }
  })
}

type PadClusterConnection = {
  kind: "bridge"
  subject: PcbPoint[]
  protected: PcbPoint[]
} | { kind: "covered" }

function rawPadOverlapCluster(geometries: PadGeometry[], seed: number) {
  const included = new Set([seed])
  let changed = true
  while (changed) {
    changed = false
    for (let index = 0; index < geometries.length; index += 1) {
      if (included.has(index)) continue
      const candidate = geometryBounds(geometries[index])
      if (![...included].some((member) => {
        const current = geometryBounds(geometries[member])
        return Math.min(current.right, candidate.right) - Math.max(current.left, candidate.left) > 1e-9
          && Math.min(current.bottom, candidate.bottom) - Math.max(current.top, candidate.top) > 1e-9
      })) continue
      included.add(index)
      changed = true
    }
  }
  return [...included]
}

function compactConnectivityGroups(
  geometries: PadGeometry[],
  bankEnvelopes: PadBankEnvelope[],
) {
  const parent = geometries.map((_, index) => index)
  const find = (value: number): number => parent[value] === value
    ? value
    : (parent[value] = find(parent[value]))
  const join = (left: number, right: number) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }
  // Raw same-net copper is already connected even without a generated zone.
  for (let left = 0; left < geometries.length; left += 1) {
    const leftBounds = geometryBounds(geometries[left])
    for (let right = left + 1; right < geometries.length; right += 1) {
      const rightBounds = geometryBounds(geometries[right])
      if (Math.min(leftBounds.right, rightBounds.right) - Math.max(leftBounds.left, rightBounds.left) > 1e-9
        && Math.min(leftBounds.bottom, rightBounds.bottom) - Math.max(leftBounds.top, rightBounds.top) > 1e-9) {
        join(left, right)
      }
    }
  }
  // Row/column envelopes remain separate geometry (important for L-shaped
  // banks), but overlapping accepted envelopes may share one connectivity
  // node through their common target pad.
  for (const envelope of bankEnvelopes) {
    if (!envelope.connectivitySafe || envelope.members.length < 2) continue
    for (const member of envelope.members.slice(1)) join(envelope.members[0], member)
  }
  const grouped = new Map<number, number[]>()
  for (let index = 0; index < geometries.length; index += 1) {
    const root = find(index)
    grouped.set(root, [...(grouped.get(root) ?? []), index])
  }
  const groups = [...grouped.values()]
    .map((group) => group.sort((left, right) => left - right))
    .sort((left, right) => left[0] - right[0])
  return groups
}

function alignedPadClusterBridge(
  routed: RoutedEdge,
  geometries: PadGeometry[],
  obstacles: PadGeometry[],
  padExpansionRatio: number,
  minimumCorridorWidthMm: number,
  obstacleClearanceMm: number,
): PadClusterConnection | undefined {
  const firstCluster = rawPadOverlapCluster(geometries, routed.edge.a)
  const secondCluster = rawPadOverlapCluster(geometries, routed.edge.b)
  // Raw target-pad bodies already form one connected copper cluster. Any MST
  // edge inside it is redundant; buffering its centerline only creates ears.
  if (firstCluster.some((index) => secondCluster.includes(index))) return { kind: "covered" }
  const foreignBounds = obstacles
    .filter((geometry) => geometry.pad.net !== geometries[routed.edge.a].pad.net)
    .map(geometryBounds)
  // A face bridge replaces an already obstacle-aware routed corridor. Apply
  // the same routing-space reserve before accepting that simplification;
  // otherwise native refill can cut the bridge back into disconnected parts.
  const foreignRoutingKeepouts = foreignBounds.map((bounds) => inflateBounds(
    bounds,
    obstacleClearanceMm + minimumCorridorWidthMm / 2,
  ))
  const overlapsWithArea = (left: Bounds, right: Bounds) =>
    Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1e-9
      && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1e-9
  const candidates: Array<Extract<PadClusterConnection, { kind: "bridge" }> & { areaMm2: number }> = []
  // The MST width is measured perpendicular to its centre-to-centre vector.
  // A face-aligned bridge can be slightly narrower while still being much
  // wider and cleaner than the design-rule minimum.
  const minimumAlignedBridgeWidthMm = Math.max(
    minimumCorridorWidthMm,
    routed.widthMm * 0.75,
  )
  for (const firstIndex of firstCluster) {
    for (const secondIndex of secondCluster) {
      const firstRaw = geometryBounds(geometries[firstIndex])
      const secondRaw = geometryBounds(geometries[secondIndex])
      const firstExpanded = geometryBounds({
        ...geometries[firstIndex],
        points: expandedPadRings(geometries[firstIndex], padExpansionRatio)[0],
      })
      const secondExpanded = geometryBounds({
        ...geometries[secondIndex],
        points: expandedPadRings(geometries[secondIndex], padExpansionRatio)[0],
      })
      const addHorizontal = (leftRaw: Bounds, rightRaw: Bounds, leftExpanded: Bounds, rightExpanded: Bounds) => {
        const overlapTop = Math.max(leftRaw.top, rightRaw.top)
        const overlapBottom = Math.min(leftRaw.bottom, rightRaw.bottom)
        const overlapMm = overlapBottom - overlapTop
        const gapMm = rightRaw.left - leftRaw.right
        if (gapMm <= 1e-9 || overlapMm + 1e-9 < minimumAlignedBridgeWidthMm) return
        const joinOverlapMm = 2 / SCALE
        const protectedBounds = {
          left: leftRaw.right - joinOverlapMm,
          right: rightRaw.left + joinOverlapMm,
          top: overlapTop,
          bottom: overlapBottom,
        }
        const expandedTop = Math.max(leftExpanded.top, rightExpanded.top)
        const expandedBottom = Math.min(leftExpanded.bottom, rightExpanded.bottom)
        const expandedBounds = rightExpanded.left > leftExpanded.right + 1e-9
          ? {
            left: leftExpanded.right - joinOverlapMm,
            right: rightExpanded.left + joinOverlapMm,
            top: expandedTop,
            bottom: expandedBottom,
          }
          : protectedBounds
        if (foreignBounds.some((foreign) =>
          overlapsWithArea(expandedBounds, foreign) || overlapsWithArea(protectedBounds, foreign))) return
        if (foreignRoutingKeepouts.some((keepout) =>
          overlapsWithArea(expandedBounds, keepout) || overlapsWithArea(protectedBounds, keepout))) return
        candidates.push({
          kind: "bridge",
          subject: boundsRing(expandedBounds),
          protected: boundsRing(protectedBounds),
          areaMm2: gapMm * overlapMm,
        })
      }
      const addVertical = (topRaw: Bounds, bottomRaw: Bounds, topExpanded: Bounds, bottomExpanded: Bounds) => {
        const overlapLeft = Math.max(topRaw.left, bottomRaw.left)
        const overlapRight = Math.min(topRaw.right, bottomRaw.right)
        const overlapMm = overlapRight - overlapLeft
        const gapMm = bottomRaw.top - topRaw.bottom
        if (gapMm <= 1e-9 || overlapMm + 1e-9 < minimumAlignedBridgeWidthMm) return
        const joinOverlapMm = 2 / SCALE
        const protectedBounds = {
          left: overlapLeft,
          right: overlapRight,
          top: topRaw.bottom - joinOverlapMm,
          bottom: bottomRaw.top + joinOverlapMm,
        }
        const expandedLeft = Math.max(topExpanded.left, bottomExpanded.left)
        const expandedRight = Math.min(topExpanded.right, bottomExpanded.right)
        const expandedBounds = bottomExpanded.top > topExpanded.bottom + 1e-9
          ? {
            left: expandedLeft,
            right: expandedRight,
            top: topExpanded.bottom - joinOverlapMm,
            bottom: bottomExpanded.top + joinOverlapMm,
          }
          : protectedBounds
        if (foreignBounds.some((foreign) =>
          overlapsWithArea(expandedBounds, foreign) || overlapsWithArea(protectedBounds, foreign))) return
        if (foreignRoutingKeepouts.some((keepout) =>
          overlapsWithArea(expandedBounds, keepout) || overlapsWithArea(protectedBounds, keepout))) return
        candidates.push({
          kind: "bridge",
          subject: boundsRing(expandedBounds),
          protected: boundsRing(protectedBounds),
          areaMm2: gapMm * overlapMm,
        })
      }
      if (firstRaw.right < secondRaw.left) addHorizontal(firstRaw, secondRaw, firstExpanded, secondExpanded)
      if (secondRaw.right < firstRaw.left) addHorizontal(secondRaw, firstRaw, secondExpanded, firstExpanded)
      if (firstRaw.bottom < secondRaw.top) addVertical(firstRaw, secondRaw, firstExpanded, secondExpanded)
      if (secondRaw.bottom < firstRaw.top) addVertical(secondRaw, firstRaw, secondExpanded, firstExpanded)
    }
  }
  return candidates.sort((left, right) => left.areaMm2 - right.areaMm2)[0]
}

function widthAcrossSegment(points: PcbPoint[], first: PcbPoint, second: PcbPoint) {
  const distanceMm = Math.hypot(second.x - first.x, second.y - first.y)
  if (distanceMm < 1e-9) return 0
  const normal = {
    x: -(second.y - first.y) / distanceMm,
    y: (second.x - first.x) / distanceMm,
  }
  return projectionWidth(points, normal)
}

function adaptiveRouteVertexWidths(
  routed: RoutedEdge,
  geometries: PadGeometry[],
  padExpansionRatio: number,
) {
  const widths = routed.points.map((_, index) => {
    if (index === 0) return routed.segmentBodyWidthsMm[0] ?? routed.widthMm
    if (index === routed.points.length - 1) return routed.segmentBodyWidthsMm.at(-1) ?? routed.widthMm
    return Math.min(
      routed.segmentBodyWidthsMm[index - 1] ?? routed.widthMm,
      routed.segmentBodyWidthsMm[index] ?? routed.widthMm,
    )
  })
  if (widths.length < 2) return widths
  const startEnvelope = expandedPadRings(geometries[routed.edge.a], padExpansionRatio)[0]
  const endEnvelope = expandedPadRings(geometries[routed.edge.b], padExpansionRatio)[0]
  widths[0] = Math.min(
    routed.segmentBodyWidthsMm[0] ?? routed.widthMm,
    Math.max(routed.widthMm, widthAcrossSegment(startEnvelope, routed.points[0], routed.points[1])),
  )
  widths[widths.length - 1] = Math.min(
    routed.segmentBodyWidthsMm.at(-1) ?? routed.widthMm,
    Math.max(
      routed.widthMm,
      widthAcrossSegment(endEnvelope, routed.points.at(-2)!, routed.points.at(-1)!),
    ),
  )
  // A 45-degree flare can change full width by at most twice the segment
  // length. Propagate that constraint through short path segments so the
  // generated outline never needs a non-octilinear side.
  for (let index = 1; index < widths.length; index += 1) {
    const lengthMm = Math.hypot(
      routed.points[index].x - routed.points[index - 1].x,
      routed.points[index].y - routed.points[index - 1].y,
    )
    widths[index] = Math.min(widths[index], widths[index - 1] + lengthMm * 2)
  }
  for (let index = widths.length - 2; index >= 0; index -= 1) {
    const lengthMm = Math.hypot(
      routed.points[index + 1].x - routed.points[index].x,
      routed.points[index + 1].y - routed.points[index].y,
    )
    widths[index] = Math.min(widths[index], widths[index + 1] + lengthMm * 2)
  }
  return widths
}

function geometryBounds(geometry: PadGeometry): Bounds {
  return {
    left: Math.min(...geometry.points.map((point) => point.x)),
    right: Math.max(...geometry.points.map((point) => point.x)),
    top: Math.min(...geometry.points.map((point) => point.y)),
    bottom: Math.max(...geometry.points.map((point) => point.y)),
  }
}

function boundsRing(bounds: Bounds): PcbPoint[] {
  return [
    { x: bounds.left, y: bounds.top },
    { x: bounds.right, y: bounds.top },
    { x: bounds.right, y: bounds.bottom },
    { x: bounds.left, y: bounds.bottom },
  ]
}

function inflateBounds(bounds: Bounds, amount: number): Bounds {
  return {
    left: bounds.left - amount,
    right: bounds.right + amount,
    top: bounds.top - amount,
    bottom: bounds.bottom + amount,
  }
}

function boundsOverlap(a: Bounds, b: Bounds) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top
}

function segmentHitsBounds(first: PcbPoint, second: PcbPoint, bounds: Bounds) {
  const epsilon = 1e-7
  const box = {
    left: bounds.left + epsilon,
    right: bounds.right - epsilon,
    top: bounds.top + epsilon,
    bottom: bounds.bottom - epsilon,
  }
  if (box.left >= box.right || box.top >= box.bottom) return false
  const inside = (point: PcbPoint) => point.x > box.left && point.x < box.right
    && point.y > box.top && point.y < box.bottom
  if (inside(first) || inside(second)) return true
  const dx = second.x - first.x
  const dy = second.y - first.y
  let near = 0
  let far = 1
  for (const [origin, delta, low, high] of [
    [first.x, dx, box.left, box.right],
    [first.y, dy, box.top, box.bottom],
  ] as const) {
    if (Math.abs(delta) < epsilon) {
      if (origin <= low || origin >= high) return false
      continue
    }
    const a = (low - origin) / delta
    const b = (high - origin) / delta
    near = Math.max(near, Math.min(a, b))
    far = Math.min(far, Math.max(a, b))
    if (near > far) return false
  }
  return near <= far && far >= 0 && near <= 1
}

function polylineLength(points: PcbPoint[]) {
  return points.slice(1).reduce((sum, point, index) => sum + Math.hypot(
    point.x - points[index].x,
    point.y - points[index].y,
  ), 0)
}

function deduplicatePath(points: PcbPoint[]) {
  return points.filter((point, index) => index === 0
    || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 1e-9)
}

function octilinearCandidates(start: PcbPoint, end: PcbPoint) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const absoluteX = Math.abs(dx)
  const absoluteY = Math.abs(dy)
  const signX = Math.sign(dx)
  const signY = Math.sign(dy)
  const diagonal = Math.min(absoluteX, absoluteY)
  const candidates: PcbPoint[][] = []
  if (absoluteX <= ANGLE_TOLERANCE_MM
    || absoluteY <= ANGLE_TOLERANCE_MM
    || Math.abs(absoluteX - absoluteY) <= ANGLE_TOLERANCE_MM) {
    candidates.push([start, end])
  } else if (absoluteX > absoluteY) {
    candidates.push(
      [start, { x: start.x + signX * (absoluteX - diagonal), y: start.y }, end],
      [start, { x: start.x + signX * diagonal, y: start.y + signY * diagonal }, end],
    )
  } else {
    candidates.push(
      [start, { x: start.x, y: start.y + signY * (absoluteY - diagonal) }, end],
      [start, { x: start.x + signX * diagonal, y: start.y + signY * diagonal }, end],
    )
  }
  candidates.push(
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end],
  )
  const unique = new Map<string, PcbPoint[]>()
  for (const candidate of candidates.map(deduplicatePath)) {
    if (candidate.length < 2 || !candidate.slice(1).every((point, index) => segmentIsOctilinear(candidate[index], point))) continue
    unique.set(candidate.map((point) => `${point.x.toFixed(9)},${point.y.toFixed(9)}`).join(";"), candidate)
  }
  return [...unique.values()]
}

function pointInsideBounds(point: PcbPoint, bounds: Bounds) {
  const epsilon = 1e-7
  return point.x > bounds.left + epsilon && point.x < bounds.right - epsilon
    && point.y > bounds.top + epsilon && point.y < bounds.bottom - epsilon
}

function samePoint(left: PcbPoint, right: PcbPoint) {
  return Math.hypot(left.x - right.x, left.y - right.y) < 1e-9
}

function endpointCanExitBounds(endpoint: PcbPoint, adjacent: PcbPoint, bounds: Bounds) {
  if (!pointInsideBounds(endpoint, bounds) || pointInsideBounds(adjacent, bounds)) return false
  const awayFromCenter = {
    x: endpoint.x - (bounds.left + bounds.right) / 2,
    y: endpoint.y - (bounds.top + bounds.bottom) / 2,
  }
  const exitDirection = { x: adjacent.x - endpoint.x, y: adjacent.y - endpoint.y }
  if (Math.hypot(awayFromCenter.x, awayFromCenter.y) < 1e-9) return false
  // A target pin can sit inside the inflated clearance box of its neighbour.
  // Allow only a taper that exits sideways/away from that neighbour; entering
  // from the neighbour's side would be clipped into a disconnected island by
  // the native EDA refill.
  return awayFromCenter.x * exitDirection.x + awayFromCenter.y * exitDirection.y >= -1e-9
}

function segmentHitsRoutingBounds(
  first: PcbPoint,
  second: PcbPoint,
  bounds: Bounds,
  start: PcbPoint,
  end: PcbPoint,
) {
  if (!segmentHitsBounds(first, second, bounds)) return false
  if (samePoint(first, start) && endpointCanExitBounds(start, second, bounds)) return false
  if (samePoint(second, start) && endpointCanExitBounds(start, first, bounds)) return false
  if (samePoint(first, end) && endpointCanExitBounds(end, second, bounds)) return false
  if (samePoint(second, end) && endpointCanExitBounds(end, first, bounds)) return false
  return true
}

function corridorObstacleHits(
  points: PcbPoint[],
  blocked: Bounds[],
  start: PcbPoint = points[0],
  end: PcbPoint = points.at(-1)!,
) {
  return blocked.filter((bounds) => points.slice(1).some((point, index) =>
    segmentHitsRoutingBounds(points[index], point, bounds, start, end))).length
}

function polylineBounds(points: PcbPoint[], marginMm = 0): Bounds {
  return {
    left: Math.min(...points.map((point) => point.x)) - marginMm,
    right: Math.max(...points.map((point) => point.x)) + marginMm,
    top: Math.min(...points.map((point) => point.y)) - marginMm,
    bottom: Math.max(...points.map((point) => point.y)) + marginMm,
  }
}

function blockedBoundsForWidth(
  obstacles: PadGeometry[],
  targetNet: string,
  points: PcbPoint[],
  widthMm: number,
  obstacleClearanceMm: number,
  routingReserveMm = 0,
) {
  const inflationMm = obstacleClearanceMm + routingReserveMm + widthMm / 2
  const searchBounds = polylineBounds(points, inflationMm)
  return obstacles
    .filter((geometry) => geometry.pad.net !== targetNet)
    .map(geometryBounds)
    .filter((bounds) => boundsOverlap(inflateBounds(bounds, inflationMm), searchBounds))
    .map((bounds) => inflateBounds(bounds, inflationMm))
}

function widestCollisionFreeBodyWidth(
  obstacles: PadGeometry[],
  targetNet: string,
  points: PcbPoint[],
  routeStart: PcbPoint,
  routeEnd: PcbPoint,
  baseWidthMm: number,
  maximumUsefulWidthMm: number,
  obstacleClearanceMm: number,
  routingReserveMm: number,
) {
  const maximumWidthMm = Math.max(
    baseWidthMm,
    Math.min(baseWidthMm * MAX_ADAPTIVE_CORRIDOR_WIDTH_RATIO, maximumUsefulWidthMm),
  )
  if (maximumWidthMm <= baseWidthMm + 1e-9) return baseWidthMm
  const collides = (widthMm: number) => corridorObstacleHits(
    points,
    blockedBoundsForWidth(
      obstacles,
      targetNet,
      points,
      widthMm,
      obstacleClearanceMm,
      routingReserveMm,
    ),
    routeStart,
    routeEnd,
  ) > 0
  if (!collides(maximumWidthMm)) return maximumWidthMm
  let safeWidthMm = baseWidthMm
  let blockedWidthMm = maximumWidthMm
  for (let index = 0; index < ADAPTIVE_WIDTH_SEARCH_STEPS; index += 1) {
    const candidateWidthMm = (safeWidthMm + blockedWidthMm) / 2
    if (collides(candidateWidthMm)) blockedWidthMm = candidateWidthMm
    else safeWidthMm = candidateWidthMm
  }
  return safeWidthMm
}

type DistanceQueueItem = { key: string; distance: number }

class DistanceMinHeap {
  private readonly items: DistanceQueueItem[] = []

  get size() { return this.items.length }

  push(item: DistanceQueueItem) {
    this.items.push(item)
    let index = this.items.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.items[parent].distance <= item.distance) break
      this.items[index] = this.items[parent]
      index = parent
    }
    this.items[index] = item
  }

  pop(): DistanceQueueItem | undefined {
    if (!this.items.length) return undefined
    const first = this.items[0]
    const last = this.items.pop()!
    if (!this.items.length) return first
    let index = 0
    while (true) {
      const left = index * 2 + 1
      if (left >= this.items.length) break
      const right = left + 1
      const child = right < this.items.length
        && this.items[right].distance < this.items[left].distance ? right : left
      if (this.items[child].distance >= last.distance) break
      this.items[index] = this.items[child]
      index = child
    }
    this.items[index] = last
    return first
  }
}

function shortestRectilinearPath(
  start: PcbPoint,
  end: PcbPoint,
  blocked: Bounds[],
  searchBudget: PolygonSearchBudget,
) {
  const xs = [...new Set([
    start.x,
    end.x,
    ...blocked.flatMap((bounds) => [bounds.left, bounds.right]),
  ])].sort((a, b) => a - b)
  const ys = [...new Set([
    start.y,
    end.y,
    ...blocked.flatMap((bounds) => [bounds.top, bounds.bottom]),
  ])].sort((a, b) => a - b)
  // Bound the whole visibility-graph attempt before allocating its grid.
  // The multiplier accounts for node filtering, edge construction and path
  // traversal. This is deterministic and independent of machine speed.
  searchBudget.spend(xs.length * ys.length * 4, "building a rectilinear visibility graph")
  const key = (xIndex: number, yIndex: number) => `${xIndex}:${yIndex}`
  const nodes = new Map<string, { point: PcbPoint; xIndex: number; yIndex: number }>()
  for (let yIndex = 0; yIndex < ys.length; yIndex += 1) {
    for (let xIndex = 0; xIndex < xs.length; xIndex += 1) {
      const point = { x: xs[xIndex], y: ys[yIndex] }
      const isEndpoint = Math.hypot(point.x - start.x, point.y - start.y) < 1e-9
        || Math.hypot(point.x - end.x, point.y - end.y) < 1e-9
      if (!isEndpoint && blocked.some((bounds) => pointInsideBounds(point, bounds))) continue
      nodes.set(key(xIndex, yIndex), { point, xIndex, yIndex })
    }
  }
  const startKey = key(xs.indexOf(start.x), ys.indexOf(start.y))
  const endKey = key(xs.indexOf(end.x), ys.indexOf(end.y))
  if (!nodes.has(startKey) || !nodes.has(endKey)) return undefined

  const rows = new Map<number, typeof nodes extends Map<string, infer T> ? T[] : never>()
  const columns = new Map<number, typeof nodes extends Map<string, infer T> ? T[] : never>()
  for (const node of nodes.values()) {
    rows.set(node.yIndex, [...(rows.get(node.yIndex) ?? []), node])
    columns.set(node.xIndex, [...(columns.get(node.xIndex) ?? []), node])
  }
  for (const row of rows.values()) row.sort((a, b) => a.xIndex - b.xIndex)
  for (const column of columns.values()) column.sort((a, b) => a.yIndex - b.yIndex)

  const neighbours = new Map<string, Array<{ key: string; distance: number }>>()
  const addVisiblePairs = (line: Array<{ point: PcbPoint; xIndex: number; yIndex: number }>) => {
    for (let index = 1; index < line.length; index += 1) {
      const first = line[index - 1]
      const second = line[index]
      if (blocked.some((bounds) => segmentHitsRoutingBounds(first.point, second.point, bounds, start, end))) continue
      const firstKey = key(first.xIndex, first.yIndex)
      const secondKey = key(second.xIndex, second.yIndex)
      const distance = Math.hypot(second.point.x - first.point.x, second.point.y - first.point.y)
      neighbours.set(firstKey, [...(neighbours.get(firstKey) ?? []), { key: secondKey, distance }])
      neighbours.set(secondKey, [...(neighbours.get(secondKey) ?? []), { key: firstKey, distance }])
    }
  }
  for (const row of rows.values()) addVisiblePairs(row)
  for (const column of columns.values()) addVisiblePairs(column)

  const distances = new Map<string, number>([[startKey, 0]])
  const previous = new Map<string, string>()
  const visited = new Set<string>()
  const queue = new DistanceMinHeap()
  queue.push({ key: startKey, distance: 0 })
  while (queue.size) {
    const currentItem = queue.pop()!
    const current = currentItem.key
    if (visited.has(current)) continue
    if (currentItem.distance > (distances.get(current) ?? Infinity) + 1e-9) continue
    visited.add(current)
    if (current === endKey) break
    for (const neighbour of neighbours.get(current) ?? []) {
      if (visited.has(neighbour.key)) continue
      const candidateDistance = currentItem.distance + neighbour.distance
      if (candidateDistance + 1e-9 >= (distances.get(neighbour.key) ?? Infinity)) continue
      distances.set(neighbour.key, candidateDistance)
      previous.set(neighbour.key, current)
      queue.push({ key: neighbour.key, distance: candidateDistance })
    }
  }
  if (!distances.has(endKey)) return undefined
  const pathKeys = [endKey]
  while (pathKeys[0] !== startKey) {
    const parent = previous.get(pathKeys[0])
    if (!parent) return undefined
    pathKeys.unshift(parent)
  }
  return simplifyCollinear(pathKeys.map((nodeKey) => nodes.get(nodeKey)!.point))
}

function routeEdge(
  geometries: PadGeometry[],
  obstacles: PadGeometry[],
  edge: Edge,
  padExpansionRatio: number,
  minimumCorridorWidthMm: number,
  obstacleClearanceMm: number,
  searchBudget: PolygonSearchBudget,
): RoutedEdge | undefined {
  searchBudget.spend(1, "evaluating a pad-pair route")
  const start = geometries[edge.a].pad
  const end = geometries[edge.b].pad
  const widthMm = Math.max(edge.bottleneckWidthMm, minimumCorridorWidthMm)
  const obstacleInflation = obstacleClearanceMm + widthMm / 2
  const searchMargin = Math.max(widthMm * 4, obstacleClearanceMm * 4, 1)
  const searchBounds = inflateBounds({
    left: Math.min(start.x, end.x),
    right: Math.max(start.x, end.x),
    top: Math.min(start.y, end.y),
    bottom: Math.max(start.y, end.y),
  }, searchMargin)
  const blocked = obstacles
    .filter((geometry) => geometry.pad.net !== geometries[edge.a].pad.net)
    .map(geometryBounds)
    .filter((bounds) => boundsOverlap(bounds, searchBounds))
    .map((bounds) => inflateBounds(bounds, obstacleInflation))
  const directObstacleCount = corridorObstacleHits([start, end], blocked)
  const candidates = octilinearCandidates(start, end)
  const unique = new Map(candidates.map((candidate) => [
    candidate.map((point) => `${point.x.toFixed(9)},${point.y.toFixed(9)}`).join(";"),
    candidate,
  ]))
  const points = [...unique.values()]
    .filter((candidate) => corridorObstacleHits(candidate, blocked) === 0)
    .sort((left, right) => {
      const lengthDifference = polylineLength(left) - polylineLength(right)
      if (Math.abs(lengthDifference) > 1e-9) return lengthDifference
      return left.length - right.length
    })[0] ?? shortestRectilinearPath(start, end, blocked, searchBudget)
  if (!points) return undefined
  const lengthMm = polylineLength(points)
  const remainingObstacleCount = corridorObstacleHits(points, blocked)
  if (remainingObstacleCount) return undefined
  const routeStart = points[0]
  const routeEnd = points.at(-1)!
  const endpointsSharePadBank = Boolean(padBankPairAxis(
    geometries[edge.a],
    geometries[edge.b],
    padExpansionRatio,
    minimumCorridorWidthMm,
    obstacleClearanceMm,
  ))
  const allowExpansion = edge.gapMm > minimumCorridorWidthMm / 2 && !endpointsSharePadBank
  const routingReserveMm = minimumCorridorWidthMm / 2
  const startEnvelope = expandedPadRings(geometries[edge.a], padExpansionRatio)[0]
  const endEnvelope = expandedPadRings(geometries[edge.b], padExpansionRatio)[0]
  const segmentBodyWidthsMm = points.slice(1).map((point, index) => {
    const startSupportWidthMm = widthAcrossSegment(startEnvelope, points[index], point)
    const endSupportWidthMm = widthAcrossSegment(endEnvelope, points[index], point)
    // Free space alone is not a reason to grow copper. Both endpoint pads
    // contribute to the useful width. A longitudinal pad-free gap must not be
    // added to a uniform transverse width: that creates copper bubbles in
    // empty space. Wider free-span copper needs a separate tapered profile.
    const padSupportedWidthMm = allowExpansion
      ? Math.sqrt(Math.max(widthMm, startSupportWidthMm) * Math.max(widthMm, endSupportWidthMm))
      : widthMm
    return widestCollisionFreeBodyWidth(
      obstacles,
      geometries[edge.a].pad.net,
      [points[index], point],
      routeStart,
      routeEnd,
      widthMm,
      padSupportedWidthMm,
      obstacleClearanceMm,
      routingReserveMm,
    )
  })
  const bodyWidthMm = segmentBodyWidthsMm.length
    ? Math.max(...segmentBodyWidthsMm)
    : widthMm
  return {
    edge,
    points,
    widthMm,
    bodyWidthMm,
    segmentBodyWidthsMm,
    lengthMm,
    avoidedObstacleCount: Math.max(0, directObstacleCount - remainingObstacleCount),
    remainingObstacleCount,
  }
}

type RoutedClearanceGateContext = {
  rawTargetPaths: any[]
  foreignClearancePaths: any[]
}

function routedClearanceGateContext(
  geometries: PadGeometry[],
  obstacles: PadGeometry[],
  obstacleClearanceMm: number,
): RoutedClearanceGateContext {
  return {
    rawTargetPaths: unionPaths(geometries.map((geometry) =>
      toClipper(boundsRing(geometryBounds(geometry))))),
    foreignClearancePaths: obstacles
      .filter((geometry) => geometry.pad.net !== geometries[0].pad.net)
      .map((geometry) => toClipper(boundsRing(inflateBounds(
        geometryBounds(geometry),
        obstacleClearanceMm + 2 / SCALE,
      )))),
  }
}

function routedConnectionAvoidsForeignClearance(
  routed: RoutedEdge,
  context: RoutedClearanceGateContext,
) {
  const corridorRings = routed.points.slice(1).flatMap((point, index) => {
    const ring = adaptiveCorridorSegmentRing(
      routed.points[index],
      point,
      routed.widthMm,
      routed.widthMm,
      routed.widthMm,
    )
    return ring ? [ring] : []
  })
  if (!corridorRings.length) return false
  // Copper inside a target pad is unavoidable and already governed by the
  // footprint DRC. Check only the emitted corridor outside all target pads.
  const exposedCorridorPaths = differencePaths(
    unionPaths(corridorRings.map(toClipper)),
    context.rawTargetPaths,
  )
  return clipperPathsAreaMm2(intersectPaths(
    exposedCorridorPaths,
    context.foreignClearancePaths,
  )) <= 1e-8
}

function stableGeometryKey(geometry: PadGeometry) {
  const pad = geometry.pad
  return [
    pad.component ?? "",
    String(pad.padNumber ?? ""),
    pad.x.toFixed(9),
    pad.y.toFixed(9),
    pad.id ?? "",
  ].join(":")
}

function routedCopperAreaProxy(routed: RoutedEdge) {
  return routed.points.slice(1).reduce((areaMm2, point, index) => areaMm2
    + Math.hypot(
      point.x - routed.points[index].x,
      point.y - routed.points[index].y,
    ) * (routed.segmentBodyWidthsMm[index] ?? routed.widthMm), 0)
}

function compareRoutedCandidates(
  left: RoutedEdge,
  right: RoutedEdge,
  geometries: PadGeometry[],
) {
  const numericLeft = [
    Math.round(left.lengthMm * SCALE),
    Math.round(routedCopperAreaProxy(left) * SCALE),
    Math.max(0, left.points.length - 2),
    Math.round((left.lengthMm - left.edge.distanceMm) * SCALE),
    Math.round(left.edge.gapMm * SCALE),
  ]
  const numericRight = [
    Math.round(right.lengthMm * SCALE),
    Math.round(routedCopperAreaProxy(right) * SCALE),
    Math.max(0, right.points.length - 2),
    Math.round((right.lengthMm - right.edge.distanceMm) * SCALE),
    Math.round(right.edge.gapMm * SCALE),
  ]
  for (let index = 0; index < numericLeft.length; index += 1) {
    if (numericLeft[index] !== numericRight[index]) return numericLeft[index] - numericRight[index]
  }
  const leftKey = `${stableGeometryKey(geometries[left.edge.a])}->${stableGeometryKey(geometries[left.edge.b])}`
  const rightKey = `${stableGeometryKey(geometries[right.edge.a])}->${stableGeometryKey(geometries[right.edge.b])}`
  return leftKey.localeCompare(rightKey)
}

function routedConnectionsForCompactGroup(
  geometries: PadGeometry[],
  obstacles: PadGeometry[],
  bankEnvelopes: PadBankEnvelope[],
  padExpansionRatio: number,
  minimumCorridorWidthMm: number,
  obstacleClearanceMm: number,
  searchBudget: PolygonSearchBudget,
) {
  const groups = compactConnectivityGroups(geometries, bankEnvelopes)
  if (groups.length < 2) return []
  const cache = new Map<string, RoutedEdge | null>()
  const clearanceContext = routedClearanceGateContext(
    geometries,
    obstacles,
    obstacleClearanceMm,
  )
  type RoutedGroupLink = {
    firstGroup: number
    secondGroup: number
    routed: RoutedEdge
  }
  const candidates: RoutedGroupLink[] = []
  const evaluateLink = (link: { firstGroup: number; secondGroup: number }) => {
    let best: RoutedEdge | undefined
    const selectsBankEndpoint = groups[link.firstGroup].length > 1
      || groups[link.secondGroup].length > 1
    for (const first of groups[link.firstGroup]) {
      for (const second of groups[link.secondGroup]) {
        const key = `${first}:${second}`
        let routed = cache.get(key)
        if (routed === undefined) {
          routed = routeEdge(
            geometries,
            obstacles,
            edgeBetween(geometries, first, second),
            padExpansionRatio,
            minimumCorridorWidthMm,
            obstacleClearanceMm,
            searchBudget,
          ) ?? null
          cache.set(key, routed)
        }
        if (!routed) continue
        if (selectsBankEndpoint
          && !routedConnectionAvoidsForeignClearance(routed, clearanceContext)
          // A safe face bridge replaces the constant-width route completely;
          // do not reject it merely because that unused route was too wide.
          && !alignedPadClusterBridge(
            routed,
            geometries,
            obstacles,
            padExpansionRatio,
            minimumCorridorWidthMm,
            obstacleClearanceMm,
          )) continue
        if (!best || compareRoutedCandidates(routed, best, geometries) < 0) best = routed
      }
    }
    if (best) candidates.push({ ...link, routed: best })
  }
  const spanningTree = () => {
    const parent = Array.from({ length: groups.length }, (_, index) => index)
    const find = (value: number): number => parent[value] === value
      ? value
      : (parent[value] = find(parent[value]))
    const selected: RoutedEdge[] = []
    const ordered = [...candidates].sort((left, right) =>
      compareRoutedCandidates(left.routed, right.routed, geometries)
        || left.firstGroup - right.firstGroup
        || left.secondGroup - right.secondGroup)
    for (const candidate of ordered) {
      const firstRoot = find(candidate.firstGroup)
      const secondRoot = find(candidate.secondGroup)
      if (firstRoot === secondRoot) continue
      parent[secondRoot] = firstRoot
      selected.push(candidate.routed)
      if (selected.length === groups.length - 1) return selected
    }
    return undefined
  }

  // A compact intent expresses connectivity, not a hand-authored topology.
  // Consider local cluster pairs by their Euclidean lower bound, route each
  // branch independently around obstacles, and let Kruskal choose the actual
  // routed tree. This avoids preserving a valid but needlessly long edge from
  // the raw pad MST merely because it happened to be considered first.
  const links: Array<{ firstGroup: number; secondGroup: number; distanceMm: number }> = []
  for (let firstGroup = 0; firstGroup < groups.length; firstGroup += 1) {
    for (let secondGroup = firstGroup + 1; secondGroup < groups.length; secondGroup += 1) {
      const distanceMm = Math.min(...groups[firstGroup].flatMap((first) =>
        groups[secondGroup].map((second) => edgeBetween(geometries, first, second).distanceMm)))
      links.push({ firstGroup, secondGroup, distanceMm })
    }
  }
  links.sort((left, right) => left.distanceMm - right.distanceMm
    || left.firstGroup - right.firstGroup
    || left.secondGroup - right.secondGroup)

  let selected: RoutedEdge[] | undefined
  for (let index = 0; index < links.length; index += 1) {
    const { distanceMm: _distanceMm, ...link } = links[index]
    evaluateLink(link)
    selected = spanningTree()
    if (!selected) continue

    // Routed length is the primary edge cost and can never be shorter than
    // the direct endpoint distance. Once the next unseen lower bound is
    // strictly longer than the heaviest selected edge (at engine precision),
    // no unseen branch can improve this tree. This keeps large pad groups
    // lazy without imposing an arbitrary pad-count or neighbour limit.
    const nextDistanceMm = links[index + 1]?.distanceMm
    const maximumSelectedLength = Math.max(...selected.map((route) => route.lengthMm))
    if (nextDistanceMm === undefined
      || Math.round(nextDistanceMm * SCALE) > Math.round(maximumSelectedLength * SCALE)) {
      return selected
    }
  }
  return selected
}

function routedConnectionGeometry(
  routed: RoutedEdge,
  geometries: PadGeometry[],
  obstacles: PadGeometry[],
  padExpansionRatio: number,
  minimumCorridorWidthMm: number,
  obstacleClearanceMm: number,
) {
  const subjects: PcbPoint[][] = []
  const protectedSubjects: PcbPoint[][] = []
  const alignedBridge = alignedPadClusterBridge(
    routed,
    geometries,
    obstacles,
    padExpansionRatio,
    minimumCorridorWidthMm,
    obstacleClearanceMm,
  )
  if (alignedBridge) {
    if (alignedBridge.kind === "bridge") {
      subjects.push(alignedBridge.subject)
      protectedSubjects.push(alignedBridge.protected)
    }
    return { subjects, protectedSubjects }
  }
  const vertexWidths = adaptiveRouteVertexWidths(routed, geometries, padExpansionRatio)
  for (let index = 1; index < routed.points.length; index += 1) {
    const corridor = adaptiveCorridorSegmentRing(
      routed.points[index - 1],
      routed.points[index],
      vertexWidths[index - 1],
      vertexWidths[index],
      routed.segmentBodyWidthsMm[index - 1] ?? routed.widthMm,
    )
    if (corridor) subjects.push(corridor)
    const protectedCorridor = adaptiveCorridorSegmentRing(
      routed.points[index - 1],
      routed.points[index],
      routed.widthMm,
      routed.widthMm,
      routed.widthMm,
    )
    if (protectedCorridor) protectedSubjects.push(protectedCorridor)
  }
  return { subjects, protectedSubjects }
}

function optimizeGroup(
  geometries: PadGeometry[],
  obstacles: PadGeometry[],
  padExpansionRatio: number,
  minimumCorridorWidthMm: number,
  obstacleClearanceMm: number,
  searchBudget: PolygonSearchBudget,
): CompactBoundaryOptimization | undefined {
  const edges = minimumSpanningTree(geometries)
  const bankEnvelopes = padBankEnvelopes(
    geometries,
    obstacles,
    padExpansionRatio,
    minimumCorridorWidthMm,
    obstacleClearanceMm,
  )
  const routes = routedConnectionsForCompactGroup(
    geometries,
    obstacles,
    bankEnvelopes,
    padExpansionRatio,
    minimumCorridorWidthMm,
    obstacleClearanceMm,
    searchBudget,
  )
  if (!routes) return undefined
  const corridorWidthMinMm = routes.length ? Math.min(...routes.map((edge) => edge.widthMm)) : 0
  const corridorBodyWidthMaxMm = routes.length ? Math.max(...routes.map((edge) => edge.bodyWidthMm)) : 0
  const minimumFeatureMm = Math.max(
    corridorWidthMinMm,
    minimumCorridorWidthMm,
  ) * MIN_BOUNDARY_FEATURE_WIDTH_RATIO
  // A future corridor needs copper width plus clearance to the existing zone.
  // Half that span is the morphological radius that closes only narrower bays.
  const pocketClosingRadiusMm = (minimumCorridorWidthMm + obstacleClearanceMm) / 2
  const padSubjects = geometries.flatMap((geometry) => expandedPadRings(geometry, padExpansionRatio))
  const padBankSubjects = bankEnvelopes.map((envelope) => envelope.ring)
  const subjects = [...padSubjects, ...padBankSubjects]
  // Padding is optional copper, not part of the mandatory core. Protect the
  // real pad bodies and minimum-width routes; this lets the regularizer shave
  // overlapping 20%-padding ears without ever losing a target connection.
  const protectedSubjects = [
    ...geometries.map((geometry) => boundsRing(geometryBounds(geometry))),
    ...padBankSubjects,
  ]
  const branchGeometry = routes.map((routed) => {
    const geometry = routedConnectionGeometry(
      routed,
      geometries,
      obstacles,
      padExpansionRatio,
      minimumCorridorWidthMm,
      obstacleClearanceMm,
    )
    subjects.push(...geometry.subjects)
    protectedSubjects.push(...geometry.protectedSubjects)
    return { routed, ...geometry }
  })
  const foreignPadRings = obstacles
    .filter((geometry) => geometry.pad.net !== geometries[0].pad.net)
    .map((geometry) => boundsRing(geometryBounds(geometry)))
  const foreignPadPaths = unionPaths(foreignPadRings.map(toClipper))
  const regularizationWidthMm = Math.max(minimumCorridorWidthMm, corridorWidthMinMm)
  const globallyRegularized = () => unionBoundary(
    subjects,
    protectedSubjects,
    foreignPadRings,
    minimumFeatureMm,
    pocketClosingRadiusMm,
    regularizationWidthMm,
  )
  const unioned = branchGeometry.length <= 1
    ? globallyRegularized()
    : ((() => {
      // Clean each routed branch as the same two-endpoint polygon the caller
      // could have described manually, then perform one plain union. Global
      // morphology on a many-branch tree is both expensive and prone to one
      // branch paying for a shape change elsewhere in the tree.
      const branchBoundaries: PcbPoint[][] = []
      let rawVertexCount = 0
      const filledPocketAreaMm2 = 0
      for (const branch of branchGeometry) {
        const endpointIndexes = [branch.routed.edge.a, branch.routed.edge.b]
        const endpointSubjects = endpointIndexes.flatMap((index) =>
          expandedPadRings(geometries[index], padExpansionRatio))
        const endpointProtected = endpointIndexes.map((index) =>
          boundsRing(geometryBounds(geometries[index])))
        const branchInputs = [...endpointSubjects, ...branch.subjects]
        const baseline = mergeOctilinearBoundaries(branchInputs)
        if (baseline.length !== 1) return undefined
        const cleaned = mergeOctilinearBoundaries(branchInputs, minimumFeatureMm)
        const protectedPaths = unionPaths(
          [...endpointProtected, ...branch.protectedSubjects].map(toClipper),
        )
        const baselinePaths = unionPaths([toClipper(baseline[0])])
        const cleanedPaths = cleaned.length === 1
          ? unionPaths([toClipper(cleaned[0])])
          : []
        const cleanedPreservesCore = cleanedPaths.length === 1
          && clipperPathsAreaMm2(differencePaths(protectedPaths, cleanedPaths)) <= 1e-8
        const cleanedAdded = cleanedPaths.length
          ? differencePaths(cleanedPaths, baselinePaths)
          : []
        const cleanedAvoidsForeignPads = !foreignPadRings.length
          || clipperPathsAreaMm2(intersectPaths(
            cleanedAdded,
            foreignPadPaths,
          )) <= 1e-8
        branchBoundaries.push(cleanedPreservesCore && cleanedAvoidsForeignPads
          ? cleaned[0]
          : baseline[0])
        rawVertexCount += branchInputs.reduce((sum, ring) => sum + ring.length, 0)
      }
      const mergeInputs = [...branchBoundaries, ...padSubjects, ...padBankSubjects]
      const baselineBoundaries = mergeOctilinearBoundaries(mergeInputs)
      if (baselineBoundaries.length !== 1) return undefined
      const cleanedBoundaries = mergeOctilinearBoundaries(mergeInputs, minimumFeatureMm)
      const protectedPaths = unionPaths(protectedSubjects.map(toClipper))
      const baselinePaths = unionPaths([toClipper(baselineBoundaries[0])])
      const cleanedPaths = cleanedBoundaries.length === 1
        ? unionPaths([toClipper(cleanedBoundaries[0])])
        : []
      const cleanedPreservesCore = cleanedPaths.length === 1
        && clipperPathsAreaMm2(differencePaths(protectedPaths, cleanedPaths)) <= 1e-8
      const cleanedAdded = cleanedPaths.length
        ? differencePaths(cleanedPaths, baselinePaths)
        : []
      const cleanedAvoidsForeignPads = !foreignPadPaths.length
        || clipperPathsAreaMm2(intersectPaths(cleanedAdded, foreignPadPaths)) <= 1e-8
      const boundary = cleanedPreservesCore && cleanedAvoidsForeignPads
        ? cleanedBoundaries[0]
        : baselineBoundaries[0]
      return {
        boundary,
        baselineBoundary: baselineBoundaries[0],
        rawVertexCount,
        removedVertexCount: Math.max(0, rawVertexCount - boundary.length),
        filledPocketAreaMm2,
      }
    })() ?? globallyRegularized())
  if (!unioned) return undefined
  const simplifiedUnion = simplifyBoundaryFeatures(unioned.boundary, minimumFeatureMm)
  const baselineUnion = simplifyBoundaryFeatures(unioned.baselineBoundary, minimumFeatureMm)
  const targetPadAreaMm2 = geometries.reduce((sum, geometry) => sum + geometry.areaMm2, 0)
  const envelope = octilinearEnvelope(subjects.flat(), minimumFeatureMm)
  const envelopeAreaMm2 = envelope ? boundaryArea(envelope) : Infinity
  const envelopePaths = envelope ? unionPaths([toClipper(envelope)]) : []
  const protectedCorePaths = unionPaths(protectedSubjects
    .filter((ring) => ring.length >= 3 && boundaryArea(ring) > 1e-9)
    .map(toClipper))
  const foreignPaths = unionPaths(foreignPadRings.map(toClipper))
  const baselinePaths = unionPaths([toClipper(baselineUnion)])
  const envelopePreservesCore = envelopePaths.length === 1
    && clipperPathsAreaMm2(differencePaths(protectedCorePaths, envelopePaths)) <= 1e-8
  const envelopeAddedPaths = envelopePaths.length
    ? differencePaths(envelopePaths, baselinePaths)
    : []
  const envelopeAvoidsForeignPads = !foreignPaths.length
    || clipperPathsAreaMm2(intersectPaths(envelopeAddedPaths, foreignPaths)) <= 1e-8
  const useEnvelope = Boolean(envelope)
    && envelopePreservesCore
    && envelopeAvoidsForeignPads
    && envelope!.length < baselineUnion.length
    && envelopeAreaMm2 / Math.max(1e-9, boundaryArea(baselineUnion)) <= MAX_OCTILINEAR_ENVELOPE_AREA_RATIO
  const boundary = useEnvelope ? envelope! : simplifiedUnion
  if (!isOctilinearBoundary(boundary)) return undefined
  const boundaryAreaMm2 = boundaryArea(boundary)
  return {
    pads: geometries.map((geometry) => geometry.pad),
    boundary,
    strategy: useEnvelope ? "octilinear_envelope" : "mst_corridor",
    // Routing metrics describe the selected inter-cluster connections. The
    // gap metrics below deliberately retain the raw MST values because that
    // is the tree used by maxPadFreeGap to admit or split this target group.
    mstLengthMm: routes.reduce((sum, edge) => sum + edge.edge.distanceMm, 0),
    routedLengthMm: routes.reduce((sum, edge) => sum + edge.lengthMm, 0),
    routeDetourMm: routes.reduce((sum, edge) => sum + edge.lengthMm - edge.edge.distanceMm, 0),
    avoidedObstacleCount: routes.reduce((sum, edge) => sum + edge.avoidedObstacleCount, 0),
    corridorWidthMinMm,
    corridorBodyWidthMaxMm,
    maxPadFreeGapMm: edges.length ? Math.max(...edges.map((edge) => edge.gapMm)) : 0,
    maxPadFreeGapWidths: edges.length ? Math.max(...edges.map((edge) => edge.gapWidths)) : 0,
    targetPadAreaMm2,
    boundaryAreaMm2,
    copperEfficiency: boundaryAreaMm2 > 0 ? Math.min(1, targetPadAreaMm2 / boundaryAreaMm2) : 0,
    angleMode: "octilinear",
    boundaryVertexCount: boundary.length,
    removedVertexCount: Math.max(0, unioned.rawVertexCount - boundary.length),
    minimumFeatureMm,
    pocketClosingRadiusMm,
    filledPocketAreaMm2: unioned.filledPocketAreaMm2,
  }
}

export function optimizeCompactBoundaries(
  pads: PolygonScenePad[],
  ringsFromPad: (pad: PolygonScenePad) => PcbPoint[][],
  obstaclePads: PolygonScenePad[] = [],
  options: {
    maxPadFreeGapWidths?: number
    padExpansionRatio?: number
    minimumCorridorWidthMm?: number
    obstacleClearanceMm?: number
    maxSearchWorkUnits?: number
  } = {},
): CompactBoundaryOptimizationResult {
  const maxPadFreeGapWidths = options.maxPadFreeGapWidths ?? MAX_PAD_FREE_GAP_WIDTHS
  const padExpansionRatio = options.padExpansionRatio ?? PAD_ENVELOPE_EXPANSION_RATIO
  const minimumCorridorWidthMm = options.minimumCorridorWidthMm ?? DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM
  const obstacleClearanceMm = options.obstacleClearanceMm ?? DEFAULT_OBSTACLE_CLEARANCE_MM
  const searchBudget = createPolygonSearchBudget(
    options.maxSearchWorkUnits ?? DEFAULT_MAX_POLYGON_SEARCH_WORK_UNITS,
  )
  const toGeometry = (pad: PolygonScenePad) => {
    const rings = ringsFromPad(pad).filter((ring) => ring.length >= 3)
    const points = rings.flat()
    if (!points.length) return []
    const areaMm2 = rings.reduce((sum, ring) => sum + boundaryArea(ring), 0)
    return [{
      pad,
      points,
      areaMm2,
      characteristicWidthMm: Math.max(1e-6, Math.sqrt(areaMm2)),
    }]
  }
  const geometries = pads.flatMap(toGeometry)
  const obstacles = obstaclePads.flatMap(toGeometry)
  if (geometries.length < 2) {
    return {
      boundaries: [],
      maxPadFreeGapMm: 0,
      maxPadFreeGapWidths: 0,
      isolatedPads: geometries.map((geometry) => ({ pad: geometry.pad, nearestPadFreeGapWidths: Infinity })),
      searchWorkUnits: 0,
    }
  }
  const globalEdges = minimumSpanningTree(geometries)
  const groups = groupsAfterCut(geometries, globalEdges, maxPadFreeGapWidths)
  const boundaries: CompactBoundaryOptimization[] = []
  const isolatedPads: CompactBoundaryOptimizationResult["isolatedPads"] = []
  const addIsolated = (geometry: PadGeometry, peers: PadGeometry[]) => {
    const nearestPadFreeGapWidths = peers
      .filter((peer) => peer !== geometry)
      .reduce((nearest, peer) => Math.min(nearest, edgeBetween([geometry, peer], 0, 1).gapWidths), Infinity)
    isolatedPads.push({ pad: geometry.pad, nearestPadFreeGapWidths })
  }
  try {
    for (const group of groups) {
      const members = group.map((index) => geometries[index])
      if (members.length < 2) {
        addIsolated(members[0], geometries)
        continue
      }
      const optimized = optimizeGroup(
        members,
        obstacles,
        padExpansionRatio,
        minimumCorridorWidthMm,
        obstacleClearanceMm,
        searchBudget,
      )
      if (optimized) {
        boundaries.push(optimized)
      } else {
        for (const geometry of members) addIsolated(geometry, members)
      }
    }
  } catch (error) {
    if (!(error instanceof PolygonSearchBudgetExceeded)) throw error
    return {
      boundaries: [],
      maxPadFreeGapMm: globalEdges.length ? Math.max(...globalEdges.map((edge) => edge.gapMm)) : 0,
      maxPadFreeGapWidths: globalEdges.length ? Math.max(...globalEdges.map((edge) => edge.gapWidths)) : 0,
      isolatedPads: [],
      searchWorkUnits: searchBudget.usedWorkUnits,
      failure: {
        code: error.code,
        message: `polygon search reached its deterministic ${error.maxWorkUnits}-unit limit while ${error.operation}`,
        usedWorkUnits: error.usedWorkUnits,
        maxWorkUnits: error.maxWorkUnits,
        operation: error.operation,
      },
    }
  }
  return {
    boundaries,
    maxPadFreeGapMm: globalEdges.length ? Math.max(...globalEdges.map((edge) => edge.gapMm)) : 0,
    maxPadFreeGapWidths: globalEdges.length ? Math.max(...globalEdges.map((edge) => edge.gapWidths)) : 0,
    isolatedPads,
    searchWorkUnits: searchBudget.usedWorkUnits,
  }
}
