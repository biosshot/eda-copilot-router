import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
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
const easyedaWasm = await import(pathToFileURL(join(distRoot, "backends", "easyeda-wasm.js")).href)
const hybrid = await import(pathToFileURL(join(distRoot, "backends", "hybrid.js")).href)
const krt = await import(pathToFileURL(join(distRoot, "backends", "krt.js")).href)

assert.equal(typeof api.run, "function")
assert.equal(typeof api.validateRoutingBoard, "function")
assert.equal(typeof api.importKiCadRoutingBoard, "function")
assert.equal(typeof api.applyKiCadRoutingResult, "function")
assert.equal(typeof api.createEasyEdaWasmBackend, "function")
assert.equal(typeof api.createBundledEasyEdaWasmBackend, "function")
assert.equal(typeof api.createHybridBackend, "function")
assert.equal(typeof dsl.compileRoutingDsl, "function")
assert.equal(typeof schema.ROUTING_BOARD_JSON_SCHEMA, "object")
assert.equal(typeof managedAssets.prepareManagedRouterAsset, "function")
assert.equal(typeof easyedaWasm.createEasyEdaWasmBackend, "function")
assert.equal(typeof easyedaWasm.createBundledEasyEdaWasmBackend, "function")
assert.equal(typeof easyedaWasm.createEasyEdaWasmWorkerEngine, "function")
assert.equal(typeof hybrid.createHybridBackend, "function")
assert.equal(hybrid.createHybridBackend().id, "hybrid")
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
assert.deepEqual(krt.parseKrtJsonSummaryMin([
  'JSON_SUMMARY: {"scope":"run","failed":2}',
  'JSON_SUMMARY: {"scope":"reconciliation-subset","failed":0}',
  'JSON_SUMMARY_MIN: {"scope":"merged","failed":0,"open_single":[]}',
].join("\n")), { scope: "merged", failed: 0, open_single: [] })
assert.equal(krt.parseKrtJsonSummaryMin("JSON_SUMMARY_MIN: not-json"), undefined)
assert.equal(krt.parseKrtJsonSummaryMin([
  'JSON_SUMMARY_MIN: {"scope":"merged"}',
  'JSON_SUMMARY_MIN: {"scope":"merged"}',
].join("\n")), undefined, "KRT must emit exactly one compact verdict")
assert.equal(typeof krt.prepareKrtRuntime, "function")
assert.equal(typeof krt.prepareManagedPython, "function")
assert.equal(krt.MANAGED_PYTHON_VERSION, "3.12.14-20260814")
assert.match(krt.managedPythonRelease().url, /python-build-standalone\/releases\/download\/20260814/)
assert.deepEqual(krt.KRT_NATIVE_AUTO_POLICY, {
  gridStep: 0.1, ordering: "mps",
  enableNetRescue: false, enableTerminalEscalation: false,
  ripPreexisting: true, dynamicIterations: false, maxIterations: 200_000,
  planeFinalize: false, finalizeRip: true,
  specialMaxCandidates: 1,
})
assert.equal(krt.KRT_QUALITY_PROFILES, undefined)
assert.deepEqual(krt.buildKrtNativeRecoveryEnvironment({}), {
  KICAD_RIP_PREEXISTING: "1",
  KICAD_NET_RESCUE: "1",
  KICAD_TERMINAL_ESCALATION: "1",
  KICAD_DYNAMIC_ITERATIONS: "1",
  KICAD_DYNAMIC_ITERATIONS_CLAMP: "200000",
  KICAD_BARE_PAD_ESCAPE: "0",
  KICAD_RESCUE_CAP_MOVE: "0",
  COPILOT_ROUTER_RESCUE_GRID_STEP: "0.1",
  COPILOT_ROUTER_RESCUE_CLEARANCE_STEPS: "1",
  COPILOT_ROUTER_RESCUE_MAX_WINDOW_CELLS: "500000",
  COPILOT_ROUTER_RESCUE_MAX_EDGES_PER_NET: "1",
  COPILOT_ROUTER_RESCUE_MAX_ITERATIONS: "100000",
  KICAD_PLANE_FINALIZE: "0",
  KICAD_FINALIZE_RIP: "1",
})
assert.deepEqual(krt.KRT_RIPUP_BLOCKER_SELECT_CHOICES, [
  "count", "near-target", "bidir", "mincut", "cost",
])
assert.deepEqual(krt.KRT_RIPUP_ABANDON_METRIC_CHOICES, [
  "stranded", "total-pads", "complete-nets", "congestion",
  "history", "weighted", "probe", "weighted-probe",
])
assert.match(krt.krtManagedRelease().url, /KiCadRoutingTools-0\.21\.3\.zip$/)
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
assert.equal(api.validateRoutingBoard({
  ...board,
  pads: [{
    ...board.pads[0], layers: ["F.Cu", "B.Cu"],
    hole: { shape: "round", diameterMm: 0, plated: true },
  }, ...board.pads.slice(1)],
}).ok, false, "invalid pad drill geometry must fail before a backend writes a native board")
const boardWithWhitespacePaddedNet = {
  ...board,
  nets: [...board.nets, { name: " padded-net " }],
}
assert.equal(
  api.validateRoutingBoard(boardWithWhitespacePaddedNet).ok,
  false,
  "net names with leading or trailing whitespace must fail validation before reaching exact KRT selectors",
)
const boardWithUnplannedGround = {
  ...board,
  pads: [
    ...board.pads,
    { component: "U1", number: "4", net: "GND", at: { x: 4, y: 8 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "circle", diameterMm: 1 } },
  ],
}
assert.deepEqual(
  krt.krtUnplannedGroundNets({ board: boardWithUnplannedGround, program: dsl.compileRoutingDsl("runRouting()") }),
  ["GND"],
  "KRT must expose ground nets that it excludes without a planned/imported zone",
)
assert.deepEqual(
  krt.krtUnplannedGroundNets({ board: boardWithUnplannedGround, program: dsl.compileRoutingDsl('ignoreNets("GND"); runRouting()') }),
  [],
  "an explicit ground exclusion must acknowledge the missing maze route",
)
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
assert.throws(() => dsl.compileRoutingDsl(`plane({ net: "GND", paddingMm: 1 }); runCopper()`), /unknown field.*paddingMm/i,
  "unimplemented plane padding must stay hidden from the public contract")

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
assert.throws(
  () => dsl.compileRoutingDsl('quality({ profile: "balanced" }); runRouting()'),
  /quality is not defined/i,
  "quality must not remain in the public DSL",
)
const netPreferences = dsl.compileRoutingDsl(`
  signalNet("VCC", { priority: "critical", viaPreference: "avoid" })
  powerNet("GND", { priority: "low", viaPreference: "forbid" })
  runRouting()
`)
assert.deepEqual(netPreferences.signalNets[0], {
  kind: "signal-net", net: "VCC", priority: "critical", viaPreference: "avoid",
})
assert.deepEqual(netPreferences.powerNets[0], {
  kind: "power-net", net: "GND", priority: "low", viaPreference: "forbid",
})
assert.throws(() => dsl.compileRoutingDsl('signalNet("VCC", { priority: "urgent" }); runRouting()'), /priority must be/i)
assert.throws(() => dsl.compileRoutingDsl('powerNet("VCC", { viaPreference: "prefer" }); runRouting()'), /viaPreference must be/i)
assert.deepEqual(dsl.compileRoutingDsl("runRouting()").fanouts, [], "QFN fanout must be opt-in")
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
  0.1,
  "full-board fine-grid escalation is replaced by KRT's bounded local rescue",
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
assert.equal(applyResult.copper, undefined)
assert.equal(applyResult.rules.nets.find((item) => item.net === "VCC").values.minTrackWidthMm, 0.2)
assert.equal(applyResult.rules.nets.find((item) => item.net === "VCC").values.preferredTrackWidthMm, 0.6)

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
assert.equal(namedClassResult.rules.default.clearanceMm, 0.22)
assert.equal(namedClassResult.rules.netClasses[0].name, "RF")
assert.equal(namedClassResult.rules.nets.find((item) => item.net === "VCC").values.preferredTrackWidthMm, 0.31)
assert.equal(namedClassResult.rules.nets.find((item) => item.net === "VCC").values.minTrackWidthMm, 0.2)

