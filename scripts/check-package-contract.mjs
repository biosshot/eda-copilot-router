import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const distRoot = resolve(process.env.COPILOT_ROUTER_PACKAGE_DIST ?? join(root, "package-dist"))
const api = await import(pathToFileURL(join(distRoot, "index.js")).href)
const dsl = await import(pathToFileURL(join(distRoot, "intent", "index.js")).href)
const schema = await import(pathToFileURL(join(distRoot, "schema.js")).href)
await import(pathToFileURL(join(distRoot, "adapters", "contracts.js")).href)
const managedAssets = await import(pathToFileURL(join(distRoot, "backends", "assets.js")).href)
const krt = await import(pathToFileURL(join(distRoot, "backends", "krt.js")).href)

assert.equal(typeof api.run, "function")
assert.equal(typeof api.validateRoutingBoard, "function")
assert.equal(typeof api.importKiCadRoutingBoard, "function")
assert.equal(typeof api.applyKiCadRoutingResult, "function")
assert.equal(typeof dsl.compileRoutingDsl, "function")
assert.equal(typeof schema.ROUTING_BOARD_JSON_SCHEMA, "object")
assert.equal(typeof managedAssets.prepareManagedRouterAsset, "function")
assert.equal(typeof krt.createKrtBackend, "function")
assert.equal(krt.createKrtBackend().id, "krt")
assert.equal(typeof krt.buildKrtSpecialCandidates, "function")
const specialCandidates = krt.buildKrtSpecialCandidates(16, 4)
assert.equal(specialCandidates.length, 16)
assert.deepEqual(specialCandidates[0], {
  id: "original-rip0", ordering: "original", mpsReverseRounds: false, maxRipup: 0,
})
assert.ok(specialCandidates.some((candidate) => candidate.mpsReverseRounds === true))
assert.ok(specialCandidates.some((candidate) => candidate.maxRipup > 0))
assert.ok(specialCandidates.every((candidate) => candidate.maxRipup >= 0))
assert.equal(krt.buildKrtSpecialCandidates(32, 4).length, 16, "special portfolio must hard-cap at 16")
assert.equal(krt.parseKrtDrcViolationCount("Checking USB_DP for DRC... OK"), 0)
assert.equal(krt.parseKrtDrcViolationCount("Checking USB_DP for DRC... OK (1 same-net copper warning(s))"), 0)
assert.equal(krt.parseKrtDrcViolationCount("Checking USB_DP for DRC... FAILED (3 violations)"), 3)
assert.equal(krt.parseKrtDrcViolationCount("check_drc produced no summary"), undefined)
assert.deepEqual(
  krt.krtAutomaticFanoutNets(["SIG", "USB_DP", "SIG", "USB_DM"], ["USB_DP", "USB_DM"]),
  ["SIG"],
  "automatic fanout must not pre-route copper owned by the special stage",
)
assert.equal(typeof krt.prepareKrtRuntime, "function")
assert.equal(typeof krt.prepareManagedPython, "function")
assert.equal(krt.MANAGED_PYTHON_VERSION, "3.12.14-20260814")
assert.match(krt.managedPythonRelease().url, /python-build-standalone\/releases\/download\/20260814/)
assert.deepEqual(krt.KRT_QUALITY_PROFILES, {
  fast: {
    gridStep: 0.1,
    maxIterations: 120_000, maxProbeIterations: 5_000, maxRipup: 2, heuristicWeight: 2,
    viaCost: 50, viaProximityCost: 10, turnCost: 1_000, directionPreferenceCost: 250,
    dynamicIterations: false, ripupBlockerSelect: "cost", ripupAbandonMetric: "stranded",
    neckdownLength: 0.5, neckdownTaperLength: 0.5,
  },
  balanced: {
    gridStep: 0.1,
    maxIterations: 300_000, maxProbeIterations: 5_000, maxRipup: 4, heuristicWeight: 1.8,
    viaCost: 50, viaProximityCost: 10, turnCost: 1_000, directionPreferenceCost: 250,
    dynamicIterations: false, ripupBlockerSelect: "count", ripupAbandonMetric: "stranded",
    neckdownLength: 0.5, neckdownTaperLength: 0.5,
  },
  "quality-first": {
    gridStep: 0.05,
    maxIterations: 600_000, maxProbeIterations: 10_000, maxRipup: 5, heuristicWeight: 1.3,
    viaCost: 80, viaProximityCost: 16, turnCost: 1_500, directionPreferenceCost: 400,
    dynamicIterations: false, ripupBlockerSelect: "cost", ripupAbandonMetric: "complete-nets",
    neckdownLength: 0.5, neckdownTaperLength: 0.5,
  },
  "completion-first": {
    gridStep: 0.05,
    maxIterations: 750_000, maxProbeIterations: 10_000, maxRipup: 5, heuristicWeight: 1.9,
    viaCost: 10, viaProximityCost: 0, turnCost: 250, directionPreferenceCost: 0,
    dynamicIterations: true, ripupBlockerSelect: "mincut", ripupAbandonMetric: "weighted-probe",
    neckdownLength: 0.5, neckdownTaperLength: 0.5,
  },
})
assert.deepEqual(krt.KRT_RIPUP_BLOCKER_SELECT_CHOICES, [
  "count", "near-target", "bidir", "mincut", "cost",
])
assert.deepEqual(krt.KRT_RIPUP_ABANDON_METRIC_CHOICES, [
  "stranded", "total-pads", "complete-nets", "congestion",
  "history", "weighted", "probe", "weighted-probe",
])
assert.match(krt.krtManagedRelease().url, /KiCadRoutingTools-0\.20\.4\.zip$/)
assert.deepEqual(krt.KRT_REQUIRED_NECKDOWN_ENVIRONMENT, {
  KICAD_IMPEDANCE_NECKDOWN: "1",
}, "KRT impedance neck-down must never be disabled by the adapter")
assert.equal(api.createPcbSnapshotV1, undefined)
assert.equal(api.routePcb, undefined)
assert.equal(api.captureLegacyRawPcbV1, undefined)

const ruleValues = {
  clearanceMm: 0.2,
  edgeClearanceMm: 0.5,
  minTrackWidthMm: 0.2,
  preferredTrackWidthMm: 0.2,
  via: {
    minDiameterMm: 0.5,
    preferredDiameterMm: 0.6,
    minDrillMm: 0.3,
    preferredDrillMm: 0.3,
  },
  differential: { trackWidthMm: 0.2, gapMm: 0.2, maxSkewMm: 0.25 },
}

