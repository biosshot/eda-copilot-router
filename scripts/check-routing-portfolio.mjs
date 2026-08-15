import assert from "node:assert/strict"
import {
  INCUMBENT_PRESET,
  QUALITY_PRESETS,
  buildPortfolioCandidates,
  compareCandidateResults,
} from "../dist/portfolio-routing.js"

assert.deepEqual(QUALITY_PRESETS.map((preset) => preset.name), ["max", "high", "medium", "low"])
assert.deepEqual({
  name: INCUMBENT_PRESET.name,
  viaCost: INCUMBENT_PRESET.viaCost,
  viaProximityCost: INCUMBENT_PRESET.viaProximityCost,
  turnCost: INCUMBENT_PRESET.turnCost,
  directionPreferenceCost: INCUMBENT_PRESET.directionPreferenceCost,
  maxRipup: INCUMBENT_PRESET.maxRipup,
  heuristicWeight: INCUMBENT_PRESET.heuristicWeight,
}, {
  name: "incumbent",
  viaCost: 20,
  viaProximityCost: 3,
  turnCost: 250,
  directionPreferenceCost: 50,
  maxRipup: 5,
  heuristicWeight: 1,
})
assert.equal(buildPortfolioCandidates(64).length, 32)
assert.ok(
  buildPortfolioCandidates(32).every((candidate) => candidate.variant.ordering === "mps"),
  "every KRT portfolio candidate must retain MPS ordering",
)
assert.equal(buildPortfolioCandidates(1)[0].variant.name, "incumbent-global-mps")

const small = buildPortfolioCandidates(4)
assert.deepEqual(small.map((candidate) => candidate.quality.name), ["incumbent", "max", "high", "medium"])
assert.equal(small[0].variant.name, "incumbent-global-mps")
assert.equal(small[1].variant.name, "global-mps")
assert.equal(small[2].variant.name, "escape-first")
assert.ok(small[3].variant.netRescue, "medium should start with a completion-first rescue variant")

const eight = buildPortfolioCandidates(8)
assert.deepEqual(eight.map((candidate) => candidate.quality.name), [
  "incumbent", "max", "max", "high", "high", "medium", "medium", "low",
])
assert.equal(new Set(eight.map((candidate) => `${candidate.quality.name}/${candidate.variant.name}`)).size, 8)

function result(index, overrides = {}) {
  const candidate = buildPortfolioCandidates(4)[index - 1]
  const metrics = {
    valid: false,
    validationCompleted: true,
    missingNonGroundNets: ["OPEN"],
    missingNonGroundItems: 1,
    newDrcErrors: 0,
    powerViolationCount: 0,
    viaCount: 10,
    segmentCount: 20,
    arcCount: 0,
    wireLengthMm: 100,
    elapsedMs: 1_000,
    ...overrides,
  }
  return {
    candidate,
    status: "completed",
    directory: "x",
    boardPath: "x.kicad_pcb",
    reportPath: "workflow-report.json",
    processExitCode: 0,
    processSignal: null,
    metrics,
    sourceUnchanged: true,
    score: [],
  }
}

assert.ok(compareCandidateResults(
  result(1, { powerViolationCount: 0, missingNonGroundNets: ["A", "B"] }),
  result(2, { powerViolationCount: 1, missingNonGroundNets: [] }),
) < 0, "electrically safe copper must outrank a completed but undersized board")
assert.ok(compareCandidateResults(
  result(1, { valid: true, missingNonGroundNets: [] }),
  result(2, { valid: false, missingNonGroundNets: [] }),
) < 0, "native-valid must win")
assert.ok(compareCandidateResults(
  result(1, { missingNonGroundNets: ["A"] }),
  result(2, { missingNonGroundNets: ["A", "B"], viaCount: 0, wireLengthMm: 1 }),
) < 0, "completion must outrank pretty copper")
assert.ok(compareCandidateResults(
  result(1, { newDrcErrors: 0, viaCount: 20 }),
  result(2, { newDrcErrors: 1, viaCount: 0 }),
) < 0, "new native DRC errors must outrank via count")
assert.ok(compareCandidateResults(
  result(1, { viaCount: 9, wireLengthMm: 200 }),
  result(2, { viaCount: 10, wireLengthMm: 1 }),
) < 0, "via count must outrank wire length")

console.log("routing portfolio regression: passed")
