// Complete two-layer routing transaction for USB_LAB_POWER.
// Provisional ordinary prototype stack: 1.6 mm FR-4, 1 oz outer copper.
stack({
  boardThicknessMm: 1.6,
  fallbackCopperThicknessOz: 1,
  maxTrackWidthMm: 2.5,
  layers: [
    { kind: "copper", name: "TOP", thicknessOz: 1 },
    { kind: "copper", name: "BOTTOM", thicknessOz: 1 },
  ],
});

drc({
  trackWidthMm: 0.25,
  minTrackWidthMm: 0.15,
  clearanceMm: 0.15,
  edgeClearanceMm: 0.30,
  holeToHoleClearanceMm: 0.25,
  via: {
    diameterMm: 0.60,
    drillMm: 0.30,
    minDiameterMm: 0.50,
    minDrillMm: 0.30,
  },
});

// Source and converter power paths.  Current sense and output-monitor taps are
// intentionally excluded from powerPads so they may neck down locally.
powerNet("USB_VBUS_RAW", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 2.5,
  priority: "critical", viaPreference: "avoid",
  powerPads: [pad("J1", "A4B9"), pad("J1", "B4A9"), pad("F1", "1")],
  tapWidthMm: "drc-min",
});
powerNet("VIN_ADAPTER", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 2.5,
  priority: "critical", viaPreference: "avoid",
  powerPads: [
    pad("F1", "2"), pad("Q1", "5"), pad("Q1", "6"), pad("Q1", "7"), pad("Q1", "8"),
    pad("U3", "3"), pad("C7", "1"), pad("C8", "1"), pad("C9", "1"), pad("C20", "1"),
  ],
  tapWidthMm: 0.25,
});
powerNet("SW1", {
  maxCurrentA: 5.0, maxTempRiseC: 20, maxTrackWidthMm: 2.5,
  allowedLayers: "TOP", priority: "critical", viaPreference: "forbid",
});
powerNet("SW2", {
  maxCurrentA: 5.0, maxTempRiseC: 20, maxTrackWidthMm: 2.5,
  allowedLayers: "TOP", priority: "critical", viaPreference: "forbid",
});
powerNet("VOUT_PRE", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 2.5,
  priority: "critical", viaPreference: "avoid",
  powerPads: [
    pad("U3", "11"), pad("U3", "12"), pad("U3", "26"), pad("R5", "1"),
    pad("C10", "1"), pad("C11", "1"), pad("C12", "1"), pad("C13", "1"), pad("C14", "1"),
  ],
  tapWidthMm: 0.20,
});
powerNet("VOUT_SENSED", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 2.5,
  priority: "critical", viaPreference: "avoid",
  powerPads: [pad("R5", "2"), pad("Q3", "2")],
  tapWidthMm: 0.20,
});
powerNet("OUT_SW_SRC", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 2.5,
  priority: "critical", viaPreference: "avoid",
  powerPads: [pad("Q3", "3"), pad("Q4", "3")],
  tapWidthMm: 0.20,
});
powerNet("OUTPUT_POS", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 2.5,
  priority: "critical", viaPreference: "avoid",
  powerPads: [pad("Q4", "2"), pad("J4", "1")],
  tapWidthMm: 0.20,
});
powerNet("GND", {
  maxCurrentA: 5.0, maxTempRiseC: 20, maxTrackWidthMm: 2.5,
  priority: "critical",
});
powerNet("VDD_3V3", {
  maxCurrentA: 0.6, maxTempRiseC: 20, maxTrackWidthMm: 1.2,
  priority: "high", viaPreference: "avoid",
});
powerNet("AUX_SW", {
  maxCurrentA: 0.6, maxTempRiseC: 20, maxTrackWidthMm: 1.0,
  allowedLayers: "TOP", priority: "high", viaPreference: "forbid",
});