const emptyCopper = { tracks: [], vias: [], zones: [] }
const board = {
  outline: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
  cutouts: [],
  layers: [
    { name: "F.Cu", index: 0, side: "top" },
    { name: "B.Cu", index: 1, side: "bottom" },
  ],
  nets: [{ name: "VCC" }, { name: "GND" }, { name: "USB_DP" }, { name: "USB_DM" }],
  components: [
    { designator: "U1", at: { x: 4, y: 5 }, rotationDeg: 0, side: "top" },
    { designator: "C1", at: { x: 8, y: 5 }, rotationDeg: 0, side: "top" },
  ],
  pads: [
    { component: "U1", number: "1", net: "VCC", at: { x: 4, y: 5 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 1, heightMm: 1 } },
    { component: "C1", number: "1", net: "VCC", at: { x: 8, y: 5 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 1, heightMm: 1 } },
    { component: "C1", number: "2", net: "GND", at: { x: 8, y: 6 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "circle", diameterMm: 1 } },
    { component: "U1", number: "2", net: "USB_DP", at: { x: 4, y: 6 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 0.5, heightMm: 0.5 } },
    { component: "U1", number: "3", net: "USB_DM", at: { x: 4, y: 7 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 0.5, heightMm: 0.5 } },
  ],
  keepouts: [],
  stackup: {
    fallbackCopperThicknessOz: 1,
    layers: [
      { kind: "copper", layer: "F.Cu", thicknessMm: 0.03479 },
      { kind: "dielectric", thicknessMm: 1.53, relativePermittivity: 4.2 },
      { kind: "copper", layer: "B.Cu", thicknessMm: 0.03479 },
    ],
  },
  rules: {
    default: ruleValues,
    nets: ["VCC", "GND", "USB_DP", "USB_DM"].map((net) => ({ net, values: ruleValues })),
  },
  copper: { fixed: emptyCopper, editable: emptyCopper },
}

assert.equal(api.validateRoutingBoard(board).ok, true)
const netlessZone = {
  layers: ["F.Cu"],
  outline: { outer: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }] },
}
assert.equal(api.validateRoutingBoard({
  ...board,
  copper: { fixed: { ...emptyCopper, zones: [netlessZone] }, editable: emptyCopper },
}).ok, true, "unknown-net copper regions are valid immutable obstacles")
assert.equal(api.validateRoutingBoard({
  ...board,
  copper: { fixed: emptyCopper, editable: { ...emptyCopper, zones: [netlessZone] } },
}).ok, false, "router-owned zones still require an electrical net")

const nativeBusDefaults = dsl.compileRoutingDsl(`busDetect(true); runRouting()`)
assert.equal(nativeBusDefaults.busDetect, true)
assert.equal(dsl.compileRoutingDsl(`busDetect(false); runRouting()`).busDetect, undefined)
const explicitBus = dsl.compileRoutingDsl(`
  busDetect({ detectionRadiusMm: 3, minNets: 3, attractionRadiusMm: 4 })
  runRouting()
`)
assert.deepEqual(explicitBus.busDetect, {
  detectionRadiusMm: 3, minNets: 3, attractionRadiusMm: 4,
})
const busStage = {
  pythonPath: "python", krtDirectory: ".", layers: ["F.Cu", "B.Cu"],
  rules: { trackWidth: 0.2, clearance: 0.2, viaSize: 0.6, viaDrill: 0.3 },
  fabOverridesPath: "fab.txt", diffPairs: [], matchedGroups: [], remainingNets: ["VCC"],
}
const nativeBusArgs = krt.buildKrtRemainingArgs("input.kicad_pcb", "output.kicad_pcb", {
  ...busStage, busDetect: true,
}, ["VCC"])
assert.ok(nativeBusArgs.includes("--bus"))
assert.ok(!nativeBusArgs.includes("--bus-detection-radius"))
assert.ok(!nativeBusArgs.includes("--bus-min-nets"))
assert.ok(!nativeBusArgs.includes("--bus-attraction-radius"))
const explicitBusArgs = krt.buildKrtRemainingArgs("input.kicad_pcb", "output.kicad_pcb", {
  ...busStage, busDetect: explicitBus.busDetect,
}, ["VCC"])
assert.equal(explicitBusArgs[explicitBusArgs.indexOf("--bus-detection-radius") + 1], "3")
assert.equal(explicitBusArgs[explicitBusArgs.indexOf("--bus-min-nets") + 1], "3")
assert.equal(explicitBusArgs[explicitBusArgs.indexOf("--bus-attraction-radius") + 1], "4")
assert.throws(() => dsl.compileRoutingDsl(`drc({ via: { from: "TOP", to: "BOTTOM" } }); runAll()`), /unknown field/i,
  "via layer spans must stay hidden from the public contract")

const allDsl = `
const commandResult = runAll()
if (commandResult !== undefined) throw new Error("terminal command returned a value")
`
assert.equal(dsl.compileRoutingDsl(allDsl).operation, "all")
assert.throws(() => dsl.compileRoutingDsl("runRouting(); runAll()"), /exactly one terminal/i)
assert.equal(dsl.compileRoutingDsl("runCopper()").operation, "copper")
assert.equal(dsl.compileRoutingDsl("stack({ layers: [{ kind: 'copper', name: 'TOP' }, { kind: 'copper', name: 'BOTTOM' }] }); applyStackup()").operation, "apply-stackup")
assert.throws(() => dsl.compileRoutingDsl("runCopper(); applyStackup(); runRouting()"), /exactly one terminal/i)
assert.throws(() => dsl.compileRoutingDsl("polygon('VCC').connect(pad('U1', 1))"), /terminal command/i)
const fanoutPolicy = dsl.compileRoutingDsl(`
  fanout(component("U1"), { method: "underpad", extensionMm: 0.3 })
  fanout(pad("U2", 4), { method: "stub" })
  disableFanout(component("U3"), pad("U1", 2))
  disableFanout(pad("U1", 2), pad("U1", 3))
  runRouting()
`)
assert.deepEqual(fanoutPolicy.fanouts, [
  { target: { kind: "component", component: "U1" }, method: "underpad", extensionMm: 0.3 },
  { target: { kind: "pad", component: "U2", pad: "4" }, method: "stub", extensionMm: 0.1 },
])
assert.deepEqual(fanoutPolicy.fanoutExclusions, [
  { kind: "component", component: "U3" },
  { kind: "pad", component: "U1", pad: "2" },
  { kind: "pad", component: "U1", pad: "3" },
])
assert.throws(() => dsl.compileRoutingDsl("disableFanout(); runRouting()"), /requires component/i)
assert.throws(() => dsl.compileRoutingDsl('fanout(component("U1"), { method: "buried" }); runRouting()'), /method must be/i)
assert.throws(() => dsl.compileRoutingDsl('fanout(component("U1"), { extensionMm: -1 }); runRouting()'), /must be >= 0/i)
assert.equal(dsl.validateRoutingProgram({
  polygons: [], planes: [], signalNets: [], powerNets: [], differentialPairs: [], matchedGroups: [],
  operation: "route", backend: "legacy-backend",
}).valid, false, "backend-specific fields must not enter the routing DSL")

