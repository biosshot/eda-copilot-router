import {
  boardOutline
} from "./chunk-HGTCHW7P.js";
import {
  atom,
  childText,
  findChild,
  footprintAt,
  footprintLayer,
  footprintReference,
  isSExpressionList,
  listChildren,
  listHead,
  padNet,
  padNumber,
  pcbFootprints,
  token
} from "./chunk-L7USXWVD.js";

// src/polygon/boundary-optimizer.ts
import ClipperLib from "clipper-lib";
var SCALE = 1e6;
var MAX_PAD_FREE_GAP_WIDTHS = 4.5;
var PAD_ENVELOPE_EXPANSION_RATIO = 0.2;
var DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM = 0.2;
var DEFAULT_OBSTACLE_CLEARANCE_MM = 0.2;
var MIN_BOUNDARY_FEATURE_WIDTH_RATIO = 0.12;
var MAX_OCTILINEAR_ENVELOPE_AREA_RATIO = 1.12;
var MAX_ADAPTIVE_CORRIDOR_WIDTH_RATIO = 2.5;
var MAX_REGULARIZED_AREA_RATIO = 1.02;
var MIN_REGULARIZED_AREA_RATIO = 0.98;
var POCKET_RADIUS_MULTIPLIERS = [1, 2, 3];
var MAX_SHORT_FEATURE_CLEANUP_ASPECT_RATIO = 10;
var ADAPTIVE_WIDTH_SEARCH_STEPS = 14;
var DEFAULT_MIN_BANK_CONNECTIVITY_NECK_MM = 0.1;
function signedArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}
function boundaryArea(points) {
  return Math.abs(signedArea(points));
}
function normalizeRing(points) {
  const ring = points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    return Math.hypot(point.x - previous.x, point.y - previous.y) > 1e-9;
  });
  return signedArea(ring) < 0 ? [...ring].reverse() : ring;
}
function toClipper(points) {
  return normalizeRing(points).map((point) => ({ X: Math.round(point.x * SCALE), Y: Math.round(point.y * SCALE) }));
}
function fromClipper(path) {
  return path.map((point) => ({ x: point.X / SCALE, y: point.Y / SCALE }));
}
var ANGLE_TOLERANCE_MM = 2 / SCALE;
function segmentIsOctilinear(first, second) {
  const dx = Math.abs(second.x - first.x);
  const dy = Math.abs(second.y - first.y);
  return dx <= ANGLE_TOLERANCE_MM || dy <= ANGLE_TOLERANCE_MM || Math.abs(dx - dy) <= ANGLE_TOLERANCE_MM;
}
function isOctilinearBoundary(points) {
  return points.length >= 3 && points.every((point, index) => segmentIsOctilinear(point, points[(index + 1) % points.length]));
}
function simplifyCollinear(points) {
  let simplified = normalizeRing(points);
  let changed = true;
  while (changed && simplified.length > 3) {
    changed = false;
    const next = simplified.filter((current, index) => {
      const previous = simplified[(index + simplified.length - 1) % simplified.length];
      const following = simplified[(index + 1) % simplified.length];
      const cross = (current.x - previous.x) * (following.y - current.y) - (current.y - previous.y) * (following.x - current.x);
      const scale = Math.max(
        1,
        Math.hypot(current.x - previous.x, current.y - previous.y),
        Math.hypot(following.x - current.x, following.y - current.y)
      );
      if (Math.abs(cross) <= ANGLE_TOLERANCE_MM * scale) {
        changed = true;
        return false;
      }
      return true;
    });
    if (next.length >= 3) simplified = next;
  }
  return simplified;
}
function lineIntersection(a, b, c, d) {
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const cd = { x: d.x - c.x, y: d.y - c.y };
  const determinant = ab.x * cd.y - ab.y * cd.x;
  if (Math.abs(determinant) < 1e-12) return void 0;
  const ac = { x: c.x - a.x, y: c.y - a.y };
  const t = (ac.x * cd.y - ac.y * cd.x) / determinant;
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}
function collapseShortEdges(points, minimumFeatureMm, maximumCleanupAreaChangeMm2 = minimumFeatureMm * minimumFeatureMm * MAX_SHORT_FEATURE_CLEANUP_ASPECT_RATIO) {
  let collapsed = points;
  const cleanupSnapDistanceMm = minimumFeatureMm * 1.5;
  let changed = true;
  while (changed && collapsed.length > 4) {
    changed = false;
    for (let index = 0; index < collapsed.length; index += 1) {
      const nextIndex = (index + 1) % collapsed.length;
      const length = Math.hypot(
        collapsed[nextIndex].x - collapsed[index].x,
        collapsed[nextIndex].y - collapsed[index].y
      );
      if (length >= minimumFeatureMm) continue;
      const rotated = [...collapsed.slice(index), ...collapsed.slice(0, index)];
      const intersection = lineIntersection(rotated.at(-1), rotated[0], rotated[1], rotated[2]);
      const candidates = [];
      if (intersection && Math.hypot(intersection.x - rotated[0].x, intersection.y - rotated[0].y) <= cleanupSnapDistanceMm && Math.hypot(intersection.x - rotated[1].x, intersection.y - rotated[1].y) <= cleanupSnapDistanceMm) {
        candidates.push(simplifyCollinear([intersection, ...rotated.slice(2)]));
      }
      if (rotated.length >= 6) {
        const backward = lineIntersection(
          rotated.at(-2),
          rotated.at(-1),
          rotated[1],
          rotated[2]
        );
        if (backward && Math.hypot(backward.x - rotated.at(-1).x, backward.y - rotated.at(-1).y) <= cleanupSnapDistanceMm) {
          candidates.push(simplifyCollinear([backward, ...rotated.slice(2, -1)]));
        }
        const forward = lineIntersection(
          rotated.at(-1),
          rotated[0],
          rotated[2],
          rotated[3]
        );
        if (forward && Math.hypot(forward.x - rotated[2].x, forward.y - rotated[2].y) <= cleanupSnapDistanceMm) {
          candidates.push(simplifyCollinear([forward, ...rotated.slice(3)]));
        }
      }
      const currentAreaMm2 = boundaryArea(collapsed);
      const candidate = candidates.filter((item) => item.length >= 3 && isOctilinearBoundary(item) && Math.abs(boundaryArea(item) - currentAreaMm2) <= maximumCleanupAreaChangeMm2 + 1e-9).sort((left, right) => Math.abs(boundaryArea(left) - currentAreaMm2) - Math.abs(boundaryArea(right) - currentAreaMm2))[0];
      if (candidate) {
        collapsed = candidate;
        changed = true;
        break;
      }
    }
  }
  return collapsed;
}
function simplifyBoundaryFeatures(points, minimumFeatureMm, maximumCleanupAreaChangeMm2) {
  return collapseShortEdges(points, minimumFeatureMm, maximumCleanupAreaChangeMm2);
}
function octilinearEnvelope(points, minimumFeatureMm) {
  if (points.length < 3) return void 0;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const sums = points.map((point) => point.x + point.y);
  const differences = points.map((point) => point.x - point.y);
  const constraints = [
    { a: 1, b: 0, c: Math.max(...xs) },
    { a: -1, b: 0, c: -Math.min(...xs) },
    { a: 0, b: 1, c: Math.max(...ys) },
    { a: 0, b: -1, c: -Math.min(...ys) },
    { a: 1, b: 1, c: Math.max(...sums) },
    { a: -1, b: -1, c: -Math.min(...sums) },
    { a: 1, b: -1, c: Math.max(...differences) },
    { a: -1, b: 1, c: -Math.min(...differences) }
  ];
  const candidates = [];
  for (let left = 0; left < constraints.length; left += 1) {
    for (let right = left + 1; right < constraints.length; right += 1) {
      const first = constraints[left];
      const second = constraints[right];
      const determinant = first.a * second.b - second.a * first.b;
      if (Math.abs(determinant) < 1e-12) continue;
      const point = {
        x: (first.c * second.b - second.c * first.b) / determinant,
        y: (first.a * second.c - second.a * first.c) / determinant
      };
      if (constraints.every((constraint) => constraint.a * point.x + constraint.b * point.y <= constraint.c + ANGLE_TOLERANCE_MM)) {
        if (!candidates.some((candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) <= ANGLE_TOLERANCE_MM)) {
          candidates.push(point);
        }
      }
    }
  }
  if (candidates.length < 3) return void 0;
  const center = {
    x: candidates.reduce((sum, point) => sum + point.x, 0) / candidates.length,
    y: candidates.reduce((sum, point) => sum + point.y, 0) / candidates.length
  };
  const envelope = collapseShortEdges(simplifyCollinear(candidates.sort((first, second) => Math.atan2(first.y - center.y, first.x - center.x) - Math.atan2(second.y - center.y, second.x - center.x))), minimumFeatureMm);
  return isOctilinearBoundary(envelope) ? envelope : void 0;
}
function offsetPaths(paths, deltaMm) {
  const offsetter = new ClipperLib.ClipperOffset(3, 0.25 * SCALE);
  offsetter.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const result = new ClipperLib.Paths();
  offsetter.Execute(result, deltaMm * SCALE);
  return result;
}
function clipPaths(subjects, clips, clipType) {
  if (!subjects.length) return [];
  const clipper = new ClipperLib.Clipper();
  clipper.StrictlySimple = true;
  clipper.AddPaths(subjects, ClipperLib.PolyType.ptSubject, true);
  if (clips.length) clipper.AddPaths(clips, ClipperLib.PolyType.ptClip, true);
  const solution = new ClipperLib.Paths();
  clipper.Execute(
    clipType,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return solution;
}
function unionPaths(paths) {
  return clipPaths(paths, [], ClipperLib.ClipType.ctUnion);
}
function differencePaths(subjects, clips) {
  return clips.length ? clipPaths(subjects, clips, ClipperLib.ClipType.ctDifference) : subjects;
}
function intersectPaths(subjects, clips) {
  return subjects.length && clips.length ? clipPaths(subjects, clips, ClipperLib.ClipType.ctIntersection) : [];
}
function clipperPathsAreaMm2(paths) {
  return paths.reduce((sum, path) => sum + Math.abs(ClipperLib.Clipper.Area(path)) / (SCALE * SCALE), 0);
}
function boundaryPerimeterMm(points) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + Math.hypot(next.x - point.x, next.y - point.y);
  }, 0);
}
function reflexVertexCount(points) {
  const orientation = Math.sign(signedArea(points)) || 1;
  return points.filter((current, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    const cross = (current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x);
    return cross * orientation < -1e-9;
  }).length;
}
function canonicalizeNearlyOctilinear(points, toleranceMm) {
  const lineForEdge = (first, second) => {
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    if (Math.abs(dx) <= toleranceMm) return { a: 1, b: 0, c: (first.x + second.x) / 2 };
    if (Math.abs(dy) <= toleranceMm) return { a: 0, b: 1, c: (first.y + second.y) / 2 };
    if (Math.abs(Math.abs(dx) - Math.abs(dy)) > toleranceMm) return void 0;
    if (dx * dy > 0) {
      return { a: -1, b: 1, c: (first.y - first.x + (second.y - second.x)) / 2 };
    }
    return { a: 1, b: 1, c: (first.x + first.y + (second.x + second.y)) / 2 };
  };
  const lines = points.map((point, index) => lineForEdge(point, points[(index + 1) % points.length]));
  if (lines.some((line) => !line)) return void 0;
  const snapped = points.map((point, index) => {
    const previous = lines[(index + lines.length - 1) % lines.length];
    const current = lines[index];
    const determinant = previous.a * current.b - current.a * previous.b;
    if (Math.abs(determinant) < 1e-12) return void 0;
    const candidate = {
      x: (previous.c * current.b - current.c * previous.b) / determinant,
      y: (previous.a * current.c - current.a * previous.c) / determinant
    };
    return Math.hypot(candidate.x - point.x, candidate.y - point.y) <= toleranceMm * 2 ? candidate : void 0;
  });
  if (snapped.some((point) => !point)) return void 0;
  const canonical = simplifyCollinear(snapped);
  return isOctilinearBoundary(canonical) ? canonical : void 0;
}
function cleanOctilinearBoundaries(paths, minimumFeatureMm, cleanupScaleMm = minimumFeatureMm) {
  const snapToleranceMm = Math.max(ANGLE_TOLERANCE_MM, Math.min(0.01, minimumFeatureMm / 4));
  const maximumCleanupAreaChangeMm2 = minimumFeatureMm * Math.max(minimumFeatureMm, cleanupScaleMm) * 2;
  return paths.map((path) => (
    // Larger CleanPolygon tolerances can replace an octilinear corner chain
    // with one arbitrary-angle chord. Remove only integer-rounding noise;
    // feature cleanup below owns the physical minimum-feature policy.
    ClipperLib.Clipper.CleanPolygon(path, 2)
  )).map(fromClipper).map(simplifyCollinear).map((ring) => canonicalizeNearlyOctilinear(ring, snapToleranceMm) ?? ring).map((ring) => simplifyBoundaryFeatures(
    ring,
    minimumFeatureMm,
    maximumCleanupAreaChangeMm2
  )).filter((ring) => ring.length >= 3 && isOctilinearBoundary(ring)).sort((a, b) => boundaryArea(b) - boundaryArea(a));
}
function unionBoundary(rings, protectedRings, foreignPadRings, minimumFeatureMm, pocketClosingRadiusMm, regularizationWidthMm) {
  const paths = rings.filter((ring) => ring.length >= 3 && boundaryArea(ring) > 1e-9).map(toClipper);
  if (!paths.length) return void 0;
  const solution = unionPaths(paths);
  const raw = solution.map(fromClipper).map(simplifyCollinear).filter((ring) => ring.length >= 3).sort((a, b) => boundaryArea(b) - boundaryArea(a));
  if (!raw.length) return void 0;
  const rawAreaMm2 = boundaryArea(raw[0]);
  const protectedPaths = unionPaths(protectedRings.filter((ring) => ring.length >= 3 && boundaryArea(ring) > 1e-9).map(toClipper));
  if (protectedPaths.length !== 1) return void 0;
  const foreignPaths = unionPaths(foreignPadRings.filter((ring) => ring.length >= 3 && boundaryArea(ring) > 1e-9).map(toClipper));
  const baseBoundary = cleanOctilinearBoundaries(
    solution,
    minimumFeatureMm,
    regularizationWidthMm
  )[0] ?? raw[0];
  const basePaths = unionPaths([toClipper(baseBoundary), ...protectedPaths]);
  const canonicalBaseBoundary = cleanOctilinearBoundaries(
    basePaths,
    minimumFeatureMm,
    regularizationWidthMm
  )[0] ?? baseBoundary;
  const baseAreaMm2 = boundaryArea(canonicalBaseBoundary);
  const basePerimeterMm = boundaryPerimeterMm(canonicalBaseBoundary);
  const compactnessScaleMm = Math.max(minimumFeatureMm, regularizationWidthMm);
  const baseEnergy = baseAreaMm2 + compactnessScaleMm * basePerimeterMm;
  let filteredPaths = basePaths;
  let bestBoundary = canonicalBaseBoundary;
  let bestEnergy = baseEnergy;
  const candidateIsSafe = (candidatePaths) => {
    const normalized = unionPaths(candidatePaths);
    const boundaries = cleanOctilinearBoundaries(
      normalized,
      minimumFeatureMm,
      regularizationWidthMm
    );
    if (boundaries.length !== 1) return void 0;
    const boundary2 = boundaries[0];
    const areaMm2 = boundaryArea(boundary2);
    const areaRatio = areaMm2 / Math.max(1e-9, baseAreaMm2);
    if (areaRatio < MIN_REGULARIZED_AREA_RATIO - 1e-9 || areaRatio > MAX_REGULARIZED_AREA_RATIO + 1e-9) return void 0;
    if (protectedPaths.length && clipperPathsAreaMm2(differencePaths(protectedPaths, normalized)) > 1e-8) return void 0;
    const added = differencePaths(normalized, basePaths);
    if (foreignPaths.length && clipperPathsAreaMm2(intersectPaths(added, foreignPaths)) > 1e-8) return void 0;
    const perimeterMm = boundaryPerimeterMm(boundary2);
    if (perimeterMm > basePerimeterMm - minimumFeatureMm + 1e-9) return void 0;
    const energy = areaMm2 + compactnessScaleMm * perimeterMm;
    if (energy >= baseEnergy - minimumFeatureMm * minimumFeatureMm) return void 0;
    return { normalized, boundary: boundary2, energy, areaMm2 };
  };
  const radii = [...new Set([
    ...POCKET_RADIUS_MULTIPLIERS.map((multiplier) => pocketClosingRadiusMm * multiplier),
    regularizationWidthMm / 2
  ].filter((radius) => radius > minimumFeatureMm / 2).map((radius) => Number(radius.toFixed(6))))].sort((a, b) => a - b);
  const consider = (candidatePaths) => {
    const candidate = candidateIsSafe(candidatePaths);
    if (!candidate) return;
    if (candidate.energy < bestEnergy - 1e-9 || Math.abs(candidate.energy - bestEnergy) <= 1e-9 && candidate.areaMm2 < boundaryArea(bestBoundary)) {
      filteredPaths = candidate.normalized;
      bestBoundary = candidate.boundary;
      bestEnergy = candidate.energy;
    }
  };
  for (const radiusMm of radii) {
    const expanded = offsetPaths(basePaths, radiusMm);
    if (expanded.length) {
      const closed = offsetPaths(expanded, -radiusMm);
      if (closed.length) {
        const extensiveClosed = unionPaths([...basePaths, ...closed]);
        consider(extensiveClosed);
        const closedInset = offsetPaths(closed, -radiusMm);
        if (closedInset.length) {
          const closedThenOpened = offsetPaths(closedInset, radiusMm);
          if (closedThenOpened.length) consider(unionPaths([
            ...closedThenOpened,
            ...protectedPaths
          ]));
        }
      }
    }
    const openingRadiusMm = radiusMm / 2;
    const inset = offsetPaths(basePaths, -openingRadiusMm);
    if (!inset.length) continue;
    const opened = offsetPaths(inset, openingRadiusMm);
    if (!opened.length) continue;
    const coreRestored = unionPaths([
      ...intersectPaths(opened, basePaths),
      ...protectedPaths
    ]);
    consider(coreRestored);
    const reopenedExpanded = offsetPaths(coreRestored, radiusMm);
    if (reopenedExpanded.length) {
      const openedThenClosed = offsetPaths(reopenedExpanded, -radiusMm);
      if (openedThenClosed.length) consider(unionPaths([
        ...openedThenClosed,
        ...protectedPaths
      ]));
    }
  }
  const MAX_SHORTCUT_PASSES = 1;
  const MAX_SHORTCUT_REMOVED_EDGES = 8;
  const MAX_SHORTCUT_CLIPPER_CHECKS_PER_PASS = 2;
  const needsLargeFeatureRegularization = bestBoundary.length >= 10 && reflexVertexCount(bestBoundary) >= 3;
  for (let pass = 0; needsLargeFeatureRegularization && pass < MAX_SHORTCUT_PASSES; pass += 1) {
    const passBoundary = bestBoundary;
    const energyBeforePass = bestEnergy;
    const shortcutCandidates = /* @__PURE__ */ new Map();
    for (let removedEdgeCount = 2; removedEdgeCount < passBoundary.length - 1 && removedEdgeCount <= MAX_SHORTCUT_REMOVED_EDGES; removedEdgeCount += 1) {
      for (let startIndex = 0; startIndex < passBoundary.length; startIndex += 1) {
        const rotated = [
          ...passBoundary.slice(startIndex),
          ...passBoundary.slice(0, startIndex)
        ];
        const removedChain = rotated.slice(0, removedEdgeCount + 1);
        const removedLengthMm = polylineLength(removedChain);
        for (const shortcut of octilinearCandidates(rotated[0], rotated[removedEdgeCount])) {
          if (polylineLength(shortcut) > removedLengthMm - minimumFeatureMm + 1e-9) continue;
          const candidateBoundary = simplifyCollinear([
            ...shortcut.slice(0, -1),
            ...rotated.slice(removedEdgeCount)
          ]);
          if (candidateBoundary.length < 3 || !isOctilinearBoundary(candidateBoundary)) continue;
          const candidateAreaMm2 = boundaryArea(candidateBoundary);
          const areaRatio = candidateAreaMm2 / Math.max(1e-9, baseAreaMm2);
          if (areaRatio < MIN_REGULARIZED_AREA_RATIO - 1e-9 || areaRatio > MAX_REGULARIZED_AREA_RATIO + 1e-9) continue;
          const candidatePerimeterMm = boundaryPerimeterMm(candidateBoundary);
          if (candidatePerimeterMm > basePerimeterMm - minimumFeatureMm + 1e-9) continue;
          const candidateEnergy = candidateAreaMm2 + compactnessScaleMm * candidatePerimeterMm;
          if (candidateEnergy >= bestEnergy - minimumFeatureMm * minimumFeatureMm) continue;
          const key = candidateBoundary.map((point) => `${point.x.toFixed(6)},${point.y.toFixed(6)}`).join(";");
          const previous = shortcutCandidates.get(key);
          if (!previous || candidateEnergy < previous.energy) {
            shortcutCandidates.set(key, {
              boundary: candidateBoundary,
              energy: candidateEnergy
            });
          }
        }
      }
    }
    const shortlisted = [...shortcutCandidates.values()].sort((left, right) => left.energy - right.energy).slice(0, MAX_SHORTCUT_CLIPPER_CHECKS_PER_PASS);
    for (const candidate of shortlisted) {
      consider([toClipper(candidate.boundary)]);
    }
    if (bestEnergy >= energyBeforePass - minimumFeatureMm * minimumFeatureMm) break;
  }
  const filtered = cleanOctilinearBoundaries(
    filteredPaths,
    minimumFeatureMm,
    regularizationWidthMm
  );
  const boundary = filtered[0] ?? raw.find(isOctilinearBoundary);
  if (!boundary) return void 0;
  return {
    boundary,
    baselineBoundary: raw[0],
    rawVertexCount: raw[0].length,
    removedVertexCount: Math.max(0, raw[0].length - boundary.length),
    filledPocketAreaMm2: Math.max(0, boundaryArea(boundary) - rawAreaMm2)
  };
}
function mergeOctilinearBoundaries(rings, minimumFeatureMm = 0) {
  const paths = rings.filter((ring) => ring.length >= 3 && boundaryArea(ring) > 1e-9).map(toClipper);
  if (!paths.length) return [];
  const clipper = new ClipperLib.Clipper();
  clipper.StrictlySimple = true;
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const solution = new ClipperLib.Paths();
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return solution.map((path) => ClipperLib.Clipper.CleanPolygon(path, 2)).map(fromClipper).map(simplifyCollinear).map((ring) => minimumFeatureMm > 0 ? simplifyBoundaryFeatures(ring, minimumFeatureMm) : ring).filter((ring) => ring.length >= 3 && isOctilinearBoundary(ring)).sort((left, right) => boundaryArea(right) - boundaryArea(left));
}
function projectionWidth(points, normal) {
  const values = points.map((point) => point.x * normal.x + point.y * normal.y);
  return Math.max(...values) - Math.min(...values);
}
function support(points, center, direction) {
  return Math.max(...points.map((point) => (point.x - center.x) * direction.x + (point.y - center.y) * direction.y));
}
function edgeBetween(geometries, a, b) {
  const first = geometries[a];
  const second = geometries[b];
  const dx = second.pad.x - first.pad.x;
  const dy = second.pad.y - first.pad.y;
  const distanceMm = Math.hypot(dx, dy);
  if (distanceMm < 1e-9) {
    const width = Math.min(first.characteristicWidthMm, second.characteristicWidthMm);
    return {
      a,
      b,
      distanceMm: 0,
      gapMm: 0,
      gapWidths: 0,
      bottleneckWidthMm: width,
      widthAtAMm: width,
      widthAtBMm: width
    };
  }
  const direction = { x: dx / distanceMm, y: dy / distanceMm };
  const normal = { x: -direction.y, y: direction.x };
  const widthAtAMm = Math.max(1e-6, projectionWidth(first.points, normal));
  const widthAtBMm = Math.max(1e-6, projectionWidth(second.points, normal));
  const bottleneckWidthMm = Math.max(1e-6, Math.min(widthAtAMm, widthAtBMm));
  const gapMm = Math.max(0, distanceMm - support(first.points, first.pad, direction) - support(second.points, second.pad, { x: -direction.x, y: -direction.y }));
  return {
    a,
    b,
    distanceMm,
    gapMm,
    gapWidths: gapMm / bottleneckWidthMm,
    bottleneckWidthMm,
    widthAtAMm,
    widthAtBMm
  };
}
function minimumSpanningTree(geometries) {
  if (geometries.length < 2) return [];
  const visited = /* @__PURE__ */ new Set([0]);
  const edges = [];
  while (visited.size < geometries.length) {
    let best;
    for (const a of visited) {
      for (let b = 0; b < geometries.length; b += 1) {
        if (visited.has(b)) continue;
        const candidate = edgeBetween(geometries, a, b);
        if (!best || candidate.gapWidths < best.gapWidths - 1e-9 || Math.abs(candidate.gapWidths - best.gapWidths) < 1e-9 && candidate.distanceMm < best.distanceMm) {
          best = candidate;
        }
      }
    }
    if (!best) break;
    visited.add(best.b);
    edges.push(best);
  }
  return edges;
}
function groupsAfterCut(geometries, edges, maxPadFreeGapWidths) {
  const parent = geometries.map((_, index) => index);
  const find = (value) => parent[value] === value ? value : parent[value] = find(parent[value]);
  const join = (a, b) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent[right] = left;
  };
  for (const edge of edges) {
    if (edge.gapWidths <= maxPadFreeGapWidths) join(edge.a, edge.b);
  }
  const groups = /* @__PURE__ */ new Map();
  for (let index = 0; index < geometries.length; index += 1) {
    const root = find(index);
    groups.set(root, [...groups.get(root) ?? [], index]);
  }
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}
function adaptiveCorridorSegmentRing(first, second, startWidthMm, endWidthMm, desiredBodyWidthMm) {
  const distanceMm = Math.hypot(second.x - first.x, second.y - first.y);
  if (distanceMm < 1e-9) return void 0;
  const direction = { x: (second.x - first.x) / distanceMm, y: (second.y - first.y) / distanceMm };
  const normal = { x: -direction.y, y: direction.x };
  const startHalf = startWidthMm / 2;
  const endHalf = endWidthMm / 2;
  const feasibleBodyHalf = (distanceMm + startHalf + endHalf) / 2;
  const bodyHalf = Math.max(
    startHalf,
    endHalf,
    Math.min(desiredBodyWidthMm / 2, feasibleBodyHalf)
  );
  const startFlareMm = Math.max(0, bodyHalf - startHalf);
  const endFlareMm = Math.max(0, bodyHalf - endHalf);
  const upperStart = { x: first.x + normal.x * startHalf, y: first.y + normal.y * startHalf };
  const upperBodyStart = {
    x: first.x + direction.x * startFlareMm + normal.x * bodyHalf,
    y: first.y + direction.y * startFlareMm + normal.y * bodyHalf
  };
  const upperBodyEnd = {
    x: second.x - direction.x * endFlareMm + normal.x * bodyHalf,
    y: second.y - direction.y * endFlareMm + normal.y * bodyHalf
  };
  const upperEnd = { x: second.x + normal.x * endHalf, y: second.y + normal.y * endHalf };
  const lowerEnd = { x: second.x - normal.x * endHalf, y: second.y - normal.y * endHalf };
  const lowerBodyEnd = {
    x: second.x - direction.x * endFlareMm - normal.x * bodyHalf,
    y: second.y - direction.y * endFlareMm - normal.y * bodyHalf
  };
  const lowerBodyStart = {
    x: first.x + direction.x * startFlareMm - normal.x * bodyHalf,
    y: first.y + direction.y * startFlareMm - normal.y * bodyHalf
  };
  const lowerStart = { x: first.x - normal.x * startHalf, y: first.y - normal.y * startHalf };
  return simplifyCollinear([
    upperStart,
    upperBodyStart,
    upperBodyEnd,
    upperEnd,
    lowerEnd,
    lowerBodyEnd,
    lowerBodyStart,
    lowerStart
  ]);
}
function expandedPadRings(geometry, padExpansionRatio) {
  const bounds = geometryBounds(geometry);
  const xPadding = (bounds.right - bounds.left) * padExpansionRatio / 2;
  const yPadding = (bounds.bottom - bounds.top) * padExpansionRatio / 2;
  return [[
    { x: bounds.left - xPadding, y: bounds.top - yPadding },
    { x: bounds.right + xPadding, y: bounds.top - yPadding },
    { x: bounds.right + xPadding, y: bounds.bottom + yPadding },
    { x: bounds.left - xPadding, y: bounds.bottom + yPadding }
  ]];
}
function padBankPairAxis(first, second, padExpansionRatio, minimumCorridorWidthMm, obstacleClearanceMm) {
  if (!first.pad.component || first.pad.component !== second.pad.component) return void 0;
  const firstBounds = geometryBounds(first);
  const secondBounds = geometryBounds(second);
  const firstExpanded = geometryBounds({
    ...first,
    points: expandedPadRings(first, padExpansionRatio)[0]
  });
  const secondExpanded = geometryBounds({
    ...second,
    points: expandedPadRings(second, padExpansionRatio)[0]
  });
  const firstWidth = firstBounds.right - firstBounds.left;
  const secondWidth = secondBounds.right - secondBounds.left;
  const firstHeight = firstBounds.bottom - firstBounds.top;
  const secondHeight = secondBounds.bottom - secondBounds.top;
  const ratio = (left, right) => Math.max(left, right) / Math.max(1e-9, Math.min(left, right));
  if (ratio(firstWidth, secondWidth) > 1.25 || ratio(firstHeight, secondHeight) > 1.25) return void 0;
  const axisGap = (firstLow, firstHigh, secondLow, secondHigh) => {
    if (firstHigh < secondLow) return secondLow - firstHigh;
    if (secondHigh < firstLow) return firstLow - secondHigh;
    return 0;
  };
  const maximumBankGapMm = minimumCorridorWidthMm + obstacleClearanceMm * 2;
  const rowAligned = Math.abs(first.pad.y - second.pad.y) <= Math.min(firstHeight, secondHeight) * 0.1 + ANGLE_TOLERANCE_MM;
  const columnAligned = Math.abs(first.pad.x - second.pad.x) <= Math.min(firstWidth, secondWidth) * 0.1 + ANGLE_TOLERANCE_MM;
  if (rowAligned && axisGap(
    firstExpanded.left,
    firstExpanded.right,
    secondExpanded.left,
    secondExpanded.right
  ) <= maximumBankGapMm + 1e-9) return "row";
  if (columnAligned && axisGap(
    firstExpanded.top,
    firstExpanded.bottom,
    secondExpanded.top,
    secondExpanded.bottom
  ) <= maximumBankGapMm + 1e-9) return "column";
  return void 0;
}
function padBankEnvelopes(geometries, obstacles, padExpansionRatio, minimumCorridorWidthMm, obstacleClearanceMm) {
  if (geometries.length < 2) return [];
  const expandedBounds = geometries.map((geometry) => {
    const ring = expandedPadRings(geometry, padExpansionRatio)[0];
    return {
      left: Math.min(...ring.map((point) => point.x)),
      right: Math.max(...ring.map((point) => point.x)),
      top: Math.min(...ring.map((point) => point.y)),
      bottom: Math.max(...ring.map((point) => point.y))
    };
  });
  const groupsForAxis = (axis) => {
    const parent = geometries.map((_, index) => index);
    const find = (value) => parent[value] === value ? value : parent[value] = find(parent[value]);
    const join = (left, right) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
    };
    for (let left = 0; left < geometries.length; left += 1) {
      for (let right = left + 1; right < geometries.length; right += 1) {
        if (padBankPairAxis(
          geometries[left],
          geometries[right],
          padExpansionRatio,
          minimumCorridorWidthMm,
          obstacleClearanceMm
        ) === axis) join(left, right);
      }
    }
    const groups2 = /* @__PURE__ */ new Map();
    for (let index = 0; index < geometries.length; index += 1) {
      const root = find(index);
      groups2.set(root, [...groups2.get(root) ?? [], index]);
    }
    return [...groups2.values()].filter((group) => group.length >= 2);
  };
  const groups = [...groupsForAxis("row"), ...groupsForAxis("column")];
  const foreignBounds = obstacles.filter((geometry) => geometry.pad.net !== geometries[0].pad.net).map(geometryBounds);
  const overlapsWithArea = (left, right) => Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1e-9 && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1e-9;
  const envelopes = groups.map((members) => ({
    members,
    bounds: {
      left: Math.min(...members.map((index) => expandedBounds[index].left)),
      right: Math.max(...members.map((index) => expandedBounds[index].right)),
      top: Math.min(...members.map((index) => expandedBounds[index].top)),
      bottom: Math.max(...members.map((index) => expandedBounds[index].bottom))
    }
  })).filter(({ bounds }) => !foreignBounds.some((foreign) => overlapsWithArea(bounds, foreign)));
  const unique = /* @__PURE__ */ new Map();
  for (const envelope of envelopes) {
    const key = `${envelope.bounds.left.toFixed(9)}:${envelope.bounds.right.toFixed(9)}:${envelope.bounds.top.toFixed(9)}:${envelope.bounds.bottom.toFixed(9)}`;
    const existing = unique.get(key);
    if (existing) {
      for (const member of envelope.members) existing.members.add(member);
    } else {
      unique.set(key, { members: new Set(envelope.members), bounds: envelope.bounds });
    }
  }
  const foreignClearancePaths = foreignBounds.map((bounds) => toClipper(boundsRing(inflateBounds(bounds, obstacleClearanceMm + 2 / SCALE))));
  return [...unique.values()].map(({ members, bounds }) => {
    const orderedMembers = [...members].sort((left, right) => left - right);
    const rawMemberPaths = orderedMembers.map((member) => toClipper(boundsRing(geometryBounds(geometries[member]))));
    const clearanceCut = differencePaths(
      [toClipper(boundsRing(bounds))],
      foreignClearancePaths
    );
    const requiredNeckMm = Math.min(
      DEFAULT_MIN_BANK_CONNECTIVITY_NECK_MM,
      minimumCorridorWidthMm
    );
    const robustClearanceCut = requiredNeckMm > 1e-9 ? offsetPaths(offsetPaths(clearanceCut, -requiredNeckMm / 2), requiredNeckMm / 2) : clearanceCut;
    const refillApproximation = unionPaths([
      ...robustClearanceCut,
      ...rawMemberPaths
    ]);
    const connectivitySafe = refillApproximation.some((path) => orderedMembers.every((member) => ClipperLib.Clipper.PointInPolygon({
      X: Math.round(geometries[member].pad.x * SCALE),
      Y: Math.round(geometries[member].pad.y * SCALE)
    }, path) !== 0));
    return {
      members: orderedMembers,
      ring: boundsRing(bounds),
      connectivitySafe
    };
  });
}
function rawPadOverlapCluster(geometries, seed) {
  const included = /* @__PURE__ */ new Set([seed]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < geometries.length; index += 1) {
      if (included.has(index)) continue;
      const candidate = geometryBounds(geometries[index]);
      if (![...included].some((member) => {
        const current = geometryBounds(geometries[member]);
        return Math.min(current.right, candidate.right) - Math.max(current.left, candidate.left) > 1e-9 && Math.min(current.bottom, candidate.bottom) - Math.max(current.top, candidate.top) > 1e-9;
      })) continue;
      included.add(index);
      changed = true;
    }
  }
  return [...included];
}
function compactConnectivityGroups(geometries, bankEnvelopes) {
  const parent = geometries.map((_, index) => index);
  const find = (value) => parent[value] === value ? value : parent[value] = find(parent[value]);
  const join = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < geometries.length; left += 1) {
    const leftBounds = geometryBounds(geometries[left]);
    for (let right = left + 1; right < geometries.length; right += 1) {
      const rightBounds = geometryBounds(geometries[right]);
      if (Math.min(leftBounds.right, rightBounds.right) - Math.max(leftBounds.left, rightBounds.left) > 1e-9 && Math.min(leftBounds.bottom, rightBounds.bottom) - Math.max(leftBounds.top, rightBounds.top) > 1e-9) {
        join(left, right);
      }
    }
  }
  for (const envelope of bankEnvelopes) {
    if (!envelope.connectivitySafe || envelope.members.length < 2) continue;
    for (const member of envelope.members.slice(1)) join(envelope.members[0], member);
  }
  const grouped = /* @__PURE__ */ new Map();
  for (let index = 0; index < geometries.length; index += 1) {
    const root = find(index);
    grouped.set(root, [...grouped.get(root) ?? [], index]);
  }
  const groups = [...grouped.values()].map((group) => group.sort((left, right) => left - right)).sort((left, right) => left[0] - right[0]);
  const groupForPad = Array(geometries.length);
  groups.forEach((group, groupIndex) => {
    for (const member of group) groupForPad[member] = groupIndex;
  });
  return { groups, groupForPad };
}
function contractedMstLinks(edges, groupForPad) {
  const links = /* @__PURE__ */ new Map();
  for (const edge of edges) {
    const left = groupForPad[edge.a];
    const right = groupForPad[edge.b];
    if (left === right) continue;
    const firstGroup = Math.min(left, right);
    const secondGroup = Math.max(left, right);
    links.set(`${firstGroup}:${secondGroup}`, { firstGroup, secondGroup });
  }
  return [...links.values()].sort((left, right) => left.firstGroup - right.firstGroup || left.secondGroup - right.secondGroup);
}
function alignedPadClusterBridge(routed, geometries, obstacles, padExpansionRatio, minimumCorridorWidthMm, obstacleClearanceMm) {
  const firstCluster = rawPadOverlapCluster(geometries, routed.edge.a);
  const secondCluster = rawPadOverlapCluster(geometries, routed.edge.b);
  if (firstCluster.some((index) => secondCluster.includes(index))) return { kind: "covered" };
  const foreignBounds = obstacles.filter((geometry) => geometry.pad.net !== geometries[routed.edge.a].pad.net).map(geometryBounds);
  const foreignRoutingKeepouts = foreignBounds.map((bounds) => inflateBounds(
    bounds,
    obstacleClearanceMm + minimumCorridorWidthMm / 2
  ));
  const overlapsWithArea = (left, right) => Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1e-9 && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1e-9;
  const candidates = [];
  const minimumAlignedBridgeWidthMm = Math.max(
    minimumCorridorWidthMm,
    routed.widthMm * 0.75
  );
  for (const firstIndex of firstCluster) {
    for (const secondIndex of secondCluster) {
      const firstRaw = geometryBounds(geometries[firstIndex]);
      const secondRaw = geometryBounds(geometries[secondIndex]);
      const firstExpanded = geometryBounds({
        ...geometries[firstIndex],
        points: expandedPadRings(geometries[firstIndex], padExpansionRatio)[0]
      });
      const secondExpanded = geometryBounds({
        ...geometries[secondIndex],
        points: expandedPadRings(geometries[secondIndex], padExpansionRatio)[0]
      });
      const addHorizontal = (leftRaw, rightRaw, leftExpanded, rightExpanded) => {
        const overlapTop = Math.max(leftRaw.top, rightRaw.top);
        const overlapBottom = Math.min(leftRaw.bottom, rightRaw.bottom);
        const overlapMm = overlapBottom - overlapTop;
        const gapMm = rightRaw.left - leftRaw.right;
        if (gapMm <= 1e-9 || overlapMm + 1e-9 < minimumAlignedBridgeWidthMm) return;
        const joinOverlapMm = 2 / SCALE;
        const protectedBounds = {
          left: leftRaw.right - joinOverlapMm,
          right: rightRaw.left + joinOverlapMm,
          top: overlapTop,
          bottom: overlapBottom
        };
        const expandedTop = Math.max(leftExpanded.top, rightExpanded.top);
        const expandedBottom = Math.min(leftExpanded.bottom, rightExpanded.bottom);
        const expandedBounds = rightExpanded.left > leftExpanded.right + 1e-9 ? {
          left: leftExpanded.right - joinOverlapMm,
          right: rightExpanded.left + joinOverlapMm,
          top: expandedTop,
          bottom: expandedBottom
        } : protectedBounds;
        if (foreignBounds.some((foreign) => overlapsWithArea(expandedBounds, foreign) || overlapsWithArea(protectedBounds, foreign))) return;
        if (foreignRoutingKeepouts.some((keepout) => overlapsWithArea(expandedBounds, keepout) || overlapsWithArea(protectedBounds, keepout))) return;
        candidates.push({
          kind: "bridge",
          subject: boundsRing(expandedBounds),
          protected: boundsRing(protectedBounds),
          areaMm2: gapMm * overlapMm
        });
      };
      const addVertical = (topRaw, bottomRaw, topExpanded, bottomExpanded) => {
        const overlapLeft = Math.max(topRaw.left, bottomRaw.left);
        const overlapRight = Math.min(topRaw.right, bottomRaw.right);
        const overlapMm = overlapRight - overlapLeft;
        const gapMm = bottomRaw.top - topRaw.bottom;
        if (gapMm <= 1e-9 || overlapMm + 1e-9 < minimumAlignedBridgeWidthMm) return;
        const joinOverlapMm = 2 / SCALE;
        const protectedBounds = {
          left: overlapLeft,
          right: overlapRight,
          top: topRaw.bottom - joinOverlapMm,
          bottom: bottomRaw.top + joinOverlapMm
        };
        const expandedLeft = Math.max(topExpanded.left, bottomExpanded.left);
        const expandedRight = Math.min(topExpanded.right, bottomExpanded.right);
        const expandedBounds = bottomExpanded.top > topExpanded.bottom + 1e-9 ? {
          left: expandedLeft,
          right: expandedRight,
          top: topExpanded.bottom - joinOverlapMm,
          bottom: bottomExpanded.top + joinOverlapMm
        } : protectedBounds;
        if (foreignBounds.some((foreign) => overlapsWithArea(expandedBounds, foreign) || overlapsWithArea(protectedBounds, foreign))) return;
        if (foreignRoutingKeepouts.some((keepout) => overlapsWithArea(expandedBounds, keepout) || overlapsWithArea(protectedBounds, keepout))) return;
        candidates.push({
          kind: "bridge",
          subject: boundsRing(expandedBounds),
          protected: boundsRing(protectedBounds),
          areaMm2: gapMm * overlapMm
        });
      };
      if (firstRaw.right < secondRaw.left) addHorizontal(firstRaw, secondRaw, firstExpanded, secondExpanded);
      if (secondRaw.right < firstRaw.left) addHorizontal(secondRaw, firstRaw, secondExpanded, firstExpanded);
      if (firstRaw.bottom < secondRaw.top) addVertical(firstRaw, secondRaw, firstExpanded, secondExpanded);
      if (secondRaw.bottom < firstRaw.top) addVertical(secondRaw, firstRaw, secondExpanded, firstExpanded);
    }
  }
  return candidates.sort((left, right) => left.areaMm2 - right.areaMm2)[0];
}
function widthAcrossSegment(points, first, second) {
  const distanceMm = Math.hypot(second.x - first.x, second.y - first.y);
  if (distanceMm < 1e-9) return 0;
  const normal = {
    x: -(second.y - first.y) / distanceMm,
    y: (second.x - first.x) / distanceMm
  };
  return projectionWidth(points, normal);
}
function adaptiveRouteVertexWidths(routed, geometries, padExpansionRatio) {
  const widths = routed.points.map((_, index) => {
    if (index === 0) return routed.segmentBodyWidthsMm[0] ?? routed.widthMm;
    if (index === routed.points.length - 1) return routed.segmentBodyWidthsMm.at(-1) ?? routed.widthMm;
    return Math.min(
      routed.segmentBodyWidthsMm[index - 1] ?? routed.widthMm,
      routed.segmentBodyWidthsMm[index] ?? routed.widthMm
    );
  });
  if (widths.length < 2) return widths;
  const startEnvelope = expandedPadRings(geometries[routed.edge.a], padExpansionRatio)[0];
  const endEnvelope = expandedPadRings(geometries[routed.edge.b], padExpansionRatio)[0];
  widths[0] = Math.min(
    routed.segmentBodyWidthsMm[0] ?? routed.widthMm,
    Math.max(routed.widthMm, widthAcrossSegment(startEnvelope, routed.points[0], routed.points[1]))
  );
  widths[widths.length - 1] = Math.min(
    routed.segmentBodyWidthsMm.at(-1) ?? routed.widthMm,
    Math.max(
      routed.widthMm,
      widthAcrossSegment(endEnvelope, routed.points.at(-2), routed.points.at(-1))
    )
  );
  for (let index = 1; index < widths.length; index += 1) {
    const lengthMm = Math.hypot(
      routed.points[index].x - routed.points[index - 1].x,
      routed.points[index].y - routed.points[index - 1].y
    );
    widths[index] = Math.min(widths[index], widths[index - 1] + lengthMm * 2);
  }
  for (let index = widths.length - 2; index >= 0; index -= 1) {
    const lengthMm = Math.hypot(
      routed.points[index + 1].x - routed.points[index].x,
      routed.points[index + 1].y - routed.points[index].y
    );
    widths[index] = Math.min(widths[index], widths[index + 1] + lengthMm * 2);
  }
  return widths;
}
function geometryBounds(geometry) {
  return {
    left: Math.min(...geometry.points.map((point) => point.x)),
    right: Math.max(...geometry.points.map((point) => point.x)),
    top: Math.min(...geometry.points.map((point) => point.y)),
    bottom: Math.max(...geometry.points.map((point) => point.y))
  };
}
function boundsRing(bounds) {
  return [
    { x: bounds.left, y: bounds.top },
    { x: bounds.right, y: bounds.top },
    { x: bounds.right, y: bounds.bottom },
    { x: bounds.left, y: bounds.bottom }
  ];
}
function inflateBounds(bounds, amount) {
  return {
    left: bounds.left - amount,
    right: bounds.right + amount,
    top: bounds.top - amount,
    bottom: bounds.bottom + amount
  };
}
function boundsOverlap(a, b) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}
function segmentHitsBounds(first, second, bounds) {
  const epsilon = 1e-7;
  const box = {
    left: bounds.left + epsilon,
    right: bounds.right - epsilon,
    top: bounds.top + epsilon,
    bottom: bounds.bottom - epsilon
  };
  if (box.left >= box.right || box.top >= box.bottom) return false;
  const inside = (point) => point.x > box.left && point.x < box.right && point.y > box.top && point.y < box.bottom;
  if (inside(first) || inside(second)) return true;
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  let near = 0;
  let far = 1;
  for (const [origin, delta, low, high] of [
    [first.x, dx, box.left, box.right],
    [first.y, dy, box.top, box.bottom]
  ]) {
    if (Math.abs(delta) < epsilon) {
      if (origin <= low || origin >= high) return false;
      continue;
    }
    const a = (low - origin) / delta;
    const b = (high - origin) / delta;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return false;
  }
  return near <= far && far >= 0 && near <= 1;
}
function polylineLength(points) {
  return points.slice(1).reduce((sum, point, index) => sum + Math.hypot(
    point.x - points[index].x,
    point.y - points[index].y
  ), 0);
}
function deduplicatePath(points) {
  return points.filter((point, index) => index === 0 || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 1e-9);
}
function octilinearCandidates(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const absoluteX = Math.abs(dx);
  const absoluteY = Math.abs(dy);
  const signX = Math.sign(dx);
  const signY = Math.sign(dy);
  const diagonal = Math.min(absoluteX, absoluteY);
  const candidates = [];
  if (absoluteX <= ANGLE_TOLERANCE_MM || absoluteY <= ANGLE_TOLERANCE_MM || Math.abs(absoluteX - absoluteY) <= ANGLE_TOLERANCE_MM) {
    candidates.push([start, end]);
  } else if (absoluteX > absoluteY) {
    candidates.push(
      [start, { x: start.x + signX * (absoluteX - diagonal), y: start.y }, end],
      [start, { x: start.x + signX * diagonal, y: start.y + signY * diagonal }, end]
    );
  } else {
    candidates.push(
      [start, { x: start.x, y: start.y + signY * (absoluteY - diagonal) }, end],
      [start, { x: start.x + signX * diagonal, y: start.y + signY * diagonal }, end]
    );
  }
  candidates.push(
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end]
  );
  const unique = /* @__PURE__ */ new Map();
  for (const candidate of candidates.map(deduplicatePath)) {
    if (candidate.length < 2 || !candidate.slice(1).every((point, index) => segmentIsOctilinear(candidate[index], point))) continue;
    unique.set(candidate.map((point) => `${point.x.toFixed(9)},${point.y.toFixed(9)}`).join(";"), candidate);
  }
  return [...unique.values()];
}
function pointInsideBounds(point, bounds) {
  const epsilon = 1e-7;
  return point.x > bounds.left + epsilon && point.x < bounds.right - epsilon && point.y > bounds.top + epsilon && point.y < bounds.bottom - epsilon;
}
function samePoint(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y) < 1e-9;
}
function endpointCanExitBounds(endpoint, adjacent, bounds) {
  if (!pointInsideBounds(endpoint, bounds) || pointInsideBounds(adjacent, bounds)) return false;
  const awayFromCenter = {
    x: endpoint.x - (bounds.left + bounds.right) / 2,
    y: endpoint.y - (bounds.top + bounds.bottom) / 2
  };
  const exitDirection = { x: adjacent.x - endpoint.x, y: adjacent.y - endpoint.y };
  if (Math.hypot(awayFromCenter.x, awayFromCenter.y) < 1e-9) return false;
  return awayFromCenter.x * exitDirection.x + awayFromCenter.y * exitDirection.y >= -1e-9;
}
function segmentHitsRoutingBounds(first, second, bounds, start, end) {
  if (!segmentHitsBounds(first, second, bounds)) return false;
  if (samePoint(first, start) && endpointCanExitBounds(start, second, bounds)) return false;
  if (samePoint(second, start) && endpointCanExitBounds(start, first, bounds)) return false;
  if (samePoint(first, end) && endpointCanExitBounds(end, second, bounds)) return false;
  if (samePoint(second, end) && endpointCanExitBounds(end, first, bounds)) return false;
  return true;
}
function corridorObstacleHits(points, blocked, start = points[0], end = points.at(-1)) {
  return blocked.filter((bounds) => points.slice(1).some((point, index) => segmentHitsRoutingBounds(points[index], point, bounds, start, end))).length;
}
function polylineBounds(points, marginMm = 0) {
  return {
    left: Math.min(...points.map((point) => point.x)) - marginMm,
    right: Math.max(...points.map((point) => point.x)) + marginMm,
    top: Math.min(...points.map((point) => point.y)) - marginMm,
    bottom: Math.max(...points.map((point) => point.y)) + marginMm
  };
}
function blockedBoundsForWidth(obstacles, targetNet, points, widthMm, obstacleClearanceMm, routingReserveMm = 0) {
  const inflationMm = obstacleClearanceMm + routingReserveMm + widthMm / 2;
  const searchBounds = polylineBounds(points, inflationMm);
  return obstacles.filter((geometry) => geometry.pad.net !== targetNet).map(geometryBounds).filter((bounds) => boundsOverlap(inflateBounds(bounds, inflationMm), searchBounds)).map((bounds) => inflateBounds(bounds, inflationMm));
}
function widestCollisionFreeBodyWidth(obstacles, targetNet, points, routeStart, routeEnd, baseWidthMm, maximumUsefulWidthMm, obstacleClearanceMm, routingReserveMm) {
  const maximumWidthMm = Math.max(
    baseWidthMm,
    Math.min(baseWidthMm * MAX_ADAPTIVE_CORRIDOR_WIDTH_RATIO, maximumUsefulWidthMm)
  );
  if (maximumWidthMm <= baseWidthMm + 1e-9) return baseWidthMm;
  const collides = (widthMm) => corridorObstacleHits(
    points,
    blockedBoundsForWidth(
      obstacles,
      targetNet,
      points,
      widthMm,
      obstacleClearanceMm,
      routingReserveMm
    ),
    routeStart,
    routeEnd
  ) > 0;
  if (!collides(maximumWidthMm)) return maximumWidthMm;
  let safeWidthMm = baseWidthMm;
  let blockedWidthMm = maximumWidthMm;
  for (let index = 0; index < ADAPTIVE_WIDTH_SEARCH_STEPS; index += 1) {
    const candidateWidthMm = (safeWidthMm + blockedWidthMm) / 2;
    if (collides(candidateWidthMm)) blockedWidthMm = candidateWidthMm;
    else safeWidthMm = candidateWidthMm;
  }
  return safeWidthMm;
}
function shortestRectilinearPath(start, end, blocked) {
  const xs = [.../* @__PURE__ */ new Set([
    start.x,
    end.x,
    ...blocked.flatMap((bounds) => [bounds.left, bounds.right])
  ])].sort((a, b) => a - b);
  const ys = [.../* @__PURE__ */ new Set([
    start.y,
    end.y,
    ...blocked.flatMap((bounds) => [bounds.top, bounds.bottom])
  ])].sort((a, b) => a - b);
  const key = (xIndex, yIndex) => `${xIndex}:${yIndex}`;
  const nodes = /* @__PURE__ */ new Map();
  for (let yIndex = 0; yIndex < ys.length; yIndex += 1) {
    for (let xIndex = 0; xIndex < xs.length; xIndex += 1) {
      const point = { x: xs[xIndex], y: ys[yIndex] };
      const isEndpoint = Math.hypot(point.x - start.x, point.y - start.y) < 1e-9 || Math.hypot(point.x - end.x, point.y - end.y) < 1e-9;
      if (!isEndpoint && blocked.some((bounds) => pointInsideBounds(point, bounds))) continue;
      nodes.set(key(xIndex, yIndex), { point, xIndex, yIndex });
    }
  }
  const startKey = key(xs.indexOf(start.x), ys.indexOf(start.y));
  const endKey = key(xs.indexOf(end.x), ys.indexOf(end.y));
  if (!nodes.has(startKey) || !nodes.has(endKey)) return void 0;
  const rows = /* @__PURE__ */ new Map();
  const columns = /* @__PURE__ */ new Map();
  for (const node of nodes.values()) {
    rows.set(node.yIndex, [...rows.get(node.yIndex) ?? [], node]);
    columns.set(node.xIndex, [...columns.get(node.xIndex) ?? [], node]);
  }
  for (const row of rows.values()) row.sort((a, b) => a.xIndex - b.xIndex);
  for (const column of columns.values()) column.sort((a, b) => a.yIndex - b.yIndex);
  const neighbours = /* @__PURE__ */ new Map();
  const addVisiblePairs = (line) => {
    for (let index = 1; index < line.length; index += 1) {
      const first = line[index - 1];
      const second = line[index];
      if (blocked.some((bounds) => segmentHitsRoutingBounds(first.point, second.point, bounds, start, end))) continue;
      const firstKey = key(first.xIndex, first.yIndex);
      const secondKey = key(second.xIndex, second.yIndex);
      const distance = Math.hypot(second.point.x - first.point.x, second.point.y - first.point.y);
      neighbours.set(firstKey, [...neighbours.get(firstKey) ?? [], { key: secondKey, distance }]);
      neighbours.set(secondKey, [...neighbours.get(secondKey) ?? [], { key: firstKey, distance }]);
    }
  };
  for (const row of rows.values()) addVisiblePairs(row);
  for (const column of columns.values()) addVisiblePairs(column);
  const distances = /* @__PURE__ */ new Map([[startKey, 0]]);
  const previous = /* @__PURE__ */ new Map();
  const pending = new Set(nodes.keys());
  while (pending.size) {
    let current;
    let best = Infinity;
    for (const candidate of pending) {
      const distance = distances.get(candidate) ?? Infinity;
      if (distance < best) {
        best = distance;
        current = candidate;
      }
    }
    if (!current || !Number.isFinite(best)) break;
    pending.delete(current);
    if (current === endKey) break;
    for (const neighbour of neighbours.get(current) ?? []) {
      if (!pending.has(neighbour.key)) continue;
      const candidateDistance = best + neighbour.distance;
      if (candidateDistance + 1e-9 >= (distances.get(neighbour.key) ?? Infinity)) continue;
      distances.set(neighbour.key, candidateDistance);
      previous.set(neighbour.key, current);
    }
  }
  if (!distances.has(endKey)) return void 0;
  const pathKeys = [endKey];
  while (pathKeys[0] !== startKey) {
    const parent = previous.get(pathKeys[0]);
    if (!parent) return void 0;
    pathKeys.unshift(parent);
  }
  return simplifyCollinear(pathKeys.map((nodeKey) => nodes.get(nodeKey).point));
}
function routeEdge(geometries, obstacles, edge, padExpansionRatio, minimumCorridorWidthMm, obstacleClearanceMm) {
  const start = geometries[edge.a].pad;
  const end = geometries[edge.b].pad;
  const widthMm = Math.max(edge.bottleneckWidthMm, minimumCorridorWidthMm);
  const obstacleInflation = obstacleClearanceMm + widthMm / 2;
  const searchMargin = Math.max(widthMm * 4, obstacleClearanceMm * 4, 1);
  const searchBounds = inflateBounds({
    left: Math.min(start.x, end.x),
    right: Math.max(start.x, end.x),
    top: Math.min(start.y, end.y),
    bottom: Math.max(start.y, end.y)
  }, searchMargin);
  const blocked = obstacles.filter((geometry) => geometry.pad.net !== geometries[edge.a].pad.net).map(geometryBounds).filter((bounds) => boundsOverlap(bounds, searchBounds)).map((bounds) => inflateBounds(bounds, obstacleInflation));
  const directObstacleCount = corridorObstacleHits([start, end], blocked);
  const candidates = octilinearCandidates(start, end);
  const unique = new Map(candidates.map((candidate) => [
    candidate.map((point) => `${point.x.toFixed(9)},${point.y.toFixed(9)}`).join(";"),
    candidate
  ]));
  const points = [...unique.values()].filter((candidate) => corridorObstacleHits(candidate, blocked) === 0).sort((left, right) => {
    const lengthDifference = polylineLength(left) - polylineLength(right);
    if (Math.abs(lengthDifference) > 1e-9) return lengthDifference;
    return left.length - right.length;
  })[0] ?? shortestRectilinearPath(start, end, blocked);
  if (!points) return void 0;
  const lengthMm = polylineLength(points);
  const remainingObstacleCount = corridorObstacleHits(points, blocked);
  if (remainingObstacleCount) return void 0;
  const routeStart = points[0];
  const routeEnd = points.at(-1);
  const endpointsSharePadBank = Boolean(padBankPairAxis(
    geometries[edge.a],
    geometries[edge.b],
    padExpansionRatio,
    minimumCorridorWidthMm,
    obstacleClearanceMm
  ));
  const allowExpansion = edge.gapMm > minimumCorridorWidthMm / 2 && !endpointsSharePadBank;
  const routingReserveMm = minimumCorridorWidthMm / 2;
  const startEnvelope = expandedPadRings(geometries[edge.a], padExpansionRatio)[0];
  const endEnvelope = expandedPadRings(geometries[edge.b], padExpansionRatio)[0];
  const segmentBodyWidthsMm = points.slice(1).map((point, index) => {
    const startSupportWidthMm = widthAcrossSegment(startEnvelope, points[index], point);
    const endSupportWidthMm = widthAcrossSegment(endEnvelope, points[index], point);
    const padSupportedWidthMm = allowExpansion ? Math.sqrt(Math.max(widthMm, startSupportWidthMm) * Math.max(widthMm, endSupportWidthMm)) : widthMm;
    return widestCollisionFreeBodyWidth(
      obstacles,
      geometries[edge.a].pad.net,
      [points[index], point],
      routeStart,
      routeEnd,
      widthMm,
      padSupportedWidthMm,
      obstacleClearanceMm,
      routingReserveMm
    );
  });
  const bodyWidthMm = segmentBodyWidthsMm.length ? Math.max(...segmentBodyWidthsMm) : widthMm;
  return {
    edge,
    points,
    widthMm,
    bodyWidthMm,
    segmentBodyWidthsMm,
    lengthMm,
    avoidedObstacleCount: Math.max(0, directObstacleCount - remainingObstacleCount),
    remainingObstacleCount
  };
}
function routedClearanceGateContext(geometries, obstacles, obstacleClearanceMm) {
  return {
    rawTargetPaths: unionPaths(geometries.map((geometry) => toClipper(boundsRing(geometryBounds(geometry))))),
    foreignClearancePaths: obstacles.filter((geometry) => geometry.pad.net !== geometries[0].pad.net).map((geometry) => toClipper(boundsRing(inflateBounds(
      geometryBounds(geometry),
      obstacleClearanceMm + 2 / SCALE
    ))))
  };
}
function routedConnectionAvoidsForeignClearance(routed, context) {
  const corridorRings = routed.points.slice(1).flatMap((point, index) => {
    const ring = adaptiveCorridorSegmentRing(
      routed.points[index],
      point,
      routed.widthMm,
      routed.widthMm,
      routed.widthMm
    );
    return ring ? [ring] : [];
  });
  if (!corridorRings.length) return false;
  const exposedCorridorPaths = differencePaths(
    unionPaths(corridorRings.map(toClipper)),
    context.rawTargetPaths
  );
  return clipperPathsAreaMm2(intersectPaths(
    exposedCorridorPaths,
    context.foreignClearancePaths
  )) <= 1e-8;
}
function stableGeometryKey(geometry) {
  const pad = geometry.pad;
  return [
    pad.component ?? "",
    String(pad.padNumber ?? ""),
    pad.x.toFixed(9),
    pad.y.toFixed(9),
    pad.id ?? ""
  ].join(":");
}
function routedCopperAreaProxy(routed) {
  return routed.points.slice(1).reduce((areaMm2, point, index) => areaMm2 + Math.hypot(
    point.x - routed.points[index].x,
    point.y - routed.points[index].y
  ) * (routed.segmentBodyWidthsMm[index] ?? routed.widthMm), 0);
}
function compareRoutedCandidates(left, right, geometries) {
  const numericLeft = [
    Math.round(left.lengthMm * SCALE),
    Math.round(routedCopperAreaProxy(left) * SCALE),
    Math.max(0, left.points.length - 2),
    Math.round((left.lengthMm - left.edge.distanceMm) * SCALE),
    Math.round(left.edge.gapMm * SCALE)
  ];
  const numericRight = [
    Math.round(right.lengthMm * SCALE),
    Math.round(routedCopperAreaProxy(right) * SCALE),
    Math.max(0, right.points.length - 2),
    Math.round((right.lengthMm - right.edge.distanceMm) * SCALE),
    Math.round(right.edge.gapMm * SCALE)
  ];
  for (let index = 0; index < numericLeft.length; index += 1) {
    if (numericLeft[index] !== numericRight[index]) return numericLeft[index] - numericRight[index];
  }
  const leftKey = `${stableGeometryKey(geometries[left.edge.a])}->${stableGeometryKey(geometries[left.edge.b])}`;
  const rightKey = `${stableGeometryKey(geometries[right.edge.a])}->${stableGeometryKey(geometries[right.edge.b])}`;
  return leftKey.localeCompare(rightKey);
}
function routedConnectionsForCompactGroup(geometries, obstacles, rawEdges, bankEnvelopes, padExpansionRatio, minimumCorridorWidthMm, obstacleClearanceMm) {
  const { groups, groupForPad } = compactConnectivityGroups(geometries, bankEnvelopes);
  if (groups.length < 2) return [];
  const cache = /* @__PURE__ */ new Map();
  const clearanceContext = routedClearanceGateContext(
    geometries,
    obstacles,
    obstacleClearanceMm
  );
  const candidates = [];
  const evaluatedLinks = /* @__PURE__ */ new Set();
  const evaluateLink = (link) => {
    const linkKey = `${link.firstGroup}:${link.secondGroup}`;
    if (evaluatedLinks.has(linkKey)) return;
    evaluatedLinks.add(linkKey);
    let best;
    const selectsBankEndpoint = groups[link.firstGroup].length > 1 || groups[link.secondGroup].length > 1;
    for (const first of groups[link.firstGroup]) {
      for (const second of groups[link.secondGroup]) {
        const key = `${first}:${second}`;
        let routed = cache.get(key);
        if (routed === void 0) {
          routed = routeEdge(
            geometries,
            obstacles,
            edgeBetween(geometries, first, second),
            padExpansionRatio,
            minimumCorridorWidthMm,
            obstacleClearanceMm
          ) ?? null;
          cache.set(key, routed);
        }
        if (!routed) continue;
        if (selectsBankEndpoint && !routedConnectionAvoidsForeignClearance(routed, clearanceContext) && !alignedPadClusterBridge(
          routed,
          geometries,
          obstacles,
          padExpansionRatio,
          minimumCorridorWidthMm,
          obstacleClearanceMm
        )) continue;
        if (!best || compareRoutedCandidates(routed, best, geometries) < 0) best = routed;
      }
    }
    if (best) candidates.push({ ...link, routed: best });
  };
  const spanningTree = () => {
    const parent = Array.from({ length: groups.length }, (_, index) => index);
    const find = (value) => parent[value] === value ? value : parent[value] = find(parent[value]);
    const selected2 = [];
    const ordered = [...candidates].sort((left, right) => compareRoutedCandidates(left.routed, right.routed, geometries) || left.firstGroup - right.firstGroup || left.secondGroup - right.secondGroup);
    for (const candidate of ordered) {
      const firstRoot = find(candidate.firstGroup);
      const secondRoot = find(candidate.secondGroup);
      if (firstRoot === secondRoot) continue;
      parent[secondRoot] = firstRoot;
      selected2.push(candidate.routed);
      if (selected2.length === groups.length - 1) return selected2;
    }
    return void 0;
  };
  for (const link of contractedMstLinks(rawEdges, groupForPad)) evaluateLink(link);
  let selected = spanningTree();
  if (selected) return selected;
  const fallbackLinks = [];
  for (let firstGroup = 0; firstGroup < groups.length; firstGroup += 1) {
    for (let secondGroup = firstGroup + 1; secondGroup < groups.length; secondGroup += 1) {
      const key = `${firstGroup}:${secondGroup}`;
      if (evaluatedLinks.has(key)) continue;
      const distanceMm = Math.min(...groups[firstGroup].flatMap((first) => groups[secondGroup].map((second) => edgeBetween(geometries, first, second).distanceMm)));
      fallbackLinks.push({ firstGroup, secondGroup, distanceMm });
    }
  }
  fallbackLinks.sort((left, right) => left.distanceMm - right.distanceMm || left.firstGroup - right.firstGroup || left.secondGroup - right.secondGroup);
  for (const { distanceMm: _distanceMm, ...link } of fallbackLinks) {
    evaluateLink(link);
    selected = spanningTree();
    if (selected) return selected;
  }
  return void 0;
}
function optimizeGroup(geometries, obstacles, padExpansionRatio, minimumCorridorWidthMm, obstacleClearanceMm) {
  const edges = minimumSpanningTree(geometries);
  const bankEnvelopes = padBankEnvelopes(
    geometries,
    obstacles,
    padExpansionRatio,
    minimumCorridorWidthMm,
    obstacleClearanceMm
  );
  const routes = routedConnectionsForCompactGroup(
    geometries,
    obstacles,
    edges,
    bankEnvelopes,
    padExpansionRatio,
    minimumCorridorWidthMm,
    obstacleClearanceMm
  );
  if (!routes) return void 0;
  const corridorWidthMinMm = routes.length ? Math.min(...routes.map((edge) => edge.widthMm)) : 0;
  const corridorBodyWidthMaxMm = routes.length ? Math.max(...routes.map((edge) => edge.bodyWidthMm)) : 0;
  const minimumFeatureMm = Math.max(
    corridorWidthMinMm,
    minimumCorridorWidthMm
  ) * MIN_BOUNDARY_FEATURE_WIDTH_RATIO;
  const pocketClosingRadiusMm = (minimumCorridorWidthMm + obstacleClearanceMm) / 2;
  const padSubjects = geometries.flatMap((geometry) => expandedPadRings(geometry, padExpansionRatio));
  const padBankSubjects = bankEnvelopes.map((envelope2) => envelope2.ring);
  const subjects = [...padSubjects, ...padBankSubjects];
  const protectedSubjects = [
    ...geometries.map((geometry) => boundsRing(geometryBounds(geometry))),
    ...padBankSubjects
  ];
  for (const routed of routes) {
    const alignedBridge = alignedPadClusterBridge(
      routed,
      geometries,
      obstacles,
      padExpansionRatio,
      minimumCorridorWidthMm,
      obstacleClearanceMm
    );
    if (alignedBridge) {
      if (alignedBridge.kind === "covered") continue;
      subjects.push(alignedBridge.subject);
      protectedSubjects.push(alignedBridge.protected);
      continue;
    }
    const vertexWidths = adaptiveRouteVertexWidths(routed, geometries, padExpansionRatio);
    for (let index = 1; index < routed.points.length; index += 1) {
      const corridor = adaptiveCorridorSegmentRing(
        routed.points[index - 1],
        routed.points[index],
        vertexWidths[index - 1],
        vertexWidths[index],
        routed.segmentBodyWidthsMm[index - 1] ?? routed.widthMm
      );
      if (corridor) subjects.push(corridor);
      const protectedCorridor = adaptiveCorridorSegmentRing(
        routed.points[index - 1],
        routed.points[index],
        routed.widthMm,
        routed.widthMm,
        routed.widthMm
      );
      if (protectedCorridor) protectedSubjects.push(protectedCorridor);
    }
  }
  const foreignPadRings = obstacles.filter((geometry) => geometry.pad.net !== geometries[0].pad.net).map((geometry) => boundsRing(geometryBounds(geometry)));
  const unioned = unionBoundary(
    subjects,
    protectedSubjects,
    foreignPadRings,
    minimumFeatureMm,
    pocketClosingRadiusMm,
    Math.max(minimumCorridorWidthMm, corridorWidthMinMm)
  );
  if (!unioned) return void 0;
  const simplifiedUnion = simplifyBoundaryFeatures(unioned.boundary, minimumFeatureMm);
  const baselineUnion = simplifyBoundaryFeatures(unioned.baselineBoundary, minimumFeatureMm);
  const targetPadAreaMm2 = geometries.reduce((sum, geometry) => sum + geometry.areaMm2, 0);
  const envelope = octilinearEnvelope(subjects.flat(), minimumFeatureMm);
  const envelopeAreaMm2 = envelope ? boundaryArea(envelope) : Infinity;
  const envelopePaths = envelope ? unionPaths([toClipper(envelope)]) : [];
  const protectedCorePaths = unionPaths(protectedSubjects.filter((ring) => ring.length >= 3 && boundaryArea(ring) > 1e-9).map(toClipper));
  const foreignPaths = unionPaths(foreignPadRings.map(toClipper));
  const baselinePaths = unionPaths([toClipper(baselineUnion)]);
  const envelopePreservesCore = envelopePaths.length === 1 && clipperPathsAreaMm2(differencePaths(protectedCorePaths, envelopePaths)) <= 1e-8;
  const envelopeAddedPaths = envelopePaths.length ? differencePaths(envelopePaths, baselinePaths) : [];
  const envelopeAvoidsForeignPads = !foreignPaths.length || clipperPathsAreaMm2(intersectPaths(envelopeAddedPaths, foreignPaths)) <= 1e-8;
  const useEnvelope = Boolean(envelope) && envelopePreservesCore && envelopeAvoidsForeignPads && envelope.length < baselineUnion.length && envelopeAreaMm2 / Math.max(1e-9, boundaryArea(baselineUnion)) <= MAX_OCTILINEAR_ENVELOPE_AREA_RATIO;
  const boundary = useEnvelope ? envelope : simplifiedUnion;
  if (!isOctilinearBoundary(boundary)) return void 0;
  const boundaryAreaMm2 = boundaryArea(boundary);
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
    filledPocketAreaMm2: unioned.filledPocketAreaMm2
  };
}
function optimizeCompactBoundaries(pads, ringsFromPad, obstaclePads = [], options = {}) {
  const maxPadFreeGapWidths = options.maxPadFreeGapWidths ?? MAX_PAD_FREE_GAP_WIDTHS;
  const padExpansionRatio = options.padExpansionRatio ?? PAD_ENVELOPE_EXPANSION_RATIO;
  const minimumCorridorWidthMm = options.minimumCorridorWidthMm ?? DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM;
  const obstacleClearanceMm = options.obstacleClearanceMm ?? DEFAULT_OBSTACLE_CLEARANCE_MM;
  const toGeometry = (pad) => {
    const rings = ringsFromPad(pad).filter((ring) => ring.length >= 3);
    const points = rings.flat();
    if (!points.length) return [];
    const areaMm2 = rings.reduce((sum, ring) => sum + boundaryArea(ring), 0);
    return [{
      pad,
      points,
      areaMm2,
      characteristicWidthMm: Math.max(1e-6, Math.sqrt(areaMm2))
    }];
  };
  const geometries = pads.flatMap(toGeometry);
  const obstacles = obstaclePads.flatMap(toGeometry);
  if (geometries.length < 2) {
    return {
      boundaries: [],
      maxPadFreeGapMm: 0,
      maxPadFreeGapWidths: 0,
      isolatedPads: geometries.map((geometry) => ({ pad: geometry.pad, nearestPadFreeGapWidths: Infinity }))
    };
  }
  const globalEdges = minimumSpanningTree(geometries);
  const groups = groupsAfterCut(geometries, globalEdges, maxPadFreeGapWidths);
  const boundaries = [];
  const isolatedPads = [];
  const addIsolated = (geometry, peers) => {
    const nearestPadFreeGapWidths = peers.filter((peer) => peer !== geometry).reduce((nearest, peer) => Math.min(nearest, edgeBetween([geometry, peer], 0, 1).gapWidths), Infinity);
    isolatedPads.push({ pad: geometry.pad, nearestPadFreeGapWidths });
  };
  for (const group of groups) {
    const members = group.map((index) => geometries[index]);
    if (members.length < 2) {
      addIsolated(members[0], geometries);
      continue;
    }
    const optimized = optimizeGroup(
      members,
      obstacles,
      padExpansionRatio,
      minimumCorridorWidthMm,
      obstacleClearanceMm
    );
    if (optimized) {
      boundaries.push(optimized);
    } else {
      for (const geometry of members) addIsolated(geometry, members);
    }
  }
  return {
    boundaries,
    maxPadFreeGapMm: globalEdges.length ? Math.max(...globalEdges.map((edge) => edge.gapMm)) : 0,
    maxPadFreeGapWidths: globalEdges.length ? Math.max(...globalEdges.map((edge) => edge.gapWidths)) : 0,
    isolatedPads
  };
}

