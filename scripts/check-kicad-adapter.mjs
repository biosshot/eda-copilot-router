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
  (footprint "test-rotated" (layer "F.Cu") (at 12 5 90) (property "Reference" "U2")
    (pad "1" smd rect (at 2 0 90) (size 2 1) (layers "F.Cu" "F.Mask") (net "N")))
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
  const input = join(directory, "input.kicad_pcb")
  await writeFile(input, source, "utf8")
  const imported = await importKiCadRoutingBoard(input)
  assert.ok(imported.board && imported.context, JSON.stringify(imported.diagnostics))
  assert.deepEqual(imported.board.layers.map((layer) => layer.name), ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"])
  assert.equal(imported.board.pads[0].hole.plated, false)
  assert.deepEqual(imported.board.pads[0].hole.offset, { x: 0.1, y: -0.1 })
  assert.equal(imported.board.pads[1].hole.slotLengthMm, 0.8)
  const rotatedPad = imported.board.pads.find((pad) => pad.component === "U2")
  assert.deepEqual(rotatedPad.at, { x: 12, y: 3 })
  assert.equal(rotatedPad.rotationDeg, 90)
  assert.equal(imported.board.keepouts[0].polygon.holes.length, 1)
  assert.equal(imported.board.copper.editable.tracks.length, 1, "unlocked native routes must be editable by default")
  assert.equal(imported.board.copper.fixed.tracks.length, 1, "locked native routes must remain fixed")
  assert.ok(imported.board.copper.editable.zones.some((zone) => zone.outline.holes?.length === 1))
  assert.ok(imported.board.copper.fixed.zones.some((zone) => !zone.net), "copper text must become a netless fixed obstacle")
  const baseResult = {
    status: "complete", operation: "route", diagnostics: [], metrics: {},
    rules: imported.board.rules,
  }
  const newTrack = { net: "N", layer: "F.Cu", widthMm: 0.2, points: [{ x: 8, y: 5 }, { x: 12, y: 5 }] }

  const preservedOutput = join(directory, "preserved.kicad_pcb")
  const preserved = await applyKiCadRoutingResult(imported.context, {
    ...baseResult,
    copper: {
      tracks: [...imported.board.copper.editable.tracks, newTrack],
      vias: imported.board.copper.editable.vias,
      zones: imported.board.copper.editable.zones,
    },
  }, preservedOutput)
  assert.equal(preserved.outputPath, preservedOutput, JSON.stringify(preserved.diagnostics))
  const preservedSource = await readFile(preservedOutput, "utf8")
  assert.match(preservedSource, /00000000-0000-0000-0000-000000000001/, "no clear intent must preserve unlocked native tracks")
  assert.equal((preservedSource.match(/00000000-0000-0000-0000-000000000001/g) ?? []).length, 1, "preserved tracks must not be recreated")
  assert.match(preservedSource, /\(start 8 5\)/, "new router copper must be appended")
  assert.doesNotMatch(preservedSource, /copilot-router:/, "preserved native zones must not be recreated")

  const stackOnlyOutput = join(directory, "stack-only.kicad_pcb")
  const fourLayerStack = {
    boardThicknessMm: 1.2,
    layers: [
      { kind: "copper", layer: "F.Cu", thicknessMm: 0.035 },
      { kind: "dielectric", name: "PREPREG 1", thicknessMm: 0.35, relativePermittivity: 4.2 },
      { kind: "copper", layer: "In1.Cu", thicknessMm: 0.035 },
      { kind: "dielectric", name: "CORE", thicknessMm: 0.36, relativePermittivity: 4.2 },
      { kind: "copper", layer: "In2.Cu", thicknessMm: 0.035 },
      { kind: "dielectric", name: "PREPREG 2", thicknessMm: 0.35, relativePermittivity: 4.2 },
      { kind: "copper", layer: "B.Cu", thicknessMm: 0.035 },
    ],
  }
  const stackOnly = await applyKiCadRoutingResult(imported.context, {
    ...baseResult, operation: "apply-stackup",
    stackup: { applyRequested: true, effective: fourLayerStack },
  }, stackOnlyOutput)
  assert.equal(stackOnly.outputPath, stackOnlyOutput, JSON.stringify(stackOnly.diagnostics))
  const stackOnlySource = await readFile(stackOnlyOutput, "utf8")
  assert.match(stackOnlySource, /00000000-0000-0000-0000-000000000001/, "stack-only apply must not touch editable copper")
  assert.match(stackOnlySource, /00000000-0000-0000-0000-000000000002/, "stack-only apply must preserve locked copper")
  assert.match(stackOnlySource, /\(thickness 1\.2\)/)

  const partialOutput = join(directory, "partial-clear.kicad_pcb")
  const partial = await applyKiCadRoutingResult(imported.context, {
    ...baseResult,
    clearRouting: { nets: ["N"], items: ["tracks"] },
    copper: {
      tracks: [newTrack],
      vias: imported.board.copper.editable.vias,
      zones: imported.board.copper.editable.zones,
    },
  }, partialOutput)
  assert.equal(partial.outputPath, partialOutput, JSON.stringify(partial.diagnostics))
  const partialSource = await readFile(partialOutput, "utf8")
  assert.doesNotMatch(partialSource, /00000000-0000-0000-0000-000000000001/, "only selected unlocked tracks must be removed")
  assert.match(partialSource, /00000000-0000-0000-0000-000000000002/, "locked routes must never be removed")
  assert.doesNotMatch(partialSource, /copilot-router:/, "an unselected native zone must remain native")

  const roundTrip = await importKiCadRoutingBoard(stackOnlyOutput)
  assert.ok(roundTrip.board, JSON.stringify(roundTrip.diagnostics))
  assert.deepEqual(roundTrip.board.layers.map((layer) => layer.name), ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"])
  assert.equal(roundTrip.board.stackup.boardThicknessMm, 1.2)
  console.log("standalone KiCad adapter contract: ok")
} finally {
  await rm(directory, { recursive: true, force: true })
}