const specialProgram = dsl.compileRoutingDsl(`
  diffPair("usb", { positive: "USB_DP", negative: "USB_DM", gapMm: 0.25 })
  runAll()
`)
const specialRules = dsl.compileRoutingRules(board, specialProgram)
assert.deepEqual(specialRules.effective.differentialPairs, [{
  id: "usb", positive: "USB_DP", negative: "USB_DM",
}])
assert.equal(krt.selectKrtGridStep({ board, program: specialProgram, rules: specialRules.effective }, 0.1), 0.1)

const finePitchProgram = dsl.compileRoutingDsl(`
  signalNet("VCC", { minTrackWidthMm: 0.127 })
  runRouting()
`)
const finePitchRules = dsl.compileRoutingRules(board, finePitchProgram)
assert.equal(
  krt.selectKrtGridStep({ board, program: finePitchProgram, rules: finePitchRules.effective }, 0.1),
  0.1,
  "the universal 0.127 mm neck-down floor must not slow routing around ordinary large pads",
)
const finePitchBoard = {
  ...board,
  pads: board.pads.map((pad, index) => index === 0
    ? { ...pad, shape: { kind: "rect", widthMm: 0.28, heightMm: 0.5 } }
    : pad),
}
assert.equal(
  krt.selectKrtGridStep({ board: finePitchBoard, program: finePitchProgram, rules: finePitchRules.effective }, 0.1),
  0.05,
  "fast/balanced must automatically use the fine grid for a physical fine-pitch terminal",
)

const densePads = [
  [-0.6, -1, 0.28, 0.7], [0.6, -1, 0.28, 0.7],
  [-0.6, 1, 0.28, 0.7], [0.6, 1, 0.28, 0.7],
  [-1, -0.6, 0.7, 0.28], [-1, 0.6, 0.7, 0.28],
  [1, -0.6, 0.7, 0.28], [1, 0.6, 0.7, 0.28],
].map(([x, y, widthMm, heightMm], index) => ({
  component: "UQ", number: String(index + 1), net: "VCC",
  at: { x: 10 + x, y: 10 + y }, rotationDeg: 0,
  layers: ["F.Cu"], shape: { kind: "rect", widthMm, heightMm },
}))
const denseBoard = {
  ...board,
  components: [...board.components, {
    designator: "UQ", at: { x: 10, y: 10 }, rotationDeg: 0, side: "top",
  }],
  pads: [...board.pads, ...densePads],
}
const denseProgram = dsl.compileRoutingDsl(`
  fanout(component("UQ"), { method: "underpad", extensionMm: 0.3 })
  disableFanout(pad("UQ", 1))
  runRouting()
`)
const denseRules = dsl.compileRoutingRules(denseBoard, denseProgram)
const denseFanout = krt.planKrtQfnFanout({
  board: denseBoard,
  program: denseProgram,
  rules: denseRules.effective,
  connectivity: { preconnectedPadGroups: [{ net: "VCC", pads: [{ component: "UQ", pad: "2" }] }] },
}, ["VCC"], 0.05)
assert.equal(denseFanout.length, 1)
assert.ok(!denseFanout[0].padNumbers.includes("1"), "pad-level fanout opt-out must be exact")
assert.ok(denseFanout[0].padNumbers.includes("2"), "polygon connectivity must not suppress a useful package escape")
assert.equal(denseFanout[0].rules.trackWidth, 0.2, "fanout uses the compiled hard neck-down width")
assert.equal(denseFanout[0].method, "underpad")
assert.equal(denseFanout[0].extensionMm, 0.3)
const disabledDenseProgram = dsl.compileRoutingDsl(`disableFanout(component("UQ")); runRouting()`)
const disabledDenseRules = dsl.compileRoutingRules(denseBoard, disabledDenseProgram)
assert.equal(krt.planKrtQfnFanout({
  board: denseBoard, program: disabledDenseProgram, rules: disabledDenseRules.effective,
}, ["VCC"], 0.05).length, 0)

const applyResult = await api.run({
  board,
  dsl: `
    powerNet("VCC", { maxCurrentA: 2, maxTempRiseC: 16 })
    applyDrcRules()
  `,
})
assert.equal(applyResult.status, "complete")
assert.equal(applyResult.operation, "apply-drc")
assert.equal(applyResult.rules.applyRequested, true)
assert.equal(applyResult.copper, undefined)
assert.equal(applyResult.rules.effective.nets.find((item) => item.net === "VCC").values.minTrackWidthMm, 0.2)
assert.equal(applyResult.rules.effective.nets.find((item) => item.net === "VCC").values.preferredTrackWidthMm, 0.6)

const namedClassResult = await api.run({
  board,
  dsl: `
    drc({ clearanceMm: 0.22 })
    netClass("RF", { nets: ["VCC"], trackWidthMm: 0.31 })
    signalNet("VCC", { netClass: "RF" })
    applyDrcRules()
  `,
})
assert.equal(namedClassResult.status, "complete")
assert.equal(namedClassResult.rules.effective.default.clearanceMm, 0.22)
assert.equal(namedClassResult.rules.effective.netClasses[0].name, "RF")
assert.equal(namedClassResult.rules.effective.nets.find((item) => item.net === "VCC").values.preferredTrackWidthMm, 0.31)
assert.equal(namedClassResult.rules.effective.nets.find((item) => item.net === "VCC").values.minTrackWidthMm, 0.2)

const splitNominalAndMinimum = await api.run({
  board,
  dsl: `
    drc({
      minTrackWidthMm: 0.127,
      trackWidthMm: 0.254,
      via: { minDiameterMm: 0.45, diameterMm: 0.6, minDrillMm: 0.2, drillMm: 0.3 }
    })
    applyDrcRules()
  `,
})
assert.equal(splitNominalAndMinimum.status, "complete")
assert.equal(splitNominalAndMinimum.rules.effective.default.minTrackWidthMm, 0.127)
assert.equal(splitNominalAndMinimum.rules.effective.default.preferredTrackWidthMm, 0.254)
assert.deepEqual(splitNominalAndMinimum.rules.effective.default.via, {
  minDiameterMm: 0.45,
  preferredDiameterMm: 0.6,
  minDrillMm: 0.2,
  preferredDrillMm: 0.3,
})
assert.throws(
  () => dsl.compileRoutingDsl(`drc({ preferredTrackWidthMm: 0.25 }); applyDrcRules()`),
  /unknown field.*preferredTrackWidthMm/i,
)

