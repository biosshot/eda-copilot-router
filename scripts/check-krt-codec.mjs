import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  approximateKiCadArc,
  krtProjectNetOrder,
  readKrtBoard,
  writeKrtBoard,
} from "../package-dist/backends/krt-codec.js"
import { importKiCadRoutingBoard } from "../package-dist/adapters/kicad.js"

const values = {
  clearanceMm: 0.2, edgeClearanceMm: 0.2, holeToHoleClearanceMm: 0.175,
  minTrackWidthMm: 0.127, preferredTrackWidthMm: 0.2,
  via: { minDiameterMm: 0.6, preferredDiameterMm: 0.6, minDrillMm: 0.3, preferredDrillMm: 0.3 },
}
const defaultValues = {
  ...values, clearanceMm: 0.25, holeToHoleClearanceMm: 0.2, preferredTrackWidthMm: 0.25,
}

const powerValues = {
  ...values, preferredTrackWidthMm: 0.4,
}
assert.deepEqual(krtProjectNetOrder({
  default: defaultValues,
  nets: [
    { net: "GND", values: defaultValues },
    { net: "SIG_A", values },
    { net: "PWR", values: powerValues },
    { net: "SIG_B", values },
  ],
}), ["GND", "SIG_A", "SIG_B", "PWR"],
  "native original ordering must follow generated netclass groups, not lexicographic board order")
assert.deepEqual(krtProjectNetOrder({
  default: defaultValues,
  nets: [
    { net: "10", values: powerValues },
    { net: "2", values },
    { net: "SIG", values },
  ],
}), ["2", "10", "SIG"],
  "selector order must exactly mirror JSON project order for integer-like net names")
const board = {
  outline: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }], cutouts: [],
  layers: [
    { name: "TOP", index: 0, side: "top" }, { name: "INNER_1", index: 1, side: "inner" },
    { name: "INNER_2", index: 2, side: "inner" }, { name: "BOTTOM", index: 3, side: "bottom" },
  ],
  nets: [{ name: "N" }], components: [
    { designator: "J1", at: { x: 5, y: 5 }, rotationDeg: 0, side: "top" },
    { designator: "U2", at: { x: 5, y: 5 }, rotationDeg: 90, side: "top" },
    { designator: "B1", at: { x: 12, y: 5 }, rotationDeg: 90, side: "bottom" },
  ],
  pads: [
    { component: "J1", number: "", at: { x: 5, y: 5 }, rotationDeg: 0, layers: ["TOP", "INNER_1", "INNER_2", "BOTTOM"], shape: { kind: "circle", diameterMm: 1 }, hole: { shape: "round", diameterMm: 0.5, offset: { x: 0.1, y: -0.1 }, plated: false } },
    { component: "J1", number: "1", net: "N", at: { x: 8, y: 5 }, rotationDeg: 0, layers: ["TOP", "INNER_1", "INNER_2", "BOTTOM"], shape: { kind: "oval", widthMm: 2, heightMm: 1 }, hole: { shape: "slot", diameterMm: 0.5, slotLengthMm: 0.8, plated: true } },
    { component: "U2", number: "1", net: "N", at: { x: 5, y: 3 }, rotationDeg: 90, layers: ["TOP"], shape: { kind: "rect", widthMm: 2, heightMm: 1 } },
    { component: "B1", number: "1", net: "N", at: { x: 12, y: 3 }, rotationDeg: 90, layers: ["BOTTOM"], shape: { kind: "rect", widthMm: 2, heightMm: 1 } },
    { component: "B1", number: "2", net: "N", at: { x: 12, y: 7 }, rotationDeg: 90, layers: ["BOTTOM"], shape: { kind: "rect", widthMm: 2, heightMm: 1 } },
    { component: "B1", number: "3", net: "N", at: { x: 14, y: 5 }, rotationDeg: 90, layers: ["BOTTOM"], shape: { kind: "rect", widthMm: 2, heightMm: 1 } },
  ],
  keepouts: [{ layers: ["TOP"], polygon: { outer: [{ x: 10, y: 10 }, { x: 15, y: 10 }, { x: 15, y: 15 }, { x: 10, y: 15 }], holes: [[{ x: 11, y: 11 }, { x: 12, y: 11 }, { x: 12, y: 12 }, { x: 11, y: 12 }]] }, forbid: { tracks: true, vias: true, zones: true } }],
  rules: { default: defaultValues, nets: [{ net: "N", values }] },
  copper: { fixed: {
    tracks: [{ net: "N", layer: "TOP", widthMm: 0.2, points: [{ x: 1, y: 18 }, { x: 4, y: 18 }, { x: 7, y: 18 }] }],
    vias: [
      { net: "N", at: { x: 4, y: 18 }, diameterMm: 0.6, drillMm: 0.3, fromLayer: "TOP", toLayer: "BOTTOM", type: "through" },
      { net: "N", at: { x: 6, y: 18 }, diameterMm: 0.3, drillMm: 0.1, fromLayer: "TOP", toLayer: "INNER_1", type: "micro" },
    ],
    zones: [
      { net: "N", layers: ["INNER_1"], outline: { outer: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 4 }, { x: 1, y: 4 }], holes: [[{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }, { x: 2, y: 3 }]] }, fill: { style: "solid" }, padConnection: { mode: "thermal", thermalGapMm: 0.2, spokeWidthMm: 0.25 }, removeIslandsBelowMm2: 1 },
      { layers: ["TOP"], outline: { outer: [{ x: 16, y: 1 }, { x: 19, y: 1 }, { x: 19, y: 4 }, { x: 16, y: 4 }] } },
    ],
  }, editable: {
    tracks: [{ net: "N", layer: "BOTTOM", widthMm: 0.2, points: [{ x: 1, y: 17 }, { x: 4, y: 17 }] }],
    vias: [
      { net: "N", at: { x: 4, y: 17 }, diameterMm: 0.6, drillMm: 0.3, fromLayer: "TOP", toLayer: "BOTTOM", type: "through" },
      { net: "N", at: { x: 6, y: 17 }, diameterMm: 0.5, drillMm: 0.2, fromLayer: "TOP", toLayer: "INNER_2", type: "blind-buried" },
    ],
    zones: [],
  } },
}

