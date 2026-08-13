import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, readFile } from "node:fs/promises"
import { resolve } from "node:path"

const defaultReport = resolve(
  "results",
  "refactor-routing-contract-regression",
  "workflow-report.json",
)
const reportPath = resolve(process.argv[2] ?? process.env.COPILOT_ROUTER_REGRESSION_REPORT ?? defaultReport)
const report = JSON.parse(await readFile(reportPath, "utf8"))

function token(value, quoted = false) { return { value, quoted } }
function isList(value) { return Array.isArray(value) }
function atom(value) { return value && !isList(value) ? value.value : undefined }
function head(value) { return isList(value) ? atom(value[0]) : undefined }

function parseSExpression(source) {
  const tokens = []
  for (let index = 0; index < source.length;) {
    const char = source[index]
    if (/\s/.test(char)) { index += 1; continue }
    if (char === ";") { while (index < source.length && source[index] !== "\n") index += 1; continue }
    if (char === "(" || char === ")") { tokens.push(char); index += 1; continue }
    if (char === '"') {
      let value = ""; index += 1
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\" && index + 1 < source.length) {
          value += source[index + 1] === "n" ? "\n" : source[index + 1]
          index += 2
        } else { value += source[index]; index += 1 }
      }
      assert.equal(source[index], '"', "unterminated KiCad string")
      tokens.push(token(value, true)); index += 1; continue
    }
    let end = index
    while (end < source.length && !/[\s()]/.test(source[end])) end += 1
    tokens.push(token(source.slice(index, end))); index = end
  }
  let cursor = 0
  const parseOne = () => {
    const current = tokens[cursor++]
    if (current !== "(") {
      assert.notEqual(current, ")", "unexpected KiCad token")
      assert.notEqual(current, undefined, "unexpected KiCad EOF")
      return current
    }
    const list = []
    while (tokens[cursor] !== ")") {
      assert.ok(cursor < tokens.length, "unclosed KiCad list")
      list.push(parseOne())
    }
    cursor += 1
    return list
  }
  const root = parseOne()
  assert.ok(isList(root) && head(root) === "kicad_pcb", "invalid KiCad PCB")
  assert.equal(cursor, tokens.length, "trailing KiCad data")
  return root
}

function children(root, expectedHead) {
  return root.filter((item) => isList(item) && head(item) === expectedHead)
}

function child(root, expectedHead) {
  return children(root, expectedHead)[0]
}

function footprintPlacements(source) {
  const root = parseSExpression(source)
  return children(root, "footprint").map((footprint) => {
    const reference = children(footprint, "property")
      .find((property) => atom(property[1]) === "Reference")
    const at = child(footprint, "at") ?? []
    const layer = child(footprint, "layer") ?? []
    return JSON.stringify({
      reference: atom(reference?.[2]) ?? "",
      layer: atom(layer[1]) ?? "",
      at: at.slice(1).map(atom),
    })
  }).sort()
}

const sourcePath = resolve(report.sourceBoard)
const outputPath = resolve(report.outputBoard)
await Promise.all([access(sourcePath), access(outputPath)])
const [source, output] = await Promise.all([readFile(sourcePath), readFile(outputPath)])
const currentSourceHash = createHash("sha256").update(source).digest("hex")

assert.equal(report.sourceUnchanged, true, "workflow reported a changed source board")
assert.equal(report.sourceHash, currentSourceHash, "source board changed after workflow")
assert.equal(report.currentSourceHash, currentSourceHash, "report currentSourceHash is stale")
assert.equal(report.finalValidation?.completed, true, "native final validation did not complete")
assert.deepEqual(
  report.stages.map((stage) => stage.stage),
  ["preflight", "polygons", "special", "remaining", "completion", "ground", "final"],
)
assert.ok(report.stages.every((stage) => !String(stage.status).startsWith("skipped_due_to_dependency")))
assert.deepEqual(
  footprintPlacements(source.toString("utf8")),
  footprintPlacements(output.toString("utf8")),
  "component placement changed",
)

process.stdout.write(`${JSON.stringify({
  sourceUnchanged: true,
  placementUnchanged: true,
  finalValidationCompleted: true,
  valid: report.valid,
  missingNonGroundNets: report.finalValidation.missingNonGroundNets,
  newErrorCount: report.finalValidation.newErrorViolations.length,
  outputBoard: outputPath,
}, null, 2)}\n`)