const relationBoard = {
  ...board,
  rules: {
    ...board.rules,
    netClasses: [
      { name: "OLD", nets: ["VCC", "GND"], values: ruleValues },
      { name: "TARGET", nets: ["USB_DP"], values: { ...ruleValues, preferredTrackWidthMm: 0.3 } },
    ],
    differentialPairs: [{ id: "OLD_PAIR", positive: "USB_DP", negative: "USB_DM" }],
    matchedGroups: [{ id: "OLD_MATCH", nets: ["VCC", "GND"], toleranceMm: 0.25 }],
  },
}
const noOpRelations = await api.run({ board: relationBoard, dsl: `applyDrcRules()` })
assert.deepEqual(noOpRelations.rules, relationBoard.rules, "no-op DRC must preserve the complete imported rule state")

const emptyNativeClass = await api.run({
  board: {
    ...relationBoard,
    rules: {
      ...relationBoard.rules,
      netClasses: [...relationBoard.rules.netClasses, { name: "EMPTY", nets: [], values: ruleValues }],
    },
  },
  dsl: `applyDrcRules()`,
})
assert.equal(emptyNativeClass.status, "complete", "an imported empty native class must not make board validation fail")

const incrementalNetRule = await api.run({
  board: relationBoard,
  dsl: `signalNet("VCC", { trackWidthMm: 0.42 }); applyDrcRules()`,
})
assert.deepEqual(
  incrementalNetRule.rules.netClasses,
  relationBoard.rules.netClasses,
  "editing a net rule must not implicitly remove or move its imported class membership",
)

