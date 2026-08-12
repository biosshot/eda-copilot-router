import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  changedCopperGeometryNets,
  deriveFinalValidation,
  summarizeFinalDrc,
} from "../dist/staged-routing.js"
import { persistKrtProtectedNets } from "../dist/backends/krt-adapter.js"

const token = (value, quoted = false) => ({ value, quoted })
const node = (head, ...children) => [token(head), ...children]
const copperBoard = (end, uuid) => [
  token("kicad_pcb"),
  node("net", token("1"), token("PAIR", true)),
  node(
    "segment",
    node("start", token("0"), token("0")),
    node("end", token(String(end)), token("0")),
    node("width", token("0.2")),
    node("layer", token("F.Cu", true)),
    node("net", token("PAIR", true)),
    node("uuid", token(uuid, true)),
  ),
]

// The downstream-copper guard ignores object identity, but detects a
// same-count reroute that the old count-only check missed.
assert.deepEqual(changedCopperGeometryNets(
  copperBoard(10, "before-id"),
  copperBoard(10, "after-id"),
  ["PAIR"],
), [])
assert.deepEqual(changedCopperGeometryNets(
  copperBoard(10, "before-id"),
  copperBoard(11, "after-id"),
  ["PAIR"],
), ["PAIR"])

// --no-fix-drc-settings suppresses KRT's own protected-net writeback. The
// adapter must merge the invariant without replacing unrelated project data.
const protectionDirectory = await mkdtemp(join(process.cwd(), ".tmp-krt-protection-"))
try {
  const board = join(protectionDirectory, "special.kicad_pcb")
  const project = join(protectionDirectory, "special.kicad_pro")
  await writeFile(project, JSON.stringify({
    board: { marker: true },
    kicad_routing_tools: { protected_nets: { KEEP: "manual" } },
  }))
  const persisted = await persistKrtProtectedNets(board, ["PAIR_P", "PAIR_N"])
  assert.equal(persisted.changed, true)
  const parsed = JSON.parse(await readFile(project, "utf8"))
  assert.equal(parsed.board.marker, true)
  assert.deepEqual(parsed.kicad_routing_tools.protected_nets, {
    KEEP: "manual",
    PAIR_P: "workflow-special",
    PAIR_N: "workflow-special",
  })
} finally {
  await rm(protectionDirectory, { recursive: true, force: true })
}

const violation = (type, severity, uuids) => ({
  type,
  severity,
  items: uuids.map((uuid) => ({ uuid })),
})

const unconnected = (net, suffix = "1") => ({
  items: [
    { description: `Pad ${suffix} [${net}] of U1` },
    { description: `Pad ${suffix} [${net}] of J1` },
  ],
})

const baseline = {
  violations: [
    // Reverse UUID order deliberately: diagnostic identity must be stable.
    violation("clearance", "error", ["base-b", "base-a"]),
  ],
  unconnected_items: [unconnected("GND")],
}

const sameBaselineAndGroundOnly = {
  violations: [violation("clearance", "error", ["base-a", "base-b"])],
  unconnected_items: [unconnected("GND")],
}

const cleanSummary = summarizeFinalDrc(baseline, sameBaselineAndGroundOnly)
assert.deepEqual(cleanSummary, {
  newErrorViolations: [],
  missingNonGroundNets: [],
  missingNonGroundItems: 0,
  totalUnconnectedItems: 1,
})

const cleanValidation = deriveFinalValidation(baseline, sameBaselineAndGroundOnly)
assert.deepEqual(cleanValidation, {
  completed: true,
  valid: true,
  ...cleanSummary,
})

// Intermediate stage diagnostics are retained, but only the final native
// validation determines board validity.
const workflowWithIntermediateErrors = {
  stages: [
    {
      stage: "polygons",
      status: "error",
      diagnostics: [{ code: "POLYGON_DISCONNECTED_AFTER_REFILL" }],
    },
    {
      stage: "special",
      status: "error",
      diagnostics: [{ code: "KRT_PARTIAL_ROUTE" }],
    },
  ],
  finalValidation: deriveFinalValidation(baseline, sameBaselineAndGroundOnly),
}
assert.equal(workflowWithIntermediateErrors.stages.every((stage) => stage.status === "error"), true)
assert.equal(workflowWithIntermediateErrors.finalValidation.valid, true)

const warningOnly = {
  violations: [
    violation("clearance", "error", ["base-a", "base-b"]),
    violation("silk_overlap", "warning", ["new-warning"]),
  ],
  unconnected_items: [unconnected("GND")],
}
assert.deepEqual(summarizeFinalDrc(baseline, warningOnly).newErrorViolations, [])
assert.equal(deriveFinalValidation(baseline, warningOnly).valid, true)

const removedBaselineError = {
  violations: [],
  unconnected_items: [unconnected("GND")],
}
assert.deepEqual(summarizeFinalDrc(baseline, removedBaselineError).newErrorViolations, [])
assert.equal(deriveFinalValidation(baseline, removedBaselineError).valid, true)

const newFinalError = {
  violations: [
    violation("clearance", "error", ["base-a", "base-b"]),
    violation("track_width", "error", ["new-track"]),
  ],
  unconnected_items: [unconnected("GND")],
}
const newErrorValidation = deriveFinalValidation(baseline, newFinalError)
assert.equal(newErrorValidation.valid, false)
assert.deepEqual(newErrorValidation.newErrorViolations, [
  { key: "track_width:new-track", type: "track_width" },
])
assert.deepEqual(newErrorValidation.missingNonGroundNets, [])

const nonGroundOpen = {
  violations: [violation("clearance", "error", ["base-a", "base-b"])],
  unconnected_items: [
    unconnected("GND"),
    unconnected("SIG", "2"),
  ],
}
const openSignalValidation = deriveFinalValidation(baseline, nonGroundOpen)
assert.equal(openSignalValidation.valid, false)
assert.deepEqual(openSignalValidation.newErrorViolations, [])
assert.deepEqual(openSignalValidation.missingNonGroundNets, ["SIG"])
assert.equal(openSignalValidation.missingNonGroundItems, 1)
assert.equal(openSignalValidation.totalUnconnectedItems, 2)

console.log("staged workflow final-validation semantics passed")
