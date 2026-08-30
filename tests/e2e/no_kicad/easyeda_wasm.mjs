import assert from "node:assert/strict"
import { createBundledEasyEdaWasmBackend } from "../../../package-dist/backends/easyeda-wasm.js"
import { createHybridBackend } from "../../../package-dist/backends/hybrid.js"
import { resolveRoutePlan } from "../../../package-dist/core/index.js"
import { compileRoutingDsl } from "../../../package-dist/intent/index.js"

const emptyCopper = { tracks: [], vias: [], zones: [] }
const values = {
  clearanceMm: 0.2,
  edgeClearanceMm: 0.2,
  minTrackWidthMm: 0.2,
  preferredTrackWidthMm: 0.2,
  via: {
    minDiameterMm: 0.6,
    preferredDiameterMm: 0.6,
    minDrillMm: 0.3,
    preferredDrillMm: 0.3,
  },
}
const board = {
  outline: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
  cutouts: [],
  layers: [
    { name: "TOP", index: 0, side: "top" },
    { name: "BOTTOM", index: 31, side: "bottom" },
  ],
  nets: [{ name: "SIGNAL" }],
  components: [
    { designator: "J1", at: { x: 2, y: 5 }, rotationDeg: 0, side: "top" },
    { designator: "J2", at: { x: 18, y: 5 }, rotationDeg: 0, side: "top" },
  ],
  pads: [
    {
      component: "J1", number: "1", net: "SIGNAL",
      at: { x: 2, y: 5 }, rotationDeg: 0, layers: ["TOP"],
      shape: { kind: "circle", diameterMm: 1 },
    },
    {
      component: "J2", number: "1", net: "SIGNAL",
      at: { x: 18, y: 5 }, rotationDeg: 0, layers: ["TOP"],
      shape: { kind: "circle", diameterMm: 1 },
    },
  ],
  keepouts: [],
  rules: { default: values, nets: [] },
  copper: { fixed: emptyCopper, editable: emptyCopper },
}
const program = compileRoutingDsl('onlyNets("SIGNAL"); runRouting()')
const request = {
  board,
  program,
  rules: board.rules,
  plan: resolveRoutePlan(board, program, board.rules),
  signal: AbortSignal.timeout(30_000),
}
const backend = createHybridBackend({}, {
  krt: {
    id: "krt-unused-smoke-guard",
    capabilities: { supported: [], maxCopperLayers: 32 },
    preflight() { throw new Error("ordinary two-layer smoke must not start KRT preflight") },
    async route() { throw new Error("ordinary two-layer smoke must not start KRT routing") },
  },
  easyeda: createBundledEasyEdaWasmBackend(),
})
const preflight = await backend.preflight(request)
assert.ok(!preflight.some((item) => item.severity === "error"), JSON.stringify(preflight))
const result = await backend.route(request)
assert.notEqual(result.status, "error")
assert.ok(!result.diagnostics?.some((item) => item.code === "EASYEDA_WASM_ROUTE_FAILED"),
  JSON.stringify(result.diagnostics))
assert.ok(result.copper.tracks.some((track) => track.net === "SIGNAL"),
  `worker produced no SIGNAL track: ${JSON.stringify(result.metrics)}`)
assert.equal(result.metrics?.backend, "hybrid")
assert.equal(result.metrics?.details?.hybrid?.mode, "easyeda-only")

console.log("bundled EasyEDA WASM Hybrid no-KiCad smoke: ok")
