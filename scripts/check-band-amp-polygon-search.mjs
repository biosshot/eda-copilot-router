import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"

import { compileRoutingDsl, run } from "../package-dist/index.js"
import { importKiCadRoutingBoard } from "../package-dist/adapters/kicad.js"

const boardPath = resolve("tests/e2e/band_amp/fixture/band_amp.kicad_pcb")
const dslPath = resolve("tests/e2e/band_amp/routing.js")
const imported = await importKiCadRoutingBoard(boardPath, { existingCopper: "fixed" })
assert.ok(imported.board, imported.diagnostics.map((item) => item.message).join("\n"))

const program = compileRoutingDsl(await readFile(dslPath, "utf8"))
let backendCalls = 0
const backend = {
  id: "band-amp-polygon-regression",
  capabilities: {
    supported: [
      "ordinary-routing", "vias", "zones", "plane-stitching", "differential-pairs",
      "matched-length", "impedance-controlled", "preserve-fixed-copper",
      "fixed-zone-obstacles", "preconnected-pad-groups", "parallel-vias",
    ],
    maxCopperLayers: 32,
  },
  async route() {
    backendCalls += 1
    return { status: "complete", copper: { tracks: [], vias: [], zones: [] } }
  },
}

const started = performance.now()
const result = await run({
  board: imported.board,
  dsl: { ...program, viaStitches: [] },
  backend,
  policy: { profile: "balanced", maxCandidates: 1 },
})
const elapsedMs = performance.now() - started

assert.equal(backendCalls, 1, "compact planning did not reach the backend")
assert.ok(elapsedMs < 5_000, `band_amp compact planning took ${elapsedMs.toFixed(1)} ms`)
assert.ok(!result.diagnostics.some((item) => item.code === "COPPER_PLANNING_EXCEPTION"))
assert.ok(
  result.copper?.zones.some((zone) => zone.net === "VBIAS" && zone.id?.startsWith("compact:")),
  "expected a completed VBIAS compact zone",
)

console.log(JSON.stringify({
  boardPath,
  dslPath,
  elapsedMs,
  status: result.status,
  zones: result.copper?.zones.length ?? 0,
  polygonPlanning: result.metrics.details?.copperPlanning,
}, null, 2))
