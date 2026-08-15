import assert from "node:assert/strict"
import {
  DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM,
  isOctilinearBoundary,
  MAX_COMPACT_BOARD_AREA_RATIO,
  mergeOctilinearBoundaries,
  PAD_ENVELOPE_EXPANSION_RATIO,
  planPolygons,
  runPolygonDsl,
  transformFootprintPoint,
  validateFilledPolygonPlans,
} from "../dist/polygon/index.js"

assert.equal(DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM, 0.254)

const topRotatedPad = transformFootprintPoint(
  { x: 3.5, y: 1.35 },
  { x: 187.775, y: 118.5, rotate: -90 },
  false,
)
assert.ok(Math.abs(topRotatedPad.x - 186.425) < 1e-9)
assert.ok(Math.abs(topRotatedPad.y - 122) < 1e-9)

const bottomRotatedPad = transformFootprintPoint(
  { x: 2, y: 1 },
  { x: 100, y: 100, rotate: 90 },
  true,
)
assert.ok(Math.abs(bottomRotatedPad.x - 99) < 1e-9)
assert.ok(Math.abs(bottomRotatedPad.y - 98) < 1e-9)

const program = runPolygonDsl(`
polygon("LOCAL")
  .connect(pad("U1", 1), pad("C1", "1"))
  .on(topLayer())
  .compact();

polygon("TUNABLE")
  .connect(pad("T1", 1), pad("T2", 1))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(5.5);

polygon("STRICT")
  .connect(pad("S1", 1), pad("S2", 1))
  .on(topLayer())
  .compact();

polygon("WIDE")
  .connect(net("WIDE"))
  .on(topLayer())
  .compact();

plane({
  net: "GND",
  layers: outerLayers(),
  region: board(),
  priority: 1,
  stitching: {
    gridMm: 5,
    maxPadViaDistanceMm: 10,
    via: "drc-min",
    viaInPad: true,
    maxVias: 500,
  },
});
`)
assert.equal(program.polygons.length, 4)
assert.equal(program.planes.length, 1)
assert.deepEqual(program.planes[0], {
  kind: "plane",
  net: "GND",
  layers: { kind: "outer" },
  region: { kind: "board" },
  paddingMm: 0,
  priority: 1,
  stitching: {
    gridMm: 5,
    maxPadViaDistanceMm: 10,
    via: "drc-min",
    viaInPad: true,
    maxVias: 500,
  },
})
assert.equal("clearance" in program.polygons[0], false)
assert.equal("around" in program.polygons[0], false)
assert.equal("refillBy" in program.polygons[0], false)
assert.throws(() => runPolygonDsl(`polygon("GND").plane()`), /plane is not a function/)
assert.throws(() => runPolygonDsl(`plane({ net: "GND", region: components() })`), /at least one designator/)
assert.throws(() => runPolygonDsl(`plane({ net: "GND", stitching: { via: "small" } })`), /drc-min/)
assert.throws(() => runPolygonDsl(`plane({ net: "GND", region: board(), paddingMm: 2 })`), /reserved/)
assert.throws(() => runPolygonDsl(`polygon("GND").connect(net("OTHER"))`), /cannot connect/)
assert.throws(() => runPolygonDsl(`polygon("GND").connect(net("GND")).on(layers("F.Cu"))`), /universal RawPcb copper layer/)
assert.throws(() => runPolygonDsl(`polygon("GND").connect(net("GND")).maxPadFreeGap(0)`), /finite number > 0/)

