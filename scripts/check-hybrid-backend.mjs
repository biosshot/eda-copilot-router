import assert from "node:assert/strict"
import {
  createHybridBackend,
  partitionHybridRoute,
  scopeBackendRequest,
} from "../package-dist/backends/hybrid.js"
import { run } from "../package-dist/index.js"
import { resolveRoutePlan } from "../package-dist/core/index.js"
import { compileRoutingDsl } from "../package-dist/intent/index.js"

const emptyCopper = { tracks: [], vias: [], zones: [] }
const defaultValues = {
  clearanceMm: 0.2,
  edgeClearanceMm: 0.2,
  minTrackWidthMm: 0.15,
  preferredTrackWidthMm: 0.2,
  via: {
    minDiameterMm: 0.45,
    preferredDiameterMm: 0.6,
    minDrillMm: 0.2,
    preferredDrillMm: 0.3,
  },
}
const netNames = [
  "POWER", "DP_P", "DP_N", "MATCH_A", "MATCH_B", "CRIT", "VIA", "LAYER", "IMP", "FAN", "ORD", "HIGH", "GND",
]
const board = {
  outline: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }, { x: 0, y: 30 }],
  cutouts: [],
  layers: [
    { name: "TOP", index: 0, side: "top" },
    { name: "BOTTOM", index: 31, side: "bottom" },
  ],
  nets: netNames.map((name) => ({ name })),
  components: [
    { designator: "U1", at: { x: 5, y: 5 }, rotationDeg: 0, side: "top" },
    { designator: "J1", at: { x: 45, y: 25 }, rotationDeg: 0, side: "top" },
  ],
  pads: netNames.flatMap((net, index) => [
    {
      component: "U1", number: String(index + 1), net,
      at: { x: 5, y: 2 + index * 2 }, rotationDeg: 0, layers: ["TOP"],
      shape: { kind: "circle", diameterMm: 0.8 },
    },
    {
      component: "J1", number: String(index + 1), net,
      at: { x: 45, y: 2 + index * 2 }, rotationDeg: 0, layers: ["TOP"],
      shape: { kind: "circle", diameterMm: 0.8 },
    },
  ]),
  keepouts: [],
  rules: {
    default: defaultValues,
    nets: [
      { net: "LAYER", values: { ...defaultValues, allowedLayers: ["TOP"] } },
      { net: "IMP", values: { ...defaultValues, impedanceOhm: 50 } },
    ],
    differentialPairs: [{ id: "DP", positive: "DP_P", negative: "DP_N" }],
    matchedGroups: [{ id: "MATCH", nets: ["MATCH_A", "MATCH_B"], toleranceMm: 0.2 }],
  },
  copper: { fixed: emptyCopper, editable: emptyCopper },
}
const base = compileRoutingDsl("runRouting()")
const program = {
  ...base,
  signalNets: [
    { kind: "signal-net", net: "CRIT", priority: "critical" },
    { kind: "signal-net", net: "VIA", viaPreference: "avoid" },
    { kind: "signal-net", net: "LAYER", allowedLayers: { kind: "top" } },
    { kind: "signal-net", net: "IMP", impedance: { targetOhm: 50 } },
    { kind: "signal-net", net: "HIGH", priority: "high" },
  ],
  powerNets: [{ kind: "power-net", net: "POWER" }],
  differentialPairs: [{ kind: "differential-pair", id: "DP", positive: "DP_P", negative: "DP_N" }],
  matchedGroups: [{ kind: "matched-group", id: "MATCH", nets: ["MATCH_A", "MATCH_B"], toleranceMm: 0.2 }],
  fanouts: [{
    target: { kind: "pad", component: "U1", pad: String(netNames.indexOf("FAN") + 1) },
    method: "stub",
    extensionMm: 0.6,
  }],
}
const request = {
  board,
  program,
  rules: board.rules,
  plan: resolveRoutePlan(board, program, board.rules),
}

const partition = partitionHybridRoute(request)
assert.deepEqual(partition.easyedaNets, ["DP_P", "DP_N", "ORD"])
assert.deepEqual(partition.krtNets, [
  "POWER", "MATCH_A", "MATCH_B", "CRIT", "VIA", "LAYER", "IMP", "FAN", "HIGH",
])
assert.ok(partition.reasons.POWER.includes("power"))
assert.equal(partition.reasons.DP_P, undefined,
  "ordinary differential pairs belong to EasyEDA's native bulk pass")