const movedClass = await api.run({
  board: relationBoard,
  dsl: `assignNetsToNetClass("TARGET", ["VCC"]); applyDrcRules()`,
})
assert.deepEqual(movedClass.rules.netClasses.find((item) => item.name === "OLD").nets, ["GND"])
assert.deepEqual(movedClass.rules.netClasses.find((item) => item.name === "TARGET").nets, ["USB_DP", "VCC"])
const movedClassAgain = await api.run({
  board: { ...relationBoard, rules: movedClass.rules },
  dsl: `assignNetsToNetClass("TARGET", ["VCC"]); applyDrcRules()`,
})
assert.deepEqual(movedClassAgain.rules, movedClass.rules, "class assignment must be idempotent")

const removedFromClass = await api.run({
  board: relationBoard,
  dsl: `removeNetsFromNetClass("OLD", ["VCC"]); applyDrcRules()`,
})
assert.deepEqual(removedFromClass.rules.netClasses.find((item) => item.name === "OLD").nets, ["GND"])
assert.deepEqual(removedFromClass.rules.netClasses.find((item) => item.name === "TARGET").nets, ["USB_DP"])

const unassignedClass = await api.run({
  board: relationBoard,
  dsl: `unassignNetClass(["VCC"]); applyDrcRules()`,
})
assert.deepEqual(unassignedClass.rules.netClasses.find((item) => item.name === "OLD").nets, ["GND"])

const deletedClass = await api.run({
  board: relationBoard,
  dsl: `deleteNetClass("OLD"); applyDrcRules()`,
})
assert.deepEqual(deletedClass.rules.netClasses.map((item) => item.name), ["TARGET"])

const replacedPair = await api.run({
  board: relationBoard,
  dsl: `diffPair("NEW_PAIR", { positive: "USB_DP", negative: "USB_DM" }); applyDrcRules()`,
})
assert.deepEqual(replacedPair.rules.differentialPairs, [
  { id: "NEW_PAIR", positive: "USB_DP", negative: "USB_DM" },
])
const deletedPair = await api.run({
  board: relationBoard,
  dsl: `deleteDiffPair("OLD_PAIR"); applyDrcRules()`,
})
assert.equal(deletedPair.rules.differentialPairs, undefined)

const movedMatch = await api.run({
  board: {
    ...relationBoard,
    rules: {
      ...relationBoard.rules,
      matchedGroups: [
        { id: "OLD_MATCH", nets: ["VCC", "GND", "USB_DM"], toleranceMm: 0.25 },
        { id: "TARGET_MATCH", nets: ["USB_DP", "USB_DM"], toleranceMm: 0.1 },
      ],
    },
  },
  dsl: `moveNetsToMatchedGroup("TARGET_MATCH", ["VCC"]); applyDrcRules()`,
})
assert.deepEqual(movedMatch.rules.matchedGroups.find((item) => item.id === "OLD_MATCH").nets, ["GND", "USB_DM"])
assert.deepEqual(movedMatch.rules.matchedGroups.find((item) => item.id === "TARGET_MATCH").nets, ["USB_DP", "USB_DM", "VCC"])

const addedMatch = await api.run({
  board: relationBoard,
  dsl: `addNetsToMatchedGroup("OLD_MATCH", ["USB_DP"]); applyDrcRules()`,
})
assert.deepEqual(addedMatch.rules.matchedGroups[0].nets, ["VCC", "GND", "USB_DP"])

const removedMatch = await api.run({
  board: {
    ...relationBoard,
    rules: {
      ...relationBoard.rules,
      matchedGroups: [{ id: "OLD_MATCH", nets: ["VCC", "GND", "USB_DP"], toleranceMm: 0.25 }],
    },
  },
  dsl: `removeNetsFromMatchedGroup("OLD_MATCH", ["USB_DP"]); applyDrcRules()`,
})
assert.deepEqual(removedMatch.rules.matchedGroups[0].nets, ["VCC", "GND"])