const pad = (component, padNumber, net, x, y, layer = "TOP") => ({
  id: `${component}-${padNumber}-${net}`,
  component,
  x,
  y,
  net,
  padNumber: String(padNumber),
  layer,
  shape: ["RECT", 1, 1],
  rotation: 0,
})
const assertCleanBoundary = (plan) => {
  const lengths = plan.boundary.map((point, index) => {
    const next = plan.boundary[(index + 1) % plan.boundary.length]
    return Math.hypot(next.x - point.x, next.y - point.y)
  })
  assert.ok(
    Math.min(...lengths) + 1e-6 >= plan.optimization.minimumFeatureMm,
    `short boundary edge: ${Math.min(...lengths)} mm in ${JSON.stringify(plan.boundary)}`,
  )
  for (let index = 0; index < plan.boundary.length; index += 1) {
    const previous = plan.boundary[(index + plan.boundary.length - 1) % plan.boundary.length]
    const current = plan.boundary[index]
    const next = plan.boundary[(index + 1) % plan.boundary.length]
    const cross = (current.x - previous.x) * (next.y - current.y)
      - (current.y - previous.y) * (next.x - current.x)
    assert.ok(Math.abs(cross) > 1e-9, "redundant collinear boundary vertex")
  }
}
const boundaryPerimeter = (boundary) => boundary.reduce((perimeter, point, index) => {
  const next = boundary[(index + 1) % boundary.length]
  return perimeter + Math.hypot(next.x - point.x, next.y - point.y)
}, 0)
const convexHull = (points) => {
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y)
  const cross = (origin, left, right) => (left.x - origin.x) * (right.y - origin.y)
    - (left.y - origin.y) * (right.x - origin.x)
  const half = (ordered) => {
    const result = []
    for (const point of ordered) {
      while (result.length >= 2 && cross(result.at(-2), result.at(-1), point) <= 1e-9) result.pop()
      result.push(point)
    }
    return result
  }
  return [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)]
}
const boundaryCoversPoint = (boundary, point) => {
  let inside = false
  for (let index = 0; index < boundary.length; index += 1) {
    const first = boundary[index]
    const second = boundary[(index + 1) % boundary.length]
    const cross = (point.x - first.x) * (second.y - first.y)
      - (point.y - first.y) * (second.x - first.x)
    const projection = (point.x - first.x) * (point.x - second.x)
      + (point.y - first.y) * (point.y - second.y)
    if (Math.abs(cross) <= 1e-7 && projection <= 1e-7) return true
    if ((first.y > point.y) !== (second.y > point.y)
      && point.x < (second.x - first.x) * (point.y - first.y) / (second.y - first.y) + first.x) {
      inside = !inside
    }
  }
  return inside
}
const assertRectPadCoverage = (plan, pads) => {
  for (const target of pads) {
    const halfWidth = target.shape[1] / 2
    const halfHeight = target.shape[2] / 2
    for (const corner of [
      { x: target.x - halfWidth, y: target.y - halfHeight },
      { x: target.x + halfWidth, y: target.y - halfHeight },
      { x: target.x + halfWidth, y: target.y + halfHeight },
      { x: target.x - halfWidth, y: target.y + halfHeight },
    ]) assert.ok(boundaryCoversPoint(plan.boundary, corner), `uncovered ${target.id} corner`)
  }
}
const maximumHorizontalCopperSpanAt = (boundary, y) => {
  const intersections = []
  for (let index = 0; index < boundary.length; index += 1) {
    const first = boundary[index]
    const second = boundary[(index + 1) % boundary.length]
    const crosses = (first.y <= y && y < second.y) || (second.y <= y && y < first.y)
    if (!crosses) continue
    const ratio = (y - first.y) / (second.y - first.y)
    intersections.push(first.x + (second.x - first.x) * ratio)
  }
  intersections.sort((left, right) => left - right)
  assert.equal(intersections.length % 2, 0, `odd horizontal intersections at y=${y}`)
  let widest = 0
  for (let index = 1; index < intersections.length; index += 2) {
    widest = Math.max(widest, intersections[index] - intersections[index - 1])
  }
  return widest
}
const longestHorizontalBoundaryEdgeNear = (boundary, y, tolerance) => boundary.reduce((longest, point, index) => {
  const next = boundary[(index + 1) % boundary.length]
  if (Math.abs(next.y - point.y) > 1e-7 || Math.abs(point.y - y) > tolerance) return longest
  return Math.max(longest, Math.abs(next.x - point.x))
}, 0)
const segmentIntersectsOpenBounds = (first, second, bounds) => {
  const epsilon = 1e-7
  const open = {
    left: bounds.left + epsilon,
    right: bounds.right - epsilon,
    top: bounds.top + epsilon,
    bottom: bounds.bottom - epsilon,
  }
  let near = 0
  let far = 1
  for (const [origin, delta, low, high] of [
    [first.x, second.x - first.x, open.left, open.right],
    [first.y, second.y - first.y, open.top, open.bottom],
  ]) {
    if (Math.abs(delta) < epsilon) {
      if (origin <= low || origin >= high) return false
      continue
    }
    const left = (low - origin) / delta
    const right = (high - origin) / delta
    near = Math.max(near, Math.min(left, right))
    far = Math.min(far, Math.max(left, right))
    if (near > far) return false
  }
  return near <= far && far >= 0 && near <= 1
}
const boundaryIntersectsOpenBounds = (boundary, bounds) => {
  if (boundary.some((point, index) =>
    segmentIntersectsOpenBounds(point, boundary[(index + 1) % boundary.length], bounds))) return true
  return boundaryCoversPoint(boundary, {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
  })
}
const pcb = {
  board: { polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] },
  components: [],
  pads: [
    pad("U1", 1, "LOCAL", 10, 10),
    pad("C1", 1, "LOCAL", 12, 10),
    pad("X1", 1, "OTHER", 11, 10),
    pad("J1", 1, "WIDE", 5, 5),
    pad("J2", 1, "WIDE", 95, 45),
    pad("U1", 2, "GND", 10, 12, "MULTI"),
    pad("T1", 1, "TUNABLE", 30, 30),
    pad("T2", 1, "TUNABLE", 36, 30),
    pad("S1", 1, "STRICT", 40, 40),
    pad("S2", 1, "STRICT", 50, 40),
  ],
  tracks: [],
  arcs: [],
  vias: [],
  polygons: [],
}

