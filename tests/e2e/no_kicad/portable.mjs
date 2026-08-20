import assert from "node:assert/strict"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { board, dsl } from "./board.mjs"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const routerDirectory = resolve(testDirectory, "../../..")
const router = await import(pathToFileURL(resolve(routerDirectory, "package-dist/index.js")))

const backend = {
  id: "portable-no-kicad",
  capabilities: {
    supported: [
      "ordinary-routing", "vias", "differential-pairs", "matched-length",
      "preserve-fixed-copper", "fixed-zone-obstacles", "preconnected-pad-groups",
    ],
  },
  async route() {
    return {
      status: "complete",
      copper: {
        tracks: [
          { net: "DPA_P", layer: "F.Cu", widthMm: 0.25, points: [{ x: 10, y: 15 }, { x: 17.52, y: 13 }] },
          { net: "DPA_N", layer: "F.Cu", widthMm: 0.25, points: [{ x: 10, y: 17.54 }, { x: 17.52, y: 17 }] },
          { net: "DPB_P", layer: "F.Cu", widthMm: 0.25, points: [{ x: 18.48, y: 13 }, { x: 26, y: 15 }] },
          { net: "DPB_N", layer: "F.Cu", widthMm: 0.25, points: [{ x: 18.48, y: 17 }, { x: 26, y: 17.54 }] },
        ],
        vias: [],
        zones: [],
      },
      metrics: { openNetCount: 0, openNets: [] },
    }
  },
}

const result = await router.run({ board, dsl, backend })
assert.equal(result.status, "complete", JSON.stringify(result.diagnostics))
assert.equal(result.metrics.backend, "portable-no-kicad")
assert.equal(result.copper?.tracks.length, 4)
assert.equal(result.requiresNativeVerification, true)
console.log("portable no-KiCad E2E: ok")

