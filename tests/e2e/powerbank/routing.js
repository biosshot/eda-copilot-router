stack({
  fallbackCopperThicknessOz: 1,
  viaPlatingThicknessUm: 20,
})

// High-current battery, converter, and USB power paths.
powerNet("BAT_POS", {
  maxCurrentA: 5,
  maxTempRiseC: 20,
  allowedLayers: "OUTER",
})
powerNet("VSYS_CONV", {
  maxCurrentA: 5,
  maxTempRiseC: 20,
  allowedLayers: "OUTER",
})
powerNet("VSYS_PORT", {
  maxCurrentA: 5,
  maxTempRiseC: 20,
  allowedLayers: "OUTER",
})
powerNet("USB_VBUS", {
  maxCurrentA: 3,
  maxTempRiseC: 20,
  allowedLayers: "OUTER",
  // U1.32 is a low-current tap. The compact polygon owns only the actual
  // connector, bulk-capacitor and MOSFET current path.
  powerPads: [
    pad("Q1", 5), pad("Q1", 6), pad("Q1", 7), pad("Q1", 8),
    pad("J1", "A4B9"), pad("J1", "B4A9"), pad("C10", 1),
  ],
})
powerNet("USB_A1_VBUS", {
  maxCurrentA: 3,
  maxTempRiseC: 20,
  allowedLayers: "OUTER",
  // U1.37 is routed as a narrow tap after the power polygon is filled.
  powerPads: [
    pad("J3", 1), pad("C12", 1),
    pad("Q2", 1), pad("Q2", 2), pad("Q2", 3),
  ],
})
powerNet("USB_A2_VBUS", {
  maxCurrentA: 3,
  maxTempRiseC: 20,
  allowedLayers: "OUTER",
  // U1.34 is routed as a narrow tap after the power polygon is filled.
  powerPads: [
    pad("J4", 1), pad("C13", 1),
    pad("Q3", 5), pad("Q3", 6), pad("Q3", 7), pad("Q3", 8),
  ],
})
powerNet("Net-(C2-Pad2)", {
  maxCurrentA: 5,
  maxTempRiseC: 20,
  allowedLayers: "ALL",
})

// Native DRC supplies width, gap, via, and skew defaults for special nets.
diffPair("USB_C_DATA", {
  positive: "USB_DP",
  negative: "USB_DM",
})
diffPair("USB_A1_DATA", {
  positive: "USB_A1_DP",
  negative: "USB_A1_DM",
})
diffPair("USB_A2_DATA", {
  positive: "USB_A2_DP",
  negative: "USB_A2_DM",
})

polygon("BAT_POS").connect(net("BAT_POS")).on("TOP").compact()
polygon("VSYS_CONV").connect(net("VSYS_CONV")).on("TOP").compact()
polygon("VSYS_PORT").connect(net("VSYS_PORT")).on("TOP").compact()
polygon("USB_VBUS").connect(net("USB_VBUS")).on("TOP").compact()
polygon("USB_A1_VBUS").connect(net("USB_A1_VBUS")).on("TOP").compact()
polygon("USB_A2_VBUS").connect(net("USB_A2_VBUS")).on("TOP").compact()
polygon("Net-(C2-Pad2)").connect(net("Net-(C2-Pad2)")).on("TOP").compact()

plane({
  net: "GND",
  layers: "OUTER",
  region: board(),
  stitching: {
    gridMm: 5,
    maxVisibleViaDistanceMm: 10,
    via: "drc-min",
    viaInPad: true,
  },
})

runAll()