const belowHardFloor = await api.run({
  board,
  dsl: `powerNet("VCC", { minTrackWidthMm: 0.1 }); applyDrcRules()`,
})
assert.equal(belowHardFloor.status, "error")
assert.ok(belowHardFloor.diagnostics.some((item) => (
  item.code === "DSL_RULE_CONFLICT" && item.message.includes("0.127 mm routing floor")
)))

const impedanceResult = await api.run({
  board,
  dsl: `
    stack({
      boardThicknessMm: 1.6,
      layers: [
        { kind: "copper", name: "TOP", thicknessOz: 1 },
        { kind: "dielectric", name: "CORE", thicknessMm: 1.53042, relativePermittivity: 4.2 },
        { kind: "copper", name: "BOTTOM", thicknessOz: 1 },
      ],
    })
    plane({ net: "GND", layers: ["TOP", "BOTTOM"], region: board(), stitching: false })
    signalNet("VCC", {
      allowedLayers: "TOP",
      impedance: { targetOhm: 50, referenceNet: "GND" },
    })
    applyDrcRules()
  `,
})
assert.equal(impedanceResult.status, "complete")
assert.deepEqual(
  impedanceResult.rules.effective.nets.find((item) => item.net === "VCC").values.impedanceReferenceLayers,
  ["F.Cu", "B.Cu"],
  "TOP plane copper plus the BOTTOM reference must resolve grounded coplanar waveguide",
)
assert.equal(
  impedanceResult.rules.effective.nets.find((item) => item.net === "VCC").values.impedanceTopology,
  "grounded-coplanar-waveguide",
)

let backendCalls = 0
const backend = {
  id: "fixture",
  capabilities: {
    supported: [
      "ordinary-routing", "vias", "zones", "differential-pairs",
      "preserve-fixed-copper", "fixed-zone-obstacles",
      "preconnected-pad-groups", "parallel-vias",
    ],
    maxCopperLayers: 2,
  },
  async route(request) {
    backendCalls += 1
    assert.equal(request.program.operation, "all")
    return {
      status: "complete",
      copper: {
        tracks: [{ net: "VCC", layer: "F.Cu", widthMm: 0.3, points: [{ x: 4, y: 5 }, { x: 8, y: 5 }] }],
        vias: [], zones: [],
      },
      metrics: { routedNetCount: 1, viaCount: 0 },
    }
  },
}
const routed = await api.run({ board, dsl: "runAll()", backend })
assert.equal(routed.status, "complete")
assert.equal(routed.operation, "all")
assert.equal(routed.rules.applyRequested, true)
assert.equal(routed.rules.effective.nets.find((item) => item.net === "VCC").values.minTrackWidthMm, 0.2)
assert.equal(routed.copper.tracks.length, 1)
assert.equal(backendCalls, 1)