assert.ok(partition.reasons.MATCH_A.includes("matched"))
assert.ok(partition.reasons.CRIT.includes("critical"))
assert.ok(partition.reasons.FAN.includes("fanout"))
assert.ok(partition.reasons.LAYER.includes("per-net-layers"))
assert.ok(partition.reasons.HIGH.includes("high-priority"))

const inheritedRelationProgram = {
  ...base,
  onlyNets: ["DP_P", "DP_N", "MATCH_A", "MATCH_B"],
}
const inheritedRelationRequest = {
  ...request,
  program: inheritedRelationProgram,
  plan: resolveRoutePlan(board, inheritedRelationProgram, board.rules),
}
assert.deepEqual(partitionHybridRoute(inheritedRelationRequest).easyedaNets, ["DP_P", "DP_N"],
  "effective matched relations stay in KRT while ordinary differential pairs stay in EasyEDA")

const busProgram = { ...program, busDetect: true }
const busRequest = { ...request, program: busProgram, plan: resolveRoutePlan(board, busProgram, board.rules) }
assert.deepEqual(partitionHybridRoute(busRequest).easyedaNets, ["DP_P", "DP_N", "ORD"],
  "bus detection must not turn the Hybrid partition into an all-KRT workflow")

const scoped = scopeBackendRequest(request, ["DP_P", "DP_N", "ORD"])
assert.deepEqual(scoped.plan.scopeNets, ["DP_P", "DP_N", "ORD"])
assert.equal(scoped.program.differentialPairs.length, 1)
assert.equal(scoped.program.matchedGroups.length, 0)
assert.equal(scoped.program.powerNets.length, 0)
assert.equal(scoped.program.fanouts.length, 0)

const capabilities = {
  supported: [
    "ordinary-routing", "vias", "differential-pairs", "matched-length", "impedance-controlled",
    "preserve-fixed-copper", "fixed-zone-obstacles", "preconnected-pad-groups", "parallel-vias",
  ],
  maxCopperLayers: 32,
}
const trackFor = (net, index, idPrefix) => ({
  id: `${idPrefix}-${net}`,
  net,
  layer: "TOP",
  widthMm: 0.2,
  points: [{ x: 5, y: 1 + index }, { x: 45, y: 1 + index }],
})
const successfulResult = (routeRequest, idPrefix) => ({
  status: "complete",
  copper: {
    tracks: [
      ...routeRequest.board.copper.editable.tracks,
      ...routeRequest.plan.scopeNets.filter((net) => net !== "GND")
        .map((net, index) => trackFor(net, index, idPrefix)),
    ],
    vias: routeRequest.board.copper.editable.vias,
    zones: routeRequest.board.copper.editable.zones,
  },
  metrics: {
    openNetCount: 0,
    openNets: [],
    connectivityComponentCount: routeRequest.plan.scopeNets.length,
    routedNetCount: routeRequest.plan.scopeNets.length,
  },
})

const krtCalls = []
const easyedaCalls = []
const krt = {
  id: "krt-fixture",
  capabilities,
  preflight() { return [] },
  async route(routeRequest) {
    krtCalls.push(routeRequest)
    assert.ok(routeRequest.board.copper.editable.tracks.some((track) => track.id?.startsWith("easyeda-")),
      "EasyEDA bulk copper must become the incoming KRT checkpoint")
    return successfulResult(routeRequest, "krt")
  },
}
const easyeda = {
  id: "easyeda-fixture",
  capabilities: { supported: ["ordinary-routing", "vias", "preserve-fixed-copper"] },
  preflight() { return [] },
  async route(routeRequest) {
    easyedaCalls.push(routeRequest)
    assert.equal(routeRequest.board.copper.editable.tracks.some((track) => track.id?.startsWith("krt-")), false,
      "EasyEDA must be the first routing process on a two-layer Hybrid board")
    return successfulResult(routeRequest, "easyeda")
  },
}
const hybrid = createHybridBackend({}, { krt, easyeda })
const preflight = await hybrid.preflight(request)
assert.ok(!preflight.some((item) => item.severity === "error"))
const hybridResult = await hybrid.route(request)
assert.equal(hybridResult.status, "complete", JSON.stringify(hybridResult.diagnostics))
assert.equal(krtCalls.length, 1)
assert.equal(easyedaCalls.length, 1)
assert.deepEqual(krtCalls[0].plan.scopeNets, request.plan.scopeNets,
  "post-Easy KRT audits the full request while internally routing reserved and open nets")
assert.deepEqual(easyedaCalls[0].plan.scopeNets, ["DP_P", "DP_N", "ORD"])
assert.equal(hybridResult.metrics.openNetCount, 0)
assert.ok(hybridResult.copper.tracks.some((track) => track.id === "easyeda-ORD"))
assert.ok(hybridResult.copper.tracks.some((track) => track.id === "krt-POWER"))

