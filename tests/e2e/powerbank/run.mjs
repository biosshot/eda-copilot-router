import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  access,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises"
import { spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const routerDirectory = resolve(testDirectory, "../../..")
const repositoryDirectory = resolve(routerDirectory, "..")
const fixtureDirectory = join(testDirectory, "fixture")
const fixturePcb = join(fixtureDirectory, "Powerbank.kicad_pcb")
const fixtureProject = join(fixtureDirectory, "Powerbank.kicad_pro")
const dslPath = join(testDirectory, "routing.js")

function parseArguments(argv) {
  const options = { profile: "balanced", maxCandidates: 1 }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (argument === "--run-id" && value) options.runId = value, index += 1
    else if (argument === "--profile" && value) options.profile = value, index += 1
    else if (argument === "--max-candidates" && value) options.maxCandidates = Number(value), index += 1
    else if (argument === "--help") options.help = true
    else throw new TypeError(`Unknown or incomplete argument: ${argument}`)
  }
  if (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1 || options.maxCandidates > 32) {
    throw new TypeError("--max-candidates must be an integer from 1 to 32")
  }
  if (!["fast", "balanced", "quality-first", "completion-first"].includes(options.profile)) {
    throw new TypeError(`Unknown profile: ${options.profile}`)
  }
  return options
}

function usage() {
  return [
    "PowerBank copilot-router E2E",
    "",
    "Usage: npm run e2e:powerbank -- [--run-id NAME] [--profile balanced] [--max-candidates 1]",
    "",
    "The default is exactly one balanced candidate. Ctrl+C aborts through AbortSignal.",
  ].join("\n")
}

function safeRunId(value) {
  const source = value ?? new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source)) throw new TypeError("Unsafe --run-id")
  return source
}

async function exists(path) {
  return access(path, fsConstants.F_OK).then(() => true, () => false)
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

function sourceCopper(request) {
  return {
    tracks: [...request.board.copper.fixed.tracks, ...request.board.copper.editable.tracks],
    vias: [...request.board.copper.fixed.vias, ...request.board.copper.editable.vias],
    zones: [...request.board.copper.fixed.zones, ...request.board.copper.editable.zones],
  }
}

function trackSegments(track) {
  return track.points.slice(0, -1).map((start, index) => ({
    net: track.net,
    layer: track.layer,
    widthMm: track.widthMm,
    start,
    end: track.points[index + 1],
  }))
}

function trackKey(track) {
  const points = [track.start, track.end].sort((left, right) => left.x - right.x || left.y - right.y)
  const rounded = (value) => Math.round(value * 1_000_000)
  return [track.net, track.layer, rounded(track.widthMm), ...points.flatMap((point) => [rounded(point.x), rounded(point.y)])].join("|")
}

function viaKey(via) {
  const rounded = (value) => Math.round(value * 1_000_000)
  return [via.net, rounded(via.at.x), rounded(via.at.y), rounded(via.diameterMm), rounded(via.drillMm),
    via.fromLayer, via.toLayer, via.type ?? "through"].join("|")
}

function subtractCopper(source, output) {
  const sourceTracks = new Map()
  for (const segment of source.tracks.flatMap(trackSegments)) {
    const key = trackKey(segment)
    sourceTracks.set(key, (sourceTracks.get(key) ?? 0) + 1)
  }
  const tracks = []
  for (const segment of output.tracks.flatMap(trackSegments)) {
    const key = trackKey(segment)
    const count = sourceTracks.get(key) ?? 0
    if (count) sourceTracks.set(key, count - 1)
    else tracks.push({
      net: segment.net,
      layer: segment.layer,
      widthMm: segment.widthMm,
      points: [segment.start, segment.end],
    })
  }
  const sourceVias = new Map()
  for (const via of source.vias) sourceVias.set(viaKey(via), (sourceVias.get(viaKey(via)) ?? 0) + 1)
  const vias = output.vias.filter((via) => {
    const key = viaKey(via)
    const count = sourceVias.get(key) ?? 0
    if (!count) return true
    sourceVias.set(key, count - 1)
    return false
  })
  return { tracks, vias, zones: [] }
}

function createTransport(context, adapter) {
  return {
    async prepare(request, directory) {
      const inputBoard = join(directory, "01-krt-input.kicad_pcb")
      const copper = sourceCopper(request)
      const materialized = await adapter.materializeKiCadRoutingCandidate(
        context,
        copper,
        request.rules,
        inputBoard,
        {
          replaceAllCopper: true,
          lockTracksAndVias: true,
          refillZones: copper.zones.length > 0,
        },
      )
      return { inputBoard: materialized.outputPath }
    },
    async read(request, _preparedBoard, routedBoard) {
      const imported = await adapter.importKiCadRoutingBoard(routedBoard, { existingCopper: "fixed" })
      if (!imported.board) return {
        copper: { tracks: [], vias: [], zones: [] },
        diagnostics: imported.diagnostics,
      }
      const source = sourceCopper(request)
      return {
        copper: subtractCopper({ tracks: source.tracks, vias: source.vias, zones: [] }, imported.board.copper.fixed),
        diagnostics: imported.diagnostics,
      }
    },
  }
}

async function resolveKiCadCli() {
  const candidates = [
    process.env.KICAD_CLI,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "KiCad", "10.0", "bin", "kicad-cli.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "KiCad", "9.0", "bin", "kicad-cli.exe"),
  ].filter(Boolean)
  for (const candidate of candidates) if (await exists(candidate)) return candidate
  return "kicad-cli"
}

async function runCaptured(command, args, cwd, signal) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, signal })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => stdout += chunk)
    child.stderr.on("data", (chunk) => stderr += chunk)
    child.once("error", reject)
    child.once("close", (code, childSignal) => resolveResult({ code, signal: childSignal, stdout, stderr }))
  })
}