const stackOnly = await api.run({
  board,
  dsl: `
    stack({
      boardThicknessMm: 1.2,
      layers: [
        { kind: "copper", name: "TOP", thicknessOz: 1 },
        { kind: "dielectric", name: "PREPREG", thicknessMm: 0.2, relativePermittivity: 4.2 },
        { kind: "copper", name: "INNER_1", thicknessOz: 1 },
        { kind: "dielectric", name: "CORE", thicknessMm: 0.9, relativePermittivity: 4.2 },
        { kind: "copper", name: "INNER_2", thicknessOz: 1 },
        { kind: "dielectric", name: "PREPREG_2", thicknessMm: 0.2, relativePermittivity: 4.2 },
        { kind: "copper", name: "BOTTOM", thicknessOz: 1 },
      ],
    })
    applyStackup()
  `,
})
assert.equal(stackOnly.status, "complete")
assert.equal(stackOnly.operation, "apply-stackup")
assert.deepEqual(stackOnly.stackup.effective.layers.filter((layer) => layer.kind === "copper").map((layer) => layer.layer), ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"])
assert.equal(stackOnly.stackup.effective.boardThicknessMm, 1.2)
assert.equal(backendCalls, 1, "applyStackup must not start the routing backend")

const copperOnly = await api.run({
  board,
  backend: { ...backend, async route() { throw new Error("runCopper must not start the routing backend") } },
  dsl: `plane({ net: "GND", layers: "BOTTOM" }); runCopper()`,
})
assert.equal(copperOnly.status, "complete")
assert.equal(copperOnly.operation, "copper")
assert.ok(copperOnly.copper.zones.some((zone) => zone.net === "GND" && zone.layers.includes("B.Cu")))

let fourLayerCalls = 0
const fourLayerBackend = {
  ...backend,
  capabilities: { ...backend.capabilities, maxCopperLayers: 4 },
  async route(request) {
    fourLayerCalls += 1
    assert.deepEqual(request.board.layers.map((layer) => layer.name), ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"])
    assert.equal(request.board.stackup.layers.filter((layer) => layer.kind === "copper").length, 4)
    return { status: "complete", copper: emptyCopper, metrics: { openNetCount: 0 } }
  },
}
const fourLayerRoute = await api.run({
  board,
  backend: fourLayerBackend,
  dsl: `
    stack({ layers: [
      { kind: "copper", name: "TOP" },
      { kind: "dielectric", thicknessMm: 0.2, relativePermittivity: 4.2 },
      { kind: "copper", name: "INNER_1" },
      { kind: "dielectric", thicknessMm: 0.9, relativePermittivity: 4.2 },
      { kind: "copper", name: "INNER_2" },
      { kind: "dielectric", thicknessMm: 0.2, relativePermittivity: 4.2 },
      { kind: "copper", name: "BOTTOM" },
    ] })
    runAll()
  `,
})
assert.equal(fourLayerRoute.status, "complete")
assert.equal(fourLayerCalls, 1)
assert.equal(fourLayerRoute.stackup.applyRequested, true)

const retained = { net: "VCC", layer: "F.Cu", widthMm: 0.2, points: [{ x: 1, y: 1 }, { x: 2, y: 1 }] }
const retainedResult = await api.run({
  board: { ...board, copper: { fixed: emptyCopper, editable: { ...emptyCopper, tracks: [retained] } } },
  backend: fourLayerBackend,
  dsl: "runRouting()",
})
assert.deepEqual(retainedResult.copper.tracks, [retained], "retained editable copper must remain in the replacement result")
assert.equal(retainedResult.clearRouting, undefined, "routing without clearRouting must not authorize native copper deletion")

const clearedResult = await api.run({
  board: { ...board, copper: { fixed: emptyCopper, editable: { ...emptyCopper, tracks: [retained] } } },
  backend: fourLayerBackend,
  dsl: `clearRouting({ nets: ["VCC"], items: ["tracks"] }); runRouting()`,
})
assert.deepEqual(clearedResult.clearRouting, { nets: ["VCC"], items: ["tracks"] })
assert.deepEqual(clearedResult.copper.tracks, [], "explicitly cleared copper must leave the logical result")

const fenced = await api.run({
  board,
  backend,
  dsl: `
    viaStitch("VCC_GUARD", { mode: "along", routes: ["VCC"], net: "GND", pitchMm: 1.5 })
    runAll()
  `,
})
assert.equal(fenced.status, "complete")
assert.ok(fenced.copper.vias.length >= 2)
assert.ok(fenced.copper.vias.every((via) => via.net === "GND"))
assert.ok(fenced.copper.vias.some((via) => String(via.id).startsWith("via-stitch:VCC_GUARD:")))
const fenceBands = new Set(fenced.copper.vias.map((via) => Math.abs(via.at.y - 5).toFixed(3)))
assert.ok(fenceBands.size >= 2, "default along stitch must create multiple lateral rows")

let remainingSawFence = false
const stagedFenceBackend = {
  ...backend,
  async routeSpecial() {
    return {
      status: "complete",
      copper: {
        tracks: [{ net: "VCC", layer: "F.Cu", widthMm: 0.3, points: [{ x: 4, y: 5 }, { x: 8, y: 5 }] }],
        vias: [], zones: [],
      },
    }
  },
  async routeRemaining(request) {
    remainingSawFence = request.board.copper.fixed.vias.some((via) => String(via.id).startsWith("via-stitch:VCC_GUARD:"))
    return { status: "complete", copper: emptyCopper }
  },
}
const stagedFence = await api.run({
  board, backend: stagedFenceBackend,
  dsl: `viaStitch("VCC_GUARD", { mode: "along", routes: ["VCC"], net: "GND", pitchMm: 1.5 }); runAll()`,
})
assert.equal(stagedFence.status, "complete")
assert.equal(remainingSawFence, true, "remaining routing must see core-generated fence vias as fixed copper")

const incompleteFenceBackend = {
  ...stagedFenceBackend,
  async routeSpecial() {
    return {
      status: "partial",
      copper: {
        tracks: [{ net: "VCC", layer: "F.Cu", widthMm: 0.3, points: [{ x: 4, y: 5 }, { x: 8, y: 5 }] }],
        vias: [], zones: [],
      },
      metrics: { openNetCount: 1, openNets: ["VCC"] },
    }
  },
  async routeRemaining() { return { status: "complete", copper: emptyCopper } },
}
const incompleteFence = await api.run({
  board, backend: incompleteFenceBackend,
  dsl: `viaStitch("VCC_GUARD", { mode: "along", routes: ["VCC"], net: "GND", pitchMm: 1.5 }); runAll()`,
})
assert.equal(incompleteFence.copper.vias.length, 0)
assert.ok(incompleteFence.diagnostics.some((item) => item.code === "VIA_STITCH_ALONG_SOURCE_INCOMPLETE"))

const oneViaStitch = api.planViaStitches(
  board,
  {
    tracks: [{ net: "VCC", layer: "F.Cu", widthMm: 0.3, points: [{ x: 0.8, y: 0.8 }, { x: 0.81, y: 0.8 }] }],
    vias: [], zones: [],
  },
  [{ kind: "via-stitch", mode: "along", id: "ONE_IS_NOT_A_FENCE", routes: ["VCC"], net: "GND", pitchMm: 1.5, rows: 1 }],
  board.rules,
  { completedNets: ["VCC"] },
)
assert.equal(oneViaStitch.vias.length, 0, "one legal via must be discarded instead of reporting a successful stitch")
assert.ok(oneViaStitch.diagnostics.some((item) => item.code === "VIA_STITCH_ALONG_INSUFFICIENT"))

const foreignCompactZone = {
  id: "compact:test:VCC:F.Cu", net: "VCC", layers: ["F.Cu"], clearanceMm: 0.2,
  outline: { outer: [{ x: 1.7, y: 1.7 }, { x: 2.3, y: 1.7 }, { x: 2.3, y: 2.3 }, { x: 1.7, y: 2.3 }] },
}
const gridAvoidingRoutedZones = api.planViaStitches(
  board,
  {
    tracks: [], vias: [],
    zones: [{
      id: "plane:test:GND", net: "GND", layers: ["F.Cu", "B.Cu"], clearanceMm: 0.2,
      outline: { outer: board.outline }, fill: { style: "solid" },
    }, foreignCompactZone],
  },
  [{ kind: "via-stitch", mode: "grid", id: "GND_ZONE_CLEARANCE", net: "GND", region: { kind: "board" }, pitchMm: 4, viaInPad: false }],
  board.rules,
  { completedNets: [] },
)
assert.ok(gridAvoidingRoutedZones.vias.length > 0)
assert.ok(gridAvoidingRoutedZones.vias.every((via) => Math.hypot(via.at.x - 2, via.at.y - 2) >= 0.7),
  "via stitches must apply the complete via radius and clearance to routed foreign-net zones")

const compactPlaneProgram = dsl.compileRoutingDsl(`
  polygon("VCC").connect(pad("U1", 1), pad("C1", 1)).on("TOP").compact()
  plane({ net: "GND", layers: "OUTER", region: board(), stitching: { gridMm: 1 } })
  runCopper()
`)
const compactPlaneRules = dsl.compileRoutingRules(board, compactPlaneProgram).effective
const compactPlane = api.planRoutingCopper(board, compactPlaneProgram, compactPlaneRules)
const plannedVccZone = compactPlane.copper.zones.find((zone) => zone.net === "VCC")
assert.ok(plannedVccZone)
assert.ok(compactPlane.copper.vias.length > 0)
const pointInTestRing = (point, ring) => {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index]
    const b = ring[previous]
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
const distanceToTestRing = (point, ring) => Math.min(...ring.map((start, index) => {
  const end = ring[(index + 1) % ring.length]
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length2 = dx * dx + dy * dy
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length2))
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy)
}))
assert.ok(compactPlane.copper.vias.every((via) => {
  const distance = pointInTestRing(via.at, plannedVccZone.outline.outer)
    ? 0
    : distanceToTestRing(via.at, plannedVccZone.outline.outer)
  return distance >= via.diameterMm / 2 + Math.max(
    compactPlaneRules.default.clearanceMm,
    plannedVccZone.clearanceMm ?? 0,
  ) - 1e-7
}), "plane stitching must see compact zones planned in the same copper operation")

