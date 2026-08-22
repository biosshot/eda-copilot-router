import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"

const execute = promisify(execFile)
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("packed E2E must be invoked through npm")
const runNpm = (args, cwd) => execute(process.execPath, [npmCli, ...args], {
  cwd, maxBuffer: 20 * 1024 * 1024,
})
const testDirectory = dirname(fileURLToPath(import.meta.url))
const routerDirectory = resolve(testDirectory, "../../..")
const fixtureDirectory = resolve(routerDirectory, "tests/e2e/cap_chain/fixture")
const temporary = await mkdtemp(join(tmpdir(), "copilot-router-packed-"))

try {
  const packed = await runNpm(["pack", "--silent", "--pack-destination", temporary], routerDirectory)
  const filename = packed.stdout.trim().split(/\r?\n/).at(-1)
  if (!filename?.endsWith(".tgz")) throw new Error(`npm pack did not return a tarball: ${packed.stdout}`)
  const tarball = join(temporary, filename)
  const consumer = join(temporary, "consumer")
  await mkdir(consumer)
  await writeFile(join(temporary, "package.json"), "{}\n", "utf8")
  await writeFile(join(temporary, "routing.js"), await readFile(resolve(routerDirectory, "tests/e2e/cap_chain/routing.js"), "utf8"), "utf8")
  await copyFile(join(fixtureDirectory, "cap_chain.kicad_pcb"), join(temporary, "board.kicad_pcb"))
  await runNpm(["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], temporary)
  const cli = join(temporary, "node_modules", "eda-copilot-router", "package-dist", "cli.js")
  const output = join(temporary, "routed.kicad_pcb")
  const routed = await execute(process.execPath, [
    cli, "route", join(temporary, "board.kicad_pcb"), "--dsl", join(temporary, "routing.js"),
    "--profile", "fast", "-o", output,
  ], { cwd: consumer, maxBuffer: 20 * 1024 * 1024 })
  const summary = JSON.parse(routed.stdout)
  assert.equal(summary.status, "complete", routed.stdout)
  assert.equal(summary.nativeVerification, "not-run")
  const adapterPath = join(temporary, "node_modules", "eda-copilot-router", "package-dist", "adapters", "kicad.js")
  const adapter = await import(pathToFileURL(adapterPath))
  const imported = await adapter.importKiCadRoutingBoard(output)
  assert.ok(imported.board, JSON.stringify(imported.diagnostics))
  assert.ok(imported.board.copper.editable.tracks.length > 0)
  console.log(`packed npm standalone routing: ok (${imported.board.copper.editable.tracks.length} tracks)`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