const krtUnavailable = {
  ...krt,
  preflight() {
    return [{ code: "KRT_FIXTURE_UNAVAILABLE", severity: "error", message: "no Python" }]
  },
  async route() { throw new Error("KRT must not run after failed preflight") },
}
const easyFullCalls = []
const easyFull = {
  ...easyeda,
  async route(routeRequest) {
    easyFullCalls.push(routeRequest)
    return successfulResult(routeRequest, "easy-full")
  },
}
const degraded = createHybridBackend({}, { krt: krtUnavailable, easyeda: easyFull })
const degradedPreflight = await degraded.preflight(request)
assert.ok(!degradedPreflight.some((item) => item.severity === "error"),
  "a viable fallback must keep public preflight non-blocking")
assert.ok(degradedPreflight.some((item) => item.code === "HYBRID_BACKEND_PREFLIGHT_DEFERRED"))
const degradedResult = await degraded.route(request)
assert.equal(degradedResult.status, "partial", "every degraded fallback remains explicitly partial")
assert.equal(easyFullCalls.length, 1)
assert.deepEqual(easyFullCalls[0].plan.scopeNets, partition.routableNets)
assert.ok(degradedResult.diagnostics.some((item) => item.code === "KRT_FIXTURE_UNAVAILABLE"),
  "the original backend error must survive fallback")

const coreFallbackProgram = {
  ...base,
  onlyNets: ["CRIT", "ORD"],
  signalNets: [{ kind: "signal-net", net: "CRIT", priority: "critical" }],
}
const degradedCoreResult = await run({ board, dsl: coreFallbackProgram, backend: degraded })
assert.equal(degradedCoreResult.status, "partial",
  `Hybrid leaf preflight failure must remain non-blocking through the public core: ${JSON.stringify(degradedCoreResult.diagnostics)}`)
assert.ok(degradedCoreResult.copper.tracks.some((track) => track.id?.startsWith("easy-full-")))
assert.ok(degradedCoreResult.diagnostics.some((item) => item.code === "KRT_FIXTURE_UNAVAILABLE"),
  "the raw leaf preflight error must survive core candidate selection")

let runtimeKrtCalls = 0
const runtimeKrt = {
  ...krt,
  async route(routeRequest) {
    runtimeKrtCalls += 1
    return successfulResult(routeRequest, "krt-full")
  },
}
const runtimeEasy = {
  ...easyeda,
  async route() { throw new Error("WASM worker crashed") },
}
const runtimeFallback = createHybridBackend({}, { krt: runtimeKrt, easyeda: runtimeEasy })
await runtimeFallback.preflight(request)
const runtimeResult = await runtimeFallback.route(request)
assert.equal(runtimeResult.status, "partial")
assert.equal(runtimeKrtCalls, 1, "EasyEDA-first failure must invoke the unchanged full KRT backend exactly once")
assert.ok(runtimeResult.copper.tracks.some((track) => track.id === "krt-full-ORD"))
assert.ok(runtimeResult.diagnostics.some((item) => item.code === "HYBRID_STAGE_ROUTE_EXCEPTION"))
assert.ok(runtimeResult.diagnostics.some((item) => item.code === "HYBRID_EASYEDA_RUNTIME_FALLBACK"))
assert.equal(runtimeResult.diagnostics.filter((item) => item.code === "HYBRID_STAGE_ROUTE_EXCEPTION").length, 1,
  "a selected or rejected stage diagnostic must be retained exactly once")

const partialKrtCode = "KRT_BACKEND_FAILED_AFTER_CHECKPOINT"
const failedEasyCode = "EASYEDA_FIXTURE_ROUTE_FAILED"
const partialKrt = {
  ...krt,
  async route(routeRequest) {
    const nonGround = routeRequest.plan.scopeNets.filter((net) => net !== "GND")
    const completedNets = nonGround.slice(0, -1)
    const openNets = nonGround.slice(-1)
    return {
      status: "partial",
      copper: {
        tracks: completedNets.map((net, index) => trackFor(net, index, "retained-krt")),
        vias: [],
        zones: [],
      },
      diagnostics: [{ code: partialKrtCode, severity: "error", message: "failed after checkpoint" }],
      metrics: {
        openNetCount: openNets.length,
        openNets,
        connectivityComponentCount: nonGround.length + openNets.length,
      },
    }
  },
}
const failedEasyFull = {
  ...easyeda,
  async route(routeRequest) {
    return {
      status: "error",
      copper: routeRequest.board.copper.editable,
      diagnostics: [{ code: failedEasyCode, severity: "error", message: "worker failed" }],
      metrics: {
        openNetCount: routeRequest.plan.scopeNets.length,
        openNets: routeRequest.plan.scopeNets,
        connectivityComponentCount: routeRequest.plan.scopeNets.length * 2,
      },
    }
  },
}
const doubleRuntimeFailure = createHybridBackend({}, { krt: partialKrt, easyeda: failedEasyFull })
await doubleRuntimeFailure.preflight(request)
const retainedPartial = await doubleRuntimeFailure.route(request)
assert.equal(retainedPartial.status, "partial")
assert.ok(retainedPartial.copper.tracks.some((track) => track.id?.startsWith("retained-krt-")),
  `a useful KRT checkpoint must survive even when both runtime attempts report errors: ${JSON.stringify(retainedPartial)}`)
