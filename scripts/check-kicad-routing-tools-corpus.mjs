import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const routerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const testDirectory = join(routerDirectory, "tests", "e2e", "kicad-routing-tools")
const manifest = JSON.parse(await readFile(join(testDirectory, "manifest.json"), "utf8"))
const source = JSON.parse(await readFile(join(testDirectory, manifest.source), "utf8"))
const { compileRoutingDsl } = await import(pathToFileURL(join(routerDirectory, "package-dist", "index.js")))

assert.equal(manifest.schema, "copilot-router-kicad-routing-tools-corpus")
assert.equal(manifest.cases.length, 22)
assert.equal(new Set(manifest.cases.map((entry) => entry.id)).size, manifest.cases.length)
assert.equal(source.commit, "52b006c7b74f05c67c928ce0471671a2ff599e69")
assert.equal(source.files.length, 26)

for (const entry of source.files) {
  const path = join(testDirectory, "upstream", entry.path)
  const contents = await readFile(path)
  assert.equal((await stat(path)).size, entry.bytes, `${entry.path} byte count`)
  assert.equal(createHash("sha256").update(contents).digest("hex"), entry.sha256, `${entry.path} hash`)
}

const fixtureBoards = (await readdir(join(testDirectory, "upstream", "kicad_files")))
  .filter((name) => name.endsWith(".kicad_pcb"))
  .sort()
assert.deepEqual(
  manifest.cases.map((entry) => entry.board.split("/").at(-1)).sort(),
  fixtureBoards,
  "every upstream board must have exactly one case",
)

for (const entry of manifest.cases) {
  const boardPath = join(testDirectory, entry.board)
  await stat(boardPath)
  if (entry.project) await stat(join(testDirectory, entry.project))
  const dsl = await readFile(join(testDirectory, entry.dsl), "utf8")
  const program = compileRoutingDsl(dsl)
  assert.ok(["route", "all"].includes(program.operation), `${entry.id} must run routing`)
  assert.equal(program.differentialPairs.length, entry.expectedDiffPairs, `${entry.id} diff-pair count`)
  assert.equal(
    new Set(program.differentialPairs.map((pair) => pair.id)).size,
    program.differentialPairs.length,
    `${entry.id} duplicate diff-pair id`,
  )
  const boardText = await readFile(boardPath, "utf8")
  const netNames = new Set([
    ...boardText.matchAll(/\(net\s+\d+\s+"((?:[^"\\]|\\.)*)"\)/g),
    ...boardText.matchAll(/\(net\s+"((?:[^"\\]|\\.)*)"\)/g),
  ].map((match) => match[1]))
  for (const pair of program.differentialPairs) {
    assert.ok(netNames.has(pair.positive), `${entry.id} missing positive net ${pair.positive}`)
    assert.ok(netNames.has(pair.negative), `${entry.id} missing negative net ${pair.negative}`)
  }
  for (const plane of program.planes) assert.ok(netNames.has(plane.net), `${entry.id} missing plane net ${plane.net}`)
}

console.log(`KiCadRoutingTools corpus contract passed: ${manifest.cases.length} boards, ${source.files.length} upstream files`)
