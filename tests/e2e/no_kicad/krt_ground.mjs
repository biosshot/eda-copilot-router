import assert from "node:assert/strict"
import { run, createKrtBackend } from "../../../package-dist/index.js"

const emptyCopper = { tracks: [], vias: [], zones: [] }
const values = {
  clearanceMm: 0.2, edgeClearanceMm: 0.2,
  minTrackWidthMm: 0.127, preferredTrackWidthMm: 0.25,
  via: { minDiameterMm: 0.6, preferredDiameterMm: 0.6, minDrillMm: 0.3, preferredDrillMm: 0.3 },
}
const rectangle = (left, bottom, right, top) => [
  { x: left, y: bottom }, { x: right, y: bottom },
  { x: right, y: top }, { x: left, y: top },
]
const board = {
  outline: rectangle(0, 0, 30, 20), cutouts: [],
  layers: [{ name: "F.Cu", index: 0, side: "top" }, { name: "B.Cu", index: 31, side: "bottom" }],
  nets: ["GND", "/GND"].map((name) => ({ name })),
  components: [
    { designator: "J1", at: { x: 5, y: 10 }, rotationDeg: 0, side: "top" },
    { designator: "J2", at: { x: 25, y: 10 }, rotationDeg: 0, side: "top" },
  ],
  pads: ["GND", "/GND"].flatMap((net, index) => [5, 25].map((x, side) => ({
    component: `J${side + 1}`, number: String(index + 1), net,
    at: { x, y: 5 + index * 10 }, rotationDeg: 0, layers: ["F.Cu"],
    shape: { kind: "circle", diameterMm: 1 },
  }))),
  keepouts: [], rules: { default: values, nets: [] },
  copper: { fixed: emptyCopper, editable: emptyCopper },
}
const backend = createKrtBackend()
const routed = await run({ board, backend, dsl: "runRouting()" })
assert.notEqual(routed.status, "error", JSON.stringify(routed.diagnostics))
assert.deepEqual(routed.metrics.openNets, [], JSON.stringify(routed.diagnostics))
for (const net of ["GND", "/GND"]) {
  assert.ok(routed.copper.tracks.some((track) => track.net === net), `${net} must route without a plane`)
}
assert.ok(!routed.diagnostics.some((item) => item.code === "KRT_GROUND_UNPLANNED"))

const ignored = await run({ board, backend, dsl: 'ignoreNets("GND"); runRouting()' })
assert.notEqual(ignored.status, "error", JSON.stringify(ignored.diagnostics))
assert.deepEqual(ignored.metrics.openNets, [])
assert.ok(ignored.copper.tracks.some((track) => track.net === "/GND"))
assert.ok(!ignored.copper.tracks.some((track) => track.net === "GND"), "explicit ignore must be exact")

const zone = (outline) => ({
  net: "GND", layers: ["F.Cu"], outline: { outer: outline },
  fill: { style: "solid" }, padConnection: { mode: "solid" },
})
for (const [label, zones, needsTracks] of [
  ["connected", [zone(rectangle(1, 1, 29, 9))], false],
  ["split", [zone(rectangle(1, 1, 9, 9)), zone(rectangle(21, 1, 29, 9))], true],
]) {
  const result = await run({
    board: { ...board, copper: { fixed: { ...emptyCopper, zones }, editable: emptyCopper } },
    backend, dsl: 'onlyNets("GND"); runRouting()',
  })
  assert.notEqual(result.status, "error", JSON.stringify(result.diagnostics))
  assert.deepEqual(result.metrics.openNets, [], `${label}: ${JSON.stringify(result.diagnostics)}`)
  assert.equal(result.copper.tracks.some((track) => track.net === "GND"), needsTracks,
    `${label} ground fill must be graded by actual connectivity`)
}
console.log("KRT ground routing, explicit ignore, and connected/split plane E2E: ok")