for (const code of [partialKrtCode, failedEasyCode, "HYBRID_EASYEDA_RUNTIME_FALLBACK"]) {
  assert.equal(retainedPartial.diagnostics.filter((item) => item.code === code).length, 1,
    `${code} must survive fallback exactly once`)
}

const ordinaryProgram = { ...base, onlyNets: ["ORD"] }
const ordinaryRequest = {
  ...request,
  program: ordinaryProgram,
  plan: resolveRoutePlan(board, ordinaryProgram, board.rules),
}
assert.equal(partitionHybridRoute(ordinaryRequest).krtNets.length, 0)
let ordinaryFallbackRequest
const ordinaryRuntimeFallback = createHybridBackend({}, {
  krt: {
    ...krt,
    async route(routeRequest) {
      ordinaryFallbackRequest = routeRequest
      return successfulResult(routeRequest, "ordinary-krt-full")
    },
  },
  easyeda: {
    ...easyeda,
    async route() { throw new Error("ordinary WASM worker crashed") },
  },
})
await ordinaryRuntimeFallback.preflight(ordinaryRequest)
const ordinaryRecovered = await ordinaryRuntimeFallback.route(ordinaryRequest)
assert.equal(ordinaryRecovered.status, "partial")
assert.deepEqual(ordinaryFallbackRequest.plan.scopeNets, ordinaryRequest.plan.scopeNets,
  "an ordinary EasyEDA runtime failure must retry KRT with the full original scope")
assert.deepEqual(ordinaryFallbackRequest.board.copper.editable, ordinaryRequest.board.copper.editable)
assert.ok(ordinaryRecovered.diagnostics.some((item) => item.code === "HYBRID_EASYEDA_RUNTIME_FALLBACK"))

let busEasyFallbackCalls = 0
const busRuntimeFallback = createHybridBackend({}, {
  krt: {
    ...krt,
    async route(routeRequest) {
      return {
        status: "partial",
        copper: routeRequest.board.copper.editable,
        diagnostics: [{
          code: "KRT_BACKEND_FAILED_AFTER_CHECKPOINT",
          severity: "error",
          message: "KRT stopped",
        }],
        metrics: {
          openNetCount: routeRequest.plan.scopeNets.length,
          openNets: routeRequest.plan.scopeNets,
          connectivityComponentCount: routeRequest.plan.scopeNets.length * 2,
        },
      }
    },
  },
  easyeda: {
    ...easyeda,
    async route(routeRequest) {
      busEasyFallbackCalls += 1
      return successfulResult(routeRequest, "bus-easy-full")
    },
  },
})
await busRuntimeFallback.preflight(busRequest)
const busRecovered = await busRuntimeFallback.route(busRequest)
assert.equal(busRecovered.status, "partial")
assert.equal(busEasyFallbackCalls, 1,
  "a late KRT failure must retain the already-run EasyEDA checkpoint without starting a second WASM route")
assert.ok(busRecovered.diagnostics.some((item) => item.code === "KRT_BACKEND_FAILED_AFTER_CHECKPOINT"))
assert.ok(busRecovered.diagnostics.some((item) => item.code === "HYBRID_KRT_CHECKPOINT_FALLBACK"))

