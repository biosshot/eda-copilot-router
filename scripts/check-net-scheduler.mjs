import assert from "node:assert/strict"
import { scheduleNets } from "../dist/net-scheduler.js"

const rules = {
  minimumClearance: 0.2,
  minimumTrackWidth: 0.2,
  minimumViaDiameter: 0.6,
  minimumViaDrill: 0.3,
  minimumViaAnnularWidth: 0.1,
  copperEdgeClearance: 0.5,
  classes: [{
    name: "Default",
    clearance: 0.2,
    trackWidth: 0.2,
    viaDiameter: 0.6,
    viaDrill: 0.3,
    diffPairWidth: 0.2,
    diffPairGap: 0.2,
  }],
  assignments: {},
  patterns: [],
}

function component(designator, x, y, padCount, pitch = 0.4) {
  const pads = Array.from({ length: padCount }, (_, index) => ({
    id: `${designator}.${index + 1}`,
    component: designator,
    x: x + (index % Math.ceil(Math.sqrt(padCount))) * pitch,
    y: y + Math.floor(index / Math.ceil(Math.sqrt(padCount))) * pitch,
    net: `NC_${designator}_${index + 1}`,
    padNumber: String(index + 1),
    layer: "TOP",
    shape: ["RECT", 0.24, 0.24],
    rotation: 0,
  }))
  const xs = pads.map((pad) => pad.x)
  const ys = pads.map((pad) => pad.y)
  return {
    item: {
      designator,
      x,
      y,
      rotate: 0,
      layer: "TOP",
      bbox: {
        left: Math.min(...xs) - 0.2,
        right: Math.max(...xs) + 0.2,
        top: Math.min(...ys) - 0.2,
        bottom: Math.max(...ys) + 0.2,
      },
    },
    pads,
  }
}

function fixture(scale = 1, reverse = false) {
  const dense = component("U1", 10, 10, 25)
  const external = component("Q1", 23, 12, 4, 0.7)
  dense.pads[0].net = "DENSE_ESCAPE"
  external.pads[0].net = "DENSE_ESCAPE"
  external.pads[1].net = "PASSIVE_BLOCKED"
  const passive = component("R1", 26, 12, 2, 1.2)
  passive.pads[0].net = "PASSIVE_BLOCKED"
  const long = component("J1", 55, 30, 2, 1.2)
  long.pads[0].net = "LONG_LOW_DENSITY"
  passive.pads[1].net = "LONG_LOW_DENSITY"

  // Surround U1.1 on seven sides.  The scheduler should recognize the dense
  // package escape, while a blocked pad on Q1 must not masquerade as the main IC.
  const blockers = Array.from({ length: 7 }, (_, index) => {
    const angle = Math.PI * index / 4
    return {
      id: `B${index}`,
      component: `B${index}`,
      x: 10 + Math.cos(angle) * 0.62,
      y: 10 + Math.sin(angle) * 0.62,
      net: `BLOCK_${index}`,
      padNumber: "1",
      layer: "TOP",
      shape: ["RECT", 0.24, 0.24],
      rotation: 0,
    }
  })
  const transform = (value) => typeof value === "number" ? value * scale : value
  const pads = [...dense.pads, ...external.pads, ...passive.pads, ...long.pads, ...blockers]
    .map((pad) => ({
      ...pad,
      x: transform(pad.x),
      y: transform(pad.y),
      shape: pad.shape.map(transform),
    }))
  const components = [dense.item, external.item, passive.item, long.item].map((item) => ({
    ...item,
    x: transform(item.x),
    y: transform(item.y),
    bbox: Object.fromEntries(Object.entries(item.bbox).map(([key, value]) => [key, transform(value)])),
  }))
  return {
    board: { polygon: [{ x: 0, y: 0 }, { x: 70 * scale, y: 0 }, { x: 70 * scale, y: 45 * scale }, { x: 0, y: 45 * scale }] },
    components: reverse ? components.reverse() : components,
    pads: reverse ? pads.reverse() : pads,
    tracks: [], arcs: [], vias: [], polygons: [],
  }
}

const nets = ["DENSE_ESCAPE", "PASSIVE_BLOCKED", "LONG_LOW_DENSITY"]
const base = scheduleNets(fixture(), rules, { nets, layers: ["TOP"] })
const shuffled = scheduleNets(fixture(1, true), rules, { nets: [...nets].reverse(), layers: ["TOP"] })

assert.equal(base.items.find((item) => item.net === "DENSE_ESCAPE")?.densePadCount, 1)
assert.equal(base.items.find((item) => item.net === "PASSIVE_BLOCKED")?.densePadCount, 0)
assert.equal(base.orderedNets[0], "DENSE_ESCAPE")
assert.deepEqual(shuffled.orderedNets, base.orderedNets, "input order must not change a schedule")
assert.ok(base.items.every((item) => item.padEscapes.every((pad) =>
  Number.isFinite(pad.componentComplexity) && Number.isFinite(pad.blockedRatio))))

console.log("net scheduler regression passed")
