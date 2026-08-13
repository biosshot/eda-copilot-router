import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const distRoot = resolve(process.env.COPILOT_ROUTER_PACKAGE_DIST ?? join(root, "package-dist"))
const api = await import(pathToFileURL(join(distRoot, "index.js")).href)
const dsl = await import(pathToFileURL(join(distRoot, "intent", "index.js")).href)
const schema = await import(pathToFileURL(join(distRoot, "schema.js")).href)
await import(pathToFileURL(join(distRoot, "adapters", "contracts.js")).href)
const easyEdaWasm = await import(pathToFileURL(join(distRoot, "backends", "easyeda-wasm.js")).href)

assert.equal(typeof api.run, "function")
assert.equal(typeof api.validateRoutingBoard, "function")
assert.equal(typeof dsl.compileRoutingDsl, "function")
assert.equal(typeof schema.ROUTING_BOARD_JSON_SCHEMA, "object")
assert.equal(typeof easyEdaWasm.createEasyEdaWasmBackend, "function")
assert.equal(typeof easyEdaWasm.createEasyEdaWasmWorkerEngine, "function")
assert.equal(api.createPcbSnapshotV1, undefined)
assert.equal(api.routePcb, undefined)
assert.equal(api.captureLegacyRawPcbV1, undefined)

const ruleValues = {
  clearanceMm: 0.2,
  edgeClearanceMm: 0.5,
  minTrackWidthMm: 0.2,
  preferredTrackWidthMm: 0.2,
  via: {
    minDiameterMm: 0.5,
    preferredDiameterMm: 0.6,
    minDrillMm: 0.3,
    preferredDrillMm: 0.3,
  },
  differential: { trackWidthMm: 0.2, gapMm: 0.2, maxSkewMm: 0.25 },
}

const emptyCopper = { tracks: [], vias: [], zones: [] }
const board = {
  outline: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
  cutouts: [],
  layers: [
    { name: "F.Cu", index: 0, side: "top" },
    { name: "B.Cu", index: 1, side: "bottom" },
  ],
  nets: [{ name: "VCC" }, { name: "USB_DP" }, { name: "USB_DM" }],
  components: [
    { designator: "U1", at: { x: 4, y: 5 }, rotationDeg: 0, side: "top" },
    { designator: "C1", at: { x: 8, y: 5 }, rotationDeg: 0, side: "top" },
  ],
  pads: [
    { component: "U1", number: "1", net: "VCC", at: { x: 4, y: 5 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 1, heightMm: 1 } },
    { component: "C1", number: "1", net: "VCC", at: { x: 8, y: 5 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 1, heightMm: 1 } },
  ],
  keepouts: [],
  stackup: {
    fallbackCopperThicknessOz: 1,
    layers: [
      { kind: "copper", layer: "F.Cu", thicknessMm: 0.03479 },
      { kind: "dielectric", thicknessMm: 1.53, relativePermittivity: 4.2 },
      { kind: "copper", layer: "B.Cu", thicknessMm: 0.03479 },
    ],
  },
  rules: {
    default: ruleValues,
    nets: ["VCC", "USB_DP", "USB_DM"].map((net) => ({ net, values: ruleValues })),
  },
  copper: { fixed: emptyCopper, editable: emptyCopper },
}

assert.equal(api.validateRoutingBoard(board).ok, true)

const allDsl = `
const commandResult = runAll()
if (commandResult !== undefined) throw new Error("terminal command returned a value")
`
assert.equal(dsl.compileRoutingDsl(allDsl).operation, "all")
assert.throws(() => dsl.compileRoutingDsl("runRouting(); runAll()"), /exactly one terminal/i)
assert.throws(() => dsl.compileRoutingDsl("polygon('VCC').connect(pad('U1', 1))"), /terminal command/i)

