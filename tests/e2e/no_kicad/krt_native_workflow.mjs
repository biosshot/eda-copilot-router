import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"

const execFileAsync = promisify(execFile)

const routerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const router = await import(pathToFileURL(resolve(routerDirectory, "package-dist/index.js")))
const krt = await import(pathToFileURL(resolve(routerDirectory, "package-dist/backends/krt.js")))
const krtCodec = await import(pathToFileURL(resolve(routerDirectory, "package-dist/backends/krt-codec.js")))

const rules = {
  clearanceMm: 0.2,
  edgeClearanceMm: 0.2,
  minTrackWidthMm: 0.127,
  preferredTrackWidthMm: 0.25,
  via: {
    minDiameterMm: 0.6,
    preferredDiameterMm: 0.8,
    minDrillMm: 0.3,
    preferredDrillMm: 0.4,
  },
}
const emptyCopper = { tracks: [], vias: [], zones: [] }
const board = {
  outline: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }],
  cutouts: [],
  layers: [
    { name: "F.Cu", index: 0, side: "top" },
    { name: "B.Cu", index: 1, side: "bottom" },
  ],
  nets: [{ name: "DATA[0]" }, { name: "DATA0" }, { name: "/Sub/DATA[0]" }],
  components: [
    { designator: "U1", at: { x: 5, y: 10 }, rotationDeg: 0, side: "top" },
    { designator: "U2", at: { x: 25, y: 10 }, rotationDeg: 0, side: "top" },
  ],
  pads: [
    { component: "U1", number: "1", net: "DATA[0]", at: { x: 5, y: 7 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "circle", diameterMm: 1 } },
    { component: "U2", number: "1", net: "DATA[0]", at: { x: 25, y: 7 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "circle", diameterMm: 1 } },
    { component: "U1", number: "2", net: "DATA0", at: { x: 5, y: 13 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "circle", diameterMm: 1 } },
    { component: "U2", number: "2", net: "DATA0", at: { x: 25, y: 13 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "circle", diameterMm: 1 } },
    { component: "U1", number: "3", net: "/Sub/DATA[0]", at: { x: 5, y: 10 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "circle", diameterMm: 1 } },
    { component: "U2", number: "3", net: "/Sub/DATA[0]", at: { x: 25, y: 10 }, rotationDeg: 0, layers: ["F.Cu"], shape: { kind: "circle", diameterMm: 1 } },
  ],
  keepouts: [],
  rules: { default: rules, nets: [] },
  copper: { fixed: emptyCopper, editable: emptyCopper },
}