const first = planPolygons(pcb, program)
const second = planPolygons(pcb, program)
const local = first.plans.find((plan) => plan.net === "LOCAL")
const wide = first.plans.find((plan) => plan.net === "WIDE")
const tunable = first.plans.find((plan) => plan.net === "TUNABLE")
const strict = first.plans.find((plan) => plan.net === "STRICT")
assert.equal(local?.status, "ready")
assert.ok(local.boardAreaRatio <= MAX_COMPACT_BOARD_AREA_RATIO)
assert.ok(isOctilinearBoundary(local.boundary))
assert.equal(tunable?.status, "ready")
assert.ok(tunable.boardAreaRatio <= MAX_COMPACT_BOARD_AREA_RATIO)
assert.ok(isOctilinearBoundary(tunable.boundary))
assert.equal(tunable.optimization?.angleMode, "octilinear")
assert.equal(tunable.optimization?.boundaryVertexCount, tunable.boundary.length)
assert.equal(wide?.status, "skipped")
assert.match(wide?.reason ?? "", /pad-free gap/)
assert.equal(strict?.status, "error")
assert.match(strict?.reason ?? "", /configured maxPadFreeGap/)
assert.equal(first.metrics.errors, 1)
assert.equal(first.program.planes.length, 1)
assert.deepEqual(first.plans.map((plan) => plan.boundary), second.plans.map((plan) => plan.boundary))

const angledProgram = runPolygonDsl(`
polygon("ANGLE")
  .connect(net("ANGLE"))
  .on(topLayer())
  .compact();
`)
const angledPcb = {
  ...pcb,
  pads: [
    { ...pad("A1", 1, "ANGLE", 20, 20), rotation: 17, shape: ["RECT", 1.4, 0.8] },
    { ...pad("A2", 1, "ANGLE", 23, 20), rotation: 33, shape: ["RECT", 1.2, 0.9] },
  ],
}
const angled = planPolygons(angledPcb, angledProgram).plans.find((plan) => plan.status === "ready")
assert.ok(angled?.boundary)
assert.ok(isOctilinearBoundary(angled.boundary))

const densePinProgram = runPolygonDsl(`
polygon("DENSE")
  .connect(pad("C1", 1), pad("U1", 3))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(6);
`)
const densePinPcb = {
  ...pcb,
  pads: [
    { ...pad("C1", 1, "DENSE", 0, 0), shape: ["RECT", 1.782, 2.074] },
    { ...pad("U1", 3, "DENSE", 2.759, 1.136), shape: ["RECT", 0.3, 0.68] },
    { ...pad("U1", 4, "BLOCKER", 2.109, 1.136), shape: ["RECT", 0.3, 0.68] },
  ],
}
const densePin = planPolygons(densePinPcb, densePinProgram, {
  rulesForNet: () => ({ minimumCorridorWidthMm: 0.6, obstacleClearanceMm: 0.2 }),
}).plans[0]
assert.equal(densePin.status, "ready")
assert.ok(isOctilinearBoundary(densePin.boundary))
assert.ok(densePin.optimization.avoidedObstacleCount > 0)

const pocketProgram = runPolygonDsl(`
polygon("POCKET")
  .connect(net("POCKET"))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(8);
`)
const pocketPcb = {
  ...pcb,
  pads: [
    { ...pad("L2", 1, "POCKET", 20, 20), shape: ["RECT", 3, 3] },
    pad("C2", 1, "POCKET", 24, 20),
    pad("U2", 1, "POCKET", 24, 23),
    { ...pad("X2", 1, "BLOCKER", 23, 21), shape: ["RECT", 0.3, 0.3] },
  ],
}
const pocket = planPolygons(pocketPcb, pocketProgram, {
  rulesForNet: () => ({ minimumCorridorWidthMm: 0.6, obstacleClearanceMm: 0.2 }),
}).plans[0]
assert.equal(pocket.status, "ready")
assert.ok(isOctilinearBoundary(pocket.boundary))
// The obstacle no longer forces a global detour: the multi-pad planner may
// choose the two clear local branches and merge their already-clean contours.
assert.ok(pocket.optimization.routeDetourMm < 1e-6)
assert.ok(pocket.optimization.removedVertexCount > 0)
assertCleanBoundary(pocket)

const adaptiveProgram = runPolygonDsl(`
polygon("ADAPTIVE")
  .connect(net("ADAPTIVE"))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(12);
`)
const adaptivePcb = {
  ...pcb,
  pads: [
    pad("P1", 1, "ADAPTIVE", 20, 20),
    pad("P2", 1, "ADAPTIVE", 28, 20),
    pad("P3", 1, "ADAPTIVE", 28, 28),
  ],
}
const adaptive = planPolygons(adaptivePcb, adaptiveProgram, {
  rulesForNet: () => ({ minimumCorridorWidthMm: 0.6, obstacleClearanceMm: 0.2 }),
}).plans[0]
assert.equal(adaptive.status, "ready")
assert.equal(adaptive.optimization.strategy, "mst_corridor")
assert.ok(isOctilinearBoundary(adaptive.boundary))
assert.ok(adaptive.optimization.corridorBodyWidthMaxMm >= adaptive.optimization.corridorWidthMinMm)
assert.ok(
  adaptive.optimization.corridorBodyWidthMaxMm
    <= 1 * (1 + PAD_ENVELOPE_EXPANSION_RATIO) + adaptive.optimization.minimumFeatureMm,
  `unsupported adaptive widening: ${adaptive.optimization.corridorBodyWidthMaxMm}`,
)
// Face-aligned pads may now use a cleaner 90-degree bridge; 45-degree edges
// are permitted, not mandatory.
assertCleanBoundary(adaptive)

