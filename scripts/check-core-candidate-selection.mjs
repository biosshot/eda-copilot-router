import assert from "node:assert/strict"
import * as core from "../package-dist/core/index.js"
import * as dsl from "../package-dist/intent/index.js"
import * as krt from "../package-dist/backends/krt.js"

const emptyCopper = { tracks: [], vias: [], zones: [] }
const values = {
  clearanceMm: 0.2,
  edgeClearanceMm: 0.2,
  minTrackWidthMm: 0.15,
  preferredTrackWidthMm: 0.2,
  via: { minDiameterMm: 0.45, preferredDiameterMm: 0.6, minDrillMm: 0.2, preferredDrillMm: 0.3 },
}
const board = {
  outline: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }],
  cutouts: [],
  layers: [
    { name: "TOP", index: 0, side: "top" },
    { name: "BOTTOM", index: 31, side: "bottom" },
  ],
  nets: ["CRIT", "AUX", "OSC", "DP_P", "DP_N", "M0", "M1", "GND"].map((name) => ({ name })),
  components: [
    { designator: "Y1", at: { x: 2, y: 2 }, rotationDeg: 0, side: "top" },
    { designator: "U1", at: { x: 7, y: 2 }, rotationDeg: 0, side: "top" },
  ],
  pads: [
    { component: "Y1", number: "1", net: "OSC", at: { x: 2, y: 2 }, rotationDeg: 0, layers: ["TOP"], shape: { kind: "circle", diameterMm: 0.8 } },
    { component: "U1", number: "1", net: "OSC", at: { x: 7, y: 2 }, rotationDeg: 0, layers: ["TOP"], shape: { kind: "circle", diameterMm: 0.8 } },
  ],
  keepouts: [],
  rules: { default: values, nets: [] },
  copper: { fixed: emptyCopper, editable: emptyCopper },
}
const base = dsl.compileRoutingDsl("runRouting()")
const program = {
  ...base,
  signalNets: [
    { kind: "signal-net", net: "CRIT", priority: "critical" },
    { kind: "signal-net", net: "AUX", priority: "low" },
    { kind: "signal-net", net: "OSC", priority: "critical", viaPreference: "avoid" },
  ],
  differentialPairs: [{ kind: "differential-pair", id: "DP", positive: "DP_P", negative: "DP_N" }],
  matchedGroups: [{ kind: "matched-group", id: "MATCH", nets: ["M0", "M1"], toleranceMm: 0.2 }],
}

const via = (net, x) => ({
  net, at: { x, y: 5 }, diameterMm: 0.6, drillMm: 0.3, fromLayer: "TOP", toLayer: "BOTTOM",
})
const result = (overrides = {}) => ({
  status: "complete",
  copper: emptyCopper,
  metrics: { openNetCount: 0, openNets: [] },
  ...overrides,
})
const candidate = (label, index, routeResult) => ({
  label,
  index,
  result: routeResult,
  grade: core.gradeRoutingCandidate(board, program, board.rules, routeResult, index),
})

const criticalOpen = candidate("critical-open", 0, result({
  status: "partial", metrics: { openNetCount: 1, openNets: ["CRIT"] },
}))
const lowOpen = candidate("low-open", 1, result({
  status: "partial", metrics: { openNetCount: 1, openNets: ["AUX"] },
}))
assert.equal(core.retainRoutingChampion(criticalOpen, lowOpen), lowOpen, "net priority must decide equal-open candidates")

const brokenPair = candidate("broken-pair", 0, result({
  metrics: { openNetCount: 0, openNets: [], details: { special: { pair_reports: [{ outcome: "single-ended" }] } } },
}))
const coupledPair = candidate("coupled-pair", 1, result({
  copper: { tracks: [], vias: [via("AUX", 1), via("AUX", 2)], zones: [] },
}))
assert.equal(core.retainRoutingChampion(brokenPair, coupledPair), coupledPair, "diff-pair audit must outrank raw via count")

const unmatched = candidate("unmatched", 0, result({
  diagnostics: [{ code: "KRT_LENGTH_MATCH_INCOMPLETE", severity: "error", message: "not matched" }],
}))
const matched = candidate("matched", 1, result({
  copper: { tracks: [], vias: [via("AUX", 3)], zones: [] },
}))
assert.equal(core.retainRoutingChampion(unmatched, matched), matched, "matched-length failures must outrank raw via count")

