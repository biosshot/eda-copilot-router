import assert from "node:assert/strict"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { board, dsl } from "./board.mjs"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const routerDirectory = resolve(testDirectory, "../../..")
const router = await import(pathToFileURL(resolve(routerDirectory, "package-dist/index.js")))

const result = await router.run({
  board,
  dsl,
})
assert.notEqual(result.status, "error", JSON.stringify(result.diagnostics))
assert.ok((result.copper?.tracks.length ?? 0) > 0 || (result.copper?.vias.length ?? 0) > 0,
  `router-owned codec must return portable KRT copper: ${JSON.stringify(result.diagnostics)}`)
for (const pad of board.pads) {
  assert.ok(result.copper.tracks.some((track) => track.net === pad.net && track.points.some((point) =>
    Math.hypot(point.x - pad.at.x, point.y - pad.at.y) < 0.9)),
  `routed ${pad.net} copper must terminate at rotated ${pad.component}.${pad.number}`)
}
assert.equal(result.metrics?.backend, "krt")
assert.notEqual(result.metrics?.details?.runtime?.source, "override",
  "managed KRT must not use a local KRT checkout")
const pairReports = result.metrics?.details?.special?.pair_reports ?? []
assert.deepEqual(pairReports.map((report) => [report.p_net, report.n_net]), [
  ["USB_DP_CONN", "USB_DM_CONN"],
  ["USB_DP_ESD", "USB_DM_ESD"],
], "managed KRT must preserve exact DSL pair membership for non-standard net names")
console.log(`managed KRT no-KiCad E2E: ok (${result.copper.tracks.length} tracks, ${result.copper.vias.length} vias)`)
