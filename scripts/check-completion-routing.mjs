import assert from "node:assert/strict"
import {
  buildCompletionProfiles,
  compareCompletionCandidates,
} from "../dist/completion-routing.js"
import {
  placementChanged,
  zonesChanged,
} from "../dist/workflow-board.js"

assert.deepEqual(buildCompletionProfiles(5).map((profile) => profile.name), [
  "max-global-mps",
  "high-escape-order",
  "medium-global-mps-rescue",
  "low-singleton-inside-out-rescue",
  "low-singleton-escape-rescue",
])
assert.equal(buildCompletionProfiles(99).length, 5)
assert.equal(buildCompletionProfiles(0).length, 0)
assert.equal(buildCompletionProfiles(5)[0].enableTerminalEscalation, undefined)

function candidate(index, overrides = {}) {
  return {
    index,
    profile: { name: `p${index}` },
    status: "completed",
    eligible: true,
    boardPath: "candidate.kicad_pcb",
    metrics: {
      missingNonGroundNets: ["OPEN"],
      missingNonGroundItems: 1,
      newDrcErrors: 0,
      viaCount: 10,
      segmentCount: 20,
      arcCount: 0,
      wireLengthMm: 100,
      elapsedMs: 1000,
      ...overrides,
    },
    diagnostics: [],
    score: [],
  }
}

assert.ok(compareCompletionCandidates(
  candidate(1, { missingNonGroundNets: [] }),
  candidate(2, { missingNonGroundNets: ["A"], viaCount: 0 }),
) < 0, "completion must outrank prettier incomplete copper")
assert.ok(compareCompletionCandidates(
  candidate(1, { newDrcErrors: 0, viaCount: 20 }),
  candidate(2, { newDrcErrors: 1, viaCount: 0 }),
) < 0, "native DRC errors must outrank via count")
assert.ok(compareCompletionCandidates(
  candidate(1, { viaCount: 9, wireLengthMm: 200 }),
  candidate(2, { viaCount: 10, wireLengthMm: 1 }),
) < 0, "via count must outrank wire length")
const ineligible = candidate(1, { missingNonGroundNets: [] })
ineligible.eligible = false
assert.ok(compareCompletionCandidates(ineligible, candidate(2)) > 0,
  "a candidate that moved fixed geometry must never win")

const token = (value, quoted = false) => ({ value, quoted })
const node = (head, ...children) => [token(head), ...children]
const footprint = (x) => node(
  "footprint", token("Test", true),
  node("layer", token("F.Cu", true)),
  node("at", token(String(x)), token("2")),
  node("property", token("Reference", true), token("U1", true)),
)
const placementA = [token("kicad_pcb"), footprint(1)]
const placementB = [token("kicad_pcb"), footprint(1)]
const placementC = [token("kicad_pcb"), footprint(1.1)]
assert.equal(placementChanged(placementA, placementB), false)
assert.equal(placementChanged(placementA, placementC), true)

const zone = (fillX) => node(
  "zone", node("net", token("PWR", true)), node("layer", token("F.Cu", true)),
  node("polygon", node("pts", node("xy", token("0"), token("0")))),
  node("filled_polygon", node("pts", node("xy", token(String(fillX)), token("0")))),
)
assert.equal(zonesChanged([token("kicad_pcb"), zone(1)], [token("kicad_pcb"), zone(2)]), false,
  "native refill cache must not look like an outline mutation")

console.log("completion routing profiles, ranking and custody guards passed")