// src/polygon/engine.ts
import { performance } from "perf_hooks";
var MAX_COMPACT_BOARD_AREA_RATIO = 0.1;
var rawLayer = (value) => value;
function resolveLayers(selector) {
  if (selector.kind === "outer") return [rawLayer("TOP"), rawLayer("BOTTOM")];
  if (selector.kind === "top") return [rawLayer("TOP")];
  if (selector.kind === "bottom") return [rawLayer("BOTTOM")];
  return selector.names.map(rawLayer);
}
function padOnLayer(pad, layer) {
  return pad.layer === "MULTI" || pad.layer === layer;
}
function rotateDegrees(point, center, degrees) {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine
  };
}
function ellipse(center, width, height, rotation) {
  return Array.from({ length: 24 }, (_, index) => {
    const angle = Math.PI * 2 * index / 24;
    return rotateDegrees({
      x: center.x + Math.cos(angle) * width / 2,
      y: center.y + Math.sin(angle) * height / 2
    }, center, rotation);
  });
}
function sourceRings(source2) {
  if (!Array.isArray(source2)) return [];
  const rings = [];
  let ring = [];
  let index = 0;
  const flush = () => {
    if (ring.length >= 3) rings.push(ring);
    ring = [];
  };
  if (typeof source2[0] === "number" && typeof source2[1] === "number") {
    ring.push({ x: source2[0], y: source2[1] });
    index = 2;
  }
  while (index < source2.length) {
    const command = source2[index++];
    if (command === "M") {
      flush();
      if (typeof source2[index] === "number" && typeof source2[index + 1] === "number") {
        ring.push({ x: source2[index], y: source2[index + 1] });
        index += 2;
      }
    } else if (command === "L") {
      while (typeof source2[index] === "number" && typeof source2[index + 1] === "number") {
        ring.push({ x: source2[index], y: source2[index + 1] });
        index += 2;
      }
    } else if (command === "Z") {
      flush();
    } else if (command === "CIRCLE") {
      const x = source2[index];
      const y = source2[index + 1];
      const radius = source2[index + 2];
      if (typeof x === "number" && typeof y === "number" && typeof radius === "number") {
        rings.push(ellipse({ x, y }, radius * 2, radius * 2, 0));
      }
      index += 3;
    } else {
      while (typeof source2[index] === "number") index += 1;
    }
  }
  flush();
  return rings;
}
function ringsFromRawPolygon(polygon) {
  return polygon.sources.flatMap((source2) => sourceRings(source2));
}
function ringsFromRawPad(pad) {
  const shape = pad.shape;
  if (!(shape == null ? void 0 : shape.length)) return [];
  const type = String(shape[0]).toUpperCase();
  if (type === "POLYGON") {
    const complex = shape[1];
    if (!Array.isArray(complex)) return [];
    const sources = Array.isArray(complex[0]) ? complex : [complex];
    return sources.flatMap((source2) => sourceRings(source2));
  }
  const width = Number(shape[1]);
  const height = Number(shape[2] ?? shape[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  if (type === "ELLIPSE" || type === "CIRCLE" || type === "OVAL") {
    return [ellipse(pad, width, height, pad.rotation || 0)];
  }
  const points = [
    { x: pad.x - width / 2, y: pad.y - height / 2 },
    { x: pad.x + width / 2, y: pad.y - height / 2 },
    { x: pad.x + width / 2, y: pad.y + height / 2 },
    { x: pad.x - width / 2, y: pad.y + height / 2 }
  ].map((point) => rotateDegrees(point, pad, pad.rotation || 0));
  return [points];
}
function polygonArea(points) {
  if (points.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}
function padKey(pad) {
  return pad.id || `${pad.component ?? ""}:${pad.padNumber}:${pad.x}:${pad.y}:${pad.layer}`;
}
function resolveTarget(pcb, intent, target) {
  if (target.kind === "net") {
    const pads2 = pcb.pads.filter((pad) => pad.net === target.net);
    return pads2.length ? { pads: pads2 } : { pads: pads2, error: `net(${target.net}) has no pads` };
  }
  const pads = pcb.pads.filter((pad) => pad.component === target.component && pad.padNumber === target.pad);
  if (!pads.length) return { pads, error: `pad(${target.component}, ${target.pad}) was not found` };
  const mismatch = pads.find((pad) => pad.net !== intent.net);
  if (mismatch) {
    return { pads: [], error: `pad(${target.component}, ${target.pad}) belongs to ${mismatch.net || "no net"}, not ${intent.net}` };
  }
  return { pads };
}
function resolvedPad(pad) {
  const { id, component, padNumber: padNumber2, net, x, y, layer } = pad;
  return { id, component, padNumber: padNumber2, net, x, y, layer };
}
function skipped(intent, layer, boardAreaMm2, reason, targetPads = [], boundary) {
  const boundaryAreaMm2 = boundary ? polygonArea(boundary) : 0;
  return {
    intent,
    net: intent.net,
    layer,
    status: "skipped",
    reason,
    targetPads: targetPads.map(resolvedPad),
    boundary,
    boardAreaMm2,
    boundaryAreaMm2,
    boardAreaRatio: boardAreaMm2 > 0 ? boundaryAreaMm2 / boardAreaMm2 : 0,
    warnings: []
  };
}
function failed(intent, layer, boardAreaMm2, reason, targetPads = [], boundary) {
  return {
    ...skipped(intent, layer, boardAreaMm2, reason, targetPads, boundary),
    status: "error"
  };
}
function optimizationMetrics(optimized, clusterIndex, clusterCount) {
  return {
    strategy: optimized.strategy,
    clusterIndex,
    clusterCount,
    mstLengthMm: optimized.mstLengthMm,
    routedLengthMm: optimized.routedLengthMm,
    routeDetourMm: optimized.routeDetourMm,
    avoidedObstacleCount: optimized.avoidedObstacleCount,
    corridorWidthMinMm: optimized.corridorWidthMinMm,
    corridorBodyWidthMaxMm: optimized.corridorBodyWidthMaxMm,
    maxPadFreeGapMm: optimized.maxPadFreeGapMm,
    maxPadFreeGapWidths: optimized.maxPadFreeGapWidths,
    targetPadAreaMm2: optimized.targetPadAreaMm2,
    copperEfficiency: optimized.copperEfficiency,
    angleMode: optimized.angleMode,
    boundaryVertexCount: optimized.boundaryVertexCount,
    removedVertexCount: optimized.removedVertexCount,
    minimumFeatureMm: optimized.minimumFeatureMm,
    pocketClosingRadiusMm: optimized.pocketClosingRadiusMm,
    filledPocketAreaMm2: optimized.filledPocketAreaMm2
  };
}
function padsConnectedAcrossBoundaries(requiredPads, boundaries) {
  if (!requiredPads.length) return true;
  const parent = /* @__PURE__ */ new Map();
  const find = (key) => {
    const current = parent.get(key) ?? key;
    if (current === key) {
      parent.set(key, key);
      return key;
    }
    const root2 = find(current);
    parent.set(key, root2);
    return root2;
  };
  const join = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const boundary of boundaries) {
    const keys = boundary.pads.map(padKey);
    if (!keys.length) continue;
    find(keys[0]);
    for (const key of keys.slice(1)) join(keys[0], key);
  }
  const requiredKeys = requiredPads.map(padKey);
  if (requiredKeys.some((key) => !parent.has(key))) return false;
  const root = find(requiredKeys[0]);
  return requiredKeys.every((key) => find(key) === root);
}
function planIntent(pcb, intent, layer, boardAreaMm2, options) {
  var _a, _b, _c;
  const resolved = intent.targets.map((target) => ({ target, ...resolveTarget(pcb, intent, target) }));
  const error = (_a = resolved.find((item) => item.error)) == null ? void 0 : _a.error;
  if (error) return [failed(intent, layer, boardAreaMm2, error)];
  const unique = /* @__PURE__ */ new Map();
  for (const pad of resolved.flatMap((item) => item.pads)) unique.set(padKey(pad), pad);
  const targetPads = [...unique.values()].filter((pad) => padOnLayer(pad, layer));
  const explicitPads = resolved.filter((item) => item.target.kind === "pad").flatMap((item) => item.pads).filter((pad) => padOnLayer(pad, layer));
  const explicitPadKeys = new Set(explicitPads.map(padKey));
  if (!targetPads.length) return [failed(intent, layer, boardAreaMm2, `no target pads are present on ${layer}`)];
  if (intent.mode === "plane") {
    const boundary = (_b = pcb.board) == null ? void 0 : _b.polygon;
    if (!boundary || boundary.length < 3 || boardAreaMm2 <= 0) {
      return [failed(intent, layer, boardAreaMm2, "board outline is missing or invalid", targetPads)];
    }
    return [{
      intent,
      net: intent.net,
      layer,
      status: "ready",
      targetPads: targetPads.map(resolvedPad),
      boundary: boundary.map((point) => ({ ...point })),
      boardAreaMm2,
      boundaryAreaMm2: boardAreaMm2,
      boardAreaRatio: 1,
      warnings: ["plane() explicitly permits a board-scale native EDA zone"]
    }];
  }
  if (targetPads.length < 2) {
    const createDiagnostic = explicitPads.length ? failed : skipped;
    return [createDiagnostic(intent, layer, boardAreaMm2, "compact polygon needs at least two target pads", targetPads)];
  }
  const usablePads = targetPads.filter((pad) => ringsFromRawPad(pad).some((ring) => ring.length >= 3));
  const unusablePads = targetPads.filter((pad) => !usablePads.includes(pad));
  const unusableExplicitPads = unusablePads.filter((pad) => explicitPadKeys.has(padKey(pad)));
  if (unusableExplicitPads.length) {
    return [failed(intent, layer, boardAreaMm2, "an explicit target pad has no usable geometry", unusableExplicitPads)];
  }
  const optimized = optimizeCompactBoundaries(
    usablePads,
    ringsFromRawPad,
    pcb.pads.filter((pad) => padOnLayer(pad, layer)),
    {
      maxPadFreeGapWidths: intent.maxPadFreeGapWidths,
      ...(_c = options.rulesForNet) == null ? void 0 : _c.call(options, intent.net)
    }
  );
  const viableBoundaries = optimized.boundaries.filter((cluster) => {
    const ratio = boardAreaMm2 > 0 ? polygonArea(cluster.boundary) / boardAreaMm2 : Infinity;
    return Number.isFinite(ratio) && ratio <= MAX_COMPACT_BOARD_AREA_RATIO;
  });
  if (explicitPads.length && !padsConnectedAcrossBoundaries(explicitPads, viableBoundaries)) {
    const reason = optimized.maxPadFreeGapWidths > intent.maxPadFreeGapWidths ? `explicit targets require a ${optimized.maxPadFreeGapWidths.toFixed(2)} pad-width gap; configured maxPadFreeGap is ${intent.maxPadFreeGapWidths}` : "explicit targets have no collision-free 0/45/90 corridor at the configured useful width";
    return [failed(intent, layer, boardAreaMm2, reason, targetPads)];
  }
  const clusterCount = optimized.boundaries.length + optimized.isolatedPads.length + unusablePads.length;
  const plans = optimized.boundaries.map((cluster, index) => {
    const boundaryAreaMm2 = polygonArea(cluster.boundary);
    const boardAreaRatio = boardAreaMm2 > 0 ? boundaryAreaMm2 / boardAreaMm2 : Infinity;
    const optimization = optimizationMetrics(cluster, index + 1, clusterCount);
    const splitWarning = clusterCount > 1 ? [explicitPads.length ? `compact target was decomposed into ${clusterCount} overlapping local boundaries` : `compact target was split into ${clusterCount} local clusters; long pad-free spans stay available to the router`] : [];
    if (!Number.isFinite(boardAreaRatio) || boardAreaRatio > MAX_COMPACT_BOARD_AREA_RATIO) {
      const containsAllExplicit = explicitPads.length > 0 && explicitPads.every((pad) => cluster.pads.some((candidate) => padKey(candidate) === padKey(pad)));
      const createDiagnostic = containsAllExplicit ? failed : skipped;
      const plan = createDiagnostic(
        intent,
        layer,
        boardAreaMm2,
        `compact boundary uses ${(boardAreaRatio * 100).toFixed(2)}% of board; limit is ${MAX_COMPACT_BOARD_AREA_RATIO * 100}%`,
        cluster.pads,
        cluster.boundary
      );
      plan.optimization = optimization;
      plan.warnings = splitWarning;
      return plan;
    }
    return {
      intent,
      net: intent.net,
      layer,
      status: "ready",
      targetPads: cluster.pads.map(resolvedPad),
      boundary: cluster.boundary,
      boardAreaMm2,
      boundaryAreaMm2,
      boardAreaRatio,
      optimization,
      warnings: splitWarning
    };
  });
  for (const isolated of optimized.isolatedPads) {
    const normalizedGap = Number.isFinite(isolated.nearestPadFreeGapWidths) ? isolated.nearestPadFreeGapWidths.toFixed(2) : "infinite";
    plans.push(skipped(
      intent,
      layer,
      boardAreaMm2,
      `local cluster has one pad; nearest pad-free gap is ${normalizedGap} pad widths (limit ${intent.maxPadFreeGapWidths})`,
      [isolated.pad]
    ));
  }
  for (const pad of unusablePads) {
    plans.push(skipped(intent, layer, boardAreaMm2, "target pad has no usable geometry", [pad]));
  }
  return plans.length ? plans : [skipped(intent, layer, boardAreaMm2, "compact target produced no usable local clusters", targetPads)];
}
function coalesceSharedPadIntents(items) {
  const buckets = /* @__PURE__ */ new Map();
  for (const item of items) {
    const { intent, layer } = item;
    const key = [
      intent.net,
      layer,
      intent.mode,
      intent.priority,
      intent.maxPadFreeGapWidths
    ].join("\0");
    buckets.set(key, [...buckets.get(key) ?? [], item]);
  }
  const merged = [];
  for (const bucket of buckets.values()) {
    if (bucket[0].intent.mode !== "compact" || bucket.length < 2) {
      merged.push(...bucket);
      continue;
    }
    const parent = bucket.map((_, index) => index);
    const find = (value) => parent[value] === value ? value : parent[value] = find(parent[value]);
    const join = (left, right) => {
      const a = find(left);
      const b = find(right);
      if (a !== b) parent[b] = a;
    };
    const owners = /* @__PURE__ */ new Map();
    bucket.forEach((item, index) => {
      for (const target of item.intent.targets) {
        if (target.kind !== "pad") continue;
        const key = `${target.component}\0${target.pad}`;
        const previous = owners.get(key);
        if (previous === void 0) owners.set(key, index);
        else join(previous, index);
      }
    });
    const components = /* @__PURE__ */ new Map();
    bucket.forEach((item, index) => {
      const root = find(index);
      components.set(root, [...components.get(root) ?? [], item]);
    });
    for (const component of components.values()) {
      if (component.length === 1) {
        merged.push(component[0]);
        continue;
      }
      const first = component.reduce((left, right) => left.order < right.order ? left : right);
      const targets = /* @__PURE__ */ new Map();
      for (const item of component.sort((left, right) => left.order - right.order)) {
        for (const target of item.intent.targets) {
          const key = target.kind === "pad" ? `pad\0${target.component}\0${target.pad}` : `net\0${target.net}`;
          if (!targets.has(key)) targets.set(key, target);
        }
      }
      merged.push({
        ...first,
        intent: { ...first.intent, targets: [...targets.values()] },
        sources: component.map((item) => item.intent)
      });
    }
  }
  return merged.sort((left, right) => left.order - right.order);
}
function planPolygons(pcb, program, options = {}) {
  var _a;
  const started = performance.now();
  const beforeHeap = process.memoryUsage().heapUsed;
  const boardAreaMm2 = polygonArea(((_a = pcb.board) == null ? void 0 : _a.polygon) ?? []);
  const layerIntents = program.polygons.flatMap((intent, order) => resolveLayers(intent.layers).map((layer) => ({ intent, layer, order, sources: [intent] })));
  const plans = coalesceSharedPadIntents(layerIntents).flatMap(({ intent, layer, sources }) => {
    const planned = planIntent(pcb, intent, layer, boardAreaMm2, options);
    if (((sources == null ? void 0 : sources.length) ?? 0) <= 1 || !planned.some((plan) => plan.status === "error")) return planned;
    return sources.flatMap((source2) => planIntent(pcb, source2, layer, boardAreaMm2, options));
  });
  return {
    program,
    plans,
    metrics: {
      elapsedMs: performance.now() - started,
      heapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap,
      ready: plans.filter((plan) => plan.status === "ready").length,
      skipped: plans.filter((plan) => plan.status === "skipped").length,
      errors: plans.filter((plan) => plan.status === "error").length,
      candidateAreaMm2: plans.filter((plan) => plan.status === "ready").reduce((sum, plan) => sum + plan.boundaryAreaMm2, 0)
    }
  };
}
function ringBounds(points) {
  return {
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    bottom: Math.max(...points.map((point) => point.y))
  };
}
function ringBoundsTouch(left, right) {
  const epsilon = 1e-7;
  return left.left <= right.right + epsilon && left.right + epsilon >= right.left && left.top <= right.bottom + epsilon && left.bottom + epsilon >= right.top;
}
function pointOnSegment(point, start, end) {
  const epsilon = 1e-7;
  const cross = (point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x);
  if (Math.abs(cross) > epsilon * Math.max(1, Math.hypot(end.x - start.x, end.y - start.y))) return false;
  return point.x >= Math.min(start.x, end.x) - epsilon && point.x <= Math.max(start.x, end.x) + epsilon && point.y >= Math.min(start.y, end.y) - epsilon && point.y <= Math.max(start.y, end.y) + epsilon;
}
function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    if (pointOnSegment(point, start, end)) return true;
    const crosses = start.y > point.y !== end.y > point.y && point.x < (end.x - start.x) * (point.y - start.y) / (end.y - start.y) + start.x;
    if (crosses) inside = !inside;
  }
  return inside;
}
function segmentsTouch(a, b, c, d) {
  const orientation = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  const epsilon = 1e-7;
  if ((abC > epsilon && abD < -epsilon || abC < -epsilon && abD > epsilon) && (cdA > epsilon && cdB < -epsilon || cdA < -epsilon && cdB > epsilon)) return true;
  return Math.abs(abC) <= epsilon && pointOnSegment(c, a, b) || Math.abs(abD) <= epsilon && pointOnSegment(d, a, b) || Math.abs(cdA) <= epsilon && pointOnSegment(a, c, d) || Math.abs(cdB) <= epsilon && pointOnSegment(b, c, d);
}
function ringsTouch(left, right) {
  if (!left.length || !right.length || !ringBoundsTouch(ringBounds(left), ringBounds(right))) return false;
  if (left.some((point) => pointInRing(point, right)) || right.some((point) => pointInRing(point, left))) return true;
  return left.some((start, leftIndex) => {
    const end = left[(leftIndex + 1) % left.length];
    return right.some((otherStart, rightIndex) => segmentsTouch(start, end, otherStart, right[(rightIndex + 1) % right.length]));
  });
}
function ringSetsTouch(left, right) {
  return left.some((leftRing) => right.some((rightRing) => ringsTouch(leftRing, rightRing)));
}
function resolvedPadLookupKey(pad) {
  return pad.id || `${pad.component ?? ""}:${pad.padNumber}:${pad.x}:${pad.y}:${pad.layer}`;
}
function validateFilledPolygonPlans(pcb, plans) {
  const validatedPlans = plans.map((plan) => ({ ...plan, warnings: [...plan.warnings] }));
  const diagnostics = [];
  for (let planIndex = 0; planIndex < validatedPlans.length; planIndex += 1) {
    const plan = validatedPlans[planIndex];
    if (plan.status !== "ready" || plan.targetPads.length < 2) continue;
    const pads = pcb.pads.filter((pad) => pad.net === plan.net && padOnLayer(pad, plan.layer));
    const polygons = pcb.polygons.filter((polygon) => polygon.net === plan.net && (polygon.layer === plan.layer || polygon.layer === "MULTI"));
    const entities = [
      ...pads.map((pad) => ({ kind: "pad", key: resolvedPadLookupKey(pad), rings: ringsFromRawPad(pad) })),
      ...polygons.map((polygon, index) => ({ kind: "polygon", key: `polygon:${index}`, rings: ringsFromRawPolygon(polygon) }))
    ].filter((entity) => entity.rings.some((ring) => ring.length >= 3));
    const parent = entities.map((_, index) => index);
    const find = (value) => parent[value] === value ? value : parent[value] = find(parent[value]);
    const join = (left, right) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
    };
    for (let left = 0; left < entities.length; left += 1) {
      for (let right = left + 1; right < entities.length; right += 1) {
        if (entities[left].kind === "pad" && entities[right].kind === "pad" && entities[left].key === entities[right].key) {
          join(left, right);
        } else if (ringSetsTouch(entities[left].rings, entities[right].rings)) {
          join(left, right);
        }
      }
    }
    const targetIndices = plan.targetPads.map((target) => entities.findIndex((entity) => entity.kind === "pad" && entity.key === resolvedPadLookupKey(target)));
    const targetRoots = /* @__PURE__ */ new Map();
    const targetCopperGroups = plan.targetPads.map((target, targetIndex) => {
      const entityIndex = targetIndices[targetIndex];
      const root = entityIndex >= 0 ? find(entityIndex) : -1;
      if (root >= 0 && !targetRoots.has(root)) targetRoots.set(root, targetRoots.size + 1);
      return {
        component: target.component,
        padNumber: target.padNumber,
        group: root >= 0 ? targetRoots.get(root) : null
      };
    });
    const connected = targetIndices.length >= plan.targetPads.length && targetIndices.every((index) => index >= 0 && find(index) === find(targetIndices[0]));
    if (connected) {
      diagnostics.push({ planIndex, net: plan.net, layer: plan.layer, status: "ready", targetCopperGroups });
      continue;
    }
    const reason = "native EDA refill did not connect every target pad through filled copper";
    validatedPlans[planIndex] = { ...plan, status: "error", reason };
    diagnostics.push({ planIndex, net: plan.net, layer: plan.layer, status: "error", reason, targetCopperGroups });
  }
  return {
    plans: validatedPlans,
    diagnostics,
    errors: diagnostics.filter((diagnostic) => diagnostic.status === "error").length
  };
}