const deletedMatch = await api.run({
  board: relationBoard,
  dsl: `deleteMatchedGroup("OLD_MATCH"); applyDrcRules()`,
})
assert.equal(deletedMatch.rules.matchedGroups, undefined)

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
assert.equal(splitNominalAndMinimum.rules.default.minTrackWidthMm, 0.127)
assert.equal(splitNominalAndMinimum.rules.default.preferredTrackWidthMm, 0.254)
assert.deepEqual(splitNominalAndMinimum.rules.default.via, {
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
  impedanceResult.rules.nets.find((item) => item.net === "VCC").values.impedanceReferenceLayers,
  ["TOP", "BOTTOM"],
  "TOP plane copper plus the BOTTOM reference must resolve grounded coplanar waveguide",
)
assert.equal(
  impedanceResult.rules.nets.find((item) => item.net === "VCC").values.impedanceTopology,
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
      metrics: { routedNetCount: 1, openNetCount: 0, openNets: [], viaCount: 0 },
    }
  },
}
const routed = await api.run({ board, dsl: "runAll()", backend })
assert.equal(routed.status, "complete")
assert.equal(routed.operation, "all")
assert.equal(routed.rules.nets.find((item) => item.net === "VCC").values.minTrackWidthMm, 0.2)
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
assert.deepEqual(stackOnly.stackup.effective.layers.filter((layer) => layer.kind === "copper").map((layer) => layer.layer), ["TOP", "INNER_1", "INNER_2", "BOTTOM"])
assert.equal(stackOnly.stackup.effective.boardThicknessMm, 1.2)
assert.equal(backendCalls, 1, "applyStackup must not start the routing backend")

const inferredTwoLayerStack = await api.run({
  board,
  dsl: `
    stack({
      boardThicknessMm: 1.6,
      fallbackCopperThicknessOz: 1,
      layers: [
        { kind: "copper", name: "TOP" },
        { kind: "copper", name: "BOTTOM" },
      ],
    })
    applyStackup()
  `,
})
assert.equal(inferredTwoLayerStack.status, "complete")
assert.deepEqual(inferredTwoLayerStack.stackup.effective.layers.map((layer) => layer.kind), [
  "copper", "dielectric", "copper",
])
assert.ok(Math.abs(inferredTwoLayerStack.stackup.effective.layers[1].thicknessMm - 1.53042) < 1e-9,
  "a two-layer board must fill its one unambiguous dielectric gap from total and copper thickness")

const copperOnly = await api.run({
  board,
  backend: { ...backend, async route() { throw new Error("runCopper must not start the routing backend") } },
  dsl: `plane({ net: "GND", layers: "BOTTOM" }); runCopper()`,
})
assert.equal(copperOnly.status, "complete")
assert.equal(copperOnly.operation, "copper")
assert.ok(copperOnly.copper.zones.some((zone) => zone.net === "GND" && zone.layers.includes("BOTTOM")))