const alignedBridgeProgram = runPolygonDsl(`
polygon("ALIGNED_BRIDGE")
  .connect(net("ALIGNED_BRIDGE"))
  .on(topLayer())
  .compact();
`)
const alignedBridgeTargets = [
  { ...pad("AB1", 1, "ALIGNED_BRIDGE", 10, 10), shape: ["RECT", 2, 2] },
  { ...pad("AB2", 1, "ALIGNED_BRIDGE", 20, 10), shape: ["RECT", 2, 2] },
]
const alignedBridgeObstacles = [
  pad("ABX1", 1, "OTHER", 15, 8),
  pad("ABX2", 1, "OTHER", 15, 12),
]
const alignedBridgeClearanceMm = 1.6
const alignedBridge = planPolygons({
  ...pcb,
  pads: [...alignedBridgeTargets, ...alignedBridgeObstacles],
}, alignedBridgeProgram, {
  rulesForNet: () => ({
    minimumCorridorWidthMm: 0.6,
    obstacleClearanceMm: alignedBridgeClearanceMm,
  }),
}).plans[0]
assert.equal(alignedBridge.status, "ready")
assert.equal(alignedBridge.targetPads.length, alignedBridgeTargets.length)
assert.equal(alignedBridge.optimization.clusterCount, 1)
assert.ok(alignedBridge.optimization.avoidedObstacleCount > 0)
assert.ok(alignedBridge.optimization.routeDetourMm > 0)
assert.ok(isOctilinearBoundary(alignedBridge.boundary))
assertRectPadCoverage(alignedBridge, alignedBridgeTargets)
assertCleanBoundary(alignedBridge)
const alignedKeepouts = alignedBridgeObstacles.map((obstacle) => ({
  left: obstacle.x - obstacle.shape[1] / 2 - alignedBridgeClearanceMm,
  right: obstacle.x + obstacle.shape[1] / 2 + alignedBridgeClearanceMm,
  top: obstacle.y - obstacle.shape[2] / 2 - alignedBridgeClearanceMm,
  bottom: obstacle.y + obstacle.shape[2] / 2 + alignedBridgeClearanceMm,
}))
assert.ok(
  alignedKeepouts.every((keepout) => !boundaryIntersectsOpenBounds(alignedBridge.boundary, keepout)),
  `aligned face bridge crossed inflated obstacles: ${JSON.stringify(alignedBridge.boundary)}`,
)
const alignedKeepoutTop = Math.min(...alignedKeepouts.map((keepout) => keepout.top))
const alignedKeepoutBottom = Math.max(...alignedKeepouts.map((keepout) => keepout.bottom))
assert.ok(
  Math.min(...alignedBridge.boundary.map((point) => point.y)) <= alignedKeepoutTop + 1e-6
    || Math.max(...alignedBridge.boundary.map((point) => point.y)) >= alignedKeepoutBottom - 1e-6,
  "aligned face bridge lost its routed detour",
)

const vsysChainProgram = runPolygonDsl(`
polygon("VSYS_CHAIN")
  .connect(net("VSYS_CHAIN"))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(20);
`)
const vsysChainPads = [
  { ...pad("V1", 1, "VSYS_CHAIN", 20, 10), shape: ["RECT", 4, 1.4] },
  { ...pad("V2", 1, "VSYS_CHAIN", 20, 15), shape: ["RECT", 1.5, 3] },
  { ...pad("V3", 1, "VSYS_CHAIN", 20, 19), shape: ["RECT", 1.5, 3] },
]
const vsysChain = planPolygons({ ...pcb, pads: vsysChainPads }, vsysChainProgram, {
  rulesForNet: () => ({ minimumCorridorWidthMm: 0.6, obstacleClearanceMm: 0.2 }),
}).plans[0]
assert.equal(vsysChain.status, "ready")
assert.equal(vsysChain.targetPads.length, vsysChainPads.length)
assert.ok(isOctilinearBoundary(vsysChain.boundary))
assertRectPadCoverage(vsysChain, vsysChainPads)
assertCleanBoundary(vsysChain)
const padInfluenceScale = 1 + PAD_ENVELOPE_EXPANSION_RATIO
const upperSmallPadBottom = vsysChainPads[1].y + vsysChainPads[1].shape[2] * padInfluenceScale / 2
const lowerSmallPadTop = vsysChainPads[2].y - vsysChainPads[2].shape[2] * padInfluenceScale / 2
const smallPadFreeGap = lowerSmallPadTop - upperSmallPadBottom
const smallPadInfluenceWidth = vsysChainPads[1].shape[1] * padInfluenceScale
// At the middle of the pad-free gap, a 45-degree support flare can add at
// most the gap itself to full width. More copper is an unsupported side bubble.
const supportedMidGapWidth = smallPadInfluenceWidth + smallPadFreeGap
const observedMidGapWidth = maximumHorizontalCopperSpanAt(
  vsysChain.boundary,
  (upperSmallPadBottom + lowerSmallPadTop) / 2,
)
assert.ok(
  observedMidGapWidth <= supportedMidGapWidth + vsysChain.optimization.minimumFeatureMm,
  `VSYS side bubble: observed=${observedMidGapWidth}, supported=${supportedMidGapWidth}`,
)

