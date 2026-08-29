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
  (net 0 "") (net 1 "N") (net 2 "VCC") (net 3 "VPP")
  (segment (start 1 5) (end 4 5) (width 0.2) (layer "F.Cu") (net "N") (uuid "00000000-0000-0000-0000-000000000001"))
  (segment (start 1 6) (end 4 6) (width 0.2) (layer "F.Cu") (locked yes) (net "N") (uuid "00000000-0000-0000-0000-000000000002"))
  (footprint "test" (layer "F.Cu") (at 5 5) (property "Reference" "J1")
    (pad "" np_thru_hole circle (at 0 0) (size 1 1) (drill 0.5 (offset 0.1 -0.1)) (layers "*.Cu" "*.Mask"))
    (pad "1" thru_hole oval (at 3 0) (size 2 1) (drill oval 1.3 0.5) (layers "*.Cu" "*.Mask") (net "N")))
  (footprint "test-rotated" (layer "F.Cu") (at 12 5 90) (property "Reference" "U2")
    (pad "1" smd rect (at 2 0 90) (size 2 1) (layers "F.Cu" "F.Mask") (net "N")))
  (footprint "test-bottom" (layer "B.Cu") (at 12 12 90) (property "Reference" "B1")
    (pad "1" smd rect (at 0 2 90) (size 2 1) (layers "B.Cu" "B.Mask") (net "N")))
  (zone (net "N") (layer "In1.Cu") (hatch edge 0.5) (connect_pads yes (clearance 0.2))
    (min_thickness 0.1) (fill yes (thermal_gap 0.2) (thermal_bridge_width 0.25))
    (polygon (pts (xy 1 1) (xy 4 1) (xy 4 4) (xy 1 4)))
    (polygon (pts (xy 2 2) (xy 3 2) (xy 3 3) (xy 2 3))))
  (zone (layer "F.Cu") (hatch edge 0.5)
    (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
    (polygon (pts (xy 10 10) (xy 15 10) (xy 15 15) (xy 10 15)))
    (polygon (pts (xy 11 11) (xy 12 11) (xy 12 12) (xy 11 12))))
  (gr_text "COPPER" (at 10 5 90) (layer "F.Cu") (effects (font (size 1 1) (thickness 0.15))))
  (gr_text "1=>>" (at 15 5 30) (layer "F.Cu")
    (effects (font (size 2.032 1.524) (thickness 0.3048)) (justify left top mirror)))
  (gr_text "HIDDEN" (at 5 10) (layer "F.Cu") (hide yes)
    (effects (font (size 5 5) (thickness 1))))
  (gr_line (start 0 0) (end 20 0) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))
  (gr_line (start 20 0) (end 20 20) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))
  (gr_line (start 20 20) (end 0 20) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))
  (gr_line (start 0 20) (end 0 0) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts")))
`

const directory = await mkdtemp(join(tmpdir(), "copilot-router-kicad-adapter-"))
try {
  const input = join(directory, "input.kicad_pcb")
  await writeFile(input, source, "utf8")
  await writeFile(join(directory, "input.kicad_pro"), `${JSON.stringify({
    board: { design_settings: { rules: {
      min_clearance: 0.15,
      min_track_width: 0.127,
      min_copper_edge_clearance: 0.25,
      min_via_diameter: 0.45,
      min_through_hole_diameter: 0.2,
      min_via_annular_width: 0.1,
    } } },
    net_settings: {
      classes: [
        { name: "Default", priority: 2147483647, clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3, diff_pair_width: 0.2, diff_pair_gap: 0.2 },
        { name: "Wide", priority: 1, clearance: 0.4, track_width: 0.5, via_diameter: 1, via_drill: 0.6, diff_pair_width: 0.3, diff_pair_gap: 0.3 },
        { name: "Strict", priority: 0, clearance: 0.6 },
      ],
      netclass_assignments: { VCC: ["Wide", "Strict"] },
      netclass_patterns: [{ pattern: "V[CP]*", netclass: "Wide" }],
    },
  }, null, 2)}\n`, "utf8")
  const imported = await importKiCadRoutingBoard(input)
  assert.ok(imported.board && imported.context, JSON.stringify(imported.diagnostics))
  const vccRules = imported.board.rules.nets.find((entry) => entry.net === "VCC")?.values
  assert.equal(vccRules?.clearanceMm, 0.6, "all explicit and pattern classes must contribute the strictest clearance")
  assert.equal(vccRules?.preferredTrackWidthMm, 0.5, "the first explicit class must select width geometry")
  assert.equal(vccRules?.via.preferredDiameterMm, 1, "KiCad netclass_patterns must materialize per-net via geometry")
  const vppRules = imported.board.rules.nets.find((entry) => entry.net === "VPP")?.values
  assert.equal(vppRules?.clearanceMm, 0.4, "fnmatch character classes must match KiCad/KRT patterns")
  assert.deepEqual(imported.board.layers.map((layer) => layer.name), ["TOP", "INNER_1", "INNER_2", "BOTTOM"])
  assert.equal(imported.board.pads[0].hole.plated, false)
  assert.deepEqual(imported.board.pads[0].hole.offset, { x: 0.1, y: -0.1 })
  assert.equal(imported.board.pads[1].hole.slotLengthMm, 0.8)
  const rotatedPad = imported.board.pads.find((pad) => pad.component === "U2")
  assert.deepEqual(rotatedPad.at, { x: 12, y: 3 })
  assert.equal(rotatedPad.rotationDeg, 90)
  assert.deepEqual(rotatedPad.layers, ["TOP"])
  const bottomPad = imported.board.pads.find((pad) => pad.component === "B1")
  assert.deepEqual(bottomPad.at, { x: 14, y: 12 }, "bottom pad locals are already pre-mirrored in KiCad board files")
  assert.equal(bottomPad.rotationDeg, 90)
  assert.deepEqual(bottomPad.layers, ["BOTTOM"])
  assert.equal(imported.board.keepouts[0].polygon.holes.length, 1)
  assert.equal(imported.board.copper.editable.tracks.length, 1, "unlocked native routes must be editable by default")
  assert.equal(imported.board.copper.fixed.tracks.length, 1, "locked native routes must remain fixed")
  assert.ok(imported.board.copper.editable.zones.some((zone) => zone.outline.holes?.length === 1))
  assert.ok(imported.board.copper.fixed.zones.some((zone) => !zone.net), "copper text must become a netless fixed obstacle")
  const textObstacle = imported.board.copper.fixed.zones.find((zone) => zone.id === "gr-text-1")
  assert.ok(textObstacle, "rotated copper text must become a fixed obstacle")
  const radians = Math.PI / 6
  const localTextPoints = textObstacle.outline.outer.map((point) => {
    const dx = point.x - 15
    const dy = point.y - 5
    return {
      x: dx * Math.cos(radians) - dy * Math.sin(radians),
      y: dx * Math.sin(radians) + dy * Math.cos(radians),
    }
  })
  const localBounds = {
    minX: Math.min(...localTextPoints.map((point) => point.x)),
    maxX: Math.max(...localTextPoints.map((point) => point.x)),
    minY: Math.min(...localTextPoints.map((point) => point.y)),
    maxY: Math.max(...localTextPoints.map((point) => point.y)),
  }
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`)
  close(localBounds.minX, -8.4328)
  close(localBounds.maxX, 0.3048)
  close(localBounds.minY, -1.3208)
  close(localBounds.maxY, 3.3528)
  assert.ok(!imported.board.copper.fixed.zones.some((zone) => zone.id === "gr-text-2"),
    "hidden copper text must not block the router")
  const baseResult = {
    status: "complete", operation: "route", diagnostics: [], metrics: {},
    rules: imported.board.rules,
  }
  const newTrack = { net: "N", layer: "TOP", widthMm: 0.2, points: [{ x: 8, y: 5 }, { x: 12, y: 5 }] }
  const newBlindVia = { net: "N", at: { x: 9, y: 9 }, diameterMm: 0.6, drillMm: 0.3, fromLayer: "TOP", toLayer: "INNER_2", type: "blind-buried" }
  const newMicroVia = { net: "N", at: { x: 10, y: 9 }, diameterMm: 0.45, drillMm: 0.2, fromLayer: "TOP", toLayer: "INNER_1", type: "micro" }

  const preservedOutput = join(directory, "preserved.kicad_pcb")
  const preserved = await applyKiCadRoutingResult(imported.context, {
    ...baseResult,
    copper: {
      tracks: [...imported.board.copper.editable.tracks, newTrack],
      vias: [...imported.board.copper.editable.vias, newBlindVia, newMicroVia],
      zones: imported.board.copper.editable.zones,
    },
  }, preservedOutput)
  assert.equal(preserved.outputPath, preservedOutput, JSON.stringify(preserved.diagnostics))
  const preservedSource = await readFile(preservedOutput, "utf8")
  assert.match(preservedSource, /00000000-0000-0000-0000-000000000001/, "no clear intent must preserve unlocked native tracks")
  assert.equal((preservedSource.match(/00000000-0000-0000-0000-000000000001/g) ?? []).length, 1, "preserved tracks must not be recreated")
  assert.match(preservedSource, /\(start 8 5\)/, "new router copper must be appended")
  assert.match(preservedSource, /\(via blind \(at 9 9\)/,
    "new blind/buried vias must use the native KiCad marker")
  assert.match(preservedSource, /\(via micro \(at 10 9\)/,
    "new microvias must use the native KiCad marker rather than a nested list")
  assert.doesNotMatch(preservedSource, /copilot-router:/, "preserved native zones must not be recreated")

  const replacementOutput = join(directory, "replacement.kicad_pcb")
  const replacement = await applyKiCadRoutingResult(imported.context, {
    ...baseResult,
    copper: {
      tracks: [newTrack],
      vias: imported.board.copper.editable.vias,
      zones: imported.board.copper.editable.zones,
    },
  }, replacementOutput)
  assert.equal(replacement.outputPath, replacementOutput, JSON.stringify(replacement.diagnostics))
  const replacementSource = await readFile(replacementOutput, "utf8")
  assert.doesNotMatch(replacementSource, /00000000-0000-0000-0000-000000000001/,
    "backend replacement must remove editable tracks omitted from the result without requiring clearRouting")
  assert.match(replacementSource, /00000000-0000-0000-0000-000000000002/,
    "backend replacement must never remove locked copper")
  assert.doesNotMatch(replacementSource, /copilot-router:/,
    "unchanged editable zones must retain their native AST records")

  const sameIdChangedOutput = join(directory, "same-id-changed.kicad_pcb")
  const sameIdChangedTrack = {
    ...imported.board.copper.editable.tracks[0],
    widthMm: 0.35,
    points: [{ x: 1, y: 5 }, { x: 6, y: 5 }],
  }
  const sameIdChanged = await applyKiCadRoutingResult(imported.context, {
    ...baseResult,
    copper: {
      tracks: [sameIdChangedTrack],
      vias: imported.board.copper.editable.vias,
      zones: imported.board.copper.editable.zones,
    },
  }, sameIdChangedOutput)
  assert.equal(sameIdChanged.outputPath, sameIdChangedOutput, JSON.stringify(sameIdChanged.diagnostics))
  const sameIdChangedSource = await readFile(sameIdChangedOutput, "utf8")
  assert.doesNotMatch(sameIdChangedSource, /00000000-0000-0000-0000-000000000001/,
    "a retained UUID must not hide changed backend geometry")
  assert.match(sameIdChangedSource, /\(start 1 5\) \(end 6 5\) \(width 0\.35\)/,
    "same-id endpoint and width changes must replace the native AST node")

  const stackOnlyOutput = join(directory, "stack-only.kicad_pcb")
  const fourLayerStack = {
    boardThicknessMm: 1.2,
    layers: [
      { kind: "copper", layer: "TOP", thicknessMm: 0.035 },
      { kind: "dielectric", name: "PREPREG 1", thicknessMm: 0.35, relativePermittivity: 4.2 },
      { kind: "copper", layer: "INNER_1", thicknessMm: 0.035 },
      { kind: "dielectric", name: "CORE", thicknessMm: 0.36, relativePermittivity: 4.2 },
      { kind: "copper", layer: "INNER_2", thicknessMm: 0.035 },
      { kind: "dielectric", name: "PREPREG 2", thicknessMm: 0.35, relativePermittivity: 4.2 },
      { kind: "copper", layer: "BOTTOM", thicknessMm: 0.035 },
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
    clearRouting: { tracks: ["N"] },
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
  assert.deepEqual(roundTrip.board.layers.map((layer) => layer.name), ["TOP", "INNER_1", "INNER_2", "BOTTOM"])
  assert.equal(roundTrip.board.stackup.boardThicknessMm, 1.2)
  console.log("standalone KiCad adapter contract: ok")
} finally {
  await rm(directory, { recursive: true, force: true })
}