let fourLayerCalls = 0
const fourLayerBackend = {
  ...backend,
  capabilities: { ...backend.capabilities, maxCopperLayers: 4 },
  async route(request) {
    fourLayerCalls += 1
    assert.deepEqual(request.board.layers.map((layer) => layer.name), ["TOP", "INNER_1", "INNER_2", "BOTTOM"])
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

const missingFourLayerDielectric = await api.run({
  board,
  backend: fourLayerBackend,
  dsl: `
    stack({ boardThicknessMm: 1.6, layers: [
      { kind: "copper", name: "TOP" },
      { kind: "copper", name: "INNER_1" },
      { kind: "copper", name: "INNER_2" },
      { kind: "copper", name: "BOTTOM" },
    ] })
    runAll()
  `,
})
assert.equal(missingFourLayerDielectric.status, "error")
assert.ok(missingFourLayerDielectric.diagnostics.some((item) => item.code === "DSL_STACK_DIELECTRIC_REQUIRED"))
assert.equal(fourLayerCalls, 1, "invalid multilayer physical stacks must stop before backend execution")

const emptyReplacementBackend = {
  ...fourLayerBackend,
  async route() {
    return { status: "complete", copper: emptyCopper, metrics: { openNetCount: 0 } }
  },
}
const retained = { net: "VCC", layer: "F.Cu", widthMm: 0.2, points: [{ x: 1, y: 1 }, { x: 2, y: 1 }] }
const retainedResult = await api.run({
  board: { ...board, copper: { fixed: emptyCopper, editable: { ...emptyCopper, tracks: [retained] } } },
  backend: emptyReplacementBackend,
  dsl: "runRouting()",
})
assert.deepEqual(retainedResult.copper.tracks, [], "backend copper is the complete editable replacement, so recovered rip-up can remove stale tracks")
assert.equal(retainedResult.clearRouting, undefined, "routing without clearRouting must not authorize native copper deletion")

const clearedResult = await api.run({
  board: { ...board, copper: { fixed: emptyCopper, editable: { ...emptyCopper, tracks: [retained] } } },
  backend: emptyReplacementBackend,
  dsl: `clearRouting({ nets: ["VCC"], items: ["tracks"] }); runRouting()`,
})
assert.deepEqual(clearedResult.clearRouting, { tracks: ["VCC"] })
assert.deepEqual(clearedResult.copper.tracks, [], "explicitly cleared copper must leave the logical result")

const independentClearScopes = dsl.compileRoutingDsl(`
  clearRouting({ nets: ["VCC"], items: ["tracks"] })
  clearRouting({ nets: ["GND"], items: ["zones"] })
  clearRouting({ nets: ["USB_DP", "VCC"], items: ["tracks"] })
  runCopper()
`)
assert.deepEqual(independentClearScopes.clearRouting, {
  tracks: ["VCC", "USB_DP"],
  zones: ["GND"],
}, "clearRouting calls must merge per item without creating a nets/items cross product")
assert.deepEqual(
  dsl.compileRoutingDsl(`
    clearRouting({ nets: ["VCC"], items: ["tracks", "vias"] })
    clearRouting({ nets: "all", items: ["vias"] })
    runCopper()
  `).clearRouting,
  { tracks: ["VCC"], vias: "all" },
  "an all scope must dominate only its own copper item",
)

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

let singleFenceRouteCalls = 0
const stagedFenceBackend = {
  ...backend,
  async route(request) {
    singleFenceRouteCalls += 1
    assert.ok(request.plan, "the single backend route must receive the resolved route plan")
    return {
      status: "complete",
      copper: {
        tracks: [{ net: "VCC", layer: "F.Cu", widthMm: 0.3, points: [{ x: 4, y: 5 }, { x: 8, y: 5 }] }],
        vias: [], zones: [],
      },
      metrics: { openNetCount: 0, openNets: [] },
    }
  },
}
const stagedFence = await api.run({
  board, backend: stagedFenceBackend,
  dsl: `viaStitch("VCC_GUARD", { mode: "along", routes: ["VCC"], net: "GND", pitchMm: 1.5 }); runAll()`,
})
assert.equal(stagedFence.status, "complete")
assert.equal(singleFenceRouteCalls, 1, "core must route once and add along stitches after backend routing")
assert.ok(stagedFence.copper.vias.some((via) => String(via.id).startsWith("via-stitch:VCC_GUARD:")))

const existingRoute = {
  net: "VCC", layer: "F.Cu", widthMm: 0.3,
  points: [{ x: 4, y: 2 }, { x: 8, y: 2 }],
}
const copperExistingFence = await api.run({
  board: { ...board, copper: { fixed: { ...emptyCopper, tracks: [existingRoute] }, editable: emptyCopper } },
  dsl: `viaStitch("EXISTING_GUARD", { mode: "along", routes: ["VCC"], net: "GND", pitchMm: 1.5 }); runCopper()`,
})
assert.equal(copperExistingFence.status, "complete")
assert.ok(copperExistingFence.copper.vias.length >= 2, "runCopper must stitch retained existing tracks without KRT")

const oldAndNewFenceBackend = {
  ...stagedFenceBackend,
  async route() {
    return {
      status: "complete",
      copper: {
        tracks: [{ net: "VCC", layer: "F.Cu", widthMm: 0.3, points: [{ x: 4, y: 8 }, { x: 8, y: 8 }] }],
        vias: [], zones: [],
      },
      metrics: { openNetCount: 0, openNets: [] },
    }
  },
}
const oldAndNewFence = await api.run({
  board: { ...board, copper: { fixed: { ...emptyCopper, tracks: [existingRoute] }, editable: emptyCopper } },
  backend: oldAndNewFenceBackend,
  dsl: `viaStitch("OLD_AND_NEW", { mode: "along", routes: ["VCC"], net: "GND", pitchMm: 1.5, rows: 1 }); runAll()`,
})
assert.equal(oldAndNewFence.status, "complete")
assert.ok(oldAndNewFence.copper.vias.some((via) => via.at.y < 4), "runAll must stitch retained existing tracks")
assert.ok(oldAndNewFence.copper.vias.some((via) => via.at.y > 6), "runAll must stitch tracks created by the current route")

const incompleteFenceBackend = {
  ...stagedFenceBackend,
  async route() {
    return {
      status: "partial",
      copper: {
        tracks: [{ net: "VCC", layer: "F.Cu", widthMm: 0.3, points: [{ x: 4, y: 5 }, { x: 8, y: 5 }] }],
        vias: [], zones: [],
      },
      metrics: { openNetCount: 1, openNets: ["VCC"] },
    }
  },
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

const multilayerStitchBoard = {
  ...board,
  layers: [
    { name: "F.Cu", index: 0, side: "top" },
    { name: "In1.Cu", index: 1, side: "inner" },
    { name: "In2.Cu", index: 2, side: "inner" },
    { name: "B.Cu", index: 3, side: "bottom" },
  ],
  components: [], pads: [], keepouts: [], stackup: undefined,
  copper: { fixed: emptyCopper, editable: emptyCopper },
}
const multilayerGroundZone = {
  net: "GND", layers: ["F.Cu", "B.Cu"], outline: { outer: multilayerStitchBoard.outline }, fill: { style: "solid" },
}
const innerTrack = {
  net: "VCC", layer: "In1.Cu", widthMm: 1,
  points: [{ x: 4, y: 5 }, { x: 6, y: 5 }],
}
const multilayerGrid = api.planViaStitches(
  multilayerStitchBoard,
  { tracks: [innerTrack], vias: [], zones: [multilayerGroundZone] },
  [{ kind: "via-stitch", mode: "grid", id: "MULTILAYER_GRID", net: "GND", region: { kind: "board" }, pitchMm: 10 }],
  multilayerStitchBoard.rules,
  { completedNets: [] },
)
assert.deepEqual(multilayerGrid.vias.map((via) => via.at), [{ x: 15, y: 5 }],
  "grid stitching must reject a candidate blocked by a foreign track on an inner layer")
assert.ok(multilayerGrid.vias.every((via) => via.fromLayer === "F.Cu" && via.toLayer === "B.Cu"),
  "multilayer stitching vias must retain their complete through-board span")

const innerForeignZone = {
  net: "VCC", layers: ["In1.Cu"], outline: { outer: multilayerStitchBoard.outline }, fill: { style: "solid" },
}
const multilayerAlong = api.planViaStitches(
  multilayerStitchBoard,
  {
    tracks: [{ net: "VCC", layer: "F.Cu", widthMm: 0.3, points: [{ x: 4, y: 5 }, { x: 16, y: 5 }] }],
    vias: [], zones: [innerForeignZone],
  },
  [{ kind: "via-stitch", mode: "along", id: "MULTILAYER_ALONG", routes: ["VCC"], net: "GND", pitchMm: 2, rows: 1 }],
  multilayerStitchBoard.rules,
  { completedNets: ["VCC"] },
)
assert.equal(multilayerAlong.vias.length, 0,
  "along stitching must see foreign zones on every layer crossed by its through vias")

const multilayerAround = api.planViaStitches(
  {
    ...multilayerStitchBoard,
    keepouts: [{
      layers: ["In2.Cu"], polygon: { outer: multilayerStitchBoard.outline },
      forbid: { tracks: false, vias: true, zones: false },
    }],
  },
  emptyCopper,
  [{ kind: "via-stitch", mode: "around", id: "MULTILAYER_AROUND", net: "GND", target: { kind: "board" }, pitchMm: 2 }],
  multilayerStitchBoard.rules,
  { completedNets: [] },
)
assert.equal(multilayerAround.vias.length, 0,
  "around stitching must see via keepouts on every layer crossed by its through vias")

const sourceThroughVia = {
  net: "VCC", at: { x: 10, y: 5 }, diameterMm: 0.6, drillMm: 0.3,
  fromLayer: "F.Cu", toLayer: "B.Cu", type: "through",
}
const multilayerReturn = api.planViaStitches(
  multilayerStitchBoard,
  { tracks: [], vias: [sourceThroughVia], zones: [{ ...innerForeignZone, net: "USB_DP" }] },
  [{ kind: "via-stitch", mode: "return", id: "MULTILAYER_RETURN", referenceNet: "GND", forNets: ["VCC"], maxDistanceMm: 2 }],
  multilayerStitchBoard.rules,
  { completedNets: [] },
)
assert.equal(multilayerReturn.vias.length, 0,
  "return stitching must see foreign zones on every layer crossed by its through vias")

const innerReferenceBoard = {
  ...multilayerStitchBoard,
  copper: { fixed: { ...emptyCopper, zones: [{ ...multilayerGroundZone, layers: ["In1.Cu"] }] }, editable: emptyCopper },
}
const multilayerAutoReturn = api.planViaStitches(
  innerReferenceBoard,
  { tracks: [], vias: [sourceThroughVia], zones: [] },
  [{ kind: "via-stitch", mode: "return", id: "MULTILAYER_AUTO_RETURN", referenceNet: "auto", forNets: ["VCC"], maxDistanceMm: 2 }],
  innerReferenceBoard.rules,
  { completedNets: [] },
)
assert.ok(multilayerAutoReturn.vias.some((via) => via.net === "GND"),
  "automatic return stitching must resolve a solid reference plane on an inner layer crossed by the source via")

const multilayerPlaneProgram = dsl.compileRoutingDsl(`
  plane({ net: "GND", layers: "OUTER", region: board(), stitching: { gridMm: 10, viaInPad: false } })
  runCopper()
`)
const multilayerPlaneRules = dsl.compileRoutingRules(multilayerStitchBoard, multilayerPlaneProgram).effective
const multilayerPlane = api.planRoutingCopper(
  { ...multilayerStitchBoard, copper: { fixed: { ...emptyCopper, tracks: [{ ...innerTrack, points: [{ x: 0, y: 5 }, { x: 20, y: 5 }] }] }, editable: emptyCopper } },
  multilayerPlaneProgram,
  multilayerPlaneRules,
)
assert.equal(multilayerPlane.copper.vias.length, 0,
  "OUTER plane stitching must still check the full through-via span for inner-layer obstacles")

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

let singleCoreRouteCalls = 0
const singleCoreRouteBackend = {
  ...backend,
  async route(request) {
    singleCoreRouteCalls += 1
    assert.ok(request.plan)
    assert.equal("policy" in request, false, "engine profiles must not leak through the backend contract")
    return { status: "complete", copper: emptyCopper, metrics: { openNetCount: 0 } }
  },
}
const singleCoreRouteResult = await api.run({
  board, dsl: "runRouting()", backend: singleCoreRouteBackend,
})
assert.equal(singleCoreRouteResult.status, "complete")
assert.equal(singleCoreRouteCalls, 1, "core must delegate exactly one complete route to the backend")
assert.equal(singleCoreRouteResult.metrics.candidateCount, 1)
assert.ok(singleCoreRouteResult.diagnostics.some((item) => item.code === "ROUTING_CANDIDATE_AUDITED"))

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
})
assert.equal(noInternalTimeoutResult.status, "complete")
assert.equal(deprecatedTimeoutFinished, true, "core must not impose an implicit backend timeout")

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
    return { status: "complete", copper: emptyCopper, metrics: { openNetCount: 0, openNets: [] } }
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
assert.deepEqual(planeResult.copper.zones[0].layers, ["TOP", "BOTTOM"])
assert.equal(planeResult.copper.zones[0].priority, 1)
assert.equal(planeResult.copper.zones[0].minThicknessMm, 0.254)
assert.equal(planeResult.copper.zones[0].padConnection.mode, "none")
assert.equal(planeResult.copper.zones[0].removeIslandsBelowMm2, 2)
assert.ok(planeResult.copper.vias.length > 0)
assert.ok(planeResult.copper.vias.length <= 8)

const largeStitchBoard = {
  ...board,
  outline: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }],
  components: [], pads: [], keepouts: [],
  copper: { fixed: emptyCopper, editable: emptyCopper },
}
const largePlaneStitchResult = await api.run({
  board: largeStitchBoard,
  dsl: `
    plane({ net: "GND", layers: "OUTER", region: board(), stitching: { gridMm: 2, viaInPad: false } })
    runCopper()
  `,
})
assert.equal(largePlaneStitchResult.status, "complete")
assert.equal(largePlaneStitchResult.copper.vias.length, 900,
  "plane stitching must not retain the obsolete 500-via guardrail")

