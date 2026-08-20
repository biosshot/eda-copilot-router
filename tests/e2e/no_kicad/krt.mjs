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
  policy: { profile: "fast", maxCandidates: 1 },
})
assert.notEqual(result.status, "error", JSON.stringify(result.diagnostics))
assert.ok((result.copper?.tracks.length ?? 0) > 0 || (result.copper?.vias.length ?? 0) > 0,
  `router-owned codec must return portable KRT copper: ${JSON.stringify(result.diagnostics)}`)
assert.equal(result.metrics?.backend, "krt")
console.log(`managed KRT no-KiCad E2E: ok (${result.copper.tracks.length} tracks, ${result.copper.vias.length} vias)`)