const drcRegression = candidate("drc-regression", 0, result({
  diagnostics: [{ code: "KRT_SPECIAL_DRC_REGRESSION", severity: "error", message: "one new violation" }],
}))
const drcClean = candidate("drc-clean", 1, result({
  copper: { tracks: [], vias: [via("AUX", 4), via("AUX", 5)], zones: [] },
}))
assert.equal(core.retainRoutingChampion(drcRegression, drcClean), drcClean, "DRC regressions must outrank raw via count")

const recoveredRip = candidate("recovered-rip", 0, result({
  metrics: { openNetCount: 0, openNets: [], details: { remaining: { preexisting_rips: { AUX: "RECOVERED" } } } },
  diagnostics: [{ code: "KRT_NATIVE_BLOCKER_RECOVERY", severity: "info", message: "recovered" }],
}))
const lostProtectedCopper = candidate("lost-protected", 1, result({
  metrics: { openNetCount: 0, openNets: [], details: { remaining: { preexisting_rips: { CRIT: "NOT RECOVERED" } } } },
  diagnostics: [{ code: "KRT_PROTECTED_COPPER_RIPPED", severity: "error", message: "lost" }],
}))
assert.equal(recoveredRip.grade.criticalRegressionCount, 0, "safe native blocker recovery is not a regression")
assert.ok(lostProtectedCopper.grade.criticalRegressionCount > 0, "unrecovered protected copper is a critical regression")

const rejectedRepairHistory = candidate("useful-partial-with-rejected-repair", 1, result({
  status: "partial",
  metrics: {
    openNetCount: 1,
    openNets: ["AUX"],
    connectivityComponentCount: 2,
    details: {
      policy: "native-auto",
      main: [{
        coverage_gate_nets: ["CRIT", "OSC"],
        preexisting_rips: { CRIT: "NOT RECOVERED", OSC: "PARTIAL" },
        failed_diff_pairs: ["DP"],
        matched_group_violations: ["MATCH"],
        addedDrcViolations: 4,
      }],
      repairs: [{
        accepted: false,
        criticalRegressions: ["CRIT"],
        summary: {
          coverage_gate_nets: ["CRIT", "OSC"],
          preexisting_rips: { CRIT: "NOT RECOVERED", OSC: "PARTIAL" },
          failed_diff_pairs: ["DP"],
          matched_group_violations: ["MATCH"],
          addedDrcViolations: 4,
        },
      }],
    },
  },
  diagnostics: [
    { code: "KRT_COVERAGE_GATE_FAILED", severity: "warning", message: "rejected repair only" },
    { code: "KRT_RIP_VICTIM_INCOMPLETE", severity: "warning", message: "rejected repair only" },
  ],
}))
const preRouteCheckpoint = candidate("pre-route-checkpoint", -1, result({
  status: "partial",
  metrics: { openNetCount: 2, openNets: ["CRIT", "AUX"], connectivityComponentCount: 3 },
}))
assert.equal(rejectedRepairHistory.grade.criticalRegressionCount, 0,
  "a rolled-back repair must not poison the promoted board's critical grade")
assert.equal(rejectedRepairHistory.grade.differentialViolationCount, 0,
  "a rolled-back repair must not poison the promoted board's differential grade")
assert.equal(rejectedRepairHistory.grade.matchedViolationCount, 0,
  "a rolled-back repair must not poison the promoted board's matched-length grade")
assert.equal(rejectedRepairHistory.grade.drcViolationCount, 0,
  "a rolled-back repair must not poison the promoted board's DRC grade")
assert.equal(core.retainRoutingChampion(preRouteCheckpoint, rejectedRepairHistory), rejectedRepairHistory,
  "a useful partial route must beat the empty checkpoint despite rejected repair history")

const finalDetailsRegression = candidate("final-details-regression", 0, result({
  metrics: {
    openNetCount: 0,
    openNets: [],
    connectivityComponentCount: 1,
    details: { criticalRegressions: ["CRIT"] },
  },
}))
assert.equal(finalDetailsRegression.grade.criticalRegressionCount, 1,
  "authoritative final-state regression details must remain a hard candidate penalty")

