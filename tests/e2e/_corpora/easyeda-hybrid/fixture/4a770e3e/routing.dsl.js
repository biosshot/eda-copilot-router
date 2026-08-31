// Full routing from the user-corrected placement.  The GND plane is applied by
// pcb-copper-gnd.js first and is preserved during this transaction.
stack({
  boardThicknessMm: 1.6,
  fallbackCopperThicknessOz: 1,
  layers: [
    { kind: "copper", name: "TOP", thicknessOz: 1 },
    { kind: "copper", name: "BOTTOM", thicknessOz: 1 },
  ],
});

powerNet("USB_VBUS_RAW", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 1.95,
  priority: "critical", viaPreference: "avoid",
  powerPads: [pad("J1", "A4B9"), pad("J1", "B4A9"), pad("F1", "1")],
  tapWidthMm: 0.25,
});
powerNet("VIN_ADAPTER", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 1.95,
  priority: "critical", viaPreference: "avoid",
  powerPads: [
    pad("F1", "2"), pad("Q1", "5"), pad("Q1", "6"), pad("Q1", "7"), pad("Q1", "8"),
    pad("C7", "1"), pad("C8", "1"), pad("C9", "1"), pad("C20", "1"),
  ],
  tapWidthMm: 0.25,
});
powerNet("SW1", {
  maxCurrentA: 4.0, maxTempRiseC: 20, maxTrackWidthMm: 2.50,
  allowedLayers: "OUTER", priority: "critical", viaPreference: "auto",
  powerPads: [
    pad("Q1", "1"), pad("Q1", "2"), pad("Q1", "3"),
    pad("Q2", "5"), pad("Q2", "6"), pad("Q2", "7"), pad("Q2", "8"),
    pad("L2", "1"),
  ],
  tapWidthMm: 0.25,
});
powerNet("SW2", {
  maxCurrentA: 4.0, maxTempRiseC: 20, maxTrackWidthMm: 2.50,
  allowedLayers: "OUTER", priority: "critical", viaPreference: "auto",
  powerPads: [pad("L2", "2"), pad("U3", "21"), pad("U3", "25")],
  tapWidthMm: 0.25,
});
powerNet("VOUT_PRE", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 1.95,
  priority: "critical", viaPreference: "avoid",
  powerPads: [
    pad("U3", "11"), pad("U3", "12"), pad("U3", "26"), pad("R5", "1"),
    pad("C10", "1"), pad("C11", "1"), pad("C12", "1"), pad("C13", "1"), pad("C14", "1"),
  ],
  tapWidthMm: 0.20,
});
powerNet("VOUT_SENSED", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 1.95,
  priority: "critical", viaPreference: "avoid",
  powerPads: [pad("R5", "2"), pad("Q3", "2")],
  tapWidthMm: 0.20,
});
powerNet("OUT_SW_SRC", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 1.95,
  priority: "critical", viaPreference: "avoid",
  powerPads: [pad("Q3", "3"), pad("Q4", "3")],
  tapWidthMm: 0.20,
});
powerNet("OUTPUT_POS", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 1.95,
  priority: "critical", viaPreference: "avoid",
  powerPads: [pad("Q4", "2"), pad("J4", "1")],
  tapWidthMm: 0.20,
});
powerNet("VDD_3V3", {
  maxCurrentA: 0.6, maxTempRiseC: 20, maxTrackWidthMm: 1.20,
  priority: "high", viaPreference: "avoid",
});
powerNet("AUX_SW", {
  maxCurrentA: 0.6, maxTempRiseC: 20, maxTrackWidthMm: 1.00,
  allowedLayers: "TOP", priority: "high", viaPreference: "forbid",
});

// Route the short converter support and gate nets before ordinary MCU traffic.
[
  "AUX_BST", "COMP_RC", "GATE_H", "GATE_L", "TPS_BOOT1",
  "TPS_BOOT2", "TPS_COMP", "TPS_DR1H", "TPS_DR1L", "TPS_FSW",
  "TPS_ILIM", "TPS_VCC", "TPS_CDC",
].forEach((n) => signalNet(n, {
  allowedLayers: "OUTER", priority: "critical", viaPreference: "auto",
  trackWidthMm: 0.20, minTrackWidthMm: 0.15,
}));

[
  "USB_DP_PORT", "USB_DM_PORT", "USB_DP", "USB_DM",
  "USB_CC1_PORT", "USB_CC2_PORT", "USB_CC1", "USB_CC2",
].forEach((n) => signalNet(n, {
  allowedLayers: "OUTER", priority: "high", viaPreference: "auto",
  trackWidthMm: 0.20, minTrackWidthMm: 0.15,
}));

[
  "I2C_SCL", "I2C_SDA", "SWCLK", "SWDIO", "MCU_NRST",
  "ADC_TEMP", "ADC_VIN", "ADC_VOUT", "INA_ALERT_N",
  "TPS_EN", "TPS_INT_N", "OUT_EN", "OUT_GATE", "OUT_GATE_DRIVE",
  "QC_PG_N", "CH224_VBUS_SENSE", "CH224_VDD", "CH224_CFG1", "AGND",
].forEach((n) => signalNet(n, {
  allowedLayers: "OUTER", priority: "high", viaPreference: "avoid",
  trackWidthMm: 0.20, minTrackWidthMm: 0.15,
}));

// The previous routing attempt proved that these U3 pads require explicit
// escape help.  Fanout is restricted to the exact unresolved pads.
[
  "1", "2", "8", "16", "17", "18", "19", "20", "21", "22", "23", "25",
].forEach((p) => fanout(pad("U3", p), { method: "auto", extensionMm: 0.10 }));

ignoreNets(
  "NC_CFG2", "NC_CFG3", "NC_PA11", "NC_PA12", "NC_PA15",
  "NC_PB3", "NC_PB4", "NC_PB5", "NC_PB8", "NC_PB9",
  "NC_PC14", "NC_PC15", "NC_PC6", "NC_SBU1", "NC_SBU2"
);

busDetect(true);
runAll();
