import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  bundledEasyEdaWasmAssets,
  createEasyEdaWasmBackend,
} from "../package-dist/backends/easyeda-wasm.js"
import { resolveRoutePlan } from "../package-dist/core/index.js"
import { compileRoutingDsl } from "../package-dist/intent/index.js"

const emptyCopper = { tracks: [], vias: [], zones: [] }
const values = {
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
const board = {
  outline: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
  cutouts: [],
  layers: [
    { name: "TOP", index: 0, side: "top" },
    { name: "BOTTOM", index: 31, side: "bottom" },
  ],
  nets: ["A", "B", "GND"].map((name) => ({ name })),
  components: [
    { designator: "J1", at: { x: 2, y: 2 }, rotationDeg: 0, side: "top" },
    { designator: "J2", at: { x: 18, y: 8 }, rotationDeg: 0, side: "bottom" },
  ],
  pads: ["A", "B", "GND"].flatMap((net, index) => [
    {
      component: "J1", number: String(index + 1), net,
      at: { x: 2, y: 2 + index * 2 }, rotationDeg: 0, layers: ["TOP"],
      shape: { kind: "circle", diameterMm: 0.8 },
    },
    {
      component: "J2", number: String(index + 1), net,
      at: { x: 18, y: 2 + index * 2 }, rotationDeg: 0, layers: ["BOTTOM"],
      shape: { kind: "circle", diameterMm: 0.8 },
    },
  ]),
  keepouts: [],
  rules: { default: values, nets: [] },
  copper: {
    fixed: emptyCopper,
    editable: {
      tracks: [{
        id: "retained", net: "B", layer: "TOP", widthMm: 0.2,
        points: [{ x: 2, y: 4 }, { x: 4, y: 4 }],
      }],
      vias: [], zones: [],
    },
  },
}
const baseProgram = compileRoutingDsl("runRouting()")
const program = { ...baseProgram, onlyNets: ["A"] }
const request = {
  board,
  program,
  rules: board.rules,
  plan: resolveRoutePlan(board, program, board.rules),
}

let capturedInput
const backend = createEasyEdaWasmBackend({
  async engine(input) {
    capturedInput = input
    return {
      progress: 1,
      routabitity: 1,
      traces: [{ id: "new-a", layer: 1, net: "A", width: 0.2, path: [[-8, 3], [8, 3]] }],
      vias: [],
    }
  },
})
const result = await backend.route(request)
assert.equal(result.status, "complete")
assert.deepEqual(
  capturedInput.nets.filter((item) => item.routing).map((item) => item.net),
  ["A"],
  "WASM routing scope must come from request.plan, not every visible board net",
)
assert.equal(capturedInput.nets.find((item) => item.net === "B").routing, false)
assert.equal(capturedInput.nets.find((item) => item.net === "GND").routing, false)
assert.equal(capturedInput.components.routing_pad_1.layer, 1,
  "synthetic pad carriers must stay on the front side so physical pad layers are not mirrored twice")
assert.deepEqual(capturedInput.footprints.routing_footprint_1.pads.p0.layers, [2],
  "a physical bottom pad must remain layer 2 in the EasyEDA footprint")
assert.equal(result.metrics.openNetCount, 0)
assert.deepEqual(result.metrics.openNets, [])
assert.ok(result.copper.tracks.some((track) => track.id === "retained"), "incoming editable copper must survive")
assert.ok(result.copper.tracks.some((track) => track.net === "A"), "worker additions must be returned")

const partial = await createEasyEdaWasmBackend({
  async engine() { return { progress: 1, routabitity: 0.4, traces: [], vias: [] } },
}).route(request)
assert.equal(partial.status, "partial")
assert.equal(partial.metrics.openNetCount, 1)
assert.ok(partial.diagnostics.some((item) => item.code === "EASYEDA_WASM_PARTIAL_ROUTABILITY"))

const failed = await createEasyEdaWasmBackend({
  async engine() { throw new Error("worker fixture failed") },
}).route(request)
assert.equal(failed.status, "partial", "a worker exception must retain a partial checkpoint")
assert.deepEqual(failed.copper, board.copper.editable)
assert.ok(failed.diagnostics.some((item) => (
  item.code === "EASYEDA_WASM_ROUTE_FAILED" && item.details === "worker fixture failed"
)))
assert.deepEqual(failed.metrics.openNets, ["A"])

const assets = bundledEasyEdaWasmAssets()
assert.ok(existsSync(assets.workerPath), assets.workerPath)
assert.ok(existsSync(assets.wasmPath), assets.wasmPath)

const inheritedModuleModeSmoke = resolve("tests/e2e/no_kicad/easyeda_wasm.mjs")
const inheritedModuleMode = spawnSync(process.execPath, [
  "--input-type=module",
  "--eval",
  `await import(${JSON.stringify(pathToFileURL(inheritedModuleModeSmoke).href)})`,
], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })
assert.equal(inheritedModuleMode.status, 0,
  `bundled worker must not inherit --input-type=module:\n${inheritedModuleMode.stderr}\n${inheritedModuleMode.stdout}`)

console.log("EasyEDA WASM backend contract: ok")
