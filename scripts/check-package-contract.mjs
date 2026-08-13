import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const distRoot = resolve(process.env.COPILOT_ROUTER_PACKAGE_DIST ?? join(root, "dist"))
const api = await import(pathToFileURL(join(distRoot, "index.js")).href)
const dsl = await import(pathToFileURL(join(distRoot, "intent", "index.js")).href)
const schema = await import(pathToFileURL(join(distRoot, "schema.js")).href)
await import(pathToFileURL(join(distRoot, "adapters", "contracts.js")).href)

assert.equal(typeof api.createPcbSnapshotV1, "function")
assert.equal(typeof api.routePcb, "function")
assert.equal(typeof api.validatePcbSnapshotV1, "function")
assert.equal(typeof api.captureLegacyRawPcbV1, "function")
assert.equal(typeof dsl.routing, "function")
assert.equal(typeof schema.ROUTING_INTENT_V2_JSON_SCHEMA, "object")

const intent = dsl.routing({
  copper: [
    dsl.polygon("vcc-local", "VCC")
      .connect(dsl.pad("U1", 1), dsl.pad("C1", 1))
      .on(dsl.topLayer()),
  ],
})
assert.deepEqual(JSON.parse(JSON.stringify(intent)), intent, "DSL output must be plain JSON data")

const ruleRange = { minMm: 0.1, preferredMm: 0.2, maxMm: 10 }
const ruleValues = {
  clearanceMm: 0.2,
  edgeClearanceMm: 0.25,
  trackWidth: ruleRange,
  via: {
    diameterMm: { minMm: 0.4, preferredMm: 0.6, maxMm: 2 },
    drillMm: { minMm: 0.2, preferredMm: 0.3, maxMm: 1 },
  },
}
const rawPcb = {
  schema: "raw-pcb",
  version: 1,
  coordinates: api.RAW_PCB_V1_COORDINATES,
  source: { eda: "test", adapter: "package-contract", documentId: "fixture" },
  board: {
    outline: [
      { x: 0, y: 0 }, { x: 20, y: 0 },
      { x: 20, y: 10 }, { x: 0, y: 10 },
    ],
    cutouts: [],
  },
  layers: [
    { id: "F.Cu", name: "F.Cu", index: 0, side: "top", role: "mixed" },
    { id: "B.Cu", name: "B.Cu", index: 1, side: "bottom", role: "mixed" },
  ],
  stackup: {
    copperThicknessOzFallback: 1,
    layers: [
      { kind: "copper", layerId: "F.Cu", thicknessMm: 0.035 },
      { kind: "dielectric", id: "core", thicknessMm: 1.53 },
      { kind: "copper", layerId: "B.Cu", thicknessMm: 0.035 },
    ],
  },
  nets: [{ id: "VCC", name: "VCC" }],
  components: [
    { id: "U1", designator: "U1", at: { x: 4, y: 5 }, rotationDeg: 0, side: "top" },
    { id: "C1", designator: "C1", at: { x: 8, y: 5 }, rotationDeg: 0, side: "top" },
  ],
  pads: [
    {
      id: "U1:1", componentId: "U1", number: "1", netId: "VCC",
      at: { x: 4, y: 5 }, rotationDeg: 0, layers: ["F.Cu"],
      shape: { kind: "rect", widthMm: 1, heightMm: 1 },
    },
    {
      id: "C1:1", componentId: "C1", number: "1", netId: "VCC",
      at: { x: 8, y: 5 }, rotationDeg: 0, layers: ["F.Cu"],
      shape: { kind: "rect", widthMm: 1, heightMm: 1 },
    },
  ],
  copper: { tracks: [], arcs: [], vias: [], zones: [] },
  keepouts: [],
  rules: { global: ruleValues, byNet: [{ netId: "VCC", values: ruleValues }] },
}
const snapshot = api.createPcbSnapshotV1(rawPcb)
assert.equal(api.validatePcbSnapshotV1(snapshot).ok, true)
assert.equal(dsl.validateRoutingIntent(intent).valid, true)
assert.equal(dsl.validateRoutingIntent({ ...intent, backend: "krt" }).valid, false)
assert.deepEqual(dsl.plane("gnd-plane", "VCC").on(dsl.outerLayers()).build().stitching, { enabled: false })
assert.throws(() => dsl.polygon("bad", "VCC").connect(dsl.pad("U1", 1)).build(), /requires.*on/i)
assert.throws(() => dsl.powerNet("VCC").build(), /requires exactly one/i)