async function nativeDrc(kicadCli, boardPath, reportPath, signal) {
  const result = await runCaptured(kicadCli, [
    "pcb", "drc", "--format", "json", "--all-track-errors", "-o", reportPath, boardPath,
  ], dirname(boardPath), signal)
  if (!await exists(reportPath)) throw new Error(`KiCad DRC did not create ${reportPath}: ${result.stderr || result.stdout}`)
  return { process: result, report: JSON.parse(await readFile(reportPath, "utf8")) }
}

function reportMetrics(report) {
  const violations = Array.isArray(report?.violations) ? report.violations : []
  const unconnected = Array.isArray(report?.unconnected_items) ? report.unconnected_items : []
  const nonGround = unconnected.filter((item) => {
    const descriptions = Array.isArray(item?.items)
      ? item.items.map((entry) => String(entry?.description ?? ""))
      : []
    return !descriptions.length || descriptions.some((description) => !description.includes("[GND]"))
  })
  return {
    violationCount: violations.length,
    errorViolationCount: violations.filter((item) => item?.severity === "error").length,
    warningViolationCount: violations.filter((item) => item?.severity === "warning").length,
    unconnectedItemCount: unconnected.length,
    nonGroundUnconnectedItemCount: nonGround.length,
    openNets: openNets(report),
    nonGroundOpenNets: openNets(report).filter((net) => net.toUpperCase() !== "GND"),
  }
}

function openNets(report) {
  const nets = new Set()
  for (const item of Array.isArray(report?.unconnected_items) ? report.unconnected_items : []) {
    for (const entry of Array.isArray(item?.items) ? item.items : []) {
      const description = String(entry?.description ?? "")
      for (const match of description.matchAll(/\[([^\]]+)\]/g)) nets.add(match[1])
    }
  }
  return [...nets].sort()
}

function violationKey(violation) {
  const items = (Array.isArray(violation?.items) ? violation.items : [])
    .map((item) => String(item?.uuid ?? item?.description ?? ""))
    .sort()
  return JSON.stringify([
    violation?.severity ?? "",
    violation?.type ?? "",
    items,
  ])
}

function violationDelta(baseline, final) {
  const baselineKeys = new Set((Array.isArray(baseline?.violations) ? baseline.violations : []).map(violationKey))
  const finalKeys = new Set((Array.isArray(final?.violations) ? final.violations : []).map(violationKey))
  const added = [...finalKeys].filter((key) => !baselineKeys.has(key))
  const removed = [...baselineKeys].filter((key) => !finalKeys.has(key))
  return { addedCount: added.length, removedCount: removed.length }
}