const artifacts = await mkdtemp(join(tmpdir(), "copilot-router-native-workflow-"))
try {
  const result = await router.run({
    board,
    backend: router.createKrtBackend({ artifactsDirectory: artifacts, keepArtifacts: true }),
    dsl: `
      signalNet("DATA[0]", { priority: "critical", viaPreference: "avoid", allowedLayers: "TOP" })
      signalNet("DATA0", { priority: "normal" })
      ignoreNets("/Sub/DATA[0]")
      runRouting()
    `,
  })
  assert.notEqual(result.status, "error", JSON.stringify(result.diagnostics))
  assert.deepEqual(result.metrics?.openNets, [], JSON.stringify(result.diagnostics))
  assert.ok(result.metrics?.details?.critical?.some((summary) => (
    summary?.critical_verified_nets?.includes("DATA[0]")
  )), "critical DATA[0] must be selected literally, geometry/DRC verified, and protected")
  assert.ok(result.metrics?.details?.protectedNets?.includes("DATA[0]"))
  assert.ok(result.copper.tracks.some((track) => track.net === "DATA[0]"),
    "literal critical selector must route DATA[0], not its fnmatch neighbor DATA0")
  assert.equal(result.copper.vias.filter((via) => via.net === "DATA[0]").length, 0)
  assert.equal(result.copper.tracks.filter((track) => track.net === "/Sub/DATA[0]").length, 0,
    "exact DATA[0] selection must not route its ignored hierarchical leaf alias")
  assert.ok(result.metrics?.details?.main?.length, "ordinary DATA0 must use the main native pass")

  const manifests = (await readdir(artifacts, { recursive: true }))
    .filter((path) => path.endsWith("-manifest.json"))
  assert.ok(manifests.length >= 2, "every attempted native stage must persist an authoritative manifest")
  const criticalManifestPath = manifests.find((path) => path.includes("critical"))
  assert.ok(criticalManifestPath)
  const manifest = JSON.parse(await readFile(join(artifacts, criticalManifestPath), "utf8"))
  assert.equal(manifest.recovery.ripPreexisting, true)
  assert.equal(manifest.recovery.netRescue, true)
  assert.equal(manifest.recovery.terminalEscalation, true)
  assert.equal(manifest.recovery.dynamicIterations, true)
  assert.ok(manifest.files.some((file) => file.path.endsWith(".kicad_pro") && file.sha256))

  const generatedPaths = await readdir(artifacts, { recursive: true })
  const mainProcessPath = generatedPaths.find((path) => {
    const normalized = path.replaceAll("\\", "/")
    return normalized.includes("/main/") && normalized.endsWith("/krt-remaining-result.json")
  })
  assert.ok(mainProcessPath, "main native process result must remain inspectable")
  const mainProcess = JSON.parse(await readFile(join(artifacts, mainProcessPath), "utf8"))
  const mainInvocationPath = generatedPaths.find((path) => {
    const normalized = path.replaceAll("\\", "/")
    return normalized.includes("/main/") && normalized.endsWith("/krt-remaining-invocation.json")
  })
  assert.ok(mainInvocationPath, "main native invocation must retain its disk-backed tool argv")
  const mainInvocation = JSON.parse(await readFile(join(artifacts, mainInvocationPath), "utf8"))
  assert.equal(mainInvocation.toolArgs[mainInvocation.toolArgs.indexOf("--nets") + 1], krt.KRT_EXACT_NET_SENTINEL,
    "disk-backed native tool argv must carry one bounded exact-scope sentinel")
  assert.ok(!mainProcess.command.includes("DATA0"),
    "raw exact net names must not cross Windows CreateProcess argv")
  assert.ok(JSON.stringify(mainProcess.command).length < 4_096,
    "native process argv must stay bounded independently of board net count")
  assert.ok(!mainInvocation.toolArgs.includes("DATA0"),
    "raw exact net names must live in the selector sidecar, not route.py argv")
  assert.deepEqual(
    JSON.parse(await readFile(mainInvocation.toolArgsPath, "utf8")),
    mainInvocation.toolArgs,
    "the invoked KRT argv sidecar must exactly match the auditable invocation manifest",
  )
  const exactSelectorPaths = generatedPaths.filter((path) => path.endsWith("-exact-selectors.json"))
  assert.ok(exactSelectorPaths.length >= 2, "every routed exact stage must retain its selector sidecar")
  const exactSelectorScopes = await Promise.all(exactSelectorPaths.map(async (path) => (
    JSON.parse(await readFile(join(artifacts, path), "utf8"))
  )))
  assert.ok(exactSelectorScopes.some((scope) => scope.netSelection.includes("DATA[0]")))
  assert.ok(exactSelectorScopes.some((scope) => scope.netSelection.includes("DATA0")))
  assert.equal(mainInvocation.toolArgs[mainInvocation.toolArgs.indexOf("--via-size") + 1], "0.8",
    "KRT CLI must receive the netclass preferred via diameter")
  assert.equal(mainInvocation.toolArgs[mainInvocation.toolArgs.indexOf("--via-drill") + 1], "0.4",
    "KRT CLI must receive the netclass preferred via drill")
  const mainFabPath = generatedPaths.find((path) => /05-main-\d+-fab\.txt$/.test(path))
  assert.ok(mainFabPath, "main fab floor must remain inspectable")
  const mainFab = await readFile(join(artifacts, mainFabPath), "utf8")
  assert.match(mainFab, /^via_diameter = 0\.6$/m,
    "preferred via diameter must not become a hard manufacturing floor")
  assert.match(mainFab, /^via_drill = 0\.3$/m,
    "preferred via drill must not disable native terminal escalation")
  assert.match(mainFab, /^annular = 0\.15(?:0+)?$/m)
  const auditBoardPath = generatedPaths.find((path) => path.endsWith("krt-remaining-input.kicad_pcb"))
  assert.ok(auditBoardPath, "managed workflow must retain an auditable KRT input board")
  const managed = await krt.prepareKrtRuntime()

  // check_drc.py's default fabrication tier pins board-edge clearance to
  // 0.2 mm. This track is legal at the explicit 0.127 mm project/fab floor
  // (0.22 > 0.127 + 0.127 / 2), but would be rejected at that hidden default
  // (0.22 < 0.2 + 0.127 / 2). The audit must therefore receive the same
  // --fab-overrides file as route.py, while retaining the exact CLI rule.
  const exactEdgeRules = {
    ...rules,
    clearanceMm: 0.127,
    edgeClearanceMm: 0.127,
    preferredTrackWidthMm: 0.127,
    holeToHoleClearanceMm: 0.127,
  }
  const exactEdgeDirectory = join(artifacts, "exact-edge-audit")
  await mkdir(exactEdgeDirectory, { recursive: true })
  const exactEdgePrepared = await krtCodec.writeKrtBoard({
    board: {
      ...board,
      nets: [{ name: "EDGE" }],
      components: [],
      pads: [],
      rules: { default: exactEdgeRules, nets: [] },
      copper: {
        fixed: emptyCopper,
        editable: {
          tracks: [{
            net: "EDGE", layer: "F.Cu", widthMm: 0.127,
            points: [{ x: 0.22, y: 5 }, { x: 0.22, y: 8 }],
          }],
          vias: [],
          zones: [],
        },
      },
    },
    rules: { default: exactEdgeRules, nets: [] },
    program: { fanouts: [], fanoutExclusions: [], ignoreNets: [] },
  }, exactEdgeDirectory)
  const exactFabPath = join(exactEdgeDirectory, "exact-fab.txt")
  await writeFile(exactFabPath, [
    "track_width = 0.127",
    "clearance = 0.127",
    "via_diameter = 0.6",
    "via_drill = 0.3",
    "hole_to_hole = 0.127",
    "pad_hole_to_hole = 0.127",
    "annular = 0.15",
    "board_edge = 0.127",
    "",
  ].join("\n"))
  const exactEdgeAudit = await krt.auditKrtBoardDrc(
    exactEdgePrepared.inputBoard,
    ["EDGE"],
    {
      pythonPath: managed.pythonPath,
      pythonPathEntries: managed.pythonPathEntries,
      krtDirectory: managed.directory,
      layers: ["F.Cu", "B.Cu"],
      rules: {
        trackWidth: 0.127,
        hardTrackWidth: 0.127,
        clearance: 0.127,
        viaSize: 0.8,
        viaDrill: 0.4,
        hardViaSize: 0.6,
        hardViaDrill: 0.3,
        hardViaAnnular: 0.15,
        gridStep: 0.1,
        holeToHoleClearance: 0.127,
        boardEdgeClearance: 0.127,
      },
      fabOverridesPath: exactFabPath,
      authoritativeProjectPath: exactEdgePrepared.inputProject,
      diffPairs: [],
      matchedGroups: [],
      remainingNets: ["EDGE"],
    },
    join(exactEdgeDirectory, "drc"),
  )
  assert.equal(exactEdgeAudit.failed, false, JSON.stringify(exactEdgeAudit.diagnostics))
  assert.equal(exactEdgeAudit.violationCount, 0,
    "native DRC must use the explicit 0.127 mm fab override, not its default 0.2 mm edge floor")

  const rawSelectorScopePath = join(artifacts, "raw-recovery-selector-scope.json")
  const rawProbeNets = [
    "DATA[0]", "!OSC[0]", "--CLK", "DATA[[]0]",
    krt.KRT_EXACT_NET_SENTINEL, krt.KRT_EXACT_RIP_SENTINEL,
  ]
  const rawSelectorScope = krt.compactKrtExactSelectorArgs([
    "--nets",
    ...rawProbeNets.map(krt.krtLiteralNetFilterPattern),
    "--rip-existing-nets",
    krt.krtLiteralNetFilterPattern("DATA0"),
  ], {
    netSelection: rawProbeNets,
    ripSelection: ["DATA0"],
    ripAuthorization: ["DATA0"],
    diffPairs: [["DATA[0]", "DATA[[]0]"]],
  }).sidecar
  await writeFile(rawSelectorScopePath, JSON.stringify(rawSelectorScope))
  const rawProbeTokenByName = Object.fromEntries(
    rawSelectorScope.selectorTokens.map(([token, name]) => [name, token]),
  )
  const patchProbe = [
    "import sys,types",
    `sys.path[:0]=${JSON.stringify([join(managed.directory, "py_router"), ...managed.pythonPathEntries])}`,
    "import length_matching,routing_common",
    "original_length_match_finder=length_matching.find_nets_matching_patterns",
    "import copilot_router_krt_patch,net_queries",
    "from unittest import TestCase",
    "case=TestCase()",
    "assert length_matching.find_nets_matching_patterns is not original_length_match_finder",
    "assert routing_common.find_nets_matching_patterns is length_matching.find_nets_matching_patterns",
    "assert net_queries.matches_net_filter('DATA[0]',['DATA[0]'])",
    "assert not net_queries.matches_net_filter('DATA0',['DATA[0]'])",
    "assert not net_queries.matches_net_filter('/Sub/DATA[0]',['DATA[0]'])",
    "assert net_queries.matches_net_filter('!OSC[0]',['!OSC[0]'])",
    "assert not net_queries.matches_net_filter('OSC0',['!OSC[0]'])",
    "assert net_queries.matches_net_filter('--CLK',['--CLK'])",
    "assert net_queries.matches_net_filter('DATA[[]0]',['DATA[[]0]'])",
    `assert net_queries.matches_net_filter(${JSON.stringify(krt.KRT_EXACT_NET_SENTINEL)},[${JSON.stringify(krt.KRT_EXACT_NET_SENTINEL)}])`,
    `assert net_queries.matches_net_filter(${JSON.stringify(krt.KRT_EXACT_RIP_SENTINEL)},[${JSON.stringify(krt.KRT_EXACT_RIP_SENTINEL)}])`,
    `assert net_queries.matches_net_filter('DATA[0]',[${JSON.stringify(rawProbeTokenByName["DATA[0]"])}])`,
    `assert not net_queries.matches_net_filter('DATA[[]0]',[${JSON.stringify(rawProbeTokenByName["DATA[0]"])}])`,
    `assert length_matching.find_nets_matching_patterns(['DATA0','DATA[0]','DATA[[]0]'],[${JSON.stringify(rawProbeTokenByName["DATA[0]"])},${JSON.stringify(rawProbeTokenByName["DATA[[]0]"])}])==['DATA[0]','DATA[[]0]']`,
    `assert routing_common.find_nets_matching_patterns(['DATA0','DATA[0]'],[${JSON.stringify(rawProbeTokenByName["DATA[0]"])}])==['DATA[0]']`,
    `case.assertRaisesRegex(RuntimeError,'absent from routed nets',length_matching.find_nets_matching_patterns,['DATA0'],[${JSON.stringify(rawProbeTokenByName["DATA[0]"])}])`,
    `case.assertRaisesRegex(RuntimeError,'outside its exact scope',length_matching.find_nets_matching_patterns,['DATA[0]'],[${JSON.stringify(rawProbeTokenByName["DATA[0]"])},'DATA*'])`,
    "pcb=types.SimpleNamespace(nets={1:types.SimpleNamespace(name='DATA[0]'),2:types.SimpleNamespace(name='DATA[[]0]')},pads_by_net={})",
    `assert net_queries.expand_net_patterns(pcb,[${JSON.stringify(rawProbeTokenByName["DATA[0]"])},${JSON.stringify(rawProbeTokenByName["DATA[[]0]"])}])==['DATA[0]','DATA[[]0]']`,
    "pairs=net_queries.find_differential_pairs(pcb,['DATA[0]','DATA[[]0]'])",
    "assert [(pair.p_net_name,pair.n_net_name) for pair in pairs.values()]==[('DATA[0]','DATA[[]0]')]",
  ].join(";")
  await execFileAsync(managed.pythonPath, ["-c", patchProbe], {
    cwd: managed.directory,
    env: {
      ...process.env,
      COPILOT_ROUTER_EXACT_SELECTORS_FILE: rawSelectorScopePath,
      PYTHONDONTWRITEBYTECODE: "1",
    },
  })
  await assert.rejects(
    execFileAsync(managed.pythonPath, ["-c", [
      "import sys",
      `sys.path[:0]=${JSON.stringify([join(managed.directory, "py_router"), ...managed.pythonPathEntries])}`,
      "import copilot_router_krt_patch",
    ].join(";")], {
      cwd: managed.directory,
      env: {
        ...process.env,
        COPILOT_ROUTER_EXACT_SELECTORS_FILE: rawSelectorScopePath,
        COPILOT_ROUTER_EXACT_NET_SELECTION: JSON.stringify([
          [rawProbeTokenByName["DATA[0]"], "DATA0"],
        ]),
        PYTHONDONTWRITEBYTECODE: "1",
      },
    }),
    (error) => {
      assert.match(`${error.stderr ?? ""}\n${error.message ?? ""}`, /selector token collision/)
      return true
    },
  )
  const partialScopeAudit = await krt.auditKrtBoardConnectivity(
    join(artifacts, auditBoardPath),
    ["DATA[0]", "ABSENT_NET"],
    {
      pythonPath: managed.pythonPath,
      pythonPathEntries: managed.pythonPathEntries,
      krtDirectory: managed.directory,
      layers: ["F.Cu", "B.Cu"],
      rules: {
        trackWidth: 0.25,
        hardTrackWidth: 0.127,
        clearance: 0.2,
        viaSize: 0.8,
        viaDrill: 0.4,
        hardViaSize: 0.6,
        hardViaDrill: 0.3,
        hardViaAnnular: 0.15,
        gridStep: 0.1,
      },
      fabOverridesPath: join(artifacts, mainFabPath),
      diffPairs: [],
      matchedGroups: [],
      remainingNets: ["DATA[0]", "ABSENT_NET"],
    },
    join(artifacts, "partial-scope-audit"),
  )
  assert.deepEqual(partialScopeAudit.openNets.sort(), ["ABSENT_NET", "DATA[0]"],
    "a partially matched audit selector must fail closed over the entire requested scope")
  assert.ok(partialScopeAudit.diagnostics.some((item) => item.code === "KRT_FINAL_CONNECTIVITY_AUDIT_FAILED"))

  const shortCriticalBoard = {
    ...board,
    layers: [
      { name: "TOP", index: 0, side: "top" },
      { name: "BOTTOM", index: 31, side: "bottom" },
    ],
    nets: [{ name: "!OSC[0]" }, { name: "OPEN" }],
    components: [
      { designator: "X1", at: { x: 5, y: 10 }, rotationDeg: 0, side: "top" },
      { designator: "U3", at: { x: 13, y: 10 }, rotationDeg: 0, side: "top" },
      { designator: "J3", at: { x: 5, y: 16 }, rotationDeg: 0, side: "top" },
      { designator: "J4", at: { x: 25, y: 16 }, rotationDeg: 0, side: "top" },
    ],
    pads: [
      { component: "X1", number: "1", net: "!OSC[0]", at: { x: 5, y: 10 }, rotationDeg: 0, layers: ["TOP"], shape: { kind: "circle", diameterMm: 1 } },
      { component: "U3", number: "1", net: "!OSC[0]", at: { x: 13, y: 10 }, rotationDeg: 0, layers: ["TOP"], shape: { kind: "circle", diameterMm: 1 } },
      { component: "J3", number: "1", net: "OPEN", at: { x: 5, y: 16 }, rotationDeg: 0, layers: ["TOP"], shape: { kind: "circle", diameterMm: 1 } },
      { component: "J4", number: "1", net: "OPEN", at: { x: 25, y: 16 }, rotationDeg: 0, layers: ["TOP"], shape: { kind: "circle", diameterMm: 1 } },
    ],
    keepouts: [{
      layers: ["TOP", "BOTTOM"],
      polygon: { outer: [{ x: 14, y: 0 }, { x: 16, y: 0 }, { x: 16, y: 20 }, { x: 14, y: 20 }] },
      forbid: { tracks: true, vias: true, zones: true },
    }],
    copper: {
      fixed: emptyCopper,
      editable: {
        tracks: [
          { net: "!OSC[0]", layer: "TOP", widthMm: 0.25, points: [{ x: 5, y: 10 }, { x: 7, y: 10 }] },
          { net: "!OSC[0]", layer: "BOTTOM", widthMm: 0.25, points: [{ x: 7, y: 10 }, { x: 11, y: 10 }] },
          { net: "!OSC[0]", layer: "TOP", widthMm: 0.25, points: [{ x: 11, y: 10 }, { x: 13, y: 10 }] },
        ],
        vias: [
          { net: "!OSC[0]", at: { x: 7, y: 10 }, diameterMm: 0.6, drillMm: 0.3, fromLayer: "TOP", toLayer: "BOTTOM", type: "through" },
          { net: "!OSC[0]", at: { x: 11, y: 10 }, diameterMm: 0.6, drillMm: 0.3, fromLayer: "TOP", toLayer: "BOTTOM", type: "through" },
        ],
        zones: [],
      },
    },
  }
  const viaRepairResult = await router.run({
    board: shortCriticalBoard,
    backend: router.createKrtBackend({
      artifactsDirectory: join(artifacts, "short-critical-via"),
      keepArtifacts: true,
    }),
    dsl: `
      signalNet("!OSC[0]", { priority: "critical", viaPreference: "avoid" })
      signalNet("OPEN", { priority: "high", allowedLayers: "TOP" })
      runRouting()
    `,
  })
  assert.notEqual(viaRepairResult.status, "error", JSON.stringify(viaRepairResult.diagnostics))
  assert.ok(viaRepairResult.metrics?.openNets?.includes("OPEN"), "fixture must retain one unresolved ordinary net")
  assert.equal(
    viaRepairResult.copper.vias.filter((via) => via.net === "!OSC[0]").length,
    0,
    JSON.stringify({ diagnostics: viaRepairResult.diagnostics, details: viaRepairResult.metrics?.details }),
  )
  const viaRepair = viaRepairResult.metrics?.details?.repairs?.find((repair) => (
    repair.kind === "short-via" && repair.targetNet === "!OSC[0]"
  ))
  assert.ok(viaRepair, "connected active-low critical+avoid !OSC[0] must receive an isolated short-via repair")
  assert.equal(viaRepairResult.metrics?.details?.repairs?.[0]?.kind, "open",
    "connectivity repair must consume the bounded queue before cosmetic via cleanup")
  assert.ok(viaRepairResult.metrics?.details?.repairs?.indexOf(viaRepair) > 0,
    "critical short-via cleanup may run only after the preceding open-net attempt")
  assert.equal(viaRepair.accepted, true, JSON.stringify(viaRepairResult.diagnostics))
  assert.equal(viaRepair.beforeTargetVias, 2)
  assert.equal(viaRepair.afterTargetVias, 0)
  assert.ok(viaRepairResult.metrics?.details?.protectedNets?.includes("!OSC[0]"),
    "critical !OSC[0] must remain in the protection ledger after exact force-reroute repair")
} finally {
  if (!process.env.KEEP_KRT_E2E_ARTIFACTS) await rm(artifacts, { recursive: true, force: true })
  else console.error(`KRT_E2E_ARTIFACTS=${artifacts}`)
}

console.log("managed KRT native workflow E2E: ok")
