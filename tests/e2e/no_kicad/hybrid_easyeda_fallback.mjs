import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHybridBackend, run } from "../../../package-dist/index.js"
import { board } from "./board.mjs"

const temporary = await mkdtemp(join(tmpdir(), "copilot-router-hybrid-offline-"))
const hiddenEnvironment = [
  "PATH", "Path", "COPILOT_ROUTER_PYTHON", "KICAD_PYTHON", "PYTHON",
  "PYTHON_EXECUTABLE", "UV_PYTHON", "npm_config_python", "VIRTUAL_ENV",
  "CONDA_PREFIX", "PYTHONHOME", "PYENV_ROOT", "LOCALAPPDATA",
  "ProgramFiles", "ProgramFiles(x86)", "USERPROFILE", "WINDIR",
  "COPILOT_ROUTER_KRT_DIR", "KICAD_ROUTING_TOOLS_DIR",
]
const previousEnvironment = Object.fromEntries(hiddenEnvironment.map((name) => [name, process.env[name]]))

try {
  // The Node process and bundled WASM assets are already loaded by absolute
  // path. Hide host Python/KiCad discovery and force a cold offline KRT cache
  // only for the routing call below.
  for (const name of hiddenEnvironment) process.env[name] = join(temporary, `missing-${name.replaceAll(/[^a-z0-9]/gi, "-")}`)
  process.env.PATH = ""
  process.env.Path = ""
  delete process.env.COPILOT_ROUTER_KRT_DIR
  delete process.env.KICAD_ROUTING_TOOLS_DIR

  const backend = createHybridBackend({
    krt: {
      pythonPath: join(temporary, "missing-python"),
      assets: {
        cacheDirectory: join(temporary, "empty-router-cache"),
        allowDownload: false,
      },
    },
  })
  const result = await run({
    board,
    backend,
    dsl: `onlyNets("USB_DP_CONN"); runRouting()`,
    signal: AbortSignal.timeout(30_000),
  })

  assert.equal(result.status, "partial",
    "a missing optional KRT runtime must be visible as degradation, not a hard routing failure")
  assert.equal(result.metrics?.backend, "hybrid")
  assert.equal(result.metrics?.details?.hybrid?.mode, "easyeda-only")
  assert.ok(result.copper.tracks.some((track) => track.net === "USB_DP_CONN"),
    `bundled EasyEDA fallback returned no routed copper: ${JSON.stringify(result.diagnostics)}`)
  assert.equal(result.metrics?.openNetCount, 0)
  assert.ok(result.diagnostics.some((item) => (
    item.code === "ROUTER_ASSET_NOT_CACHED"
    || item.code === "KRT_PYTHON_PLATFORM_UNSUPPORTED"
  )), `the original KRT availability diagnostic was lost: ${JSON.stringify(result.diagnostics)}`)
  assert.ok(result.diagnostics.some((item) => item.code === "HYBRID_ROUTE_MODE_SELECTED"
    && item.details?.mode === "easyeda-only"))

  const hardFallback = await run({
    board,
    backend,
    dsl: `
      onlyNets("USB_DP_CONN", "USB_DM_CONN")
      matchedGroup("USB_UNVERIFIED", { nets: ["USB_DP_CONN", "USB_DM_CONN"], toleranceMm: 0.25 })
      runRouting()
    `,
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(hardFallback.status, "partial")
  assert.equal(hardFallback.metrics?.details?.hybrid?.mode, "easyeda-full")
  assert.ok(hardFallback.copper.tracks.some((track) => track.net === "USB_DP_CONN"))
  assert.ok(hardFallback.copper.tracks.some((track) => track.net === "USB_DM_CONN"))
  assert.ok(hardFallback.diagnostics.some((item) => item.code === "HYBRID_HARD_CONSTRAINTS_UNVERIFIED_FALLBACK"),
    "EasyEDA full fallback must retain copper without pretending to verify matched-length semantics")

  console.log(`Hybrid bundled-EasyEDA offline fallback: ok (${result.copper.tracks.length} ordinary, ${hardFallback.copper.tracks.length} hard-scope tracks)`)
} finally {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(temporary, { recursive: true, force: true })
}
