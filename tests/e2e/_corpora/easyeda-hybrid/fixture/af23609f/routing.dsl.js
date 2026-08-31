stack({
  boardThicknessMm: 1.6,
  fallbackCopperThicknessOz: 1,
  layers: [
    { kind: "copper", name: "TOP", thicknessOz: 1 },
    { kind: "copper", name: "BOTTOM", thicknessOz: 1 },
  ],
});

drc({
  trackWidthMm: 0.2,
  minTrackWidthMm: 0.15,
  clearanceMm: 0.15,
  edgeClearanceMm: 0.25,
  holeToHoleClearanceMm: 0.25,
  allowedLayers: "OUTER",
  via: {
    diameterMm: 0.6,
    drillMm: 0.3,
    minDiameterMm: 0.5,
    minDrillMm: 0.3,
  },
});

netClass("USB_FS", {
  nets: [
    "USB_DP_CONN", "USB_DM_CONN",
    "USB_DP_ESD", "USB_DM_ESD",
    "USB_DP", "USB_DM",
  ],
  trackWidthMm: 0.2,
  minTrackWidthMm: 0.15,
  clearanceMm: 0.15,
  allowedLayers: "OUTER",
});

disableFanout(component("USB1"));

matchedGroup("USB_CONNECTOR_MATCH", {
  nets: ["USB_DP_CONN", "USB_DM_CONN"],
  toleranceMm: 0.5,
});

matchedGroup("USB_ESD_MATCH", {
  nets: ["USB_DP_ESD", "USB_DM_ESD"],
  toleranceMm: 0.5,
});

matchedGroup("USB_MCU_MATCH", {
  nets: ["USB_DP", "USB_DM"],
  toleranceMm: 0.5,
});

powerNet("VBUS", {
  maxCurrentA: 0.6,
  maxTempRiseC: 10,
  maxTrackWidthMm: 1.0,
  allowedLayers: "OUTER",
});

powerNet("+3V3", {
  maxCurrentA: 0.6,
  maxTempRiseC: 10,
  maxTrackWidthMm: 1.0,
  allowedLayers: "OUTER",
});

plane({
  net: "GND",
  layers: "BOTTOM",
  region: board(),
  zone: {
    clearanceMm: 0.2,
    minThicknessMm: 0.2,
    padConnection: {
      mode: "thermal",
      thermalGapMm: 0.2,
      spokeWidthMm: 0.25,
      spokeCount: 4,
    },
    removeIslandsBelowMm2: 1,
  },
  stitching: {
    gridMm: 6,
    maxVisibleViaDistanceMm: 8,
    via: "drc-min",
    viaInPad: false,
  },
});

polygon("GND")
  .connect(net("GND"))
  .on("TOP")
  .compact({ maxPadFreeGapWidths: 3 })
  .zone({
    clearanceMm: 0.2,
    minThicknessMm: 0.2,
    padConnection: {
      mode: "thermal",
      thermalGapMm: 0.2,
      spokeWidthMm: 0.25,
      spokeCount: 4,
    },
    removeIslandsBelowMm2: 1,
  });

viaStitch("USB_RETURN", {
  mode: "return",
  referenceNet: "GND",
  forNets: [
    "USB_DP_CONN", "USB_DM_CONN",
    "USB_DP_ESD", "USB_DM_ESD",
    "USB_DP", "USB_DM",
  ],
  maxDistanceMm: 3,
  via: "drc-min",
});

runAll();
