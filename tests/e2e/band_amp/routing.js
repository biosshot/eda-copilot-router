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

signalNet("RF_IN_AC", {
  allowedLayers: "TOP",
  impedance: {
    targetOhm: 50,
    tolerancePercent: 10,
    topology: "microstrip",
    reference: { net: "GND" },
  },
})

signalNet("RF_OUT_DC", {
  allowedLayers: "TOP",
  impedance: {
    targetOhm: 50,
    tolerancePercent: 10,
    topology: "microstrip",
    reference: { net: "GND" },
  },
})

viaFence("RF_GROUND_FENCE", {
  along: ["RF_IN_AC", "RF_OUT_DC"],
  net: "GND",
  pitchMm: 1.5,
})

quality({ profile: "fast", maxCandidates: 1 })
runAll()
