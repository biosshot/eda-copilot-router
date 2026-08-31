// ESP32-C3 development board — complete two-layer routing intent.

clearRouting({
  nets: "all",
  items: ["tracks", "vias", "zones"],
});

// Replace obsolete equal-length relations with real USB differential pairs.
deleteMatchedGroup("USB_CONNECTOR_MATCH");
deleteMatchedGroup("USB_ESD_MATCH");
deleteMatchedGroup("USB_MCU_MATCH");

stack({
  boardThicknessMm: 1.6,
  fallbackCopperThicknessOz: 1,
  layers: [
    { kind: "copper", name: "TOP", thicknessOz: 1 },
    { kind: "dielectric", name: "PREPREG_TOP", thicknessMm: 0.20, relativePermittivity: 4.2, material: "FR-4" },
    { kind: "copper", name: "INNER_1", thicknessOz: 1 },
    { kind: "dielectric", name: "CORE", thicknessMm: 1.06084, relativePermittivity: 4.2, material: "FR-4" },
    { kind: "copper", name: "INNER_2", thicknessOz: 1 },
    { kind: "dielectric", name: "PREPREG_BOTTOM", thicknessMm: 0.20, relativePermittivity: 4.2, material: "FR-4" },
    { kind: "copper", name: "BOTTOM", thicknessOz: 1 },
  ],
});

drc({
  trackWidthMm: 0.20,
  minTrackWidthMm: 0.15,
  clearanceMm: 0.15,
  edgeClearanceMm: 0.25,
  holeToHoleClearanceMm: 0.30,
  allowedLayers: "ALL",
  via: {
    diameterMm: 0.60,
    drillMm: 0.30,
    minDiameterMm: 0.50,
    minDrillMm: 0.30,
  },
});

netClass("USB_FS", {
  nets: [
    "USB_DP_CONN",
    "USB_DM_CONN",
    "USB_DP_ESD",
    "USB_DM_ESD",
    "USB_DP",
    "USB_DM",
  ],
  trackWidthMm: 0.20,
  minTrackWidthMm: 0.15,
  clearanceMm: 0.15,
  allowedLayers: "OUTER",
  via: {
    diameterMm: 0.60,
    drillMm: 0.30,
    minDiameterMm: 0.50,
    minDrillMm: 0.30,
  },
});

diffPair("USB_CONNECTOR_PAIR", {
  positive: "USB_DP_CONN",
  negative: "USB_DM_CONN",
  gapMm: 0.20,
  maxSkewMm: 0.50,
  maxUncoupledLengthMm: 1.50,
  trackWidthMm: 0.20,
  minTrackWidthMm: 0.15,
  clearanceMm: 0.15,
  allowedLayers: "OUTER",
});

diffPair("USB_ESD_PAIR", {
  positive: "USB_DP_ESD",
  negative: "USB_DM_ESD",
  gapMm: 0.20,
  maxSkewMm: 0.50,
  maxUncoupledLengthMm: 1.50,
  trackWidthMm: 0.20,
  minTrackWidthMm: 0.15,
  clearanceMm: 0.15,
  allowedLayers: "OUTER",
});

diffPair("USB_MCU_PAIR", {
  positive: "USB_DP",
  negative: "USB_DM",
  gapMm: 0.20,
  maxSkewMm: 0.50,
  maxUncoupledLengthMm: 1.50,
  trackWidthMm: 0.20,
  minTrackWidthMm: 0.15,
  clearanceMm: 0.15,
  allowedLayers: "OUTER",
});

powerNet("VBUS", {
  maxCurrentA: 0.50,
  maxTempRiseC: 20,
  maxTrackWidthMm: 0.60,
  tapWidthMm: 0.20,
  allowedLayers: "ALL",
});

powerNet("+3V3", {
  maxCurrentA: 0.50,
  maxTempRiseC: 20,
  maxTrackWidthMm: 0.60,
  tapWidthMm: 0.20,
  allowedLayers: "ALL",
});

const groundZone = {
  clearanceMm: 0.20,
  minThicknessMm: 0.20,
  padConnection: {
    mode: "thermal",
    thermalGapMm: 0.20,
    spokeWidthMm: 0.25,
    spokeCount: 4,
  },
  removeIslandsBelowMm2: 2,
};

plane({ net: "GND", layers: "TOP", region: board(), zone: groundZone, stitching: false });
plane({ net: "GND", layers: "INNER_1", region: board(), zone: groundZone, stitching: false });
plane({ net: "+3V3", layers: "INNER_2", region: board(), zone: groundZone, stitching: false });
plane({ net: "GND", layers: "BOTTOM", region: board(), zone: groundZone, stitching: false });

viaStitch("GND_GRID", {
  mode: "grid",
  net: "GND",
  region: board(),
  pitchMm: 5,
  via: "drc-min",
  viaInPad: false,
});

fanout(component("USB1"), { method: "auto" });

busDetect(true);
quality({ profile: "balanced" });
runAll();
