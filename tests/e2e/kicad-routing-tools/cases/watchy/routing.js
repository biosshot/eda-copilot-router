diffPair("CLOCK_40M", { positive: "/40M_P", negative: "/40M_N" })
diffPair("CLOCK_32K", { positive: "/32K_P", negative: "/32K_N" })
diffPair("USB", {
  positive: "USB_D+",
  negative: "USB_D-",
  trackWidthMm: 0.1,
  gapMm: 0.15,
})

runRouting()
