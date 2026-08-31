stack({
  boardThicknessMm: 1.6,
  fallbackCopperThicknessOz: 1,
  viaPlatingThicknessUm: 20,
  layers: [
    { kind: "copper", name: "TOP", thicknessOz: 1 },
    { kind: "dielectric", name: "FR4_CORE", thicknessMm: 1.49042, relativePermittivity: 4.2, lossTangent: 0.02, material: "FR-4" },
    { kind: "copper", name: "BOTTOM", thicknessOz: 1 },
  ],
  solderMask: {
    top: { thicknessMm: 0.02, relativePermittivity: 3.3 },
    bottom: { thicknessMm: 0.02, relativePermittivity: 3.3 },
  },
});

clearRouting({ nets: "all", items: ["tracks", "vias", "zones"] });

drc({
  trackWidthMm: 0.3,
  minTrackWidthMm: 0.127,
  clearanceMm: 0.15,
  edgeClearanceMm: 0.01,
  holeToHoleClearanceMm: 0.2,
  via: {
    diameterMm: 0.6,
    drillMm: 0.3,
    minDiameterMm: 0.5,
    minDrillMm: 0.3,
  },
});

netClass("RF_50R", {
  nets: ["RF_IN", "RF_IN_IC", "RF_OUT_IC", "RF_OUT"],
  minTrackWidthMm: 0.127,
  clearanceMm: 0.2,
  edgeClearanceMm: 0.01,
  allowedLayers: "TOP",
});

signalNet("RF_IN", {
  netClass: "RF_50R",
  allowedLayers: "TOP",
  impedance: { targetOhm: 50, tolerancePercent: 10, referenceNet: "GND" },
});
signalNet("RF_IN_IC", {
  netClass: "RF_50R",
  allowedLayers: "TOP",
  impedance: { targetOhm: 50, tolerancePercent: 10, referenceNet: "GND" },
});
signalNet("RF_OUT_IC", {
  netClass: "RF_50R",
  allowedLayers: "TOP",
  impedance: { targetOhm: 50, tolerancePercent: 10, referenceNet: "GND" },
});
signalNet("RF_OUT", {
  netClass: "RF_50R",
  allowedLayers: "TOP",
  impedance: { targetOhm: 50, tolerancePercent: 10, referenceNet: "GND" },
});

powerNet("VRAW_6V_12V", { maxCurrentA: 0.05, maxTempRiseC: 10, allowedLayers: "TOP" });
powerNet("VREG5", { maxCurrentA: 0.05, maxTempRiseC: 10, allowedLayers: "TOP" });
powerNet("VCC_RF", { maxCurrentA: 0.03, maxTempRiseC: 10, allowedLayers: "TOP" });
signalNet("LDO_BYP", { allowedLayers: "TOP" });

plane({
  net: "GND",
  layers: "ALL",
  region: board(),
  zone: {
    clearanceMm: 0.2,
    minThicknessMm: 0.15,
    fill: { style: "solid" },
    padConnection: { mode: "solid" },
    removeIslandsBelowMm2: 0.5,
  },
  stitching: {
    gridMm: 4.0,
    maxVisibleViaDistanceMm: 4.5,
    via: "drc-min",
    viaInPad: false,
  },
});

runAll();
