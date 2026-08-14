import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const distRoot = resolve(process.env.COPILOT_ROUTER_PACKAGE_DIST ?? join(root, "package-dist"))
const api = await import(pathToFileURL(join(distRoot, "index.js")).href)
const dsl = await import(pathToFileURL(join(distRoot, "intent", "index.js")).href)
const schema = await import(pathToFileURL(join(distRoot, "schema.js")).href)
await import(pathToFileURL(join(distRoot, "adapters", "contracts.js")).href)
const easyEdaWasm = await import(pathToFileURL(join(distRoot, "backends", "easyeda-wasm.js")).href)
const managedAssets = await import(pathToFileURL(join(distRoot, "backends", "assets.js")).href)
const krt = await import(pathToFileURL(join(distRoot, "backends", "krt.js")).href)
const freerouting = await import(pathToFileURL(join(distRoot, "backends", "freerouting-runtime.js")).href)

assert.equal(typeof api.run, "function")
assert.equal(typeof api.validateRoutingBoard, "function")
assert.equal(typeof dsl.compileRoutingDsl, "function")
assert.equal(typeof schema.ROUTING_BOARD_JSON_SCHEMA, "object")
assert.equal(typeof easyEdaWasm.createEasyEdaWasmBackend, "function")
assert.equal(typeof easyEdaWasm.createEasyEdaWasmWorkerEngine, "function")
assert.equal(typeof managedAssets.prepareManagedRouterAsset, "function")
assert.equal(typeof krt.createKrtBackend, "function")
assert.equal(typeof krt.prepareKrtRuntime, "function")
assert.deepEqual(krt.KRT_QUALITY_PROFILES.fast, {
  maxIterations: 120_000,
  maxProbeIterations: 8_000,
  maxRipup: 2,
  heuristicWeight: 1.8,
})
assert.equal(typeof freerouting.prepareFreeroutingRuntime, "function")
assert.match(krt.krtManagedRelease().url, /KiCadRoutingTools-0\.20\.2\.zip$/)
assert.match(freerouting.freeroutingManagedRelease().url, /freerouting-2\.3\.0\.jar$/)
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
  nets: [{ name: "VCC" }, { name: "GND" }, { name: "USB_DP" }, { name: "USB_DM" }],
  components: [
    { designator: "U1", at: { x: 4, y: 5 }, rotationDeg: 0, side: "top" },
    { designator: "C1", at: { x: 8, y: 5 }, rotationDeg: 0, side: "top" },
  ],
  pads: [
    { component: "U1", number: "1", net: "VCC", at: { x: 4, y: 5 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 1, heightMm: 1 } },
    { component: "C1", number: "1", net: "VCC", at: { x: 8, y: 5 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 1, heightMm: 1 } },
    { component: "U1", number: "2", net: "USB_DP", at: { x: 4, y: 6 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 0.5, heightMm: 0.5 } },
    { component: "U1", number: "3", net: "USB_DM", at: { x: 4, y: 7 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "rect", widthMm: 0.5, heightMm: 0.5 } },
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
    nets: ["VCC", "GND", "USB_DP", "USB_DM"].map((net) => ({ net, values: ruleValues })),
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
assert.equal(dsl.validateRoutingProgram({
  polygons: [], planes: [], signalNets: [], powerNets: [], differentialPairs: [], matchedGroups: [],
  operation: "route", backend: "easyeda-wasm",
}).valid, false, "backend-specific fields must not enter the routing DSL")

const specialProgram = dsl.compileRoutingDsl(`
  diffPair("usb", { positive: "USB_DP", negative: "USB_DM", gapMm: 0.25 })
  runAll()
`)
const specialRules = dsl.compileRoutingRules(board, specialProgram)
assert.deepEqual(specialRules.effective.differentialPairs, [{
  id: "usb", positive: "USB_DP", negative: "USB_DM",
}])

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
assert.equal(applyResult.rules.effective.nets.find((item) => item.net === "VCC").values.minTrackWidthMm, 0.127)
assert.equal(applyResult.rules.effective.nets.find((item) => item.net === "VCC").values.preferredTrackWidthMm, 0.6)
assert.equal(applyResult.rules.effective.nets.find((item) => item.net === "VCC").values.via.minParallelCount, 2)

const belowHardFloor = await api.run({
  board,
  dsl: `powerNet("VCC", { minTrackWidthMm: 0.1 }); applyDrcRules()`,
})
assert.equal(belowHardFloor.status, "error")
assert.ok(belowHardFloor.diagnostics.some((item) => (
  item.code === "DSL_RULE_CONFLICT" && item.message.includes("0.127 mm routing floor")
)))

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

const cascadeProfiles = []
const cascadeBackend = {
  ...backend,
  async route(request) {
    cascadeProfiles.push(request.policy.profile)
    const complete = request.policy.profile === "balanced"
    return {
      status: complete ? "complete" : "partial",
      copper: {
        tracks: complete
          ? [{ net: "VCC", layer: "F.Cu", widthMm: 0.3, points: [{ x: 4, y: 5 }, { x: 8, y: 5 }] }]
          : [],
        vias: [], zones: [],
      },
      metrics: { openNetCount: complete ? 0 : 2, viaCount: 0 },
    }
  },
}
const cascadeResult = await api.run({
  board, dsl: "runRouting()", backend: cascadeBackend,
  policy: { profile: "balanced", maxCandidates: 2 },
})
assert.deepEqual(cascadeProfiles, ["fast", "balanced"])
assert.equal(cascadeResult.status, "complete")
assert.equal(cascadeResult.copper.tracks.length, 1)
assert.equal(cascadeResult.metrics.candidateCount, 2)
assert.ok(cascadeResult.diagnostics.some((item) => (
  item.code === "ROUTING_PORTFOLIO_SELECTED" && item.details.selectedProfile === "balanced"
)))

let earlyStopCalls = 0
const earlyStopBackend = {
  ...backend,
  async route() {
    earlyStopCalls += 1
    return { status: "complete", copper: emptyCopper, metrics: { openNetCount: 0 } }
  },
}
const earlyStopResult = await api.run({
  board, dsl: "runRouting()", backend: earlyStopBackend,
  policy: { profile: "completion-first", maxCandidates: 3 },
})
assert.equal(earlyStopResult.status, "complete")
assert.equal(earlyStopCalls, 1, "a fully routed fast candidate must stop the cascade")
assert.equal(earlyStopResult.metrics.candidateCount, 1)

let deprecatedTimeoutFinished = false
const noInternalTimeoutBackend = {
  ...backend,
  async route() {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    deprecatedTimeoutFinished = true
    return { status: "complete", copper: emptyCopper, metrics: { openNetCount: 0 } }
  },
}
const noInternalTimeoutResult = await api.run({
  board, dsl: "runRouting()", backend: noInternalTimeoutBackend,
  policy: { profile: "fast", timeoutMs: 1 },
})
assert.equal(noInternalTimeoutResult.status, "complete")
assert.equal(deprecatedTimeoutFinished, true, "deprecated timeoutMs must not stop public run()")

const externalAbort = new AbortController()
let backendObservedAbort = false
const abortableBackend = {
  ...backend,
  async route(request) {
    return await new Promise((resolvePromise) => {
      const finishAbort = () => {
        backendObservedAbort = true
        resolvePromise({ status: "error", copper: emptyCopper })
      }
      if (request.signal.aborted) finishAbort()
      else request.signal.addEventListener("abort", finishAbort, { once: true })
    })
  },
}
const abortedRun = api.run({
  board, dsl: "runRouting()", backend: abortableBackend,
  policy: { profile: "completion-first", maxCandidates: 3 },
  signal: externalAbort.signal,
})
await new Promise((resolvePromise) => setImmediate(resolvePromise))
externalAbort.abort("package contract test")
const abortedResult = await abortedRun
assert.equal(backendObservedAbort, true)
assert.equal(abortedResult.status, "error")
assert.ok(abortedResult.diagnostics.some((item) => item.code === "ROUTING_ABORTED"))

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
assert.equal(polygonResult.copper.zones[0].priority, 1)
assert.equal(polygonResult.copper.zones[0].minThicknessMm, 0.254)
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
assert.equal(planeResult.copper.zones[0].priority, 1)
assert.equal(planeResult.copper.zones[0].minThicknessMm, 0.254)
assert.ok(planeResult.copper.vias.length > 0)
assert.ok(planeResult.copper.vias.length <= 8)

const groundAndPowerResult = await api.run({
  board,
  backend: polygonBackend,
  dsl: `
    powerNet("VCC", { minTrackWidthMm: 1.85 })
    polygon("VCC").connect(pad("U1", 1), pad("C1", 1)).on(topLayer()).compact()
    plane({ net: "GND", layers: outerLayers(), region: board(), stitching: false })
    runRouting()
  `,
})
assert.equal(groundAndPowerResult.status, "complete")
assert.equal(groundAndPowerResult.rules.effective.nets.find((item) => item.net === "VCC").values.minTrackWidthMm, 0.127)
assert.equal(groundAndPowerResult.rules.effective.nets.find((item) => item.net === "VCC").values.preferredTrackWidthMm, 1.85)
assert.deepEqual(groundAndPowerResult.copper.zones.map((zone) => ({
  net: zone.net, priority: zone.priority, minThicknessMm: zone.minThicknessMm,
})), [
  { net: "VCC", priority: 1, minThicknessMm: 0.254 },
  { net: "GND", priority: 0, minThicknessMm: 0.254 },
])

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
assert.deepEqual(wasmInput.nets.map((item) => item.net), ["VCC", "USB_DP", "USB_DM"])
assert.deepEqual(wasmRouted.copper.tracks[0].points, [{ x: 4, y: 5 }, { x: 8, y: 5 }])

await api.run({
  board,
  backend: wasmBackend,
  dsl: `diffPair("usb", { positive: "USB_DP", negative: "USB_DM", gapMm: 0.25 }); runAll()`,
})
assert.deepEqual(wasmInput.classes.differentialPairClasses.usb, ["USB_DP", "USB_DM"])
assert.equal(wasmInput.nets.find((item) => item.net === "USB_DP").differentialPair, "usb")
assert.equal(wasmInput.rules.differentialPairs.usb[0].clearance[0], 0.25)

const wasmPolygonRouted = await api.run({
  board,
  backend: wasmBackend,
  dsl: `
    polygon("VCC").connect(pad("U1", 1), pad("C1", 1)).on(topLayer()).compact()
    runRouting()
  `,
})
assert.equal(wasmPolygonRouted.status, "complete")
assert.equal(wasmCalls, 3)
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
  const assetPayload = Buffer.from("managed backend fixture\n", "utf8")
  const assetSpec = {
    backend: "fixture-router",
    version: "1.0.0",
    url: `data:application/octet-stream;base64,${assetPayload.toString("base64")}`,
    sha256: createHash("sha256").update(assetPayload).digest("hex"),
    sizeBytes: assetPayload.length,
    archive: "file",
    fileName: "router.bin",
    markers: ["router.bin"],
  }
  const firstAsset = await managedAssets.prepareManagedRouterAsset(assetSpec, {
    cacheDirectory: join(temporary, "asset-cache"),
  })
  assert.equal(firstAsset.source, "download")
  const cachedAsset = await managedAssets.prepareManagedRouterAsset(assetSpec, {
    cacheDirectory: join(temporary, "asset-cache"),
    allowDownload: false,
  })
  assert.equal(cachedAsset.source, "cache")
  await assert.rejects(
    managedAssets.prepareManagedRouterAsset({
      ...assetSpec,
      version: "1.0.1",
      sha256: "0".repeat(64),
    }, { cacheDirectory: join(temporary, "asset-cache") }),
    error => error?.code === "ROUTER_ASSET_INTEGRITY_FAILED",
  )
  await assert.rejects(
    krt.discoverKrtDirectory(join(temporary, "missing-krt"), { allowDownload: false }),
    error => error?.code === "KRT_OVERRIDE_INVALID",
  )

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
