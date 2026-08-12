import assert from "node:assert/strict"
import {
  calculateTrackWidthMm,
  compilePowerIntent,
  validatePowerRouting,
  withCompiledPowerRules,
} from "../dist/power-intent.js"

const token = (value, quoted = false) => ({ value, quoted })
const node = (head, ...children) => [token(head), ...children]
const rules = {
  minimumClearance: 0.2,
  minimumTrackWidth: 0.2,
  minimumViaDiameter: 0.5,
  minimumViaDrill: 0.3,
  minimumViaAnnularWidth: 0.1,
  copperEdgeClearance: 0.5,
  classes: [{
    name: "Default",
    clearance: 0.2,
    trackWidth: 0.2,
    viaDiameter: 0.6,
    viaDrill: 0.3,
    diffPairWidth: 0.2,
    diffPairGap: 0.2,
  }],
  assignments: {},
  patterns: [],
}
const root = [
  token("kicad_pcb"),
  node("net", token("1"), token("PWR", true)),
]

const width = calculateTrackWidthMm(2, 16, 0.03479, true)
assert.ok(width > 0.58 && width < 0.61)
const compiled = compilePowerIntent({
  powerNets: [{ net: "PWR", maxCurrentA: 2 }],
}, root, rules, ["PWR"])
assert.equal(compiled.errors, 0)
assert.equal(compiled.defaultCopperThicknessOz, 1)
assert.equal(compiled.nets[0].requiredTrackWidthMm, 0.6)
assert.equal(compiled.nets[0].maxTempRiseC, 16)
assert.equal(compiled.nets[0].viaDiameterMm, 0.5)
assert.equal(compiled.nets[0].viaDrillMm, 0.3)
assert.equal(compiled.nets[0].requiredParallelVias, 2)

const augmented = withCompiledPowerRules(rules, compiled)
assert.equal(augmented.assignments.PWR, "WorkflowPower_1")
assert.equal(augmented.classes.find((item) => item.name === "WorkflowPower_1").trackWidth, 0.6)

const twoOunceRoot = [
  ...root,
  node("setup", node("stackup",
    node("layer", token("F.Cu", true), node("type", token("copper", true)), node("thickness", token("0.06958"))),
    node("layer", token("B.Cu", true), node("type", token("copper", true)), node("thickness", token("0.06958"))),
  )),
]
const twoOunce = compilePowerIntent({ powerNets: [{ net: "PWR", maxCurrentA: 2 }] }, twoOunceRoot, rules, ["PWR"])
assert.equal(twoOunce.layers[0].source, "stackup")
assert.equal(twoOunce.nets[0].requiredTrackWidthMm, 0.3)

const conflict = compilePowerIntent({
  powerNets: [{ net: "PWR", maxCurrentA: 2, minTrackWidthMm: 0.8 }],
  manufacturing: { maxTrackWidthMm: 11 },
}, root, rules, ["PWR"])
assert.ok(conflict.errors >= 2)
assert.ok(conflict.diagnostics.some((item) => item.code === "POWER_SOURCE_CONFLICT"))
assert.ok(conflict.diagnostics.some((item) => item.code === "POWER_MAX_WIDTH_EXCEEDS_ABSOLUTE_LIMIT"))

const segment = (widthMm) => node(
  "segment",
  node("start", token("1"), token("1")),
  node("end", token("3"), token("1")),
  node("width", token(String(widthMm))),
  node("layer", token("F.Cu", true)),
  node("net", token("PWR", true)),
)
const thinBoard = [...root, segment(0.2)]
assert.equal(validatePowerRouting(thinBoard, compiled).violations[0].code, "POWER_TRACK_WIDTH")
const reinforcedBoard = [
  ...thinBoard,
  node("zone", node("net", token("PWR", true)), node("layer", token("F.Cu", true)),
    node("filled_polygon", node("layer", token("F.Cu", true)), node("pts",
      node("xy", token("0"), token("0")), node("xy", token("4"), token("0")),
      node("xy", token("4"), token("2")), node("xy", token("0"), token("2")),
    )),
  ),
]
const reinforced = validatePowerRouting(reinforcedBoard, compiled)
assert.equal(reinforced.valid, true)
assert.equal(reinforced.reinforcedTrackItems, 1)

const oneVia = [...root, node("via", node("at", token("1"), token("1")),
  node("size", token("0.5")), node("drill", token("0.3")), node("net", token("PWR", true)))]
assert.ok(validatePowerRouting(oneVia, compiled).violations.some((item) => item.code === "POWER_VIA_PARALLEL_COUNT"))
const twoVias = [...oneVia, node("via", node("at", token("1.6"), token("1")),
  node("size", token("0.5")), node("drill", token("0.3")), node("net", token("PWR", true)))]
assert.equal(validatePowerRouting(twoVias, compiled).valid, true)
const equivalentLargeVia = [...root, node("via", node("at", token("1"), token("1")),
  node("size", token("0.8")), node("drill", token("0.4")), node("net", token("PWR", true)))]
assert.equal(validatePowerRouting(equivalentLargeVia, compiled).valid, true)

console.log("power intent regression: passed")
