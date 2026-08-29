import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const routerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const router = await import(pathToFileURL(resolve(routerDirectory, "package-dist/index.js")))

const rules = {
  clearanceMm: 0.2,
  edgeClearanceMm: 0.25,
  holeToHoleClearanceMm: 0.2,
  minTrackWidthMm: 0.127,
  preferredTrackWidthMm: 0.2,
  via: {
    minDiameterMm: 0.5,
    preferredDiameterMm: 0.6,
    minDrillMm: 0.25,
    preferredDrillMm: 0.3,
  },
}
const emptyCopper = { tracks: [], vias: [], zones: [] }
const components = [
  { designator: "J1", at: { x: 3, y: 5 }, rotationDeg: 0, side: "top" },
  { designator: "J2", at: { x: 17, y: 5 }, rotationDeg: 0, side: "top" },
]
const pad = (component, number, net, x, y) => ({
  component, number, net, at: { x, y }, rotationDeg: 0, layers: ["F.Cu"],
  shape: { kind: "circle", diameterMm: 1 },
})
const board = {
  outline: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
  cutouts: [],
  layers: [
    { name: "F.Cu", index: 0, side: "top" },
    { name: "B.Cu", index: 1, side: "bottom" },
  ],
  nets: [{ name: "GND" }, { name: "+3V3" }, { name: "+1V8" }],
  components,
  pads: [
    pad("J1", "1", "GND", 3, 2), pad("J2", "1", "GND", 17, 8),
    pad("J1", "2", "+3V3", 3, 5), pad("J2", "2", "+3V3", 17, 5),
    pad("J1", "3", "+1V8", 3, 8), pad("J2", "3", "+1V8", 17, 2),
  ],
  keepouts: [],
  rules: { default: rules, nets: [] },
  copper: { fixed: emptyCopper, editable: emptyCopper },
}

const artifacts = await mkdtemp(join(tmpdir(), "copilot-router-krt-planes-"))
try {
  const result = await router.run({
    board,
    backend: router.createKrtBackend({ artifactsDirectory: artifacts, keepArtifacts: true }),
    dsl: `
      stack({
        boardThicknessMm: 1.6,
        layers: [
          { kind: "copper", name: "TOP", thicknessOz: 1 },
          { kind: "dielectric", thicknessMm: 0.2, relativePermittivity: 4.2 },
          { kind: "copper", name: "INNER_1", plane: { nets: ["GND"] } },
          { kind: "dielectric", thicknessMm: 1.0, relativePermittivity: 4.2 },
          { kind: "copper", name: "INNER_2", plane: { nets: ["+3V3", "+1V8"] } },
          { kind: "dielectric", thicknessMm: 0.2, relativePermittivity: 4.2 },
          { kind: "copper", name: "BOTTOM", thicknessOz: 1 }
        ]
      })
      powerNet("+3V3")
      powerNet("+1V8")
      runRouting()
    `,
  })

  assert.notEqual(result.status, "error", JSON.stringify(result.diagnostics))
  const ownership = new Set(result.copper.zones.flatMap((zone) => (
    zone.net ? zone.layers.map((layer) => `${layer}:${zone.net}`) : []
  )))
  assert.ok(ownership.has("INNER_1:GND"), JSON.stringify(result.diagnostics))
  assert.ok(ownership.has("INNER_2:+3V3"), JSON.stringify(result.diagnostics))
  assert.ok(ownership.has("INNER_2:+1V8"), JSON.stringify(result.diagnostics))
  assert.ok(result.copper.zones.every((zone) => !(zone.outline.holes?.length)),
    "native split-plane islands must remain separate RoutedZone polygons, not synthetic holes")
  const planeOwners = new Map([
    ["INNER_1", new Set(["GND"])],
    ["INNER_2", new Set(["+3V3", "+1V8"])],
  ])
  assert.ok(result.copper.tracks.every((track) => (
    !planeOwners.has(track.layer) || planeOwners.get(track.layer).has(track.net)
  )), "dedicated plane layers may contain KRT plane geometry, but never another net's tracks")
  assert.ok(result.metrics?.details?.planes?.plane_zones?.length >= 2)

  const paths = await readdir(artifacts, { recursive: true })
  const invocationPath = paths.find((path) => {
    const normalized = path.replaceAll("\\", "/")
    return normalized.includes("/plane-finalize/")
      && normalized.endsWith("/krt-remaining-invocation.json")
  })
  assert.ok(invocationPath, "stack planes must retain an auditable native finalizer invocation")
  const invocation = JSON.parse(await readFile(join(artifacts, invocationPath), "utf8"))
  const layerIndex = invocation.toolArgs.indexOf("--layers")
  assert.ok(layerIndex >= 0)
  const layerEnd = invocation.toolArgs.findIndex(
    (value, index) => index > layerIndex && value.startsWith("--"),
  )
  assert.ok(layerEnd > layerIndex)
  const finalizerLayers = invocation.toolArgs.slice(layerIndex + 1, layerEnd)
  assert.deepEqual(finalizerLayers, ["F.Cu", "B.Cu"],
    "native plane finalizer must see dedicated planes as forbidden full-stack layers")
  const powerIndex = invocation.toolArgs.indexOf("--power-nets")
  const powerWidthIndex = invocation.toolArgs.indexOf("--power-nets-widths")
  assert.ok(powerIndex >= 0 && powerWidthIndex > powerIndex,
    "stack power ownership must reach the native finalizer")
  assert.equal(invocation.toolArgs.slice(powerIndex + 1, powerWidthIndex).length, 2,
    "GND plane ownership must not leak into Stack power cleanup scope")

  console.log(`managed KRT plane E2E: ok (${result.copper.zones.length} zones)`)
} finally {
  await rm(artifacts, { recursive: true, force: true })
}
