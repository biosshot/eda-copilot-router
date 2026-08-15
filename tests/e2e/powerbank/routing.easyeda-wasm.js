stack({
  fallbackCopperThicknessOz: 1,
  viaPlatingThicknessUm: 20,
})

// EasyEDA WASM routes a single via geometry but cannot guarantee parallel-via
// bundles. Keep the calculated PowerBank widths while making that limitation
// explicit in this backend comparison instead of claiming a false capability.
netClass("POWER_5A_EASYEDA", {
  nets: ["BAT_POS", "VSYS_CONV", "VSYS_PORT"],
  minTrackWidthMm: 0.127,
  preferredTrackWidthMm: 1.85,
  via: { diameterMm: 0.6, drillMm: 0.3 },
  allowedLayers: "OUTER",
})
netClass("SWITCH_5A_EASYEDA", {
  nets: ["Net-(C2-Pad2)"],
  minTrackWidthMm: 0.127,
  preferredTrackWidthMm: 1.85,
  via: { diameterMm: 0.6, drillMm: 0.3 },
  allowedLayers: "ALL",
})
netClass("USB_POWER_EASYEDA", {
  nets: ["USB_VBUS", "USB_A1_VBUS", "USB_A2_VBUS"],
  minTrackWidthMm: 0.127,
  preferredTrackWidthMm: 0.95,
  via: { diameterMm: 0.6, drillMm: 0.3 },
  allowedLayers: "OUTER",
})

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
