import assert from "node:assert/strict"
import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const routerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const e2eDirectory = join(routerDirectory, "tests", "e2e")
const testDirectory = join(e2eDirectory, "_corpora", "kicad-routing-tools")
const manifest = JSON.parse(await readFile(join(testDirectory, "manifest.json"), "utf8"))
const source = JSON.parse(await readFile(join(testDirectory, manifest.source), "utf8"))
const { compileRoutingDsl } = await import(pathToFileURL(join(routerDirectory, "package-dist", "index.js")))

assert.equal(manifest.schema, "copilot-router-kicad-routing-tools-corpus")
assert.equal(manifest.cases.length, 22)
assert.equal(new Set(manifest.cases.map((entry) => entry.id)).size, manifest.cases.length)
assert.equal(source.commit, "52b006c7b74f05c67c928ce0471671a2ff599e69")

const fixtureFiles = new Map()
for (const entry of manifest.cases) {
  assert.equal(entry.directory, entry.id, `${entry.id} must be a direct tests/e2e child`)
  const caseDirectory = join(e2eDirectory, entry.directory)
  const fixtureDirectory = dirname(join(caseDirectory, entry.board))
  for (const item of await readdir(fixtureDirectory, { withFileTypes: true })) {
    if (!item.isFile()) continue
    assert.ok(!fixtureFiles.has(item.name), `duplicate fixture filename ${item.name}`)
    fixtureFiles.set(item.name, join(fixtureDirectory, item.name))
  }
}

const fixtureBoards = [...fixtureFiles.keys()]
  .filter((name) => name.endsWith(".kicad_pcb"))
  .sort()
assert.deepEqual(
  manifest.cases.map((entry) => entry.board.split("/").at(-1)).sort(),
  fixtureBoards,
  "every upstream board must have exactly one case",
)

for (const entry of manifest.cases) {
  const caseDirectory = join(e2eDirectory, entry.directory)
  const boardPath = join(caseDirectory, entry.board)
  await stat(boardPath)
  if (entry.project) await stat(join(caseDirectory, entry.project))
  await stat(join(caseDirectory, "run.mjs"))
  const dsl = await readFile(join(caseDirectory, "routing.js"), "utf8")
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

console.log(`KiCadRoutingTools corpus contract passed: ${manifest.cases.length} boards`)
