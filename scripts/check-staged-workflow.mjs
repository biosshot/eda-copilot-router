import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  changedCopperGeometryNets,
  deriveFinalValidation,
  summarizeFinalDrc,
} from "../dist/staged-routing.js"
import {
  appendFilledCopperProxy,
  filledCopperPadGroups,
  fullyConnectedByFilledCopperNets,
  removeFilledCopperProxy,
} from "../dist/filled-copper-proxy.js"
import { persistKrtProtectedNets } from "../dist/backends/krt-adapter.js"
import { runFreeroutingRemaining } from "../dist/backends/freerouting-adapter.js"

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

// The native filled zone becomes connected, locked same-net copper for the
// remaining backend, then is removed exactly before the user-visible board.
const proxyBoard = [
  token("kicad_pcb"),
  node("net", token("1"), token("PWR", true)),
  node("gr_rect", node("start", token("-1"), token("-1")), node("end", token("8"), token("3")),
    node("stroke", node("width", token("0.05")), node("type", token("default"))),
    node("fill", token("none")), node("layer", token("Edge.Cuts", true)), node("uuid", token("edge", true))),
  node(
    "zone",
    node("net", token("PWR", true)),
    node("layer", token("F.Cu", true)),
    node(
      "filled_polygon",
      node("layer", token("F.Cu", true)),
      node(
        "pts",
        node("xy", token("0"), token("0")),
        node("xy", token("4"), token("0")),
        node("xy", token("4"), token("2")),
        node("xy", token("0"), token("2")),
      ),
    ),
  ),
]
const footprint = (reference, at, pads) => node(
  "footprint",
  token("Test", true),
  node("layer", token("F.Cu", true)),
  node("at", token(String(at[0])), token(String(at[1]))),
  node("property", token("Reference", true), token(reference, true)),
  ...pads.map(([number, x, y]) => node(
    "pad", token(String(number), true), token("smd"), token("rect"),
    node("at", token(String(x)), token(String(y))),
    node("size", token("0.5"), token("0.5")),
    node("layers", token("F.Cu", true)),
    node("net", token("PWR", true)),
    node("uuid", token(`${reference}-${number}`, true)),
  )),
)
proxyBoard.push(
  footprint("U1", [0, 0], [["1", 1, 1], ["2", 2, 1]]),
  footprint("J1", [0, 0], [["1", 6, 1]]),
)
const padGroups = filledCopperPadGroups(proxyBoard)
assert.equal(padGroups.length, 1)
assert.deepEqual(padGroups[0].pads.map((pad) => `${pad.component}.${pad.padNumber}`).sort(), ["U1.1", "U1.2"])
assert.equal(padGroups[0].representative.padNumber, "2")
assert.equal(padGroups[0].redundantPads[0].padNumber, "1")
assert.deepEqual(fullyConnectedByFilledCopperNets(proxyBoard), [])
const fullyFilledBoard = structuredClone(proxyBoard)
fullyFilledBoard.splice(fullyFilledBoard.indexOf(fullyFilledBoard.find((item) => Array.isArray(item)
  && item[0]?.value === "footprint" && item.some((child) => Array.isArray(child)
    && child[0]?.value === "property" && child[2]?.value === "J1"))), 1)
assert.deepEqual(fullyConnectedByFilledCopperNets(fullyFilledBoard), ["PWR"])
const proxyManifest = appendFilledCopperProxy(proxyBoard, { widthMm: 0.1, pitchMm: 0.2 })
assert.ok(proxyManifest.segmentUuids.length > 0)
const proxySegments = proxyBoard.filter((item) => Array.isArray(item) && item[0]?.value === "segment")
assert.equal(proxySegments.length, proxyManifest.segmentUuids.length)
assert.ok(proxySegments.every((segment) => segment.some((item) => Array.isArray(item)
  && item[0]?.value === "locked" && item[1]?.value === "yes")))
assert.ok(proxySegments.every((segment) => segment.some((item) => Array.isArray(item)
  && item[0]?.value === "net" && item[1]?.value === "PWR")))
const proxyRemoval = removeFilledCopperProxy(proxyBoard, proxyManifest)
assert.deepEqual(proxyRemoval, {
  expected: proxyManifest.segmentUuids.length,
  removed: proxyManifest.segmentUuids.length,
  missingUuids: [],
})
assert.equal(proxyBoard.filter((item) => Array.isArray(item) && item[0]?.value === "segment").length, 0)

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

// Backend preflight is non-throwing and must never launch Java when scope or
// dependencies are invalid.
const adapterDirectory = await mkdtemp(join(process.cwd(), ".tmp-freerouting-adapter-"))
try {
  const baseSpec = {
    javaPath: "java",
    javacPath: "javac",
    jarPath: join(adapterDirectory, "missing.jar"),
    kicadPythonPath: join(adapterDirectory, "missing-python.exe"),
    bridgePath: join(adapterDirectory, "missing-bridge.py"),
    runnerSourcePath: join(adapterDirectory, "missing-runner.java"),
    timeoutMs: 1000,
    remainingNets: ["SIG"],
    excludedNets: ["GND", "USB_DP", "USB_DM"],
  }
  const missing = await runFreeroutingRemaining(
    join(adapterDirectory, "missing.kicad_pcb"),
    join(adapterDirectory, "output.kicad_pcb"),
    baseSpec,
    adapterDirectory,
  )
  assert.equal(missing.attempted, false)
  assert.equal(missing.status, "preflight_failed")
  assert.ok(missing.diagnostics.some((item) => item.code === "FREEROUTING_DEPENDENCY_MISSING"))

  const overlap = await runFreeroutingRemaining(
    join(adapterDirectory, "missing.kicad_pcb"),
    join(adapterDirectory, "overlap.kicad_pcb"),
    { ...baseSpec, remainingNets: ["USB_DP"], excludedNets: ["GND", "USB_DP"] },
    adapterDirectory,
  )
  assert.equal(overlap.attempted, false)
  assert.ok(overlap.diagnostics.some((item) => item.code === "FREEROUTING_SCOPE_CONFLICT"))
} finally {
  await rm(adapterDirectory, { recursive: true, force: true })
}

// The KiCad bridge must require an exact partition of all board nets. This is
// the invariant that prevents a Freerouting remaining pass from silently
// broadening its scope to GND or special copper.
const bridgeSource = await readFile(new URL("./freerouting-kicad-bridge.py", import.meta.url), "utf8")
assert.match(bridgeSource, /Nets missing from the exact workflow scope/)
assert.match(bridgeSource, /Nets assigned to both route and ignore scopes/)
const runnerSource = await readFile(new URL("./freerouting\/ScopedFreeroutingRunner.java", import.meta.url), "utf8")
assert.match(runnerSource, /netClass\.is_ignored_by_autorouter = true/)
assert.match(runnerSource, /settings\.fanout\.enabled = false/)

console.log("staged workflow final-validation semantics passed")