const usbPinBankProgram = runPolygonDsl(`
polygon("USB_PIN_BANK")
  .connect(net("USB_PIN_BANK"))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(20);
`)
const usbPinPads = [-2.4, -0.8, 0.8, 2.4].map((xOffset, index) => ({
  ...pad("QUSB", index + 1, "USB_PIN_BANK", 20 + xOffset, 25.1),
  shape: ["RECT", 0.6, 1.6],
}))
const usbPinBankPads = [
  { ...pad("QUSB", 8, "USB_PIN_BANK", 20, 20), shape: ["RECT", 6, 5] },
  ...usbPinPads,
]
const usbPinBank = planPolygons({ ...pcb, pads: usbPinBankPads }, usbPinBankProgram, {
  rulesForNet: () => ({ minimumCorridorWidthMm: 0.6, obstacleClearanceMm: 0.2 }),
}).plans[0]
assert.equal(usbPinBank.status, "ready")
assert.equal(usbPinBank.targetPads.length, usbPinBankPads.length)
assert.ok(isOctilinearBoundary(usbPinBank.boundary))
assertRectPadCoverage(usbPinBank, usbPinBankPads)
assertCleanBoundary(usbPinBank)
const usbOuterPadEdgeY = usbPinPads[0].y + usbPinPads[0].shape[2] * padInfluenceScale / 2
const usbPinBankLeft = usbPinPads[0].x - usbPinPads[0].shape[1] * padInfluenceScale / 2
const usbPinBankRight = usbPinPads.at(-1).x + usbPinPads.at(-1).shape[1] * padInfluenceScale / 2
const usbPinBankSpan = usbPinBankRight - usbPinBankLeft
const usbOuterEdgeLength = longestHorizontalBoundaryEdgeNear(
  usbPinBank.boundary,
  usbOuterPadEdgeY,
  usbPinBank.optimization.minimumFeatureMm,
)
const usbSpikeOvershoot = Math.max(...usbPinBank.boundary.map((point) => point.y)) - usbOuterPadEdgeY
assert.ok(
  usbOuterEdgeLength >= usbPinBankSpan * 0.8,
  `USB pin bank repeats inter-pad notches: outerEdge=${usbOuterEdgeLength}, span=${usbPinBankSpan}`,
)
assert.ok(
  usbSpikeOvershoot <= usbPinBank.optimization.minimumFeatureMm,
  `USB pin bank has an unsupported spike: overshoot=${usbSpikeOvershoot}`,
)

const lBankPads = [
  { ...pad("QL", 1, "L_BANK", 20, 20), shape: ["RECT", 1, 1] },
  { ...pad("QL", 2, "L_BANK", 22, 20), shape: ["RECT", 1, 1] },
  { ...pad("QL", 3, "L_BANK", 20, 22), shape: ["RECT", 1, 1] },
]
const lBank = planPolygons({ ...pcb, pads: lBankPads }, runPolygonDsl(`
polygon("L_BANK")
  .connect(net("L_BANK"))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(20);
`), {
  rulesForNet: () => ({ minimumCorridorWidthMm: 0.6, obstacleClearanceMm: 0.2 }),
}).plans[0]
assert.equal(lBank.status, "ready")
assertRectPadCoverage(lBank, lBankPads)
assert.ok(isOctilinearBoundary(lBank.boundary))
// Independent row/column banks may form an L, but must not create a 2-D hull
// over the unsupported empty corner.
assert.equal(boundaryCoversPoint(lBank.boundary, { x: 21.5, y: 21.5 }), false)
assertCleanBoundary(lBank)