const krtOnlyProgram = {
  ...base,
  onlyNets: ["IMP"],
  signalNets: [{ kind: "signal-net", net: "IMP", impedance: { targetOhm: 50 } }],
}
const krtOnlyRequest = {
  ...request,
  program: krtOnlyProgram,
  plan: resolveRoutePlan(board, krtOnlyProgram, board.rules),
}
assert.deepEqual(partitionHybridRoute(krtOnlyRequest).easyedaNets, [])
let krtOnlyEasyCalls = 0
let krtOnlyEasyRequest
const krtOnlyRuntimeFallback = createHybridBackend({}, {
  krt: {
    ...krt,
    async route(routeRequest) {
      return {
        status: "partial",
        copper: routeRequest.board.copper.editable,
        diagnostics: [{
          code: "KRT_BACKEND_FAILED_AFTER_CHECKPOINT",
          severity: "error",
          message: "KRT failed before producing useful copper",
        }],
        metrics: {
          openNetCount: 1,
          openNets: ["IMP"],
          connectivityComponentCount: 2,
        },
      }
    },
  },
  easyeda: {
    ...easyeda,
    async route(routeRequest) {
      krtOnlyEasyCalls += 1
      krtOnlyEasyRequest = routeRequest
      return successfulResult(routeRequest, "krt-only-easy-fallback")
    },
  },
})
await krtOnlyRuntimeFallback.preflight(krtOnlyRequest)
const krtOnlyRecovered = await krtOnlyRuntimeFallback.route(krtOnlyRequest)
assert.equal(krtOnlyRecovered.status, "partial")
assert.equal(krtOnlyEasyCalls, 1,
  "a KRT-only runtime failure must retain the one still-unused EasyEDA full fallback attempt")
assert.deepEqual(krtOnlyEasyRequest.plan.scopeNets, ["IMP"])
assert.ok(krtOnlyRecovered.copper.tracks.some((track) => track.id === "krt-only-easy-fallback-IMP"))
assert.ok(krtOnlyRecovered.diagnostics.some((item) => item.code === "HYBRID_KRT_RUNTIME_FALLBACK"))
assert.ok(krtOnlyRecovered.diagnostics.some((item) => item.code === "HYBRID_HARD_CONSTRAINTS_UNVERIFIED_FALLBACK"))

const bothUnavailable = createHybridBackend({}, {
  krt: krtUnavailable,
  easyeda: {
    ...easyeda,
    preflight() {
      return [{ code: "EASYEDA_FIXTURE_UNAVAILABLE", severity: "error", message: "no assets" }]
    },
    async route() { throw new Error("EasyEDA must not run after failed preflight") },
  },
})
const unavailablePreflight = await bothUnavailable.preflight(request)
assert.ok(!unavailablePreflight.some((item) => item.severity === "error"))
const unavailableResult = await bothUnavailable.route(request)
assert.equal(unavailableResult.status, "partial")
assert.deepEqual(unavailableResult.copper, board.copper.editable)
for (const code of ["KRT_FIXTURE_UNAVAILABLE", "EASYEDA_FIXTURE_UNAVAILABLE", "HYBRID_NO_BACKEND_AVAILABLE"]) {
  assert.ok(unavailableResult.diagnostics.some((item) => item.code === code), `${code} must not be discarded`)
}

const unavailableCoreResult = await run({ board, dsl: coreFallbackProgram, backend: bothUnavailable })
assert.equal(unavailableCoreResult.status, "partial",
  "even total leaf unavailability must return the core's applicable partial checkpoint")
assert.deepEqual(unavailableCoreResult.copper, board.copper.editable)
for (const code of ["KRT_FIXTURE_UNAVAILABLE", "EASYEDA_FIXTURE_UNAVAILABLE", "HYBRID_NO_BACKEND_AVAILABLE"]) {
  assert.ok(unavailableCoreResult.diagnostics.some((item) => item.code === code),
    `${code} must survive a rejected Hybrid candidate in the core`)
}

let multilayerRequestSeen
const multilayerBoard = {
  ...board,
  layers: [
    { name: "TOP", index: 0, side: "top" },
    { name: "INNER_1", index: 1, side: "inner" },
    { name: "INNER_2", index: 2, side: "inner" },
    { name: "BOTTOM", index: 31, side: "bottom" },
  ],
}
const multilayerRequest = {
  ...request,
  board: multilayerBoard,
  plan: resolveRoutePlan(multilayerBoard, program, board.rules),
}
const multilayerKrt = {
  ...krt,
  async route(routeRequest) {
    multilayerRequestSeen = routeRequest
    return successfulResult(routeRequest, "multi")
  },
}
const multilayerHybrid = createHybridBackend({}, { krt: multilayerKrt, easyeda })
await multilayerHybrid.preflight(multilayerRequest)
const multilayerResult = await multilayerHybrid.route(multilayerRequest)
assert.equal(multilayerRequestSeen, multilayerRequest,
  "multilayer routing must delegate the original request to the unchanged KRT backend")
assert.equal(multilayerResult.status, "complete")

console.log("Hybrid backend scope, fallback, and diagnostic preservation: ok")