const customVerdict = candidate("custom-final-verdict", 0, result({
  metrics: {
    openNetCount: 0,
    openNets: [],
    connectivityComponentCount: 1,
    details: {
      verdict: {
        accepted: false,
        summary: { criticalRegressions: ["CRIT"] },
      },
    },
  },
}))
assert.equal(customVerdict.grade.criticalRegressionCount, 1,
  "an open-ended custom detail named accepted=false must not be mistaken for KRT rollback history")

const parseableTransportError = candidate("transport-error", 0, result({ status: "error" }))
assert.equal(parseableTransportError.grade.errorCount, 0, "transport status alone must not poison parseable copper")

const shortAvoidVia = candidate("short-avoid-via", 0, result({
  copper: {
    tracks: [{
      net: "OSC", layer: "TOP", widthMm: 0.2,
      points: [{ x: 2, y: 2 }, { x: 2, y: 18 }, { x: 7, y: 18 }, { x: 7, y: 2 }],
    }],
    vias: [via("OSC", 6)], zones: [],
  },
}))
const twoOrdinaryVias = candidate("ordinary-vias", 1, result({
  copper: { tracks: [], vias: [via("AUX", 7), via("AUX", 8)], zones: [] },
}))
assert.equal(
  core.retainRoutingChampion(shortAvoidVia, twoOrdinaryVias),
  twoOrdinaryVias,
  "a short avoid-via net must be protected before minimizing total vias",
)
assert.ok(shortAvoidVia.grade.trackLengthMm > core.SHORT_AVOID_VIA_NET_LENGTH_MM)
assert.ok(shortAvoidVia.grade.shortAvoidViaPenalty > 0,
  "physical pad span, not a bad routed detour, must define a short avoid-via net")

const partialWithShortVia = candidate("partial-with-short-via", 0, result({
  status: "partial",
  copper: { tracks: [], vias: [via("OSC", 6)], zones: [] },
  metrics: { openNetCount: 1, openNets: ["AUX"] },
}))
const repairedPartial = candidate("repaired-partial", 1, result({
  status: "partial",
  metrics: { openNetCount: 1, openNets: ["AUX"] },
  diagnostics: [
    { code: "KRT_NETS_UNROUTED", severity: "error", message: "AUX remains open" },
    { code: "KRT_PAD_PAIRS_OPEN", severity: "error", message: "AUX remains open" },
  ],
}))
assert.equal(repairedPartial.grade.errorCount, 0,
  "audited open-net diagnostics must not double-penalize an otherwise useful partial checkpoint")
assert.equal(core.retainRoutingChampion(partialWithShortVia, repairedPartial), repairedPartial,
  "removing vias from a short critical net must survive while an unrelated net remains open")

const connectedShortViaBaseline = candidate("connected-short-via-baseline", 0, result({
  status: "partial",
  copper: { tracks: [], vias: [via("OSC", 6)], zones: [] },
  metrics: { openNetCount: 1, openNets: ["AUX"], connectivityComponentCount: 2 },
}))
const disconnectedViaRepair = candidate("disconnected-via-repair", 1, result({
  status: "partial",
  metrics: { openNetCount: 2, openNets: ["AUX", "OSC"], connectivityComponentCount: 3 },
}))
assert.equal(core.retainRoutingChampion(connectedShortViaBaseline, disconnectedViaRepair), connectedShortViaBaseline,
  "a via-removal repair that opens its critical target must roll back")

const drcRegressingViaRepair = candidate("drc-regressing-via-repair", 1, result({
  status: "partial",
  metrics: { openNetCount: 1, openNets: ["AUX"], connectivityComponentCount: 2 },
  diagnostics: [{ code: "KRT_SPECIAL_DRC_REGRESSION", severity: "error", message: "new violation" }],
}))
assert.equal(core.retainRoutingChampion(connectedShortViaBaseline, drcRegressingViaRepair), connectedShortViaBaseline,
  "a via-removal repair that adds DRC damage must roll back")

