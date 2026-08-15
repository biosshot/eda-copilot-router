import assert from "node:assert/strict"
import {
  atomicSpecialGroupsForBlockers,
  buildBlockerRepairPlans,
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
  "low-singleton-mps-rescue",
  "low-singleton-escape-rescue",
])
assert.ok(buildCompletionProfiles(5).every((profile) => profile.ordering === "mps"))
assert.equal(buildCompletionProfiles(99).length, 5)
assert.equal(buildCompletionProfiles(0).length, 0)
assert.equal(buildCompletionProfiles(5)[0].enableTerminalEscalation, undefined)

const blockerPlans = buildBlockerRepairPlans([
  {
    blockers: [
      {
        net: "TARGET",
        stage: "phase3",
        blocked_by: [
          { net: "DIRECT", blocked_count: 5, near_target_cells: 2 },
          { net: "GND", blocked_count: 999, near_target_cells: 99 },
          { net: "ZONE", blocked_count: 100 },
        ],
      },
      {
        net: "TARGET",
        stage: "preexisting",
        blocked_by: [{ net: "BOX", preexisting: true }, { net: "DIRECT", preexisting: true }],
      },
    ],
  },
], ["TARGET"], ["TARGET", "DIRECT", "BOX", "ZONE", "GND"], ["GND", "ZONE"], 1)
assert.deepEqual(blockerPlans[0].blockers, ["DIRECT"],
  "direct endpoint evidence must outrank the coarse pre-existing box hint")
assert.deepEqual(blockerPlans[0].hardBlockers, ["GND", "ZONE"])
assert.ok(blockerPlans[0].blockerScores.DIRECT > blockerPlans[0].blockerScores.BOX)

const atomicGroups = atomicSpecialGroupsForBlockers([
  "USB_A1_DM",
  "BUS_B",
], {
  diffPairs: [
    { positive: "USB_A1_DP", negative: "USB_A1_DM" },
    { positive: "USB_A2_DP", negative: "USB_A2_DM" },
  ],
  matchedGroups: [{ nets: ["BUS_A", "BUS_B", "BUS_C"] }],
})
assert.deepEqual(atomicGroups, [
  { kind: "diff-pair", nets: ["USB_A1_DP", "USB_A1_DM"] },
  { kind: "matched-group", nets: ["BUS_A", "BUS_B", "BUS_C"] },
], "one blocked member must move its whole special group")

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
