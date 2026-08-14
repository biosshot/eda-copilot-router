stack({
  boardThicknessMm: 1.6,
  fallbackCopperThicknessOz: 1,
  layers: [
    { kind: "copper", name: "TOP", thicknessOz: 1 },
    { kind: "dielectric", name: "TOP_PREPREG", thicknessMm: 0.2, relativePermittivity: 4.2 },
    { kind: "copper", name: "INNER_1", thicknessOz: 1 },
    { kind: "dielectric", name: "CORE", thicknessMm: 1.1, relativePermittivity: 4.2 },
    { kind: "copper", name: "INNER_2", thicknessOz: 1 },
    { kind: "dielectric", name: "BOTTOM_PREPREG", thicknessMm: 0.2, relativePermittivity: 4.2 },
    { kind: "copper", name: "BOTTOM", thicknessOz: 1 },
  ],
})

plane({ net: "GND", layers: ["INNER_1", "INNER_2"], region: board(), stitching: false })

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