const unprotectedViaRepair = candidate("unprotected-via-repair", 1, result({
  status: "partial",
  metrics: { openNetCount: 1, openNets: ["AUX"], connectivityComponentCount: 2 },
  diagnostics: [{ code: "KRT_PROTECTED_COPPER_RIPPED", severity: "error", message: "protection lost" }],
}))
assert.equal(core.retainRoutingChampion(connectedShortViaBaseline, unprotectedViaRepair), connectedShortViaBaseline,
  "a via-removal repair that loses protected copper must roll back")

const auditedShortViaBaseline = candidate("audited-short-via-baseline", 0, result({
  status: "partial",
  copper: { tracks: [], vias: [via("OSC", 9)], zones: [] },
  metrics: { openNetCount: 0, openNets: [], connectivityComponentCount: 1 },
}))
const recoveredWithoutShortVia = candidate("recovered-without-short-via", 1, result({
  status: "partial",
  metrics: { openNetCount: 0, openNets: [], connectivityComponentCount: 1 },
  diagnostics: [{
    code: "KRT_BACKEND_FAILED_AFTER_CHECKPOINT",
    severity: "error",
    message: "late process failure after an audited checkpoint",
  }],
}))
assert.equal(recoveredWithoutShortVia.grade.errorCount, 0,
  "transport failure must not poison finite audited checkpoint copper")
assert.equal(core.retainRoutingChampion(auditedShortViaBaseline, recoveredWithoutShortVia), recoveredWithoutShortVia,
  "an audited recovered checkpoint that removes the short avoid-via must beat its transport-clean baseline")

const tiedLater = candidate("later", 9, result())
const tiedEarlier = candidate("earlier", 0, result())
assert.equal(core.retainRoutingChampion(tiedEarlier, tiedLater), tiedEarlier, "a later tie must not replace the accepted champion")

const invalidCheckpoint = core.retainCopperCheckpoint(board, emptyCopper, {
  tracks: [{ net: "UNKNOWN", layer: "TOP", widthMm: 0.2, points: [{ x: 1, y: 1 }, { x: 2, y: 1 }] }],
  vias: [], zones: [],
}, "test")
assert.equal(invalidCheckpoint.accepted, false)
assert.equal(invalidCheckpoint.copper, emptyCopper)
assert.ok(invalidCheckpoint.diagnostics.some((item) => item.code === "ROUTING_CHECKPOINT_REJECTED"))

const immutableTrack = { net: "OSC", layer: "TOP", widthMm: 0.2, points: [{ x: 2, y: 2 }, { x: 7, y: 2 }] }
const fixedEchoBoard = { ...board, copper: { fixed: { ...emptyCopper, tracks: [immutableTrack] }, editable: emptyCopper } }
const fixedEcho = core.gradeRoutingCandidate(fixedEchoBoard, program, board.rules, result({
  copper: { ...emptyCopper, tracks: [{ ...immutableTrack, points: [...immutableTrack.points].reverse() }] },
}), 0)
assert.equal(fixedEcho.structurallyUsable, false, "fixed copper echoed as editable must be rejected")
assert.ok(fixedEcho.structuralDiagnostics.some((item) => item.code === "ROUTING_FIXED_COPPER_ECHO"))

const capabilities = {
  supported: [
    "ordinary-routing", "vias", "zones", "plane-stitching", "differential-pairs", "matched-length",
    "impedance-controlled", "preserve-fixed-copper", "fixed-zone-obstacles", "preconnected-pad-groups",
    "parallel-vias",
  ],
  maxCopperLayers: 32,
}

const retainedTrack = { net: "AUX", layer: "TOP", widthMm: 0.2, points: [{ x: 2, y: 2 }, { x: 4, y: 2 }] }
const replacementTrack = { net: "CRIT", layer: "TOP", widthMm: 0.2, points: [{ x: 2, y: 4 }, { x: 8, y: 4 }] }
let routeCalls = 0
const replacement = await core.run({
  board: { ...board, copper: { fixed: emptyCopper, editable: { ...emptyCopper, tracks: [retainedTrack] } } },
  dsl: base,
  backend: {
    id: "single-route",
    capabilities,
    async route(request) {
      routeCalls += 1
      assert.ok(request.plan, "resolved route plan must reach the backend boundary")
      return {
        status: "complete",
        copper: { ...emptyCopper, tracks: [replacementTrack] },
        metrics: { openNetCount: 0, openNets: [] },
      }
    },
  },
})
assert.equal(routeCalls, 1, "core must make exactly one backend route call")
assert.equal(replacement.status, "complete")
assert.deepEqual(replacement.copper.tracks, [replacementTrack], "backend editable copper is a replacement, not an additions-only delta")

