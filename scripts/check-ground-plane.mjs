import assert from "node:assert/strict"
import {
  applyPlaneStitching,
  removeInvalidPlaneVias,
} from "../dist/ground-plane.js"
import { runPolygonDsl } from "../dist/polygon/index.js"

const token = (value, quoted = false) => ({ value, quoted })
const node = (head, ...children) => [token(head), ...children]
const pad = (number, type, x, y, net = "GND", size = 1) => node(
  "pad", token(String(number), true), token(type), token("rect"),
  node("at", token(String(x)), token(String(y))),
  node("size", token(String(size)), token(String(size))),
  node("layers", ...(type === "thru_hole"
    ? [token("*.Cu", true), token("*.Mask", true)]
    : [token("F.Cu", true), token("F.Paste", true), token("F.Mask", true)])),
  ...(type === "thru_hole" ? [node("drill", token("0.5"))] : []),
  node("net", token(net, true)),
  node("uuid", token(`pad-${number}`, true)),
)
const board = [
  token("kicad_pcb"),
  node("net", token("1"), token("GND", true)),
  node("net", token("2"), token("SIG", true)),
  node(
    "gr_rect",
    node("start", token("0"), token("0")),
    node("end", token("24"), token("14")),
    node("stroke", node("width", token("0.05")), node("type", token("default"))),
    node("fill", token("none")),
    node("layer", token("Edge.Cuts", true)),
    node("uuid", token("edge", true)),
  ),
  node(
    "footprint", token("Test", true),
    node("layer", token("F.Cu", true)),
    node("at", token("0"), token("0")),
    node("property", token("Reference", true), token("U1", true)),
    // The existing PTH GND pad is a visible inter-layer connection for pad 1.
    pad(1, "smd", 3, 3),
    pad(2, "thru_hole", 5, 3),
    // This SMD GND pad is isolated by distance and must receive via-in-pad.
    pad(3, "smd", 21, 11),
    // Foreign copper blocks a nearby regular grid location.
    pad(4, "smd", 10, 7, "SIG", 2),
  ),
]
const rules = {
  minimumClearance: 0.2,
  minimumTrackWidth: 0.2,
  minimumViaDiameter: 0.5,
  minimumViaDrill: 0.3,
  minimumViaAnnularWidth: 0.1,
  copperEdgeClearance: 0.5,
  classes: [{
    name: "Default", clearance: 0.2, trackWidth: 0.2,
    viaDiameter: 0.6, viaDrill: 0.3, diffPairWidth: 0.2, diffPairGap: 0.2,
  }],
  assignments: {},
  patterns: [],
}
const program = runPolygonDsl(`
plane({
  net: "GND",
  layers: outerLayers(),
  region: board(),
  stitching: {
    gridMm: 20,
    maxPadViaDistanceMm: 10,
    via: "drc-min",
    viaInPad: true,
    maxVias: 20,
  },
})
`)
const manifest = applyPlaneStitching(board, program.planes, rules)
assert.equal(manifest.zonesAdded, 1)
assert.equal(manifest.unsupportedRegions.length, 0)
assert.equal(manifest.viaDiameterMm, 0.5)
assert.equal(manifest.viaDrillMm, 0.3)
assert.equal(manifest.pthPadsSkipped, 1)
assert.ok(manifest.padsCoveredByVisibleVia >= 1)
assert.ok(manifest.padVias >= 1)

const values = (item, head) => item.find((child) => Array.isArray(child) && child[0]?.value === head)
const generatedVias = board.filter((item) => Array.isArray(item)
  && item[0]?.value === "via"
  && manifest.generatedViaUuids.includes(values(item, "uuid")?.[1]?.value))
assert.equal(generatedVias.length, manifest.generatedViaUuids.length)
assert.ok(generatedVias.some((via) => {
  const at = values(via, "at")
  return Number(at?.[1]?.value) === 21 && Number(at?.[2]?.value) === 11
}), "uncovered SMD GND pad should receive via-in-pad")
assert.ok(generatedVias.every((via) => {
  const at = values(via, "at")
  return Math.hypot(Number(at?.[1]?.value) - 10, Number(at?.[2]?.value) - 7) >= 1.45
}), "stitching via must avoid foreign pad plus clearance")

const generatedZones = board.filter((item) => Array.isArray(item) && item[0]?.value === "zone")
assert.ok(generatedZones.every((zone) => {
  const fill = values(zone, "fill")
  return fill && values(fill, "island_removal_mode")?.[1]?.value === "0"
}))

const badUuid = manifest.generatedViaUuids[0]
const cleanup = removeInvalidPlaneVias(board, manifest, {
  violations: [{ severity: "error", items: [{ uuid: badUuid }] }],
})
assert.equal(cleanup.removed, 1)
assert.equal(board.some((item) => Array.isArray(item)
  && item[0]?.value === "via" && values(item, "uuid")?.[1]?.value === badUuid), false)

const reserved = runPolygonDsl(`
plane({ net: "GND", region: components("U1", "C1"), paddingMm: 2, stitching: true })
`)
const reservedBoard = structuredClone(board)
const reservedManifest = applyPlaneStitching(reservedBoard, reserved.planes, rules)
assert.equal(reservedManifest.zonesAdded, 0)
assert.deepEqual(reservedManifest.unsupportedRegions, [{
  net: "GND", kind: "components", designators: ["U1", "C1"],
}])

console.log("ground plane DSL and stitching geometry passed")