const largeExplicitStitch = api.planViaStitches(
  largeStitchBoard,
  {
    tracks: [], vias: [], zones: [{
      net: "GND", layers: ["F.Cu", "B.Cu"], outline: { outer: largeStitchBoard.outline }, fill: { style: "solid" },
    }],
  },
  [{ kind: "via-stitch", mode: "grid", id: "LARGE_GRID", net: "GND", region: { kind: "board" }, pitchMm: 2 }],
  largeStitchBoard.rules,
  { completedNets: [] },
)
assert.equal(largeExplicitStitch.vias.length, 900,
  "explicit grid stitching must not retain the obsolete 500-via guardrail")

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

const existingReturnVia = { net: "VCC", at: { x: 10, y: 5 }, diameterMm: 0.6, drillMm: 0.3, fromLayer: "F.Cu", toLayer: "B.Cu", type: "through" }
const copperReturnViaResult = await api.run({
  board: { ...board, copper: { fixed: { ...emptyCopper, vias: [existingReturnVia] }, editable: emptyCopper } },
  dsl: `viaStitch("EXISTING_RETURN", { mode: "return", referenceNet: "GND", forNets: ["VCC"], maxDistanceMm: 2 }); runCopper()`,
})
assert.equal(copperReturnViaResult.status, "complete")
assert.ok(copperReturnViaResult.copper.vias.some((via) => via.net === "GND" && String(via.id).startsWith("via-stitch:EXISTING_RETURN:")),
  "runCopper must add return vias beside retained existing signal vias")

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
assert.equal(groundAndPowerResult.rules.nets.find((item) => item.net === "VCC").values.minTrackWidthMm, 1.85)
assert.equal(groundAndPowerResult.rules.nets.find((item) => item.net === "VCC").values.preferredTrackWidthMm, 1.85)
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
assert.equal(malformed.status, "partial")
assert.ok(malformed.diagnostics.some((item) => (
  item.code === "ROUTING_CANDIDATE_REJECTED"
  && item.details.validation.some((validation) => validation.code === "ROUTING_TRACK_INVALID")
)))
assert.equal(malformed.copper.tracks.length, 0, "invalid later geometry must retain the applicable pre-route checkpoint")