const partialFromException = await core.run({
  board: { ...board, copper: { fixed: emptyCopper, editable: { ...emptyCopper, tracks: [retainedTrack] } } },
  dsl: base,
  backend: {
    id: "throws",
    capabilities,
    async route() { throw new Error("engine stopped after its last checkpoint") },
  },
})
assert.equal(partialFromException.status, "partial", "an applicable pre-route checkpoint must survive backend failure")
assert.deepEqual(partialFromException.copper.tracks, [retainedTrack])
assert.ok(partialFromException.diagnostics.some((item) => item.code === "BACKEND_ROUTE_EXCEPTION"))

const clearRollback = await core.run({
  board: { ...board, copper: { fixed: emptyCopper, editable: { ...emptyCopper, tracks: [retainedTrack] } } },
  dsl: { ...base, clearRouting: { tracks: "all", vias: "all", zones: "all" } },
  backend: {
    id: "throws-after-clear",
    capabilities,
    async route() { throw new Error("engine failed before a useful checkpoint") },
  },
})
assert.equal(clearRollback.status, "error", "clearRouting plus an unusable backend result must roll back the transaction")
assert.equal(clearRollback.clearRouting, undefined, "a rolled-back clear intent must never reach a partial-applying host")
assert.equal(clearRollback.copper, undefined, "a rolled-back clear must not expose empty replacement copper")
assert.ok(clearRollback.diagnostics.some((item) => item.code === "ROUTING_CLEAR_ROLLBACK"))

const usefulErrorSnapshot = await core.run({
  board: { ...board, copper: { fixed: emptyCopper, editable: { ...emptyCopper, tracks: [retainedTrack] } } },
  dsl: base,
  backend: {
    id: "parseable-error-snapshot",
    capabilities,
    async route() {
      return {
        status: "error",
        copper: { ...emptyCopper, tracks: [replacementTrack] },
        metrics: { openNetCount: 0, openNets: [] },
      }
    },
  },
})
assert.equal(usefulErrorSnapshot.status, "partial", "parseable error-status copper remains applicable")
assert.deepEqual(usefulErrorSnapshot.copper.tracks, [replacementTrack])

const invalidBackend = await core.run({
  board: { ...board, copper: { fixed: emptyCopper, editable: { ...emptyCopper, tracks: [retainedTrack] } } },
  dsl: base,
  backend: {
    id: "invalid-copper",
    capabilities,
    async route() {
      return {
        status: "error",
        copper: { tracks: [{ ...replacementTrack, net: "UNKNOWN" }], vias: [], zones: [] },
      }
    },
  },
})
assert.equal(invalidBackend.status, "partial", "invalid later copper must retain the structurally usable baseline")
assert.deepEqual(invalidBackend.copper.tracks, [retainedTrack])

let singleStageCalls = 0
const noSummedCounters = await core.run({
  board,
  dsl: base,
  backend: {
    id: "one-stage-counters",
    capabilities,
    async route() {
      singleStageCalls += 1
      return { status: "partial", copper: emptyCopper, metrics: { openNetCount: 1, openNets: ["AUX"] } }
    },
  },
})
assert.equal(singleStageCalls, 1)
assert.equal(noSummedCounters.metrics.openNetCount, 1, "core must preserve the backend's board-level open counter")
assert.equal(noSummedCounters.status, "partial")