// src/polygon/kicad-adapter.ts
import { randomUUID } from "crypto";
var numberAt = (node, index, fallback = 0) => {
  const value = Number(atom(node == null ? void 0 : node[index]));
  return Number.isFinite(value) ? value : fallback;
};
var pointAt = (node) => ({
  x: numberAt(node, 1),
  y: numberAt(node, 2)
});
var rotate = (point, degrees) => {
  const radians = degrees * Math.PI / 180;
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians)
  };
};
function transformFootprintPoint(point, at, bottom) {
  const local = bottom ? { x: -point.x, y: point.y } : point;
  const rotated = rotate(local, bottom ? at.rotate : -at.rotate);
  return { x: rotated.x + at.x, y: rotated.y + at.y };
}
function roundedRect(width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r <= 1e-6) return [
    { x: -width / 2, y: -height / 2 },
    { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 },
    { x: -width / 2, y: height / 2 }
  ];
  const points = [];
  const corners = [
    { x: width / 2 - r, y: -height / 2 + r, start: -90 },
    { x: width / 2 - r, y: height / 2 - r, start: 0 },
    { x: -width / 2 + r, y: height / 2 - r, start: 90 },
    { x: -width / 2 + r, y: -height / 2 + r, start: 180 }
  ];
  for (const corner of corners) {
    for (let index = 0; index <= 4; index += 1) {
      const angle = (corner.start + index * 22.5) * Math.PI / 180;
      points.push({ x: corner.x + Math.cos(angle) * r, y: corner.y + Math.sin(angle) * r });
    }
  }
  return points;
}
function ellipse2(width, height) {
  return Array.from({ length: 24 }, (_, index) => {
    const angle = Math.PI * 2 * index / 24;
    return { x: Math.cos(angle) * width / 2, y: Math.sin(angle) * height / 2 };
  });
}
function localPadOutline(pad) {
  const shape = atom(pad[3]) ?? "rect";
  const size = findChild(pad, "size");
  const width = Math.max(1e-3, numberAt(size, 1, 1e-3));
  const height = Math.max(1e-3, numberAt(size, 2, width));
  if (shape === "circle") return ellipse2(width, width);
  if (shape === "oval") return roundedRect(width, height, Math.min(width, height) / 2);
  if (shape === "roundrect") {
    const ratio = numberAt(findChild(pad, "roundrect_rratio"), 1, 0.25);
    return roundedRect(width, height, Math.min(width, height) * ratio);
  }
  return roundedRect(width, height, 0);
}
function source(points) {
  return [points[0].x, points[0].y, "L", ...points.slice(1).flatMap((point) => [point.x, point.y]), "Z"];
}
function rawLayer2(name) {
  if (name === "F.Cu") return "TOP";
  if (name === "B.Cu") return "BOTTOM";
  const inner = /^In(\d+)\.Cu$/.exec(name);
  return inner ? `INNER_${inner[1]}` : name;
}
function padLayer(pad, footprintSide) {
  var _a;
  const layers = (_a = findChild(pad, "layers")) == null ? void 0 : _a.slice(1).map(atom).filter(Boolean);
  if ((layers == null ? void 0 : layers.some((layer) => layer === "*.Cu")) || (layers == null ? void 0 : layers.includes("F.Cu")) && layers.includes("B.Cu")) return "MULTI";
  const copper = layers == null ? void 0 : layers.find((layer) => layer.endsWith(".Cu"));
  return rawLayer2(copper ?? footprintSide);
}
function drillDiameter(pad) {
  var _a;
  const values = ((_a = findChild(pad, "drill")) == null ? void 0 : _a.slice(1).map(atom).map(Number).filter((value) => Number.isFinite(value) && value > 0)) ?? [];
  return values.length ? Math.max(...values) : 0;
}
function rawPads(root) {
  const pads = [];
  const components = [];
  for (const [componentIndex, footprint] of pcbFootprints(root).entries()) {
    const at = footprintAt(footprint);
    const side = footprintLayer(footprint);
    const bottom = side === "B.Cu";
    const designator = footprintReference(footprint) ?? `FP${componentIndex + 1}`;
    const componentPads = [];
    for (const [padIndex, pad] of listChildren(footprint, "pad").entries()) {
      const padAt = findChild(pad, "at");
      const center = transformFootprintPoint(pointAt(padAt), at, bottom);
      const padRotation = numberAt(padAt, 3);
      const outline = localPadOutline(pad).map((point) => rotate(point, -padRotation)).map((point) => ({ x: point.x + numberAt(padAt, 1), y: point.y + numberAt(padAt, 2) })).map((point) => transformFootprintPoint(point, at, bottom));
      componentPads.push(...outline);
      const drill = drillDiameter(pad);
      pads.push({
        id: childText(pad, "uuid"),
        component: designator,
        x: center.x,
        y: center.y,
        net: padNet(pad),
        padNumber: padNumber(pad) ?? String(padIndex + 1),
        layer: padLayer(pad, side),
        shape: ["POLYGON", source(outline)],
        rotation: 0,
        ...drill > 0 ? { hole: { data: [drill], offsetX: 0, offsetY: 0, rotation: 0 } } : {}
      });
    }
    const xs = componentPads.map((point) => point.x);
    const ys = componentPads.map((point) => point.y);
    components.push({
      designator,
      x: at.x,
      y: at.y,
      rotate: at.rotate,
      layer: rawLayer2(side),
      ...xs.length ? { bbox: { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) } } : {}
    });
  }
  return { pads, components };
}
function nodeNetName(root, node) {
  var _a;
  const net = findChild(node, "net");
  if (!net) return "";
  if (net.length >= 3) return atom(net[2]) ?? "";
  const value = atom(net[1]) ?? "";
  if (!/^\d+$/.test(value)) return value;
  return atom((_a = listChildren(root, "net").find((item) => atom(item[1]) === value)) == null ? void 0 : _a[2]) ?? "";
}
function arcAngle(start, mid, end) {
  const determinant = 2 * (start.x * (mid.y - end.y) + mid.x * (end.y - start.y) + end.x * (start.y - mid.y));
  if (Math.abs(determinant) < 1e-12) return 0;
  const start2 = start.x ** 2 + start.y ** 2;
  const mid2 = mid.x ** 2 + mid.y ** 2;
  const end2 = end.x ** 2 + end.y ** 2;
  const center = {
    x: (start2 * (mid.y - end.y) + mid2 * (end.y - start.y) + end2 * (start.y - mid.y)) / determinant,
    y: (start2 * (end.x - mid.x) + mid2 * (start.x - end.x) + end2 * (mid.x - start.x)) / determinant
  };
  const angle = (point) => Math.atan2(point.y - center.y, point.x - center.x);
  const tau = Math.PI * 2;
  const normalized = (value) => (value % tau + tau) % tau;
  const from = angle(start);
  const to = angle(end);
  const through = angle(mid);
  const ccwSpan = normalized(to - from);
  const ccwMid = normalized(through - from);
  return (ccwMid <= ccwSpan ? ccwSpan : ccwSpan - tau) * 180 / Math.PI;
}
function zonePolygons(root) {
  var _a;
  const polygons = [];
  for (const zone of listChildren(root, "zone")) {
    const net = nodeNetName(root, zone);
    const zoneLayers = (_a = findChild(zone, "layers")) == null ? void 0 : _a.slice(1).map(atom).filter(Boolean);
    const layers = (zoneLayers == null ? void 0 : zoneLayers.length) ? zoneLayers : [childText(zone, "layer") ?? "F.Cu"];
    const filled = listChildren(zone, "filled_polygon");
    const contours = filled.length ? filled : listChildren(zone, "polygon");
    for (const contour of contours) {
      const points = listChildren(findChild(contour, "pts") ?? [], "xy").map(pointAt);
      if (points.length < 3) continue;
      const contourLayer = childText(contour, "layer");
      for (const layer of contourLayer ? [contourLayer] : layers) {
        polygons.push({ net, layer: rawLayer2(layer), fill: true, lineWidth: 0, sources: [source(points)] });
      }
    }
  }
  return polygons;
}
function kicadToRawPcb(root, options = {}) {
  const outline = boardOutline(root);
  const { pads, components } = rawPads(root);
  const tracks = listChildren(root, "segment").map((segment) => ({
    ...(() => {
      const start = pointAt(findChild(segment, "start"));
      const end = pointAt(findChild(segment, "end"));
      return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
    })(),
    width: numberAt(findChild(segment, "width"), 1, 0.2),
    layer: rawLayer2(childText(segment, "layer") ?? "F.Cu"),
    net: nodeNetName(root, segment)
  }));
  const arcs = listChildren(root, "arc").map((arc) => {
    const start = pointAt(findChild(arc, "start"));
    const mid = pointAt(findChild(arc, "mid"));
    const end = pointAt(findChild(arc, "end"));
    return {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      arcAngle: arcAngle(start, mid, end),
      width: numberAt(findChild(arc, "width"), 1, 0.2),
      layer: rawLayer2(childText(arc, "layer") ?? "F.Cu"),
      net: nodeNetName(root, arc)
    };
  });
  const vias = listChildren(root, "via").map((via) => {
    const at = pointAt(findChild(via, "at"));
    return {
      ...at,
      net: nodeNetName(root, via),
      diameter: numberAt(findChild(via, "size"), 1, 0.6),
      drill: numberAt(findChild(via, "drill"), 1, 0.3)
    };
  });
  return {
    board: { polygon: outline.points },
    components,
    pads,
    tracks,
    arcs,
    vias,
    polygons: options.includeZones === false ? [] : zonePolygons(root)
  };
}
function removeKicadZones(root) {
  let removed = 0;
  for (let index = root.length - 1; index >= 0; index -= 1) {
    const node = root[index];
    if (!isSExpressionList(node) || listHead(node) !== "zone") continue;
    root.splice(index, 1);
    removed += 1;
  }
  return removed;
}
function zoneNode(plan, options, exportPriority) {
  var _a;
  if (!plan.boundary) throw new Error("cannot export a zone plan without a boundary");
  const clearance = Math.max(0, ((_a = options.clearanceForNet) == null ? void 0 : _a.call(options, plan.net)) ?? 0.2);
  const minThickness = Math.max(1e-3, options.minThickness ?? 0.1);
  const connectPads = options.padConnection === "thermal" ? [token("connect_pads"), [token("clearance"), token(String(clearance))]] : [token("connect_pads"), token("yes"), [token("clearance"), token(String(clearance))]];
  return [
    token("zone"),
    [token("net"), token(plan.net, true)],
    [token("layer"), token(plan.layer === "TOP" ? "F.Cu" : plan.layer === "BOTTOM" ? "B.Cu" : plan.layer.replace("INNER_", "In") + ".Cu", true)],
    [token("uuid"), token(randomUUID(), true)],
    [token("name"), token(`copilot-router:${plan.net}:${plan.layer}:${plan.intent.mode}`, true)],
    [token("hatch"), token("edge"), token("0.5")],
    ...exportPriority > 0 ? [[token("priority"), token(String(exportPriority))]] : [],
    connectPads,
    [token("min_thickness"), token(String(minThickness))],
    [
      token("fill"),
      token("yes"),
      [token("thermal_gap"), token(String(Math.max(clearance, 0.2)))],
      [token("thermal_bridge_width"), token("0.3")],
      [token("island_removal_mode"), token("0")]
    ],
    [token("polygon"), [
      token("pts"),
      ...plan.boundary.map((point) => [token("xy"), token(String(point.x)), token(String(point.y))])
    ]]
  ];
}
function appendPlannedZones(root, plans, options = {}) {
  let count = 0;
  const ready = plans.filter((plan) => plan.status === "ready" && plan.boundary);
  const grouped = /* @__PURE__ */ new Map();
  for (const plan of ready) {
    const key = `${plan.net}\0${plan.layer}\0${plan.intent.mode}\0${plan.intent.priority}`;
    grouped.set(key, [...grouped.get(key) ?? [], plan]);
  }
  const merged = [...grouped.values()].flatMap((group) => {
    const template = group[0];
    const minimumFeatureMm = group.reduce((minimum, plan) => {
      var _a;
      return Math.min(minimum, ((_a = plan.optimization) == null ? void 0 : _a.minimumFeatureMm) ?? Infinity);
    }, Infinity);
    return mergeOctilinearBoundaries(
      group.map((plan) => plan.boundary),
      Number.isFinite(minimumFeatureMm) ? minimumFeatureMm : 0
    ).map((boundary) => ({ ...template, boundary }));
  });
  for (const [index, plan] of merged.entries()) {
    const exportPriority = plan.intent.priority * 1e3 + merged.length - index;
    root.push(zoneNode(plan, options, exportPriority));
    count += 1;
  }
  return count;
}

export {
  MAX_PAD_FREE_GAP_WIDTHS,
  PAD_ENVELOPE_EXPANSION_RATIO,
  DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM,
  DEFAULT_OBSTACLE_CLEARANCE_MM,
  MIN_BOUNDARY_FEATURE_WIDTH_RATIO,
  MAX_OCTILINEAR_ENVELOPE_AREA_RATIO,
  MAX_ADAPTIVE_CORRIDOR_WIDTH_RATIO,
  isOctilinearBoundary,
  mergeOctilinearBoundaries,
  MAX_COMPACT_BOARD_AREA_RATIO,
  ringsFromRawPolygon,
  ringsFromRawPad,
  planPolygons,
  validateFilledPolygonPlans,
  transformFootprintPoint,
  kicadToRawPcb,
  removeKicadZones,
  appendPlannedZones
};
