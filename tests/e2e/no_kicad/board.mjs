const values = Object.freeze({
  clearanceMm: 0.2,
  edgeClearanceMm: 0.2,
  minTrackWidthMm: 0.127,
  preferredTrackWidthMm: 0.25,
  via: {
    minDiameterMm: 0.6,
    preferredDiameterMm: 0.6,
    minDrillMm: 0.3,
    preferredDrillMm: 0.3,
  },
  differential: { trackWidthMm: 0.25, gapMm: 0.2 },
})

// These names deliberately do not use a KRT-recognized polarity suffix.
// They prove that the router DSL's explicit positive/negative mapping reaches
// the managed KRT process instead of being re-inferred from net names.
const nets = ["USB_DM_CONN", "USB_DP_CONN", "USB_DM_ESD", "USB_DP_ESD"]

export const board = Object.freeze({
  outline: [
    { x: 5, y: 5 }, { x: 31, y: 5 },
    { x: 31, y: 25 }, { x: 5, y: 25 },
  ],
  cutouts: [],
  layers: [
    { name: "F.Cu", index: 0, side: "top" },
    { name: "B.Cu", index: 1, side: "bottom" },
  ],
  nets: nets.map((name) => ({ name })),
  components: [
    { designator: "C1", at: { x: 18, y: 13 }, rotationDeg: 90, side: "top" },
    { designator: "C2", at: { x: 18, y: 17 }, rotationDeg: 90, side: "top" },
    { designator: "J2", at: { x: 26, y: 15 }, rotationDeg: 0, side: "top" },
    { designator: "J1", at: { x: 10, y: 15 }, rotationDeg: 0, side: "top" },
  ],
  pads: [
    {
      component: "C1", number: "1", net: "USB_DP_CONN", at: { x: 17.52, y: 13 }, rotationDeg: 0,
      layers: ["F.Cu"], shape: { kind: "round-rect", widthMm: 0.56, heightMm: 0.62, cornerRadiusMm: 0.14 },
    },
    {
      component: "C1", number: "2", net: "USB_DP_ESD", at: { x: 18.48, y: 13 }, rotationDeg: 0,
      layers: ["F.Cu"], shape: { kind: "round-rect", widthMm: 0.56, heightMm: 0.62, cornerRadiusMm: 0.14 },
    },
    {
      component: "C2", number: "1", net: "USB_DM_CONN", at: { x: 17.52, y: 17 }, rotationDeg: 0,
      layers: ["F.Cu"], shape: { kind: "round-rect", widthMm: 0.56, heightMm: 0.62, cornerRadiusMm: 0.14 },
    },
    {
      component: "C2", number: "2", net: "USB_DM_ESD", at: { x: 18.48, y: 17 }, rotationDeg: 0,
      layers: ["F.Cu"], shape: { kind: "round-rect", widthMm: 0.56, heightMm: 0.62, cornerRadiusMm: 0.14 },
    },
    {
      component: "J2", number: "1", net: "USB_DP_ESD", at: { x: 26, y: 15 }, rotationDeg: 0,
      layers: ["F.Cu", "B.Cu"], shape: { kind: "rect", widthMm: 1.7, heightMm: 1.7 },
      hole: { shape: "round", diameterMm: 1, plated: true },
    },
    {
      component: "J2", number: "2", net: "USB_DM_ESD", at: { x: 26, y: 17.54 }, rotationDeg: 0,
      layers: ["F.Cu", "B.Cu"], shape: { kind: "circle", diameterMm: 1.7 },
      hole: { shape: "round", diameterMm: 1, plated: true },
    },
    {
      component: "J1", number: "1", net: "USB_DP_CONN", at: { x: 10, y: 15 }, rotationDeg: 0,
      layers: ["F.Cu", "B.Cu"], shape: { kind: "rect", widthMm: 1.7, heightMm: 1.7 },
      hole: { shape: "round", diameterMm: 1, plated: true },
    },
    {
      component: "J1", number: "2", net: "USB_DM_CONN", at: { x: 10, y: 17.54 }, rotationDeg: 0,
      layers: ["F.Cu", "B.Cu"], shape: { kind: "circle", diameterMm: 1.7 },
      hole: { shape: "round", diameterMm: 1, plated: true },
    },
  ],
  keepouts: [],
  stackup: {
    fallbackCopperThicknessOz: 1,
    layers: [
      { kind: "copper", layer: "F.Cu", thicknessMm: 0.03479 },
      { kind: "copper", layer: "B.Cu", thicknessMm: 0.03479 },
    ],
  },
  rules: {
    default: values,
    nets: nets.map((net) => ({ net, values })),
  },
  copper: {
    fixed: { tracks: [], vias: [], zones: [] },
    editable: { tracks: [], vias: [], zones: [] },
  },
})

export const dsl = `
  diffPair("USB_CONNECTOR_PAIR", { positive: "USB_DP_CONN", negative: "USB_DM_CONN" })
  diffPair("USB_ESD_PAIR", { positive: "USB_DP_ESD", negative: "USB_DM_ESD" })
  runRouting()
`