const localBranchProgram = runPolygonDsl(`
polygon("LOCAL_BRANCH_TREE")
  .connect(net("LOCAL_BRANCH_TREE"))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(20);
`)
const localBranchTargets = [
  { ...pad("A", 1, "LOCAL_BRANCH_TREE", 20, 20), shape: ["RECT", 2, 2] },
  { ...pad("B", 1, "LOCAL_BRANCH_TREE", 24, 20), shape: ["RECT", 2, 2] },
  { ...pad("C", 1, "LOCAL_BRANCH_TREE", 22, 22), shape: ["RECT", 0.3, 0.3] },
]
const localBranchObstacle = {
  ...pad("X", 1, "OTHER", 22, 19),
  shape: ["RECT", 1, 1],
}
const planLocalBranchTree = (targets) => planPolygons({
  ...pcb,
  pads: [...targets, localBranchObstacle],
}, localBranchProgram, {
  rulesForNet: () => ({ minimumCorridorWidthMm: 0.6, obstacleClearanceMm: 0.2 }),
}).plans[0]
const localBranchTree = planLocalBranchTree(localBranchTargets)
assert.equal(localBranchTree.status, "ready")
assertRectPadCoverage(localBranchTree, localBranchTargets)
assert.ok(isOctilinearBoundary(localBranchTree.boundary))
assertCleanBoundary(localBranchTree)
// The normalized-gap MST contains the wide A-B edge. That branch has to
// detour around X, while A-C and B-C are clear local diagonals. A multi-pad
// intent describes desired connectivity, so the planner must choose the
// shorter routed tree rather than preserve the raw-MST topology or require
// several hand-authored intents.
assert.ok(
  localBranchTree.optimization.routeDetourMm < 1e-6,
  `multi-pad tree kept an avoidable detour: ${localBranchTree.optimization.routeDetourMm}`,
)
assert.ok(
  localBranchTree.optimization.mstLengthMm < 6,
  `multi-pad tree kept the raw wide-pad edge: ${localBranchTree.optimization.mstLengthMm}`,
)
const shuffledLocalBranchTree = planLocalBranchTree([
  localBranchTargets[2],
  localBranchTargets[0],
  localBranchTargets[1],
])
assert.equal(shuffledLocalBranchTree.status, "ready")
assert.deepEqual(shuffledLocalBranchTree.boundary, localBranchTree.boundary)

const c2BankProgram = runPolygonDsl(`
polygon("C2_BANK")
  .connect(net("C2_BANK"))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(4.5);
`)
const c2BankTargets = [
  { ...pad("L1", 1, "C2_BANK", 10.315, 12.501), shape: ["RECT", 3.8, 4.8] },
  { ...pad("C2", 2, "C2_BANK", 13.509, 12.501), shape: ["RECT", 0.8, 0.9] },
  ...[10, 10.5, 11, 11.5, 12].map((y, index) => ({
    ...pad("U1", index + 14, "C2_BANK", 16.533, y),
    shape: ["RECT", 0.665, 0.28],
  })),
]
const c2BankObstacles = [
  { ...pad("C2", 1, "BST", 14.509, 12.501), shape: ["RECT", 0.8, 0.9] },
  { ...pad("U1", 19, "BST", 16.533, 12.5), shape: ["RECT", 0.665, 0.28] },
  { ...pad("U1", 20, "RESET", 16.533, 13), shape: ["RECT", 0.665, 0.28] },
]
const c2Bank = planPolygons({
  ...pcb,
  pads: [...c2BankTargets, ...c2BankObstacles],
}, c2BankProgram, {
  rulesForNet: () => ({ minimumCorridorWidthMm: 0.6, obstacleClearanceMm: 0.2 }),
}).plans[0]
assert.equal(c2Bank.status, "ready")
assert.equal(c2Bank.targetPads.length, c2BankTargets.length)
assert.ok(isOctilinearBoundary(c2Bank.boundary))
assertRectPadCoverage(c2Bank, c2BankTargets)
assertCleanBoundary(c2Bank)
// The raw pad MST prefers U1.15 by normalized gap, but reaching it requires a
// long detour above C2.1. Once U1.14-18 are treated as one bank, the external
// connection must use the shorter, lower obstacle-aware entry instead of
// preserving the old horizontal shelf through y=10.5.
assert.equal(
  boundaryCoversPoint(c2Bank.boundary, { x: 15.5, y: 10.5 }),
  false,
  `C2 bank retained the old U1.15 shelf: ${JSON.stringify(c2Bank.boundary)}`,
)
assert.equal(
  boundaryCoversPoint(c2Bank.boundary, { x: 15.5, y: 11.5 }),
  true,
  `C2 bank missed the shorter lower entry: ${JSON.stringify(c2Bank.boundary)}`,
)
assert.ok(
  c2Bank.optimization.routeDetourMm < 1.2,
  `C2 bank kept the longer obstacle detour: ${c2Bank.optimization.routeDetourMm}`,
)

const clearanceSlitProgram = runPolygonDsl(`
polygon("CLEARANCE_SLIT")
  .connect(net("CLEARANCE_SLIT"))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(20);
`)
const clearanceSlitTargets = [
  { ...pad("BN", 1, "CLEARANCE_SLIT", 10, 10), shape: ["RECT", 1, 0.4] },
  { ...pad("BN", 2, "CLEARANCE_SLIT", 12, 10), shape: ["RECT", 1, 0.4] },
]
const clearanceSlitObstacles = [
  { ...pad("XT", 1, "OTHER", 11, 9.709), shape: ["RECT", 0.3, 0.1] },
  { ...pad("XB", 1, "OTHER", 11, 10.291), shape: ["RECT", 0.3, 0.1] },
]
const clearanceSlitPlans = planPolygons({
  ...pcb,
  pads: [...clearanceSlitTargets, ...clearanceSlitObstacles],
}, clearanceSlitProgram, {
  rulesForNet: () => ({ minimumCorridorWidthMm: 0.6, obstacleClearanceMm: 0.2 }),
}).plans
// The expanded bank is 0.48 mm tall. Opposing foreign-clearance cuts leave
// only about 0.082 mm of copper between them: top=9.959002, bottom=10.040998.
// That sub-rule neck is not sufficient evidence for contracting the bank.
// A feasible implementation may route around the slit; otherwise it must
// report a non-ready plan instead of claiming zero-route connectivity.
for (const clearanceSlit of clearanceSlitPlans) {
  if (clearanceSlit.status !== "ready") continue
  assert.ok(isOctilinearBoundary(clearanceSlit.boundary))
  assert.ok(
    clearanceSlit.optimization.routedLengthMm > 0,
    `clearance-slit bank was falsely contracted: ${JSON.stringify(clearanceSlit)}`,
  )
}

