stack({
  boardThicknessMm: 1.6,
  fallbackCopperThicknessOz: 1,
  layers: [
    { kind: "copper", name: "TOP" },
    { kind: "copper", name: "BOTTOM" },
  ],
});

drc({
  trackWidthMm: 0.127,
  minTrackWidthMm: 0.1,
  clearanceMm: 0.127,
  edgeClearanceMm: 0.127,
  via: {
    diameterMm: 0.5,
    drillMm: 0.3,
    minDiameterMm: 0.5,
    minDrillMm: 0.3,
  },
});

powerNet("VBUS", { priority: "high" });
powerNet("+3V3", { priority: "high" });
powerNet("+1V8", { priority: "high" });
powerNet("+1V1", { priority: "high" });
powerNet("VREG_AVDD", { priority: "high", viaPreference: "avoid" });
powerNet("ADC_AVDD", { priority: "high", viaPreference: "avoid" });
powerNet("VREG_LX", { priority: "critical", viaPreference: "avoid" });

signalNet("XIN", { priority: "critical", viaPreference: "avoid" });
signalNet("XOUT", { priority: "critical", viaPreference: "avoid" });
signalNet("QSPI_SCLK", { priority: "critical", viaPreference: "avoid" });
signalNet("QSPI_SS", { priority: "high", viaPreference: "avoid" });
signalNet("QSPI_SD0", { priority: "high", viaPreference: "avoid" });
signalNet("QSPI_SD1", { priority: "high", viaPreference: "avoid" });
signalNet("QSPI_SD2", { priority: "high", viaPreference: "avoid" });
signalNet("QSPI_SD3", { priority: "high", viaPreference: "avoid" });
signalNet("USB_DP", { priority: "critical", viaPreference: "avoid" });
signalNet("USB_DM", { priority: "critical", viaPreference: "avoid" });
diffPair('DP1', {
  positive: '$1N10164',
  negative: '$1N10163'
});

matchedGroup("spi", {
  nets: ["QSPI_SD1", "QSPI_SD2", "QSPI_SD0", "QSPI_SCLK", "QSPI_SD3"],
  toleranceMm: 8,
});

matchedGroup("header", {
  nets: [
    "GPIO29_ADC3", "GPIO28_ADC2", "GPIO27_ADC1", "GPIO26_ADC0",
    "GPIO25", "GPIO24", "GPIO23", "GPIO22", "GPIO21", "GPIO20",
    "GPIO19", "GPIO18", "GPIO17", "GPIO16"
  ],
  toleranceMm: 8,
});

// plane({
//   net: "GND",
//   layers: "BOTTOM",
//   zone: {
//     clearanceMm: 0.127,
//     minThicknessMm: 0.127,
//     padConnection: { mode: "thermal" },
//     removeIslandsBelowMm2: 1,
//   },
// });

// busDetect(true);
runAll();
