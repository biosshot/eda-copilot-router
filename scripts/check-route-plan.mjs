import assert from "node:assert/strict"
import {
  canonicalizeRoutingBoard,
  compileRoutingDsl,
  compileRoutingRules,
  resolveRoutePlan,
} from "../package-dist/index.js"

const values = {
  clearanceMm: 0.2,
  edgeClearanceMm: 0.2,
  minTrackWidthMm: 0.15,
  preferredTrackWidthMm: 0.2,
  via: {
    minDiameterMm: 0.5,
    preferredDiameterMm: 0.6,
    minDrillMm: 0.25,
    preferredDrillMm: 0.3,
  },
}

const importedBoard = {
  outline: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
  cutouts: [],
  layers: [
    { name: "F.Cu", index: 0, side: "top" },
    { name: "B.Cu", index: 1, side: "bottom" },
  ],
  nets: [{ name: "XTAL_IN" }, { name: "A" }],
  components: [{ designator: "U1", at: { x: 5, y: 5 }, rotationDeg: 0, side: "top" }],
  pads: [
    { component: "U1", number: "1", net: "XTAL_IN", at: { x: 5, y: 5 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 1, heightMm: 1 } },
    { component: "U1", number: "2", net: "A", at: { x: 7, y: 5 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 1, heightMm: 1 } },
  ],
  keepouts: [],
  rules: { default: values, nets: [] },
  copper: { fixed: { tracks: [], vias: [], zones: [] }, editable: { tracks: [], vias: [], zones: [] } },
}

const { board, catalog } = canonicalizeRoutingBoard(importedBoard)
assert.deepEqual(board.layers.map((layer) => layer.name), ["TOP", "BOTTOM"])
assert.deepEqual(board.pads.map((pad) => pad.layers), [["TOP"], ["TOP"]])
assert.equal(catalog.kiCadName("TOP"), "F.Cu")
assert.equal(catalog.kiCadName("BOTTOM"), "B.Cu")

const program = compileRoutingDsl(`
  signalNet("XTAL_IN", { priority: "critical", viaPreference: "avoid", allowedLayers: "TOP" })
  signalNet("A", { priority: "low" })
  fanout(component("U1"), { method: "stub" })
  runRouting()
`)
const compiled = compileRoutingRules(board, program)
assert.ok(!compiled.diagnostics.some((item) => item.severity === "error"), JSON.stringify(compiled.diagnostics))
const plan = resolveRoutePlan(board, program, compiled.effective)
assert.equal(plan.schemaVersion, 1)
assert.equal(plan.fanout.enabled, true)
assert.equal(plan.fanout.targets.length, 1)
assert.deepEqual(plan.netPolicies.map(({ net, priority, viaPreference, priorityWeight, viaPenalty }) => ({
  net, priority, viaPreference, priorityWeight, viaPenalty,
})), [
  { net: "XTAL_IN", priority: "critical", viaPreference: "avoid", priorityWeight: 64, viaPenalty: 16 },
  { net: "A", priority: "low", viaPreference: "auto", priorityWeight: 1, viaPenalty: 1 },
])
assert.ok(plan.groups.some((group) => group.kind === "critical" && group.nets.includes("XTAL_IN")))
assert.deepEqual(plan.mainNets, ["A"])

const withoutFanout = resolveRoutePlan(board, compileRoutingDsl("runRouting()"), board.rules)
assert.equal(withoutFanout.fanout.enabled, false)
assert.deepEqual(withoutFanout.fanout.targets, [])

assert.throws(
  () => compileRoutingDsl('quality({ profile: "balanced" }); runRouting()'),
  /quality is not defined/,
)

console.log("route plan contract: ok")
