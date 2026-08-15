import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"

import { run } from "../package-dist/index.js"
import { importKiCadRoutingBoard } from "../../kicad-copilot/dist/router-package-adapter.js"

const boardPath = resolve(process.env.COPILOT_ROUTER_POWERBANK_BOARD
  ?? "tests/e2e/powerbank/fixture/Powerbank.kicad_pcb")
const dslPath = resolve(process.env.COPILOT_ROUTER_POWERBANK_DSL
  ?? "tests/e2e/powerbank/routing.js")

const imported = await importKiCadRoutingBoard(boardPath, { existingCopper: "fixed" })
assert.ok(imported.board, imported.diagnostics.map((item) => item.message).join("\n"))

let backendCalls = 0
const backend = {
  id: "powerbank-polygon-regression",
  capabilities: {
    supported: [
      "ordinary-routing", "vias", "zones", "differential-pairs", "matched-length",
      "preserve-fixed-copper", "fixed-zone-obstacles", "preconnected-pad-groups", "parallel-vias",
    ],
    maxCopperLayers: 2,
  },
  async route() {
    backendCalls += 1
    return { status: "complete", copper: { tracks: [], vias: [], zones: [] } }
  },
}

const started = performance.now()
const result = await run({
  board: imported.board,
  dsl: await readFile(dslPath, "utf8"),
  backend,
})
const elapsedMs = performance.now() - started

assert.equal(backendCalls, 1, "polygon planning did not reach the routing backend")
assert.ok(elapsedMs < 5_000, `polygon planning took ${elapsedMs.toFixed(1)} ms`)
assert.ok(!result.diagnostics.some((item) => item.code === "COPPER_PLANNING_EXCEPTION"))
assert.ok(!result.diagnostics.some((item) => /polygon search reached/i.test(item.message)))
assert.ok((result.copper?.zones.length ?? 0) >= 6, "expected compact power zones plus the GND plane")

console.log(JSON.stringify({
  boardPath,
  dslPath,
  elapsedMs,
  backendCalls,
  status: result.status,
  zones: result.copper?.zones.length ?? 0,
  polygonPlans: result.metrics.details?.copperPlanning,
}, null, 2))