const sharedPadProgram = runPolygonDsl(`
polygon("SHARED_PAD")
  .connect(pad("M1", 1), pad("M2", 1))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(12);
polygon("SHARED_PAD")
  .connect(pad("M2", 1), pad("M3", 1))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(12);
`)
const sharedPadPlans = planPolygons({
  ...pcb,
  pads: [
    pad("M1", 1, "SHARED_PAD", 20, 20),
    pad("M2", 1, "SHARED_PAD", 24, 22),
    pad("M3", 1, "SHARED_PAD", 28, 20),
  ],
}, sharedPadProgram, {
  rulesForNet: () => ({ minimumCorridorWidthMm: 0.6, obstacleClearanceMm: 0.2 }),
}).plans.filter((plan) => plan.status === "ready")
assert.equal(sharedPadPlans.length, 1)
assert.equal(sharedPadPlans[0].targetPads.length, 3)
assert.ok(isOctilinearBoundary(sharedPadPlans[0].boundary))
assertCleanBoundary(sharedPadPlans[0])

const sharedPadFallback = planPolygons({
  ...pcb,
  pads: [
    pad("M1", 1, "SHARED_PAD", 20, 20),
    pad("M2", 1, "SHARED_PAD", 24, 22),
    pad("M3", 1, "SHARED_PAD", 45, 20),
  ],
}, sharedPadProgram, {
  rulesForNet: () => ({ minimumCorridorWidthMm: 0.6, obstacleClearanceMm: 0.2 }),
}).plans
assert.equal(sharedPadFallback.filter((plan) => plan.status === "ready").length, 1)
assert.equal(sharedPadFallback.filter((plan) => plan.status === "error").length, 1)

const raggedChainProgram = runPolygonDsl(`
polygon("RAGGED_CHAIN")
  .connect(net("RAGGED_CHAIN"))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(20);
`)
const raggedChainPads = [
  { ...pad("R1", 1, "RAGGED_CHAIN", 10, 25), shape: ["RECT", 5, 5] },
  { ...pad("R2", 1, "RAGGED_CHAIN", 15, 24), shape: ["RECT", 0.8, 0.8] },
  { ...pad("R3", 1, "RAGGED_CHAIN", 18, 26), shape: ["RECT", 1.2, 0.7] },
  { ...pad("R4", 1, "RAGGED_CHAIN", 21, 23), shape: ["RECT", 0.7, 1.5] },
  { ...pad("R5", 1, "RAGGED_CHAIN", 24, 27), shape: ["RECT", 1.8, 0.8] },
  { ...pad("R6", 1, "RAGGED_CHAIN", 28, 24), shape: ["RECT", 0.7, 0.7] },
  { ...pad("R7", 1, "RAGGED_CHAIN", 32, 28), shape: ["RECT", 2, 2] },
]
const raggedChain = planPolygons({ ...pcb, pads: raggedChainPads }, raggedChainProgram, {
  rulesForNet: () => ({ minimumCorridorWidthMm: 0.6, obstacleClearanceMm: 0.2 }),
}).plans[0]
assert.equal(raggedChain.status, "ready")
assert.equal(raggedChain.targetPads.length, raggedChainPads.length)
assert.equal(raggedChain.optimization.clusterCount, 1)
assert.ok(isOctilinearBoundary(raggedChain.boundary))
for (const target of raggedChainPads) {
  const halfWidth = target.shape[1] / 2
  const halfHeight = target.shape[2] / 2
  for (const corner of [
    { x: target.x - halfWidth, y: target.y - halfHeight },
    { x: target.x + halfWidth, y: target.y - halfHeight },
    { x: target.x + halfWidth, y: target.y + halfHeight },
    { x: target.x - halfWidth, y: target.y + halfHeight },
  ]) assert.ok(boundaryCoversPoint(raggedChain.boundary, corner), `uncovered ${target.id} corner`)
}
assertCleanBoundary(raggedChain)
const raggedPerimeter = boundaryPerimeter(raggedChain.boundary)
const raggedHullPerimeter = boundaryPerimeter(convexHull(raggedChain.boundary))
const normalizedTurnDensity = raggedChain.boundary.length
  * raggedChain.optimization.corridorWidthMinMm / raggedPerimeter