const doctor = spawnSync(process.execPath, [join(distRoot, "cli.js"), "doctor"], { cwd: root, encoding: "utf8" })
assert.equal(doctor.status, 0, doctor.stderr)
assert.equal(JSON.parse(doctor.stdout).edaAccess, "KiCad file adapter")

const temporary = await mkdtemp(join(tmpdir(), "copilot-router-package-"))
try {
  const virtualEnvironment = join(temporary, "fixture-venv")
  const virtualPython = process.platform === "win32"
    ? join(virtualEnvironment, "python.exe")
    : join(virtualEnvironment, "bin", "python3")
  const pyenvPython = process.platform === "win32"
    ? join(temporary, ".pyenv", "pyenv-win", "versions", "3.13.1", "python.exe")
    : join(temporary, ".pyenv", "versions", "3.13.1", "bin", "python3")
  await mkdir(dirname(virtualPython), { recursive: true })
  await mkdir(dirname(pyenvPython), { recursive: true })
  await writeFile(virtualPython, "fixture", "utf8")
  await writeFile(pyenvPython, "fixture", "utf8")
  const discoveryEnvironment = {
    COPILOT_ROUTER_PYTHON: join(temporary, "declared-python"),
    KICAD_PYTHON: join(temporary, "declared-kicad-python"),
    PYTHON: join(temporary, "declared-generic-python"),
    UV_PYTHON: join(temporary, "declared-uv-python"),
    npm_config_python: join(temporary, "declared-npm-python"),
    VIRTUAL_ENV: virtualEnvironment,
    USERPROFILE: temporary,
    HOME: temporary,
    PATH: "",
  }
  const pythonCandidates = await krt.krtPythonDiscoveryCandidates(
    join(temporary, "explicit-python"),
    {
      environment: discoveryEnvironment,
      currentPlatform: process.platform,
      homeDirectory: temporary,
    },
  )
  assert.equal(pythonCandidates[0].command, join(temporary, "explicit-python"))
  for (const expected of [
    discoveryEnvironment.COPILOT_ROUTER_PYTHON,
    discoveryEnvironment.KICAD_PYTHON,
    discoveryEnvironment.PYTHON,
    discoveryEnvironment.UV_PYTHON,
    discoveryEnvironment.npm_config_python,
    virtualPython,
    pyenvPython,
  ]) assert.ok(pythonCandidates.some((candidate) => candidate.command === expected),
    `Python discovery omitted ${expected}`)
  if (process.platform === "win32") assert.ok(pythonCandidates.some((candidate) => (
    candidate.command === "py" && candidate.args.join(" ") === "-3" && candidate.resolveExecutable
  )), "Windows Python launcher discovery must resolve py -3 to an executable")

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
