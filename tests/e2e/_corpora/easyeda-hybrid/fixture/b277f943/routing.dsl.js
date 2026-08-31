const powerNets = [
  "USB_VBUS_RAW", "VIN_ADAPTER", "SW1", "SW2",
  "VOUT_PRE", "VOUT_SENSED", "OUT_SW_SRC", "OUTPUT_POS",
];

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
    pad("Q2", "5"), pad("Q2", "6"), pad("Q2", "7"), pad("Q2", "8"), pad("L2", "1"),
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
  powerPads: [pad("R5", "2"), pad("Q3", "2")], tapWidthMm: 0.20,
});
powerNet("OUT_SW_SRC", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 1.95,
  priority: "critical", viaPreference: "avoid",
  powerPads: [pad("Q3", "3"), pad("Q4", "3")], tapWidthMm: 0.20,
});
powerNet("OUTPUT_POS", {
  maxCurrentA: 3.0, maxTempRiseC: 20, maxTrackWidthMm: 1.95,
  priority: "critical", viaPreference: "avoid",
  powerPads: [pad("Q4", "2"), pad("J4", "1")], tapWidthMm: 0.20,
});

onlyNets(...powerNets);
runRouting();