const singleBalancedProfiles = []
const singleBalancedBackend = {
  ...backend,
  async route(request) {
    singleBalancedProfiles.push(request.policy.profile)
    return { status: "complete", copper: emptyCopper, metrics: { openNetCount: 0 } }
  },
}
await api.run({
  board, dsl: `quality({ profile: "balanced", maxCandidates: 1 }); runRouting()`, backend: singleBalancedBackend,
})
assert.deepEqual(singleBalancedProfiles, ["balanced"], "one selected profile must mean one backend run")

const cascadeProfiles = []
const cascadeBudgets = []
const cascadeBackend = {
  ...backend,
  async route(request) {
    cascadeProfiles.push(request.policy.profile)
    cascadeBudgets.push(request.policy.maxCandidates)
    const complete = request.policy.profile === "completion-first"
    return {
      status: complete ? "complete" : "partial",
      copper: {
        tracks: complete
          ? [{ net: "VCC", layer: "F.Cu", widthMm: 0.3, points: [{ x: 4, y: 5 }, { x: 8, y: 5 }] }]
          : [],
        vias: [], zones: [],
      },
      metrics: { openNetCount: complete ? 0 : 2, viaCount: 0 },
    }
  },
}
const cascadeResult = await api.run({
  board, dsl: "runRouting()", backend: cascadeBackend,
  policy: { profile: "balanced", maxCandidates: 2 },
})
assert.deepEqual(cascadeProfiles, ["balanced", "completion-first"])
assert.deepEqual(cascadeBudgets, [2, 2], "stage-local backends must receive the caller's bounded candidate budget")
assert.equal(cascadeResult.status, "complete")
assert.equal(cascadeResult.copper.tracks.length, 1)
assert.equal(cascadeResult.metrics.candidateCount, 2)
assert.ok(cascadeResult.diagnostics.some((item) => (
  item.code === "ROUTING_PORTFOLIO_SELECTED" && item.details.selectedProfile === "completion-first"
)))

const qualityCascadeProfiles = []
const qualityCascadeBackend = {
  ...backend,
  async route(request) {
    qualityCascadeProfiles.push(request.policy.profile)
    return { status: "partial", copper: emptyCopper, metrics: { openNetCount: 1 } }
  },
}
await api.run({
  board, dsl: `quality({ profile: "quality-first", maxCandidates: 3 }); runRouting()`, backend: qualityCascadeBackend,
})
assert.deepEqual(qualityCascadeProfiles, ["quality-first", "balanced", "completion-first"])

let earlyStopCalls = 0
const earlyStopBackend = {
  ...backend,
  async route() {
    earlyStopCalls += 1
    return { status: "complete", copper: emptyCopper, metrics: { openNetCount: 0 } }
  },
}
const earlyStopResult = await api.run({
  board, dsl: "runRouting()", backend: earlyStopBackend,
  policy: { profile: "completion-first", maxCandidates: 3 },
})
assert.equal(earlyStopResult.status, "complete")
assert.equal(earlyStopCalls, 1, "a fully routed fast candidate must stop the cascade")
assert.equal(earlyStopResult.metrics.candidateCount, 1)

let deprecatedTimeoutFinished = false
const noInternalTimeoutBackend = {
  ...backend,
  async route() {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    deprecatedTimeoutFinished = true
    return { status: "complete", copper: emptyCopper, metrics: { openNetCount: 0 } }
  },
}
const noInternalTimeoutResult = await api.run({
  board, dsl: "runRouting()", backend: noInternalTimeoutBackend,
  policy: { profile: "fast", timeoutMs: 1 },
})
assert.equal(noInternalTimeoutResult.status, "complete")
assert.equal(deprecatedTimeoutFinished, true, "deprecated timeoutMs must not stop public run()")

const externalAbort = new AbortController()
let backendObservedAbort = false
const abortableBackend = {
  ...backend,
  async route(request) {
    return await new Promise((resolvePromise) => {
      const finishAbort = () => {
        backendObservedAbort = true
        resolvePromise({ status: "error", copper: emptyCopper })
      }
      if (request.signal.aborted) finishAbort()
      else request.signal.addEventListener("abort", finishAbort, { once: true })
    })
  },
}
const abortedRun = api.run({
  board, dsl: "runRouting()", backend: abortableBackend,
  policy: { profile: "completion-first", maxCandidates: 3 },
  signal: externalAbort.signal,
})
await new Promise((resolvePromise) => setImmediate(resolvePromise))
externalAbort.abort("package contract test")
const abortedResult = await abortedRun
assert.equal(backendObservedAbort, true)
assert.equal(abortedResult.status, "error")
assert.ok(abortedResult.diagnostics.some((item) => item.code === "ROUTING_ABORTED"))

let polygonBackendRequest
const polygonBackend = {
  ...backend,
  async route(request) {
    polygonBackendRequest = request
    return { status: "complete", copper: emptyCopper }
  },
}
const polygonResult = await api.run({
  board,
  backend: polygonBackend,
  dsl: `
    polygon("VCC")
      .connect(pad("U1", 1), pad("C1", 1))
      .on("TOP")
      .zone({
        clearanceMm: 0.3,
        minThicknessMm: 0.18,
        fill: { style: "hatched", hatchThicknessMm: 0.25, hatchGapMm: 0.5, hatchOrientationDeg: 225 },
        padConnection: { mode: "thermal", thermalGapMm: 0.2, spokeWidthMm: 0.22, spokeCount: 4, spokeAngleDeg: -45 },
        removeIslandsBelowMm2: 1.5,
      })
      .compact()
    runRouting()
  `,
})
assert.equal(polygonResult.status, "complete")
assert.equal(polygonResult.copper.zones.length, 1)
assert.equal(polygonResult.copper.zones[0].net, "VCC")
assert.equal(polygonResult.copper.zones[0].priority, 1)
assert.equal(polygonResult.copper.zones[0].minThicknessMm, 0.18)
assert.equal(polygonResult.copper.zones[0].clearanceMm, 0.3)
assert.deepEqual(polygonResult.copper.zones[0].fill, {
  style: "hatched", hatchThicknessMm: 0.25, hatchGapMm: 0.5, hatchOrientationDeg: 45,
})
assert.deepEqual(polygonResult.copper.zones[0].padConnection, {
  mode: "thermal", thermalGapMm: 0.2, spokeWidthMm: 0.22, spokeCount: 4, spokeAngleDeg: 135,
})
assert.equal(polygonResult.copper.zones[0].removeIslandsBelowMm2, 1.5)
assert.equal(polygonBackendRequest.board.copper.fixed.zones.length, 1)
assert.equal(polygonBackendRequest.program.polygons.length, 0)
assert.equal(polygonBackendRequest.program.planes.length, 0)
assert.deepEqual(polygonBackendRequest.connectivity.preconnectedPadGroups, [{
  net: "VCC",
  pads: [{ component: "U1", pad: "1" }, { component: "C1", pad: "1" }],
}])

