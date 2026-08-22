import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyKiCadRoutingResult, importKiCadRoutingBoard } from "../package-dist/adapters/kicad.js"

const source = `(kicad_pcb
  (version 20260206) (generator "contract-test")
  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal)
    (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "N")
  (segment (start 1 5) (end 4 5) (width 0.2) (layer "F.Cu") (net "N") (uuid "00000000-0000-0000-0000-000000000001"))
  (segment (start 1 6) (end 4 6) (width 0.2) (layer "F.Cu") (locked yes) (net "N") (uuid "00000000-0000-0000-0000-000000000002"))
  (footprint "test" (layer "F.Cu") (at 5 5) (property "Reference" "J1")
    (pad "" np_thru_hole circle (at 0 0) (size 1 1) (drill 0.5 (offset 0.1 -0.1)) (layers "*.Cu" "*.Mask"))
    (pad "1" thru_hole oval (at 3 0) (size 2 1) (drill oval 1.3 0.5) (layers "*.Cu" "*.Mask") (net "N")))
  (zone (net "N") (layer "In1.Cu") (hatch edge 0.5) (connect_pads yes (clearance 0.2))
    (min_thickness 0.1) (fill yes (thermal_gap 0.2) (thermal_bridge_width 0.25))
    (polygon (pts (xy 1 1) (xy 4 1) (xy 4 4) (xy 1 4)))
    (polygon (pts (xy 2 2) (xy 3 2) (xy 3 3) (xy 2 3))))
  (zone (layer "F.Cu") (hatch edge 0.5)
    (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
    (polygon (pts (xy 10 10) (xy 15 10) (xy 15 15) (xy 10 15)))
    (polygon (pts (xy 11 11) (xy 12 11) (xy 12 12) (xy 11 12))))
  (gr_text "COPPER" (at 10 5 90) (layer "F.Cu") (effects (font (size 1 1) (thickness 0.15))))
  (gr_line (start 0 0) (end 20 0) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))
  (gr_line (start 20 0) (end 20 20) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))
  (gr_line (start 20 20) (end 0 20) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))
  (gr_line (start 0 20) (end 0 0) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts")))
`

const directory = await mkdtemp(join(tmpdir(), "copilot-router-kicad-adapter-"))
try {
  const input = join(directory, "input.kicad_pcb"); const output = join(directory, "output.kicad_pcb")
  await writeFile(input, source, "utf8")
  const imported = await importKiCadRoutingBoard(input)
  assert.ok(imported.board && imported.context, JSON.stringify(imported.diagnostics))
  assert.deepEqual(imported.board.layers.map((layer) => layer.name), ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"])
  assert.equal(imported.board.pads[0].hole.plated, false)
  assert.deepEqual(imported.board.pads[0].hole.offset, { x: 0.1, y: -0.1 })
  assert.equal(imported.board.pads[1].hole.slotLengthMm, 0.8)
  assert.equal(imported.board.keepouts[0].polygon.holes.length, 1)
  assert.equal(imported.board.copper.editable.tracks.length, 1, "unlocked native routes must be editable by default")
  assert.equal(imported.board.copper.fixed.tracks.length, 1, "locked native routes must remain fixed")
  assert.ok(imported.board.copper.editable.zones.some((zone) => zone.outline.holes?.length === 1))
  assert.ok(imported.board.copper.fixed.zones.some((zone) => !zone.net), "copper text must become a netless fixed obstacle")
  const result = {
    status: "complete", operation: "route", diagnostics: [], metrics: {},
    rules: { effective: imported.board.rules, applyRequested: false, overriddenFields: [] },
    stackup: {
      applyRequested: true,
      effective: {
        boardThicknessMm: 1.2,
        layers: [
          { kind: "copper", layer: "F.Cu", thicknessMm: 0.035 },
          { kind: "dielectric", name: "CORE", thicknessMm: 1.13, relativePermittivity: 4.2 },
          { kind: "copper", layer: "B.Cu", thicknessMm: 0.035 },
        ],
      },
    },
    copper: { tracks: [{ net: "N", layer: "F.Cu", widthMm: 0.2, points: [{ x: 8, y: 5 }, { x: 12, y: 5 }] }], vias: [], zones: [] },
  }
  const applied = await applyKiCadRoutingResult(imported.context, result, output)
  assert.equal(applied.outputPath, output, JSON.stringify(applied.diagnostics))
  const outputSource = await readFile(output, "utf8")
  assert.match(outputSource, /\(segment /)
  assert.doesNotMatch(outputSource, /00000000-0000-0000-0000-000000000001/, "old editable route must be replaced")
  assert.match(outputSource, /00000000-0000-0000-0000-000000000002/, "locked route must be preserved")
  assert.match(outputSource, /\(thickness 1\.2\)/)
  const roundTrip = await importKiCadRoutingBoard(output)
  assert.ok(roundTrip.board, JSON.stringify(roundTrip.diagnostics))
  assert.deepEqual(roundTrip.board.layers.map((layer) => layer.name), ["F.Cu", "B.Cu"])
  assert.equal(roundTrip.board.stackup.boardThicknessMm, 1.2)
  console.log("standalone KiCad adapter contract: ok")
} finally {
  await rm(directory, { recursive: true, force: true })
}
