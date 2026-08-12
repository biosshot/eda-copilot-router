// Power-only copper intent for the fixed Powerbank placement.
// Long inter-block links remain for the autorouter; every polygon here is local.

polygon("BAT_POS")
  .connect(pad("U1", 28), pad("C9", 1))
  .on(topLayer())
  .compact()
  .priority(25)

polygon("Net-(C2-Pad2)")
  .connect(net("Net-(C2-Pad2)"))
  .on(topLayer())
  .compact()
  .priority(30)

polygon("VSYS_CONV")
  .connect(pad("U1", 8), pad("U1", 9))
  .on(topLayer())
  .compact()
  .priority(20)

polygon("VSYS_CONV")
  .connect(pad("U1", 22), pad("U1", 23), pad("U1", 24))
  .on(topLayer())
  .compact()
  .priority(20)

polygon("VSYS_CONV")
  .connect(pad("U1", 24), pad("R1", 1))
  .on(topLayer())
  .compact()
  .priority(20)

polygon("VSYS_CONV")
  .connect(pad("C11", 1), pad("C8", 1), pad("C7", 1))
  .on(topLayer())
  .compact()
  .priority(20)

polygon("VSYS_CONV")
  .connect(pad("C6", 1), pad("C5", 1), pad("C3", 1))
  .on(topLayer())
  .compact()
  .priority(20)

polygon("VSYS_PORT")
  .connect(pad("Q1", 1), pad("Q1", 2), pad("Q1", 3))
  .on(topLayer())
  .compact()
  .priority(18)

polygon("VSYS_PORT")
  .connect(pad("Q1", 1), pad("Q2", 7))
  .on(topLayer())
  .compact()
  .priority(18)

polygon("VSYS_PORT")
  .connect(pad("Q2", 5), pad("Q2", 6), pad("Q2", 7), pad("Q2", 8), pad("Q2", 9))
  .on(topLayer())
  .compact()
  .priority(18)

polygon("VSYS_PORT")
  .connect(pad("R9", 1), pad("Q3", 1), pad("Q3", 2), pad("Q3", 3))
  .on(topLayer())
  .compact()
  .priority(18)

polygon("USB_VBUS")
  .connect(pad("Q1", 5), pad("Q1", 6), pad("Q1", 7), pad("Q1", 8))
  .on(topLayer())
  .compact()
  .priority(16)

polygon("USB_VBUS")
  .connect(pad("C10", 1), pad("Q1", 5))
  .on(topLayer())
  .compact()
  .priority(16)

polygon("USB_A1_VBUS")
  .connect(pad("Q2", 1), pad("Q2", 2), pad("Q2", 3))
  .on(topLayer())
  .compact()
  .priority(15)

polygon("USB_A1_VBUS")
  .connect(pad("C12", 1), pad("Q2", 3))
  .on(topLayer())
  .compact()
  .priority(15)

polygon("USB_A1_VBUS")
  .connect(pad("C12", 1), pad("J3", 1))
  .on(topLayer())
  .compact()
  .priority(15)

polygon("USB_A2_VBUS")
  .connect(pad("Q3", 5), pad("Q3", 6), pad("Q3", 7), pad("Q3", 8))
  .on(topLayer())
  .compact()
  .priority(15)

polygon("USB_A2_VBUS")
  .connect(pad("C13", 1), pad("Q3", 5))
  .on(topLayer())
  .compact()
  .priority(15)

polygon("USB_A2_VBUS")
  .connect(pad("Q3", 8), pad("J4", 1))
  .on(topLayer())
  .compact()
  .priority(15)

// Late plane intent: materialized only after special and remaining routing.
plane({
  net: "GND",
  layers: outerLayers(),
  region: board(),
  priority: 1,
  stitching: {
    gridMm: 5,
    maxPadViaDistanceMm: 10,
    via: "drc-min",
    viaInPad: true,
    maxVias: 500,
  },
})