const tappedPowerBoard = {
  ...board,
  pads: [...board.pads, {
    component: "U1", number: "4", net: "VCC", at: { x: 12, y: 5 }, rotationDeg: 0,
    layers: ["F.Cu"], shape: { kind: "rect", widthMm: 0.4, heightMm: 0.4 },
  }],
}
const mainPowerCalls = []
let mainPowerRequest
const mainPowerBackend = {
  ...backend,
  async route(request) {
    mainPowerCalls.push("main")
    mainPowerRequest = request
    return { status: "complete", copper: emptyCopper, metrics: { openNetCount: 0 } }
  },
  async routeSpecial() { throw new Error("powerNet must not enter the logical special stage") },
  async routeRemaining() { throw new Error("a power-only run must stay in the main stage") },
}
const tappedPowerResult = await api.run({
  board: tappedPowerBoard,
  backend: mainPowerBackend,
  dsl: `
    powerNet("VCC", {
      maxCurrentA: 0.1,
      powerPads: [pad("U1", 1), pad("C1", 1)],
      tapWidthMm: "drc-min",
    })
    polygon("VCC").connect(net("VCC")).on("TOP").compact()
    runRouting()
  `,
})
assert.equal(tappedPowerResult.status, "complete")
assert.deepEqual(mainPowerCalls, ["main"])
assert.equal(mainPowerRequest.program.powerNets[0].net, "VCC")
assert.deepEqual(mainPowerRequest.connectivity.preconnectedPadGroups, [{
  net: "VCC",
  pads: [{ component: "U1", pad: "1" }, { component: "C1", pad: "1" }],
}], "net(...) polygons must use explicit powerPads and leave other same-net pads routable")

const planeResult = await api.run({
  board,
  backend: polygonBackend,
  dsl: `
    plane({
      net: "VCC",
      layers: "OUTER",
      region: board(),
      zone: { padConnection: { mode: "none" }, removeIslandsBelowMm2: 2 },
      stitching: { gridMm: 5 }
    })
    runRouting()
  `,
})
assert.equal(planeResult.status, "complete")
assert.equal(polygonBackendRequest.board.copper.fixed.zones.length, 0)
assert.equal(polygonBackendRequest.program.planes.length, 0)
assert.equal(planeResult.copper.zones.length, 1)
assert.deepEqual(planeResult.copper.zones[0].layers, ["F.Cu", "B.Cu"])
assert.equal(planeResult.copper.zones[0].priority, 1)
assert.equal(planeResult.copper.zones[0].minThicknessMm, 0.254)
assert.equal(planeResult.copper.zones[0].padConnection.mode, "none")
assert.equal(planeResult.copper.zones[0].removeIslandsBelowMm2, 2)
assert.ok(planeResult.copper.vias.length > 0)
assert.ok(planeResult.copper.vias.length <= 8)

const viaInPadBoard = {
  ...board,
  components: [...board.components, { designator: "C2", at: { x: 12, y: 5 }, rotationDeg: 0, side: "top" }],
  pads: [...board.pads, {
    component: "C2", number: "1", net: "GND", at: { x: 12, y: 5 }, rotationDeg: 0,
    layers: ["F.Cu"], shape: { kind: "circle", diameterMm: 1 },
  }],
}
const unifiedStitchResult = await api.run({
  board: viaInPadBoard,
  backend: polygonBackend,
  dsl: `
    plane({ net: "GND", layers: "OUTER", region: board(), stitching: false })
    viaStitch("GND_GRID", { mode: "grid", net: "GND", region: board(), pitchMm: 4, viaInPad: true })
    viaStitch("GND_EDGE", { mode: "around", net: "GND", target: board(), pitchMm: 4, rows: 1 })
    runRouting()
  `,
})
assert.equal(unifiedStitchResult.status, "complete")
assert.ok(unifiedStitchResult.copper.vias.some((via) => String(via.id).startsWith("via-stitch:GND_GRID:")))
assert.ok(unifiedStitchResult.copper.vias.some((via) => String(via.id).startsWith("via-stitch:GND_GRID:")
  && via.at.x === 12 && via.at.y === 5), "grid viaInPad must include a legal same-net SMD pad")
assert.ok(unifiedStitchResult.copper.vias.some((via) => String(via.id).startsWith("via-stitch:GND_EDGE:")))
assert.throws(
  () => dsl.compileRoutingDsl(`viaStitch("LIMIT", { mode: "grid", net: "GND", region: board(), pitchMm: 4, maxVias: 2 })`),
  /viaStitch has unknown field\(s\): maxVias/,
)
assert.throws(
  () => dsl.compileRoutingDsl(`plane({ net: "GND", stitching: { maxVias: 2 } })`),
  /plane\.stitching has unknown field\(s\): maxVias/,
)

const returnViaBackend = {
  ...backend,
  async route() {
    return {
      status: "complete",
      copper: {
        tracks: [], zones: [],
        vias: [{ net: "VCC", at: { x: 10, y: 5 }, diameterMm: 0.6, drillMm: 0.3, fromLayer: "F.Cu", toLayer: "B.Cu", type: "through" }],
      },
      metrics: { openNetCount: 0 },
    }
  },
}
const returnViaResult = await api.run({
  board,
  backend: returnViaBackend,
  dsl: `
    viaStitch("VCC_RETURN", { mode: "return", referenceNet: "GND", forNets: ["VCC"], maxDistanceMm: 2 })
    runRouting()
  `,
})
assert.equal(returnViaResult.status, "complete")
assert.ok(returnViaResult.copper.vias.some((via) => via.net === "GND" && String(via.id).startsWith("via-stitch:VCC_RETURN:")))

