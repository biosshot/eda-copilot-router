stack({
  boardThicknessMm: 1.6,
  fallbackCopperThicknessOz: 1,
  layers: [
    { kind: "copper", name: "TOP", thicknessOz: 1 },
    { kind: "dielectric", name: "CORE", thicknessMm: 1.53042, relativePermittivity: 4.2 },
    { kind: "copper", name: "BOTTOM", thicknessOz: 1 },
  ],
})

drc({
  edgeClearanceMm: 0.5,
  holeToHoleClearanceMm: 0.25,
})

plane({
  net: "GND",
  layers: ["TOP", "BOTTOM"],
  region: board(),
  stitching: {
    gridMm: 3,
    maxVisibleViaDistanceMm: 10,
    via: "drc-min",
    viaInPad: true,
  },
})

powerNet("VIN_6_12V", {
  trackWidthMm: 0.8,
  tapWidthMm: "drc-min",
  allowedLayers: "TOP",
})

powerNet("VCC5", {
  trackWidthMm: 0.8,
  tapWidthMm: "drc-min",
  allowedLayers: "TOP",
})

powerNet("VBIAS", {
  trackWidthMm: 0.3,
  tapWidthMm: "drc-min",
  allowedLayers: "TOP",
})

polygon("VIN_6_12V")
  .connect(pad("J3", 1), pad("C6", 1))
  .on("TOP")
  .compact({ maxPadFreeGapWidths: 20 })
polygon("VIN_6_12V")
  .connect(pad("C6", 1), pad("U2", 3))
  .on("TOP")
  .compact({ maxPadFreeGapWidths: 20 })

polygon("VCC5")
  .connect(pad("U2", 2), pad("C7", 1))
  .on("TOP")
  .compact({ maxPadFreeGapWidths: 20 })
polygon("VCC5")
  .connect(pad("U2", 2), pad("C3", 1))
  .on("TOP")
  .compact({ maxPadFreeGapWidths: 20 })
polygon("VCC5")
  .connect(pad("C3", 1), pad("C4", 1), pad("L1", 1))
  .on("TOP")
  .compact({ maxPadFreeGapWidths: 20 })

polygon("VBIAS")
  .connect(pad("U1", 1), pad("C2", 1), pad("R1", 1))
  .on("TOP")
  .compact({ maxPadFreeGapWidths: 20 })

signalNet("Net-(C1-Pad1)", {
  allowedLayers: "TOP",
  impedance: {
    targetOhm: 50,
    tolerancePercent: 10,
    referenceNet: "GND",
  },
})

signalNet("RF_IN_AC", {
  allowedLayers: "TOP",
  minTrackWidthMm: 0.127,
})

signalNet("RF_OUT_DC", {
  allowedLayers: "TOP",
  minTrackWidthMm: 0.127,
})

signalNet("Net-(C5-Pad2)", {
  allowedLayers: "TOP",
  impedance: {
    targetOhm: 50,
    tolerancePercent: 10,
    referenceNet: "GND",
  },
})

viaStitch("RF_GROUND_FENCE", {
  mode: "along",
  // Route the dense amplifier connections before the wide 50-ohm trunks.
  routes: ["RF_IN_AC", "RF_OUT_DC", "Net-(C1-Pad1)", "Net-(C5-Pad2)"],
  net: "GND",
  pitchMm: 1,
  rows: 2,
  stagger: true,
})

runAll()