const applyResult = await api.run({
  board,
  dsl: `
    powerNet("VCC", { maxCurrentA: 2, maxTempRiseC: 16 })
    applyDrcRules()
  `,
})
assert.equal(applyResult.status, "complete")
assert.equal(applyResult.operation, "apply-drc")
assert.equal(applyResult.rules.applyRequested, true)
assert.equal(applyResult.copper, undefined)
assert.equal(applyResult.rules.effective.nets.find((item) => item.net === "VCC").values.minTrackWidthMm, 0.6)
assert.equal(applyResult.rules.effective.nets.find((item) => item.net === "VCC").values.via.minParallelCount, 2)

let backendCalls = 0
const backend = {
  id: "fixture",
  capabilities: {
    supported: [
      "ordinary-routing", "vias", "zones", "differential-pairs",
      "preserve-fixed-copper", "fixed-zone-obstacles",
      "preconnected-pad-groups", "parallel-vias",
    ],
    maxCopperLayers: 2,
  },
  async route(request) {
    backendCalls += 1
    assert.equal(request.program.operation, "all")
    return {
      status: "complete",
      copper: {
        tracks: [{ net: "VCC", layer: "F.Cu", widthMm: 0.3, points: [{ x: 4, y: 5 }, { x: 8, y: 5 }] }],
        vias: [], zones: [],
      },
      metrics: { routedNetCount: 1, viaCount: 0 },
    }
  },
}
const routed = await api.run({ board, dsl: "runAll()", backend })
assert.equal(routed.status, "complete")
assert.equal(routed.operation, "all")
assert.equal(routed.rules.applyRequested, true)
assert.equal(routed.copper.tracks.length, 1)
assert.equal(backendCalls, 1)

let polygonBackendRequest
const polygonBackend = {
  ...backend,
  async route(request) {
    polygonBackendRequest = request
    return { status: "complete", copper: emptyCopper }
  },
}
const polygonResult = await api.run({
  board,
  backend: polygonBackend,
  dsl: `
    polygon("VCC").connect(pad("U1", 1), pad("C1", 1)).on(topLayer()).compact()
    runRouting()
  `,
})
assert.equal(polygonResult.status, "complete")
assert.equal(polygonResult.copper.zones.length, 1)
assert.equal(polygonResult.copper.zones[0].net, "VCC")
assert.equal(polygonBackendRequest.board.copper.fixed.zones.length, 1)
assert.equal(polygonBackendRequest.program.polygons.length, 0)
assert.equal(polygonBackendRequest.program.planes.length, 0)
assert.deepEqual(polygonBackendRequest.connectivity.preconnectedPadGroups, [{
  net: "VCC",
  pads: [{ component: "U1", pad: "1" }, { component: "C1", pad: "1" }],
}])

const planeResult = await api.run({
  board,
  backend: polygonBackend,
  dsl: `
    plane({
      net: "VCC",
      layers: outerLayers(),
      region: board(),
      stitching: { gridMm: 5, maxVias: 8 }
    })
    runRouting()
  `,
})
assert.equal(planeResult.status, "complete")
assert.equal(polygonBackendRequest.board.copper.fixed.zones.length, 0)
assert.equal(polygonBackendRequest.program.planes.length, 0)
assert.equal(planeResult.copper.zones.length, 1)
assert.deepEqual(planeResult.copper.zones[0].layers, ["F.Cu", "B.Cu"])
assert.ok(planeResult.copper.vias.length > 0)
assert.ok(planeResult.copper.vias.length <= 8)

const weakOnlyRouting = await api.run({
  board,
  dsl: `signalNet("VCC", { trackWidthMm: 0.1 }); runRouting()`,
  backend,
})
assert.equal(weakOnlyRouting.status, "error")
assert.ok(weakOnlyRouting.diagnostics.some((item) => item.code === "DRC_APPLY_REQUIRED"))
assert.equal(backendCalls, 1, "preflight must reject before backend")