const normalizedPerimeter = raggedPerimeter / raggedHullPerimeter
// These are fixture-specific, scale-free regularity budgets rather than a
// general vertex limit: a larger legitimate outline may keep arbitrarily many points.
assert.ok(
  normalizedTurnDensity <= 0.60 && normalizedPerimeter <= 1.28,
  `ragged chain needs regularization: turnDensity=${normalizedTurnDensity}, perimeterRatio=${normalizedPerimeter}`,
)

const islandProgram = runPolygonDsl(`
polygon("ISLAND")
  .connect(net("ISLAND"))
  .on(topLayer())
  .compact();
`)
const islandPcb = {
  ...pcb,
  pads: Array.from({ length: 12 }, (_, index) =>
    pad("U9", index + 1, "ISLAND", 20, 10 + index * 0.5)),
}
const islandPlans = planPolygons(islandPcb, islandProgram).plans.filter((plan) => plan.status === "ready")
assert.equal(islandPlans.length, 1)
assert.equal(islandPlans[0].targetPads.length, 12)
assert.ok(isOctilinearBoundary(islandPlans[0].boundary))

const filledPolygon = (net, left, top, right, bottom) => ({
  net,
  layer: "TOP",
  fill: true,
  lineWidth: 0,
  sources: [[left, top, "L", right, top, right, bottom, left, bottom, "Z"]],
})
const connectedFill = validateFilledPolygonPlans({
  ...pcb,
  polygons: [filledPolygon("TUNABLE", 29, 29, 37, 31)],
}, [tunable])
assert.equal(connectedFill.errors, 0)
assert.equal(connectedFill.plans[0].status, "ready")

const splitFill = validateFilledPolygonPlans({
  ...pcb,
  polygons: [
    filledPolygon("TUNABLE", 29, 29, 31, 31),
    filledPolygon("TUNABLE", 35, 29, 37, 31),
  ],
}, [tunable])
assert.equal(splitFill.errors, 1)
assert.equal(splitFill.plans[0].status, "error")

const mergedBoundaries = mergeOctilinearBoundaries([
  [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }],
  [{ x: 1, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }, { x: 1, y: 2 }],
])
assert.equal(mergedBoundaries.length, 1)
assert.ok(isOctilinearBoundary(mergedBoundaries[0]))

const cleanedMergedBoundaries = mergeOctilinearBoundaries([
  [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }],
  [{ x: 1.95, y: 0.05 }, { x: 4, y: 0.05 }, { x: 4, y: 1.95 }, { x: 1.95, y: 1.95 }],
], 0.1)
assert.equal(cleanedMergedBoundaries.length, 1)
assert.ok(isOctilinearBoundary(cleanedMergedBoundaries[0]))
assert.ok(Math.min(...cleanedMergedBoundaries[0].map((point, index) => {
  const next = cleanedMergedBoundaries[0][(index + 1) % cleanedMergedBoundaries[0].length]
  return Math.hypot(next.x - point.x, next.y - point.y)
})) + 1e-6 >= 0.1)

const boundedSearchProgram = runPolygonDsl(`
polygon("BOUNDED")
  .connect(pad("B1", 1), pad("B2", 1))
  .on(topLayer())
  .compact()
  .maxPadFreeGap(20);
`)
const boundedSearch = planPolygons({
  ...pcb,
  pads: [
    pad("B1", 1, "BOUNDED", 0, 0),
    pad("B2", 1, "BOUNDED", 10, 0),
    { ...pad("X1", 1, "OTHER", 5, 0), shape: ["RECT", 2, 4] },
  ],
}, boundedSearchProgram, {
  rulesForNet: () => ({
    minimumCorridorWidthMm: DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM,
    obstacleClearanceMm: 0.2,
    maxSearchWorkUnits: 1,
  }),
})
assert.equal(boundedSearch.plans.length, 1)
assert.equal(boundedSearch.plans[0].status, "error")
assert.match(boundedSearch.plans[0].reason, /deterministic 1-unit limit/)

const partialBranchProgram = runPolygonDsl(`
polygon("PARTIAL_BRANCH")
  .connect(net("PARTIAL_BRANCH"))
  .on(topLayer())
  .compact();
`)
const partialBranches = planPolygons({
  ...pcb,
  pads: [
    pad("PB1", 1, "PARTIAL_BRANCH", 10, 10),
    pad("PB2", 1, "PARTIAL_BRANCH", 11.5, 10),
    pad("PB3", 1, "PARTIAL_BRANCH", 40, 10),
  ],
}, partialBranchProgram).plans
assert.equal(partialBranches.filter((plan) => plan.status === "ready").length, 1)
assert.equal(partialBranches.filter((plan) => plan.status === "skipped").length, 1)
assert.deepEqual(
  partialBranches.find((plan) => plan.status === "ready").targetPads.map((item) => item.component).sort(),
  ["PB1", "PB2"],
  "a failed distant branch must not erase a ready local boundary",
)

console.log("polygon DSL, octilinear geometry, spike filtering, and deterministic boundary tests passed")