const groundAndPowerResult = await api.run({
  board,
  backend: polygonBackend,
  dsl: `
    powerNet("VCC", { minTrackWidthMm: 1.85 })
    polygon("VCC").connect(pad("U1", 1), pad("C1", 1)).on("TOP").compact()
    plane({ net: "GND", layers: "OUTER", region: board(), stitching: false })
    runRouting()
  `,
})
assert.equal(groundAndPowerResult.status, "complete")
assert.equal(groundAndPowerResult.rules.effective.nets.find((item) => item.net === "VCC").values.minTrackWidthMm, 1.85)
assert.equal(groundAndPowerResult.rules.effective.nets.find((item) => item.net === "VCC").values.preferredTrackWidthMm, 1.85)
assert.deepEqual(groundAndPowerResult.copper.zones.map((zone) => ({
  net: zone.net, priority: zone.priority, minThicknessMm: zone.minThicknessMm,
})), [
  { net: "VCC", priority: 1, minThicknessMm: 0.254 },
  { net: "GND", priority: 0, minThicknessMm: 0.254 },
])

const weakOnlyRouting = await api.run({
  board,
  dsl: `signalNet("VCC", { trackWidthMm: 0.1 }); runRouting()`,
  backend,
})
assert.equal(weakOnlyRouting.status, "error")
assert.ok(weakOnlyRouting.diagnostics.some((item) => item.code === "DSL_RULE_CONFLICT"))
assert.equal(backendCalls, 2, "preflight must reject before backend")

const weakAll = await api.run({
  board,
  dsl: `signalNet("VCC", { trackWidthMm: 0.1 }); runAll()`,
  backend,
})
assert.equal(weakAll.status, "error")
assert.ok(weakAll.diagnostics.some((item) => item.code === "DSL_RULE_CONFLICT"))
assert.equal(backendCalls, 2)

const unsupportedBackend = {
  ...backend,
  capabilities: { supported: ["ordinary-routing", "preserve-fixed-copper"], maxCopperLayers: 2 },
}
const unsupported = await api.run({
  board,
  dsl: `diffPair("usb", { positive: "USB_DP", negative: "USB_DM" }); runRouting()`,
  backend: unsupportedBackend,
})
assert.equal(unsupported.status, "error")
assert.ok(unsupported.diagnostics.some((item) => item.code === "CAPABILITY_MISMATCH"))

const malformed = await api.run({
  board,
  dsl: "runRouting()",
  backend: {
    ...backend,
    async route() { return { status: "complete", copper: { tracks: [{ net: "VCC" }], vias: [], zones: [] } } },
  },
})
assert.equal(malformed.status, "error")
assert.ok(malformed.diagnostics.some((item) => item.code === "ROUTING_TRACK_INVALID"))
assert.equal(malformed.copper.tracks.length, 1, "post-validation must retain the diagnostic candidate")

const doctor = spawnSync(process.execPath, [join(distRoot, "cli.js"), "doctor"], { cwd: root, encoding: "utf8" })
assert.equal(doctor.status, 0, doctor.stderr)
assert.equal(JSON.parse(doctor.stdout).edaAccess, "KiCad file adapter")

const temporary = await mkdtemp(join(tmpdir(), "copilot-router-package-"))
try {
  const assetPayload = Buffer.from("managed backend fixture\n", "utf8")
  const assetSpec = {
    backend: "fixture-router",
    version: "1.0.0",
    url: `data:application/octet-stream;base64,${assetPayload.toString("base64")}`,
    sha256: createHash("sha256").update(assetPayload).digest("hex"),
    sizeBytes: assetPayload.length,
    archive: "file",
    fileName: "router.bin",
    markers: ["router.bin"],
  }
  const firstAsset = await managedAssets.prepareManagedRouterAsset(assetSpec, {
    cacheDirectory: join(temporary, "asset-cache"),
  })
  assert.equal(firstAsset.source, "download")
  const cachedAsset = await managedAssets.prepareManagedRouterAsset(assetSpec, {
    cacheDirectory: join(temporary, "asset-cache"),
    allowDownload: false,
  })
  assert.equal(cachedAsset.source, "cache")

  const tarContents = Buffer.from("portable runtime fixture\n", "utf8")
  const tarHeader = Buffer.alloc(512)
  tarHeader.write("runtime/bin/python", 0, "utf8")
  tarHeader.write("0000755\0", 100, "ascii")
  tarHeader.write("0000000\0", 108, "ascii")
  tarHeader.write("0000000\0", 116, "ascii")
  tarHeader.write(`${tarContents.length.toString(8).padStart(11, "0")}\0`, 124, "ascii")
  tarHeader.write("00000000000\0", 136, "ascii")
  tarHeader.fill(0x20, 148, 156)
  tarHeader[156] = "0".charCodeAt(0)
  tarHeader.write("ustar\0", 257, "ascii")
  tarHeader.write("00", 263, "ascii")
  const tarChecksum = tarHeader.reduce((sum, value) => sum + value, 0)
  tarHeader.write(`${tarChecksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii")
  const tarPayload = gzipSync(Buffer.concat([
    tarHeader,
    tarContents,
    Buffer.alloc((512 - (tarContents.length % 512)) % 512),
    Buffer.alloc(1024),
  ]))
  const tarAsset = await managedAssets.prepareManagedRouterAsset({
    backend: "fixture-python",
    version: "1.0.0",
    url: `data:application/gzip;base64,${tarPayload.toString("base64")}`,
    sha256: createHash("sha256").update(tarPayload).digest("hex"),
    sizeBytes: tarPayload.length,
    archive: "tar.gz",
    rootDirectory: "runtime",
    markers: ["bin/python"],
  }, { cacheDirectory: join(temporary, "asset-cache") })
  assert.equal(await readFile(join(tarAsset.directory, "bin", "python"), "utf8"), tarContents.toString("utf8"))
  await assert.rejects(
    managedAssets.prepareManagedRouterAsset({
      ...assetSpec,
      version: "1.0.1",
      sha256: "0".repeat(64),
    }, { cacheDirectory: join(temporary, "asset-cache") }),
    error => error?.code === "ROUTER_ASSET_INTEGRITY_FAILED",
  )
  await assert.rejects(
    krt.discoverKrtDirectory(join(temporary, "missing-krt"), { allowDownload: false }),
    error => error?.code === "KRT_OVERRIDE_INVALID",
  )

  const boardPath = join(temporary, "board.json")
  const dslPath = join(temporary, "routing.dsl.js")
  await writeFile(boardPath, JSON.stringify(board), "utf8")
  await writeFile(dslPath, "powerNet('VCC', { maxCurrentA: 2 }); applyDrcRules()", "utf8")
  const validate = spawnSync(
    process.execPath,
    [join(distRoot, "cli.js"), "validate", boardPath, "--dsl", dslPath],
    { cwd: root, encoding: "utf8" },
  )
  assert.equal(validate.status, 0, validate.stderr || validate.stdout)
  assert.equal(JSON.parse(validate.stdout).valid, true)
} finally {
  await rm(temporary, { recursive: true, force: true })
}

process.stdout.write("package contract: ok\n")