function copperMetrics(copper) {
  return {
    trackCount: copper?.tracks?.length ?? 0,
    viaCount: copper?.vias?.length ?? 0,
    zoneCount: copper?.zones?.length ?? 0,
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) return console.log(usage())
  const runId = safeRunId(options.runId)
  const runDirectory = join(routerDirectory, "results", "e2e", "powerbank", runId)
  if (await exists(runDirectory)) throw new Error(`Run directory already exists: ${runDirectory}`)
  await mkdir(runDirectory, { recursive: true })

  const inputPcb = join(runDirectory, "Powerbank-input.kicad_pcb")
  const inputProject = join(runDirectory, "Powerbank-input.kicad_pro")
  const outputPcb = join(runDirectory, `Powerbank-${options.profile}.kicad_pcb`)
  const copiedDsl = join(runDirectory, "routing.js")
  const baselineReportPath = join(runDirectory, "baseline-drc.json")
  const finalReportPath = join(runDirectory, "final-drc.json")
  const fixtureBefore = { pcb: await sha256(fixturePcb), project: await sha256(fixtureProject) }
  await copyFile(fixturePcb, inputPcb)
  await copyFile(fixtureProject, inputProject)
  await copyFile(dslPath, copiedDsl)

  const abortController = new AbortController()
  const abort = (name) => abortController.abort(new Error(`Received ${name}`))
  const onInterrupt = () => abort("SIGINT")
  const onTerminate = () => abort("SIGTERM")
  process.once("SIGINT", onInterrupt)
  process.once("SIGTERM", onTerminate)

  const startedAt = performance.now()
  try {
    const router = await import(pathToFileURL(join(routerDirectory, "package-dist", "index.js")))
    const adapter = await import(pathToFileURL(join(repositoryDirectory, "kicad-copilot", "dist", "router-package-adapter.js")))
    const imported = await adapter.importKiCadRoutingBoard(inputPcb, { existingCopper: "fixed" })
    if (!imported.board || !imported.context) throw new Error(`KiCad import failed: ${JSON.stringify(imported.diagnostics)}`)
    const fixtureCopper = sourceCopper({ board: imported.board })
    if (fixtureCopper.tracks.length || fixtureCopper.vias.length || fixtureCopper.zones.length) {
      throw new Error(`PowerBank fixture must be unrouted: ${JSON.stringify(copperMetrics(fixtureCopper))}`)
    }
    const kicadCli = await resolveKiCadCli()
    console.log(`[e2e] fixture: ${fixturePcb}`)
    console.log(`[e2e] result:  ${runDirectory}`)
    console.log(`[e2e] profile: ${options.profile}, candidates: ${options.maxCandidates}`)
    console.log("[e2e] native baseline DRC")
    const baselineDrc = await nativeDrc(kicadCli, inputPcb, baselineReportPath, abortController.signal)

    const dsl = await readFile(dslPath, "utf8")
    const backend = router.createKrtBackend({
      transport: createTransport(imported.context, adapter),
      artifactsDirectory: join(runDirectory, "krt"),
      keepArtifacts: true,
    })
    console.log("[e2e] routing")
    const result = await router.run({
      board: imported.board,
      dsl,
      backend,
      policy: { profile: options.profile, maxCandidates: options.maxCandidates },
      signal: abortController.signal,
    })
    await writeFile(join(runDirectory, "routing-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8")
    console.log(`[e2e] router status: ${result.status}`)
    console.log("[e2e] apply + refill + native final DRC")
    const applied = await adapter.applyKiCadRoutingResult(imported.context, result, outputPcb, { nativeVerify: true })
    await writeFile(join(runDirectory, "apply-result.json"), `${JSON.stringify(applied, null, 2)}\n`, "utf8")
    if (!applied.outputPath) throw new Error(`KiCad apply failed: ${JSON.stringify(applied.diagnostics)}`)
    const finalDrc = await nativeDrc(kicadCli, applied.outputPath, finalReportPath, abortController.signal)
    const fixtureAfter = { pcb: await sha256(fixturePcb), project: await sha256(fixtureProject) }
    if (fixtureBefore.pcb !== fixtureAfter.pcb || fixtureBefore.project !== fixtureAfter.project) {
      throw new Error("Immutable fixture changed during E2E")
    }
    const summary = {
      schema: "copilot-router-powerbank-e2e",
      runId,
      profile: options.profile,
      maxCandidates: options.maxCandidates,
      fixture: {
        pcb: fixturePcb,
        project: fixtureProject,
        sha256: fixtureAfter,
      },
      dsl: dslPath,
      result: {
        status: result.status,
        operation: result.operation,
        metrics: result.metrics,
        copper: copperMetrics(result.copper),
        diagnostics: {
          error: result.diagnostics.filter((item) => item.severity === "error").length,
          warning: result.diagnostics.filter((item) => item.severity === "warning").length,
          info: result.diagnostics.filter((item) => item.severity === "info").length,
        },
      },
      native: {
        baseline: reportMetrics(baselineDrc.report),
        final: reportMetrics(finalDrc.report),
        violationDelta: violationDelta(baselineDrc.report, finalDrc.report),
        verification: applied.nativeVerification,
      },
      elapsedMs: performance.now() - startedAt,
      artifacts: {
        inputPcb,
        outputPcb: applied.outputPath,
        routingResult: join(runDirectory, "routing-result.json"),
        baselineDrc: baselineReportPath,
        finalDrc: finalReportPath,
      },
    }
    await writeFile(join(runDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
    const latestPath = join(routerDirectory, "results", "e2e", "powerbank", "latest.json")
    await writeFile(latestPath, `${JSON.stringify({ runId, summary: join(runDirectory, "summary.json") }, null, 2)}\n`, "utf8")
    console.log(`[e2e] done: ${join(runDirectory, "summary.json")}`)
    console.log(JSON.stringify(summary.native, null, 2))
  } finally {
    process.removeListener("SIGINT", onInterrupt)
    process.removeListener("SIGTERM", onTerminate)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