// Fast/sensitive converter nodes stay short and on the component side.
[
  "AUX_BST", "GATE_H", "GATE_L", "TPS_BOOT1", "TPS_BOOT2",
  "TPS_DR1H", "TPS_DR1L", "TPS_COMP", "COMP_RC", "TPS_ILIM",
  "TPS_FSW", "TPS_VCC", "TPS_CDC",
].forEach((n) => signalNet(n, {
  allowedLayers: "TOP", priority: "critical", viaPreference: "forbid",
  trackWidthMm: 0.25, minTrackWidthMm: 0.15,
}));

// QC/USB signalling is not USB data traffic here, but the paired conductors
// are still routed together and without unnecessary layer changes.
[
  "USB_DP_PORT", "USB_DM_PORT", "USB_DP", "USB_DM",
  "USB_CC1_PORT", "USB_CC2_PORT", "USB_CC1", "USB_CC2",
].forEach((n) => signalNet(n, {
  priority: "high", viaPreference: "avoid", trackWidthMm: 0.20,
}));
matchedGroup("USB_PORT_PAIR", { nets: ["USB_DP_PORT", "USB_DM_PORT"], toleranceMm: 2.0 });
matchedGroup("USB_QC_PAIR", { nets: ["USB_DP", "USB_DM"], toleranceMm: 2.0 });

// MCU buses, programming, sensing and output control.
[
  "I2C_SCL", "I2C_SDA", "SWCLK", "SWDIO", "MCU_NRST",
  "ADC_TEMP", "ADC_VIN", "ADC_VOUT", "INA_ALERT_N",
  "TPS_EN", "TPS_INT_N", "OUT_EN", "OUT_GATE", "OUT_GATE_DRIVE",
  "QC_PG_N", "CH224_VBUS_SENSE", "CH224_VDD", "CH224_CFG1", "AGND",
].forEach((n) => signalNet(n, {
  priority: "high", viaPreference: "avoid", trackWidthMm: 0.20,
}));

// Explicitly leave schematic no-connect nets unrouted.
ignoreNets(
  "NC_CFG2", "NC_CFG3", "NC_PA11", "NC_PA12", "NC_PA15",
  "NC_PB3", "NC_PB4", "NC_PB5", "NC_PB8", "NC_PB9",
  "NC_PC14", "NC_PC15", "NC_PC6", "NC_SBU1", "NC_SBU2"
);

busDetect(true);

// Continuous return copper on both sides with a moderate stitching grid.
plane({
  net: "GND",
  layers: "OUTER",
  region: board(),
  zone: {
    clearanceMm: 0.20,
    minThicknessMm: 0.25,
    fill: { style: "solid" },
    padConnection: {
      mode: "thermal", thermalGapMm: 0.25,
      spokeWidthMm: 0.50, spokeCount: 4, spokeAngleDeg: 45,
    },
    removeIslandsBelowMm2: 8,
  },
  stitching: {
    gridMm: 8,
    maxVisibleViaDistanceMm: 12,
    via: { diameterMm: 0.60, drillMm: 0.30 },
    viaInPad: false,
  },
});

// Restore the requested thermal-via fields under the two TO-252 drain tabs.
viaStitch("Q3_THERMAL", {
  mode: "grid", net: "VOUT_SENSED", region: components("Q3"),
  pitchMm: 1.25, viaInPad: true,
  via: { diameterMm: 0.60, drillMm: 0.30 },
});
viaStitch("Q4_THERMAL", {
  mode: "grid", net: "OUTPUT_POS", region: components("Q4"),
  pitchMm: 1.25, viaInPad: true,
  via: { diameterMm: 0.60, drillMm: 0.30 },
});

viaStitch("SENSITIVE_RETURNS", {
  mode: "return", referenceNet: "GND",
  forNets: [
    "USB_DP_PORT", "USB_DM_PORT", "USB_DP", "USB_DM",
    "I2C_SCL", "I2C_SDA", "SWCLK", "SWDIO",
    "ADC_TEMP", "ADC_VIN", "ADC_VOUT",
  ],
  maxDistanceMm: 4,
  via: { diameterMm: 0.60, drillMm: 0.30 },
});

runAll();
