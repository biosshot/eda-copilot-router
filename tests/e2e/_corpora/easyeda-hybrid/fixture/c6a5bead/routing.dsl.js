// ESPower: complete two-layer routing transaction.
// The physical dielectric geometry is not present in EasyEDA, so this uses
// a provisional ordinary 1.6 mm FR-4 / 1 oz copper declaration and does not
// claim controlled impedance.

stack({
  boardThicknessMm: 1.6,
  fallbackCopperThicknessOz: 1,
  maxTrackWidthMm: 4,
  layers: [
    { kind: "copper", name: "TOP", thicknessOz: 1 },
    {
      kind: "dielectric",
      name: "FR4 core",
      thicknessMm: 1.53042,
      relativePermittivity: 4.2,
      lossTangent: 0.02,
      material: "FR-4",
    },
    { kind: "copper", name: "BOTTOM", thicknessOz: 1 },
  ],
});

// // RF copper is routed in a separate TOP-only transaction and is preserved.
// clearRouting({
//   nets: [
//     "GND", "3V3", "VBUS", "VBAT", "VBAT_SW", "VDC", "VIN+", "VIN-",
//     "D+", "D-", "USBD_P", "USBD_N", "XTAL_P", "XTAL_N", "EN",
//     "GPIO1", "GPIO2", "GPIO3", "GPIO7", "GPIO8", "GPIO9", "BAT_ADC",
//     "$1N11294", "$1N5047", "$1N4824", "$1N5094", "$1N11149",
//     "$1N11113", "$1N4899", "$1N4820"
//   ],
//   items: ["tracks", "vias", "zones"],
// });

drc({
  trackWidthMm: 0.15,
  minTrackWidthMm: 0.127,
  clearanceMm: 0.152,
  edgeClearanceMm: 0.3,
  holeToHoleClearanceMm: 0.175,
  via: {
    diameterMm: 0.5,
    drillMm: 0.3,
    minDiameterMm: 0.5,
    minDrillMm: 0.3,
  },
});

// netClass("SIGNAL", {
//   nets: [
//     "ANTENNA", "$1N742", "$1N11294", "XTAL_N", "XTAL_P", "EN",
//     "GPIO1", "GPIO2", "GPIO3", "GPIO7", "GPIO8", "GPIO9",
//     "$1N5047", "$1N4824", "$1N5094", "$1N11149", "$1N11113",
//     "$1N4899", "$1N4820", "BAT_ADC",
//   ],
//   trackWidthMm: 0.15,
//   minTrackWidthMm: 0.15,
//   clearanceMm: 0.152,
//   via: { diameterMm: 0.5, drillMm: 0.3 },
// });

netClass("POWER", {
  nets: ["VBUS", "VBAT", "VBAT_SW", "VDC", "3V3"],
  trackWidthMm: 0.3,
  minTrackWidthMm: 0.15,
  clearanceMm: 0.152,
  via: { diameterMm: 0.5, drillMm: 0.3 },
});

// // Current shunt: U8<->R21 pads are the power trunk. U13 pins 8/7 are taps,
// // so the router keeps their branches narrow and independent of trunk sizing.
powerNet("VIN+", {
  maxCurrentA: 2,
  maxTempRiseC: 10,
  maxTrackWidthMm: 1.5,
  minTrackWidthMm: 0.15,
  clearanceMm: 0.152,
  powerPads: [pad("U8", 2), pad("R21", 2)],
  tapWidthMm: "drc-min",
  via: { diameterMm: 0.6, drillMm: 0.3 },
});

powerNet("VIN-", {
  maxCurrentA: 2,
  maxTempRiseC: 10,
  maxTrackWidthMm: 1.5,
  minTrackWidthMm: 0.15,
  clearanceMm: 0.152,
  powerPads: [pad("U8", 1), pad("R21", 1)],
  tapWidthMm: "drc-min",
  via: { diameterMm: 0.6, drillMm: 0.3 },
});

powerNet("VBUS", { trackWidthMm: 0.3, minTrackWidthMm: 0.15 });
powerNet("VBAT", { trackWidthMm: 0.3, minTrackWidthMm: 0.15 });
powerNet("VBAT_SW", { trackWidthMm: 0.3, minTrackWidthMm: 0.15 });
powerNet("VDC", { trackWidthMm: 0.3, minTrackWidthMm: 0.15 });
powerNet("3V3", { trackWidthMm: 0.3, minTrackWidthMm: 0.15 });

// // The connector-side pair terminates in duplicated USB-C A/B pads. Routing it
// // as two short matched signals avoids an invalid three-terminal pair topology.
// deleteDiffPair("DP1");
// signalNet("D+", { trackWidthMm: 0.15, minTrackWidthMm: 0.15 });
// signalNet("D-", { trackWidthMm: 0.15, minTrackWidthMm: 0.15 });

// diffPair("DP2", {
//   positive: "USBD_P",
//   negative: "USBD_N",
//   // trackWidthMm: 0.15,
//   // minTrackWidthMm: 0.15,
//   gapMm: 0.2,
//   // maxSkewMm: 3,
//   // maxUncoupledLengthMm: 3,
// });

// diffPair("DP1", {
//   positive: "D+",
//   negative: "D-",
//   // trackWidthMm: 0.15,
//   // minTrackWidthMm: 0.15,
//   gapMm: 0.2,
//   // maxSkewMm: 3,
//   // maxUncoupledLengthMm: 3,
// });

// onlyNets("D+", "D-", "USBD_P", "USBD_N");


// signalNet("XTAL_P", { trackWidthMm: 0.15 });
// signalNet("XTAL_N", { trackWidthMm: 0.15 });

disableFanout(component("U1"), component("U12"));
// busDetect(true);
// ignoreNets("ANTENNA", "$1N742");
// quality({ profile: "completion-first", maxCandidates: 16 });

runAll();