const threePadBoard = {
  ...board,
  nets: [{ name: "BUS" }],
  components: [
    { designator: "J1", at: { x: 2, y: 10 }, rotationDeg: 0, side: "top" },
    { designator: "J2", at: { x: 8, y: 10 }, rotationDeg: 0, side: "top" },
    { designator: "J3", at: { x: 14, y: 10 }, rotationDeg: 0, side: "top" },
  ],
  pads: [2, 8, 14].map((x, index) => ({
    component: `J${index + 1}`, number: "1", net: "BUS", at: { x, y: 10 }, rotationDeg: 0,
    layers: ["TOP"], shape: { kind: "circle", diameterMm: 1 },
  })),
  copper: { fixed: emptyCopper, editable: emptyCopper },
}
const busDsl = dsl.compileRoutingDsl('signalNet("BUS", { priority: "high" }); runRouting()')
const partialBusTrack = {
  net: "BUS", layer: "TOP", widthMm: 0.2,
  points: [{ x: 2, y: 10 }, { x: 8, y: 10 }],
}
const recoveredBusConnectivity = krt.krtRecoveredConnectivityFields(
  { openNets: ["BUS"], componentsByNet: { BUS: 3 }, connectivityComponentCount: 3 },
  { openNets: ["BUS"], componentsByNet: { BUS: 2 }, connectivityComponentCount: 2 },
)
const partialBusBackend = (status = "partial") => ({
  id: `partial-bus-${status}`,
  capabilities,
  async route() {
    return {
      status,
      copper: { ...emptyCopper, tracks: [partialBusTrack] },
      metrics: {
        openNetCount: 1,
        openNets: ["BUS"],
        ...recoveredBusConnectivity.metrics,
        details: {
          ...recoveredBusConnectivity.details,
          recoveredCheckpoint: "synthetic-checkpoint.kicad_pcb",
        },
      },
    }
  },
})
const partialMultipoint = await core.run({ board: threePadBoard, dsl: busDsl, backend: partialBusBackend() })
assert.equal(partialMultipoint.status, "partial")
assert.deepEqual(partialMultipoint.copper.tracks, [partialBusTrack],
  "three pads improved from three components to two must beat the empty baseline while still open")

const destructiveThreePadBoard = {
  ...threePadBoard,
  copper: {
    fixed: emptyCopper,
    editable: { ...emptyCopper, tracks: [{
      net: "BUS", layer: "TOP", widthMm: 0.2,
      points: [{ x: 8, y: 10 }, { x: 14, y: 10 }],
    }] },
  },
}
const partialAfterClear = await core.run({
  board: destructiveThreePadBoard,
  dsl: { ...busDsl, clearRouting: { tracks: "all", vias: "all", zones: "all" } },
  backend: partialBusBackend("error"),
})
assert.equal(partialAfterClear.status, "partial",
  "parseable error-status copper with proven component improvement must survive clearRouting")
assert.deepEqual(partialAfterClear.copper.tracks, [partialBusTrack])
assert.ok(partialAfterClear.clearRouting, "a useful partial replacement keeps the explicit clear intent")

const fullyConnectedTracks = [
  { net: "BUS", layer: "TOP", widthMm: 0.2, points: [{ x: 2, y: 10 }, { x: 8, y: 10 }] },
  { net: "BUS", layer: "TOP", widthMm: 0.2, points: [{ x: 8, y: 10 }, { x: 14, y: 10 }] },
]
const connectedBoard = {
  ...threePadBoard,
  copper: { fixed: emptyCopper, editable: { ...emptyCopper, tracks: fullyConnectedTracks } },
}
const unprovenEmpty = await core.run({
  board: connectedBoard,
  dsl: busDsl,
  backend: {
    id: "complete-empty-without-audit",
    capabilities,
    async route() { return { status: "complete", copper: emptyCopper } },
  },
})
assert.deepEqual(unprovenEmpty.copper.tracks, fullyConnectedTracks,
  "complete+empty without connectivity metrics must not erase an applicable incumbent")

const noOpClearFailure = await core.run({
  board: threePadBoard,
  dsl: { ...busDsl, clearRouting: { tracks: "all", vias: "all", zones: "all" } },
  backend: {
    id: "no-op-clear-failure",
    capabilities,
    async route() { throw new Error("nothing was changed") },
  },
})
assert.equal(noOpClearFailure.status, "partial",
  "clearRouting on an already empty editable set is not a destructive rollback")
assert.ok(!noOpClearFailure.diagnostics.some((item) => item.code === "ROUTING_CLEAR_ROLLBACK"))

console.log("core candidate selection and partial-result invariants: ok")