const directory = await mkdtemp(join(tmpdir(), "copilot-router-codec-"))
try {
  const { inputBoard, inputProject } = await writeKrtBoard({ board, rules: board.rules }, directory)
  const source = await readFile(inputBoard, "utf8")
  const project = JSON.parse(await readFile(inputProject, "utf8"))
  assert.equal(project.board.design_settings.rules.min_track_width, 0.127)
  assert.equal(project.board.design_settings.rules.min_clearance, 0.2)
  assert.equal(project.board.design_settings.rules.min_hole_to_hole, 0.175)
  assert.deepEqual(project.net_settings.classes, [
    {
      name: "Default", clearance: 0.25, track_width: 0.25,
      via_diameter: 0.6, via_drill: 0.3, diff_pair_width: 0.25, diff_pair_gap: 0.25,
    },
    {
      name: "Router_1", clearance: 0.2, track_width: 0.2,
      via_diameter: 0.6, via_drill: 0.3, diff_pair_width: 0.2, diff_pair_gap: 0.2,
    },
  ])
  assert.deepEqual(project.net_settings.netclass_assignments, { N: "Router_1" })
  assert.match(source, /\(0 "F\.Cu" signal\)[\s\S]*\(4 "In1\.Cu" signal\)[\s\S]*\(6 "In2\.Cu" signal\)[\s\S]*\(2 "B\.Cu" signal\)/)
  assert.match(source, /\(pad "" np_thru_hole circle[\s\S]*\(drill 0\.5 \(offset 0\.1 -0\.1\)\)/)
  assert.match(source, /\(drill oval 1\.3 0\.5\)/)
  assert.match(source, /\(property "Reference" "U2"[\s\S]*?\(pad "1" smd rect[\s\S]*?\(at 2 0 90\)/)
  assert.match(source, /\(property "Reference" "B1"[\s\S]*?\(pad "1" smd rect[\s\S]*?\(layers "B\.Cu" "B\.Mask" "B\.Paste"\)/)
  assert.match(source, /\(property "Reference" "B1"[\s\S]*?\(pad "3" smd rect\s+\(at 0 2 90\)/,
    "KRT board files keep bottom pad coordinates pre-mirrored and must not receive another X reflection")
  const roundTrip = await importKiCadRoutingBoard(inputBoard)
  assert.ok(roundTrip.board, JSON.stringify(roundTrip.diagnostics))
  assert.deepEqual(roundTrip.board.pads.filter((pad) => pad.component === "B1").map((pad) => ({
    number: pad.number, at: pad.at, rotationDeg: pad.rotationDeg, layers: pad.layers,
  })), [
    { number: "1", at: { x: 12, y: 3 }, rotationDeg: 90, layers: ["BOTTOM"] },
    { number: "2", at: { x: 12, y: 7 }, rotationDeg: 90, layers: ["BOTTOM"] },
    { number: "3", at: { x: 14, y: 5 }, rotationDeg: 90, layers: ["BOTTOM"] },
  ])
  assert.match(source, /\(zone \(layer "F\.Cu"\)[\s\S]*?\(keepout \(tracks not_allowed\)/)
  assert.match(source, /\(start 1 18\) \(end 4 18\)[\s\S]*?\(locked yes\)/,
    "fixed copper must remain immutable")
  assert.match(source, /\(start 1 17\) \(end 4 17\)[\s\S]*?\(net "N"\)\s+\(uuid/,
    "editable copper must stay unlocked for native KRT recovery")
  assert.match(source, /\(via micro \(at 6 18\)/, "fixed microvias must retain their KiCad marker")
  assert.match(source, /\(via blind \(at 6 17\)/, "editable blind/buried vias must retain their KiCad marker")
  const routedBoard = join(directory, "routed.kicad_pcb")
  const replaced = source
    .replace(/\s*\(segment\s+\(start 1 17\)[\s\S]*?\(uuid "[^"]+"\)\)/, "")
    .replace(/\)\s*$/, `
      (segment (start 5 17) (end 8 17) (width 0.2) (layer "B.Cu") (net "N")
        (uuid "00000000-0000-0000-0000-000000000099")))\n`)
  await writeFile(routedBoard, replaced, "utf8")
  const recovered = await readKrtBoard(inputBoard, routedBoard, board)
  assert.ok(recovered.copper.tracks.some((track) => track.layer === "BOTTOM"
    && track.points[0].x === 5 && track.points[1].x === 8), "KRT replacement copper must be returned")
  assert.ok(!recovered.copper.tracks.some((track) => track.points[0].y === 18),
    "fixed copper must not leak into backend-owned output")
  assert.ok(!recovered.copper.tracks.some((track) => track.points[0].x === 1 && track.points[0].y === 17),
    "ripped editable copper must not be merged back into backend-owned output")
  assert.equal(recovered.copper.vias.find((via) => via.at.x === 4 && via.at.y === 17)?.type, "through")
  assert.equal(recovered.copper.vias.find((via) => via.at.x === 6 && via.at.y === 17)?.type, "blind-buried",
    "KRT output parsing must not silently turn blind/buried vias into through vias")
  assert.ok(!recovered.copper.vias.some((via) => via.at.x === 6 && via.at.y === 18),
    "fixed microvias must not leak into backend-owned replacement copper")
  assert.ok((source.match(/\(polygon \(pts/g) ?? []).length >= 4, "zone and keepout hole contours must be serialized")
  const points = approximateKiCadArc({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, 0.01)
  assert.ok(points.length > 3)
  assert.ok(points.some((point) => Math.hypot(point.x, point.y - 1) < 0.02), "arc approximation must pass through the selected sweep")
  console.log("KRT codec contract: ok")
} finally {
  await rm(directory, { recursive: true, force: true })
}
