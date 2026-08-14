// Geometry follows the explicit values used by the upstream ESP programmer test.
diffPair("USB_DATA", {
  positive: "/D_P",
  negative: "/D_N",
  trackWidthMm: 0.2,
  gapMm: 0.25,
})

runRouting()