const malformedBackend = {
  id: "malformed-test",
  version: "1",
  capabilities: { supported: ["ordinary-routing", "zones", "preserve-existing-copper"] },
  async route() {
    return { operations: [{ op: "add", item: { kind: "track", id: "broken" } }] }
  },
}
const malformed = await api.routePcb({ snapshot, intent, backend: malformedBackend })
assert.equal(malformed.patch.coreStatus, "error")
assert.equal(malformed.outputSnapshot, undefined)

const lockedSnapshot = api.createPcbSnapshotV1({
  ...rawPcb,
  copper: {
    ...rawPcb.copper,
    tracks: [{
      kind: "track", id: "locked-track", netId: "VCC", layerId: "F.Cu",
      start: { x: 4, y: 5 }, end: { x: 5, y: 5 }, widthMm: 0.2, locked: true,
    }],
  },
})
assert.throws(() => api.applyPcbPatchV1(lockedSnapshot, {
  schema: "pcb-patch", version: 1, baseSnapshotHash: lockedSnapshot.contentHash,
  operations: [{ op: "remove", id: "locked-track", kind: "track" }],
  diagnostics: [], coreStatus: "complete", requiresNativeVerification: true,
}), /LOCKED_COPPER/)

const diffIntent = dsl.routing({ special: [dsl.diffPair("usb", "VCC", "OTHER")] })
const unsupported = await api.routePcb({
  snapshot: api.createPcbSnapshotV1({
    ...rawPcb,
    nets: [...rawPcb.nets, { id: "OTHER", name: "OTHER" }],
    rules: {
      global: { ...ruleValues, diffPair: { gapMm: ruleRange } },
      byNet: [
        { netId: "VCC", values: { ...ruleValues, diffPair: { gapMm: ruleRange } } },
        { netId: "OTHER", values: { ...ruleValues, diffPair: { gapMm: ruleRange } } },
      ],
    },
  }),
  intent: diffIntent,
  backend: malformedBackend,
  scope: "declared-only",
})
assert.equal(unsupported.patch.coreStatus, "error")
assert.ok(unsupported.patch.diagnostics.some((item) => item.code === "UNSUPPORTED_CONSTRAINT"))

const legacy = api.captureLegacyRawPcbV1({
  board: { polygon: rawPcb.board.outline },
  components: rawPcb.components.map((component) => ({
    designator: component.designator, x: component.at.x, y: component.at.y,
    rotate: component.rotationDeg, layer: component.side === "top" ? "TOP" : "BOTTOM",
  })),
  pads: rawPcb.pads.map((padItem) => ({
    id: padItem.id, component: rawPcb.components.find((component) => component.id === padItem.componentId)?.designator,
    x: padItem.at.x, y: padItem.at.y, net: padItem.netId ?? "", padNumber: padItem.number,
    layer: "TOP", shape: ["RECT", 1, 1], rotation: 0,
  })),
}, {
  source: { eda: "test", adapter: "legacy-contract" },
  rules: rawPcb.rules,
  holesArePlated: true,
})
assert.ok(legacy.snapshot)

const doctor = spawnSync(process.execPath, [join(distRoot, "cli.js"), "doctor"], {
  cwd: root,
  encoding: "utf8",
})
assert.equal(doctor.status, 0, doctor.stderr)
assert.equal(JSON.parse(doctor.stdout).edaAccess, "none")

const temporary = await mkdtemp(join(tmpdir(), "copilot-router-package-"))
try {
  const snapshotPath = join(temporary, "snapshot.json")
  const intentPath = join(temporary, "intent.json")
  await writeFile(snapshotPath, JSON.stringify(snapshot), "utf8")
  await writeFile(intentPath, JSON.stringify(intent), "utf8")
  const validate = spawnSync(
    process.execPath,
    [join(distRoot, "cli.js"), "validate", snapshotPath, "--intent", intentPath],
    { cwd: root, encoding: "utf8" },
  )
  assert.equal(validate.status, 0, validate.stderr || validate.stdout)
  assert.equal(JSON.parse(validate.stdout).valid, true)
} finally {
  await rm(temporary, { recursive: true, force: true })
}

process.stdout.write("package contract: ok\n")
