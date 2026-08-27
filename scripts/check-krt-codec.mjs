import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { approximateKiCadArc, writeKrtBoard } from "../package-dist/backends/krt-codec.js"
import { importKiCadRoutingBoard } from "../package-dist/adapters/kicad.js"

const values = {
  clearanceMm: 0.2, edgeClearanceMm: 0.2, minTrackWidthMm: 0.127, preferredTrackWidthMm: 0.2,
  via: { minDiameterMm: 0.6, preferredDiameterMm: 0.6, minDrillMm: 0.3, preferredDrillMm: 0.3 },
}
const board = {
  outline: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }], cutouts: [],
  layers: [
    { name: "F.Cu", index: 0, side: "top" }, { name: "In1.Cu", index: 1, side: "inner" },
    { name: "In2.Cu", index: 2, side: "inner" }, { name: "B.Cu", index: 3, side: "bottom" },
  ],
  nets: [{ name: "N" }], components: [
    { designator: "J1", at: { x: 5, y: 5 }, rotationDeg: 0, side: "top" },
    { designator: "U2", at: { x: 5, y: 5 }, rotationDeg: 90, side: "top" },
    { designator: "B1", at: { x: 12, y: 5 }, rotationDeg: 90, side: "bottom" },
  ],
  pads: [
    { component: "J1", number: "", at: { x: 5, y: 5 }, rotationDeg: 0, layers: ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"], shape: { kind: "circle", diameterMm: 1 }, hole: { shape: "round", diameterMm: 0.5, offset: { x: 0.1, y: -0.1 }, plated: false } },
    { component: "J1", number: "1", net: "N", at: { x: 8, y: 5 }, rotationDeg: 0, layers: ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"], shape: { kind: "oval", widthMm: 2, heightMm: 1 }, hole: { shape: "slot", diameterMm: 0.5, slotLengthMm: 0.8, plated: true } },
    { component: "U2", number: "1", net: "N", at: { x: 5, y: 3 }, rotationDeg: 90, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 2, heightMm: 1 } },
    { component: "B1", number: "1", net: "N", at: { x: 12, y: 3 }, rotationDeg: 90, layers: ["B.Cu"], shape: { kind: "rect", widthMm: 2, heightMm: 1 } },
    { component: "B1", number: "2", net: "N", at: { x: 12, y: 7 }, rotationDeg: 90, layers: ["B.Cu"], shape: { kind: "rect", widthMm: 2, heightMm: 1 } },
    { component: "B1", number: "3", net: "N", at: { x: 14, y: 5 }, rotationDeg: 90, layers: ["B.Cu"], shape: { kind: "rect", widthMm: 2, heightMm: 1 } },
  ],
  keepouts: [{ layers: ["F.Cu"], polygon: { outer: [{ x: 10, y: 10 }, { x: 15, y: 10 }, { x: 15, y: 15 }, { x: 10, y: 15 }], holes: [[{ x: 11, y: 11 }, { x: 12, y: 11 }, { x: 12, y: 12 }, { x: 11, y: 12 }]] }, forbid: { tracks: true, vias: true, zones: true } }],
  rules: { default: values, nets: [{ net: "N", values }] },
  copper: { fixed: { tracks: [], vias: [], zones: [
    { net: "N", layers: ["In1.Cu"], outline: { outer: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 4 }, { x: 1, y: 4 }], holes: [[{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }, { x: 2, y: 3 }]] }, fill: { style: "solid" }, padConnection: { mode: "thermal", thermalGapMm: 0.2, spokeWidthMm: 0.25 }, removeIslandsBelowMm2: 1 },
    { layers: ["F.Cu"], outline: { outer: [{ x: 16, y: 1 }, { x: 19, y: 1 }, { x: 19, y: 4 }, { x: 16, y: 4 }] } },
  ] }, editable: { tracks: [], vias: [], zones: [] } },
}

const directory = await mkdtemp(join(tmpdir(), "copilot-router-codec-"))
try {
  const { inputBoard } = await writeKrtBoard({ board }, directory)
  const source = await readFile(inputBoard, "utf8")
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
    { number: "1", at: { x: 12, y: 3 }, rotationDeg: 90, layers: ["B.Cu"] },
    { number: "2", at: { x: 12, y: 7 }, rotationDeg: 90, layers: ["B.Cu"] },
    { number: "3", at: { x: 14, y: 5 }, rotationDeg: 90, layers: ["B.Cu"] },
  ])
  assert.match(source, /\(zone \(layer "F\.Cu"\)[\s\S]*?\(keepout \(tracks not_allowed\)/)
  assert.ok((source.match(/\(polygon \(pts/g) ?? []).length >= 4, "zone and keepout hole contours must be serialized")
  const points = approximateKiCadArc({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, 0.01)
  assert.ok(points.length > 3)
  assert.ok(points.some((point) => Math.hypot(point.x, point.y - 1) < 0.02), "arc approximation must pass through the selected sweep")
  console.log("KRT codec contract: ok")
} finally {
  await rm(directory, { recursive: true, force: true })
}
