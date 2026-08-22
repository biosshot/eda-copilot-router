import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"

const execute = promisify(execFile)
const testDirectory = dirname(fileURLToPath(import.meta.url))
const routerDirectory = resolve(testDirectory, "../../..")
const fixture = resolve(routerDirectory, "tests/e2e/cap_chain/fixture/cap_chain.kicad_pcb")
const dsl = resolve(routerDirectory, "tests/e2e/cap_chain/routing.js")
const before = await readFile(fixture, "utf8")
const temporary = await mkdtemp(join(tmpdir(), "copilot-router-native-"))

try {
  const output = join(temporary, "routed.kicad_pcb")
  const { stdout } = await execute(process.execPath, [
    resolve(routerDirectory, "package-dist/cli.js"), "route", fixture,
    "--dsl", dsl, "--profile", "fast", "-o", output,
  ], { cwd: routerDirectory, maxBuffer: 10 * 1024 * 1024 })
  const summary = JSON.parse(stdout)
  assert.equal(summary.status, "complete", stdout)
  assert.equal(summary.outputPath, output)
  assert.equal(summary.nativeVerification, "not-run")
  const adapter = await import(pathToFileURL(resolve(routerDirectory, "package-dist/adapters/kicad.js")))
  const imported = await adapter.importKiCadRoutingBoard(output)
  assert.ok(imported.board, JSON.stringify(imported.diagnostics))
  assert.ok(imported.board.copper.editable.tracks.length > 0)
  assert.equal(await readFile(fixture, "utf8"), before, "standalone route must not modify its source board")
  console.log(`standalone KiCad CLI without KiCad: ok (${imported.board.copper.editable.tracks.length} tracks)`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
