import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import * as api from "../package-dist/index.js"

const root = resolve("tests/e2e/_corpora/easyeda-hybrid")
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))
assert.equal(manifest.version, 1)
assert.ok(Array.isArray(manifest.cases) && manifest.cases.length > 0)
const ids = new Set()
for (const item of manifest.cases) {
  assert.match(item.id, /^[0-9a-f]{8}$/)
  assert.ok(!ids.has(item.id), `duplicate EasyEDA corpus id ${item.id}`)
  ids.add(item.id)
  assert.ok(["hybrid", "krt"].includes(item.workflow))
  assert.ok(["stable", "diagnostic", "archive"].includes(item.tier))
  assert.ok(Number.isInteger(item.expect?.maxOpenNetCount) && item.expect.maxOpenNetCount >= 0)
  assert.ok(Number.isFinite(item.expect?.maxElapsedMs) && item.expect.maxElapsedMs > 0)
  if (item.expect.maxFinalDrcViolationCount !== undefined) {
    assert.ok(Number.isInteger(item.expect.maxFinalDrcViolationCount) && item.expect.maxFinalDrcViolationCount >= 0)
  }
  const directory = join(root, "fixture", item.id)
  await Promise.all([
    access(join(directory, "input.json")),
    access(join(directory, "routing.dsl.js")),
    access(join(directory, "hole-overrides.json")),
  ])
  const source = await readFile(join(directory, "input.json"), "utf8")
  assert.doesNotMatch(source, /AppData|%TEMP%|results[\\/]research/i,
    `${item.id} must not depend on an external artifact directory`)
  const input = JSON.parse(source)
  const validation = api.validateRoutingBoard(input.board)
  assert.ok(validation.ok, `${item.id}: ${JSON.stringify(validation.diagnostics)}`)
  assert.equal(input.dsl?.quality, undefined, `${item.id} retains removed quality DSL state`)
  const physicalBoard = api.materializeRoutingStackup(input.board, input.dsl?.stack)
  const stackDiagnostics = api.routingStackupDiagnostics(physicalBoard.stackup, physicalBoard.layers.length)
  assert.equal(stackDiagnostics.length, 0, `${item.id}: ${JSON.stringify(stackDiagnostics)}`)
  assert.equal(physicalBoard.stackup.layers.length, physicalBoard.layers.length * 2 - 1,
    `${item.id} physical stack must alternate copper and dielectric layers`)
  const physicalThicknessMm = api.stackupThicknessMm(physicalBoard.stackup)
  assert.ok(Math.abs(physicalThicknessMm - physicalBoard.stackup.boardThicknessMm) < 0.001,
    `${item.id} physical stack ${physicalThicknessMm} mm does not match board thickness ${physicalBoard.stackup.boardThicknessMm} mm`)
  const multilayer = input.board.pads.filter(pad => pad.layers.length > 1)
  assert.equal(multilayer.length, item.expectedHolePads, `${item.id} multilayer pad count changed`)
  assert.ok(multilayer.every(pad => pad.hole), `${item.id} has a multilayer pad without hole metadata`)
  assert.ok(multilayer.every(pad => pad.hole.diameterMm > 0), `${item.id} has a non-positive drill`)
  const overrides = JSON.parse(await readFile(join(directory, "hole-overrides.json"), "utf8"))
  assert.equal(overrides.fabricationAuthoritative, false)
  assert.equal(overrides.pads.length, item.expectedHolePads)
}
assert.ok(manifest.cases.some(item => item.tier === "stable"), "corpus needs at least one default stable case")
process.stdout.write(`EasyEDA hybrid corpus contract: ${manifest.cases.length} cases ok\n`)