const weakAll = await api.run({
  board,
  dsl: `signalNet("VCC", { trackWidthMm: 0.1 }); runAll()`,
  backend,
})
assert.equal(weakAll.status, "complete")
assert.equal(weakAll.rules.effective.nets.find((item) => item.net === "VCC").values.minTrackWidthMm, 0.1)
assert.equal(backendCalls, 2)

let wasmCalls = 0
let wasmInput
const wasmBackend = easyEdaWasm.createEasyEdaWasmBackend({
  async engine(input) {
    wasmCalls += 1
    wasmInput = input
    return {
      progress: 1,
      routabitity: 1,
      traces: [{ id: "new", layer: 1, net: "VCC", width: 0.2, path: [[-6, 0], [-2, 0]] }],
      vias: [],
    }
  },
})
const wasmRouted = await api.run({ board, dsl: "runRouting()", backend: wasmBackend })
assert.equal(wasmRouted.status, "complete")
assert.equal(wasmCalls, 1)
assert.equal(wasmInput.boardOutline.bbox.length, 4)
assert.equal(Object.keys(wasmInput.components).length, board.pads.length)
assert.deepEqual(wasmInput.nets.map((item) => item.net), ["VCC"])
assert.deepEqual(wasmRouted.copper.tracks[0].points, [{ x: 4, y: 5 }, { x: 8, y: 5 }])

const wasmPolygonRouted = await api.run({
  board,
  backend: wasmBackend,
  dsl: `
    polygon("VCC").connect(pad("U1", 1), pad("C1", 1)).on(topLayer()).compact()
    runRouting()
  `,
})
assert.equal(wasmPolygonRouted.status, "complete")
assert.equal(wasmCalls, 2)
assert.ok(wasmInput.tracks.some((item) => String(item.id).startsWith("existing-zone-proxy-")))
assert.ok(wasmPolygonRouted.copper.tracks.every((item) => !String(item.id).includes("zone-proxy")))

const unsupportedBackend = {
  ...backend,
  capabilities: { supported: ["ordinary-routing", "preserve-fixed-copper"], maxCopperLayers: 2 },
}
const unsupported = await api.run({
  board,
  dsl: `diffPair("usb", { positive: "USB_DP", negative: "USB_DM" }); runRouting()`,
  backend: unsupportedBackend,
})
assert.equal(unsupported.status, "error")
assert.ok(unsupported.diagnostics.some((item) => item.code === "CAPABILITY_MISMATCH"))

const malformed = await api.run({
  board,
  dsl: "runRouting()",
  backend: {
    ...backend,
    async route() { return { status: "complete", copper: { tracks: [{ net: "VCC" }], vias: [], zones: [] } } },
  },
})
assert.equal(malformed.status, "error")
assert.ok(malformed.diagnostics.some((item) => item.code === "ROUTING_TRACK_INVALID"))

const doctor = spawnSync(process.execPath, [join(distRoot, "cli.js"), "doctor"], { cwd: root, encoding: "utf8" })
assert.equal(doctor.status, 0, doctor.stderr)
assert.equal(JSON.parse(doctor.stdout).edaAccess, "none")

const temporary = await mkdtemp(join(tmpdir(), "copilot-router-package-"))
try {
  const boardPath = join(temporary, "board.json")
  const dslPath = join(temporary, "routing.dsl.js")
  await writeFile(boardPath, JSON.stringify(board), "utf8")
  await writeFile(dslPath, "powerNet('VCC', { maxCurrentA: 2 }); applyDrcRules()", "utf8")
  const validate = spawnSync(
    process.execPath,
    [join(distRoot, "cli.js"), "validate", boardPath, "--dsl", dslPath],
    { cwd: root, encoding: "utf8" },
  )
  assert.equal(validate.status, 0, validate.stderr || validate.stdout)
  assert.equal(JSON.parse(validate.stdout).valid, true)
} finally {
  await rm(temporary, { recursive: true, force: true })
}

process.stdout.write("package contract: ok\n")
