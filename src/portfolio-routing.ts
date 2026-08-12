import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises"
import { constants } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { readPcb } from "../../kicad-copilot/src/kicad/pcb-reader"
import { parsePcbSource } from "../../kicad-copilot/src/kicad/pcb-writer"
import { kicadToRawPcb } from "./polygon/kicad-adapter"

type QualityName = "incumbent" | "max" | "high" | "medium" | "low"
type SchedulingMode = "diagnostic" | "ordered" | "batched" | "singleton"
type KrtOrdering = "mps" | "inside_out" | "original"

export type QualityPreset = {
  name: QualityName
  rank: number
  viaCost: number
  viaProximityCost: number
  turnCost: number
  directionPreferenceCost: number
  maxRipup: number
  heuristicWeight: number
  maxIterations: number
  maxProbeIterations: number
}

type RouteVariant = {
  name: string
  scheduling: SchedulingMode
  ordering: KrtOrdering
  netRescue: boolean
}

export type PortfolioCandidate = {
  index: number
  quality: QualityPreset
  variant: RouteVariant
}

export type CandidateMetrics = {
  valid: boolean
  validationCompleted: boolean
  missingNonGroundNets: string[]
  missingNonGroundItems: number
  newDrcErrors: number
  viaCount: number
  segmentCount: number
  arcCount: number
  wireLengthMm: number
  elapsedMs: number
}

export type CandidateResult = {
  candidate: PortfolioCandidate
  status: "completed" | "error" | "timeout"
  directory: string
  boardPath: string | null
  reportPath: string
  processExitCode: number | null
  processSignal: string | null
  processError?: string
  metrics: CandidateMetrics
  sourceUnchanged: boolean
  score: Array<number>
}

export const INCUMBENT_PRESET: QualityPreset = {
  name: "incumbent",
  rank: 0,
  viaCost: 20,
  viaProximityCost: 3,
  turnCost: 250,
  directionPreferenceCost: 50,
  maxRipup: 5,
  heuristicWeight: 1,
  maxIterations: 1_000_000,
  maxProbeIterations: 50_000,
}

export const QUALITY_PRESETS: readonly QualityPreset[] = [
  {
    name: "max",
    rank: 1,
    viaCost: 80,
    viaProximityCost: 16,
    turnCost: 1_500,
    directionPreferenceCost: 400,
    maxRipup: 8,
    heuristicWeight: 1.15,
    maxIterations: 2_000_000,
    maxProbeIterations: 100_000,
  },
  {
    name: "high",
    rank: 2,
    viaCost: 50,
    viaProximityCost: 10,
    turnCost: 1_000,
    directionPreferenceCost: 250,
    maxRipup: 8,
    heuristicWeight: 1.1,
    maxIterations: 1_500_000,
    maxProbeIterations: 75_000,
  },
  {
    name: "medium",
    rank: 3,
    viaCost: 20,
    viaProximityCost: 3,
    turnCost: 250,
    directionPreferenceCost: 50,
    maxRipup: 10,
    heuristicWeight: 1,
    maxIterations: 1_200_000,
    maxProbeIterations: 60_000,
  },
  {
    name: "low",
    rank: 4,
    viaCost: 1,
    viaProximityCost: 0,
    turnCost: 0,
    directionPreferenceCost: 0,
    maxRipup: 15,
    heuristicWeight: 1,
    maxIterations: 1_000_000,
    maxProbeIterations: 50_000,
  },
] as const

const ROUTE_VARIANTS: readonly RouteVariant[] = [
  { name: "escape-first", scheduling: "ordered", ordering: "original", netRescue: false },
  { name: "global-mps", scheduling: "diagnostic", ordering: "mps", netRescue: false },
  { name: "escape-first-rescue", scheduling: "ordered", ordering: "original", netRescue: true },
  { name: "global-mps-rescue", scheduling: "diagnostic", ordering: "mps", netRescue: true },
  { name: "escape-batches-rescue", scheduling: "batched", ordering: "original", netRescue: true },
  { name: "global-inside-out", scheduling: "diagnostic", ordering: "inside_out", netRescue: false },
  { name: "global-original", scheduling: "diagnostic", ordering: "original", netRescue: false },
  { name: "escape-singletons-rescue", scheduling: "singleton", ordering: "original", netRescue: true },
] as const

const INCUMBENT_VARIANT: RouteVariant = {
  name: "incumbent-global-mps",
  scheduling: "diagnostic",
  ordering: "mps",
  netRescue: false,
}

const VARIANTS_BY_QUALITY: Readonly<Record<Exclude<QualityName, "incumbent">, readonly RouteVariant[]>> = {
  // With a tiny 3-5 run budget, do not spend every quality tier on the same
  // ordering.  MPS is the strongest global baseline, while later tiers trade
  // aesthetics for the escape scheduler and additive rescue.
  max: [
    ROUTE_VARIANTS[1], ROUTE_VARIANTS[0], ROUTE_VARIANTS[5], ROUTE_VARIANTS[6],
    ROUTE_VARIANTS[3], ROUTE_VARIANTS[2], ROUTE_VARIANTS[4], ROUTE_VARIANTS[7],
  ],
  high: [
    ROUTE_VARIANTS[0], ROUTE_VARIANTS[1], ROUTE_VARIANTS[5], ROUTE_VARIANTS[2],
    ROUTE_VARIANTS[3], ROUTE_VARIANTS[4], ROUTE_VARIANTS[7], ROUTE_VARIANTS[6],
  ],
  medium: [
    ROUTE_VARIANTS[2], ROUTE_VARIANTS[3], ROUTE_VARIANTS[4], ROUTE_VARIANTS[7],
    ROUTE_VARIANTS[0], ROUTE_VARIANTS[1], ROUTE_VARIANTS[5], ROUTE_VARIANTS[6],
  ],
  low: [
    ROUTE_VARIANTS[3], ROUTE_VARIANTS[2], ROUTE_VARIANTS[4], ROUTE_VARIANTS[7],
    ROUTE_VARIANTS[1], ROUTE_VARIANTS[5], ROUTE_VARIANTS[6], ROUTE_VARIANTS[0],
  ],
} as const

const DEFAULT_BOARD = "D:\\MyProject\\kicad\\Powerbank\\Powerbank.kicad_pcb"
const DEFAULT_RULES = "D:\\MyProject\\kicad\\Powerbank\\Powerbank.drc-benchmark-clean-no-gnd.kicad_pcb"

function finiteMetric(value: number) {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

function candidateScore(result: Pick<CandidateResult, "candidate" | "metrics">) {
  const metrics = result.metrics
  return [
    metrics.valid ? 0 : 1,
    metrics.validationCompleted ? 0 : 1,
    metrics.missingNonGroundNets.length,
    finiteMetric(metrics.missingNonGroundItems),
    finiteMetric(metrics.newDrcErrors),
    finiteMetric(metrics.viaCount),
    finiteMetric(metrics.wireLengthMm),
    result.candidate.quality.rank,
    finiteMetric(metrics.elapsedMs),
    result.candidate.index,
  ]
}

export function compareCandidateResults(left: CandidateResult, right: CandidateResult) {
  const a = candidateScore(left)
  const b = candidateScore(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

/**
 * Allocate at least one run to each quality tier when the budget permits, then
 * spend the remaining budget from max quality downward. Candidates remain
 * grouped max -> high -> medium -> low, so the first fully valid result is the
 * best quality tier that was actually explored.
 */
export function buildPortfolioCandidates(requestedRuns: number) {
  const runCount = Math.max(1, Math.min(32, Math.trunc(requestedRuns)))
  const candidates: PortfolioCandidate[] = [{
    index: 1,
    quality: INCUMBENT_PRESET,
    variant: INCUMBENT_VARIANT,
  }]
  if (runCount === 1) return candidates

  const experimentalRuns = runCount - 1
  const counts = QUALITY_PRESETS.map(() => 0)
  const initial = Math.min(experimentalRuns, QUALITY_PRESETS.length)
  for (let index = 0; index < initial; index += 1) counts[index] = 1
  for (let index = initial; index < experimentalRuns; index += 1) {
    counts[(index - initial) % QUALITY_PRESETS.length] += 1
  }

  for (let qualityIndex = 0; qualityIndex < QUALITY_PRESETS.length; qualityIndex += 1) {
    const variants = VARIANTS_BY_QUALITY[QUALITY_PRESETS[qualityIndex].name]
    for (let variantIndex = 0; variantIndex < counts[qualityIndex]; variantIndex += 1) {
      candidates.push({
        index: candidates.length + 1,
        quality: QUALITY_PRESETS[qualityIndex],
        variant: variants[variantIndex],
      })
    }
  }
  return candidates
}

function boardStem(path: string) {
  const extension = extname(path)
  return extension ? path.slice(0, -extension.length) : path
}

async function exists(path: string) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function sha256(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

async function uniqueResultDirectory(requested: string) {
  if (!(await exists(requested))) return requested
  const entries = await readdir(requested)
  if (!entries.length) return requested
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")
  return `${requested}-${stamp}`
}

function arcLengthMm(arc: { x1: number; y1: number; x2: number; y2: number; arcAngle: number }) {
  const angle = Math.abs(arc.arcAngle) * Math.PI / 180
  const chord = Math.hypot(arc.x2 - arc.x1, arc.y2 - arc.y1)
  if (!(angle > 1e-9) || chord <= 1e-9) return chord
  const radius = chord / (2 * Math.sin(Math.min(Math.PI, angle) / 2))
  return Number.isFinite(radius) ? radius * angle : chord
}

async function copperMetrics(boardPath: string) {
  const source = await readPcb(boardPath)
  const raw = kicadToRawPcb(parsePcbSource(source.source), { includeZones: false })
  const segmentLength = raw.tracks.reduce((sum, track) => (
    sum + Math.hypot(track.x2 - track.x1, track.y2 - track.y1)
  ), 0)
  const arcLength = raw.arcs.reduce((sum, arc) => sum + arcLengthMm(arc), 0)
  return {
    viaCount: raw.vias.length,
    segmentCount: raw.tracks.length,
    arcCount: raw.arcs.length,
    wireLengthMm: Number((segmentLength + arcLength).toFixed(6)),
  }
}

function emptyMetrics(elapsedMs: number): CandidateMetrics {
  return {
    valid: false,
    validationCompleted: false,
    missingNonGroundNets: [],
    missingNonGroundItems: Number.MAX_SAFE_INTEGER,
    newDrcErrors: Number.MAX_SAFE_INTEGER,
    viaCount: Number.MAX_SAFE_INTEGER,
    segmentCount: Number.MAX_SAFE_INTEGER,
    arcCount: Number.MAX_SAFE_INTEGER,
    wireLengthMm: Number.MAX_SAFE_INTEGER,
    elapsedMs,
  }
}

async function copyBoardAndSidecars(sourceBoard: string, targetBoard: string) {
  await copyFile(sourceBoard, targetBoard)
  for (const suffix of [".kicad_pro", ".kicad_dru", ".kicad_prl"]) {
    const source = `${boardStem(sourceBoard)}${suffix}`
    if (await exists(source)) await copyFile(source, `${boardStem(targetBoard)}${suffix}`)
  }
}

function candidateDirectoryName(candidate: PortfolioCandidate) {
  return `${String(candidate.index).padStart(2, "0")}-${candidate.quality.name}-${candidate.variant.name}`
}

async function runChild(
  stagedScript: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdoutPath: string,
  stderrPath: string,
  timeoutMs: number,
) {
  const stdout = createWriteStream(stdoutPath)
  const stderr = createWriteStream(stderrPath)
  const started = performance.now()
  return await new Promise<{
    exitCode: number | null
    signal: string | null
    timedOut: boolean
    elapsedMs: number
    error?: string
  }>((resolvePromise) => {
    const child = spawn(process.execPath, [stagedScript, ...args], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    child.stdout.pipe(stdout)
    child.stderr.pipe(stderr)
    let timedOut = false
    let spawnError: string | undefined
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeoutMs)
    child.on("error", (error) => {
      spawnError = error.message
    })
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer)
      stdout.end()
      stderr.end()
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        elapsedMs: performance.now() - started,
        ...(spawnError ? { error: spawnError } : {}),
      })
    })
  })
}

async function runCandidate(
  candidate: PortfolioCandidate,
  config: {
    sourceBoard: string
    rulesBoard: string
    polygonDsl: string
    specialIntent: string
    resultDirectory: string
    candidateTimeoutMs: number
    stagedScript: string
    sourceHash: string
  },
): Promise<CandidateResult> {
  const directory = join(config.resultDirectory, candidateDirectoryName(candidate))
  await mkdir(directory, { recursive: true })
  const outputBoard = join(directory, `${basename(boardStem(config.sourceBoard))}.portfolio-candidate.kicad_pcb`)
  const reportPath = join(directory, "workflow-report.json")
  const quality = candidate.quality
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COPILOT_ROUTER_REMAINING_BACKEND: "krt",
    COPILOT_ROUTER_FULL_RESULT: directory,
    COPILOT_ROUTER_FULL_OUTPUT: outputBoard,
    COPILOT_ROUTER_NET_SCHEDULING: candidate.variant.scheduling,
    COPILOT_ROUTER_KRT_ORDERING: candidate.variant.ordering,
    COPILOT_ROUTER_KRT_NET_RESCUE: candidate.variant.netRescue ? "1" : "0",
    COPILOT_ROUTER_KRT_VIA_COST: String(quality.viaCost),
    COPILOT_ROUTER_KRT_VIA_PROXIMITY_COST: String(quality.viaProximityCost),
    COPILOT_ROUTER_KRT_TURN_COST: String(quality.turnCost),
    COPILOT_ROUTER_KRT_DIRECTION_PREFERENCE_COST: String(quality.directionPreferenceCost),
    COPILOT_ROUTER_KRT_MAX_RIPUP: String(quality.maxRipup),
    COPILOT_ROUTER_KRT_HEURISTIC_WEIGHT: String(quality.heuristicWeight),
    COPILOT_ROUTER_KRT_MAX_ITERATIONS: String(quality.maxIterations),
    COPILOT_ROUTER_KRT_MAX_PROBE_ITERATIONS: String(quality.maxProbeIterations),
  }
  await writeFile(join(directory, "portfolio-candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`)
  const processResult = await runChild(
    config.stagedScript,
    [config.sourceBoard, config.rulesBoard, config.polygonDsl, config.specialIntent, directory],
    env,
    join(directory, "portfolio.stdout.log"),
    join(directory, "portfolio.stderr.log"),
    config.candidateTimeoutMs,
  )

  let metrics = emptyMetrics(processResult.elapsedMs)
  let boardPath: string | null = null
  let report: Record<string, unknown> | undefined
  try {
    if (await exists(reportPath)) report = JSON.parse(await readFile(reportPath, "utf8"))
    const final = report?.finalValidation && typeof report.finalValidation === "object"
      ? report.finalValidation as Record<string, unknown>
      : {}
    const reportedBoard = typeof report?.outputBoard === "string" ? resolve(report.outputBoard) : outputBoard
    if (await exists(reportedBoard)) boardPath = reportedBoard
    const copper = boardPath ? await copperMetrics(boardPath) : {
      viaCount: Number.MAX_SAFE_INTEGER,
      segmentCount: Number.MAX_SAFE_INTEGER,
      arcCount: Number.MAX_SAFE_INTEGER,
      wireLengthMm: Number.MAX_SAFE_INTEGER,
    }
    metrics = {
      valid: !processResult.timedOut
        && processResult.exitCode === 0
        && !processResult.error
        && report?.valid === true
        && final.valid === true
        && final.completed === true,
      validationCompleted: final.completed === true,
      missingNonGroundNets: Array.isArray(final.missingNonGroundNets)
        ? [...new Set(final.missingNonGroundNets.map(String))].sort()
        : [],
      missingNonGroundItems: Number(final.missingNonGroundItems ?? Number.MAX_SAFE_INTEGER),
      newDrcErrors: Array.isArray(final.newErrorViolations)
        ? final.newErrorViolations.length
        : Number.MAX_SAFE_INTEGER,
      ...copper,
      elapsedMs: processResult.elapsedMs,
    }
  } catch (error) {
    processResult.error = error instanceof Error ? error.message : String(error)
  }
  const sourceUnchanged = await sha256(config.sourceBoard) === config.sourceHash
  const partial: CandidateResult = {
    candidate,
    status: processResult.timedOut
      ? "timeout"
      : processResult.error || processResult.exitCode !== 0 || !report
        ? "error"
        : "completed",
    directory,
    boardPath,
    reportPath,
    processExitCode: processResult.exitCode,
    processSignal: processResult.signal,
    ...(processResult.error ? { processError: processResult.error } : {}),
    metrics,
    sourceUnchanged,
    score: [],
  }
  partial.score = candidateScore(partial)
  await writeFile(join(directory, "portfolio-result.json"), `${JSON.stringify(partial, null, 2)}\n`)
  return partial
}

async function main() {
  const sourceBoard = resolve(process.argv[2] ?? process.env.COPILOT_ROUTER_BOARD ?? DEFAULT_BOARD)
  const rulesBoard = resolve(process.argv[3] ?? process.env.COPILOT_ROUTER_RULES_BOARD ?? DEFAULT_RULES)
  const polygonDsl = resolve(process.argv[4] ?? process.env.COPILOT_ROUTER_POLYGON_DSL ?? "examples/powerbank.polygons.js")
  const specialIntent = resolve(process.argv[5] ?? process.env.COPILOT_ROUTER_SPECIAL_INTENT ?? "examples/powerbank.special.json")
  const requestedDirectory = resolve(process.argv[6] ?? process.env.COPILOT_ROUTER_PORTFOLIO_RESULT ?? "results/portfolio")
  const resultDirectory = await uniqueResultDirectory(requestedDirectory)
  const requestedRuns = Number(process.env.COPILOT_ROUTER_PORTFOLIO_MAX_RUNS ?? 8)
  if (!Number.isFinite(requestedRuns) || requestedRuns <= 0) {
    throw new Error("COPILOT_ROUTER_PORTFOLIO_MAX_RUNS must be a positive number (maximum 32).")
  }
  const candidates = buildPortfolioCandidates(requestedRuns)
  const candidateTimeoutMs = Number(process.env.COPILOT_ROUTER_PORTFOLIO_CANDIDATE_TIMEOUT_MS ?? 35 * 60_000)
  if (!Number.isFinite(candidateTimeoutMs) || candidateTimeoutMs <= 0) {
    throw new Error("COPILOT_ROUTER_PORTFOLIO_CANDIDATE_TIMEOUT_MS must be positive.")
  }
  for (const path of [sourceBoard, rulesBoard, polygonDsl, specialIntent]) {
    if (!(await exists(path))) throw new Error(`Portfolio input was not found: ${path}`)
  }
  await mkdir(resultDirectory, { recursive: true })
  const sourceHash = await sha256(sourceBoard)
  const started = performance.now()
  const stagedScript = resolve(dirname(fileURLToPath(import.meta.url)), "staged-routing.js")
  const results: CandidateResult[] = []
  let stoppedEarly = false

  for (const candidate of candidates) {
    console.log(`[portfolio ${candidate.index}/${candidates.length}] ${candidate.quality.name} / ${candidate.variant.name}`)
    const result = await runCandidate(candidate, {
      sourceBoard,
      rulesBoard,
      polygonDsl,
      specialIntent,
      resultDirectory,
      candidateTimeoutMs,
      stagedScript,
      sourceHash,
    })
    results.push(result)
    console.log(JSON.stringify({
      candidate: candidate.index,
      valid: result.metrics.valid,
      missingNets: result.metrics.missingNonGroundNets.length,
      newDrcErrors: result.metrics.newDrcErrors,
      vias: result.metrics.viaCount,
      wireLengthMm: result.metrics.wireLengthMm,
    }))
    if (!result.sourceUnchanged) break
    if (result.metrics.valid) {
      stoppedEarly = true
      break
    }
  }

  const ranked = [...results]
    .filter((result) => result.boardPath && result.sourceUnchanged)
    .sort(compareCandidateResults)
  const best = ranked[0]
  let bestBoard: string | null = null
  if (best?.boardPath) {
    bestBoard = join(resultDirectory, `${basename(boardStem(sourceBoard))}.portfolio-best.kicad_pcb`)
    await copyBoardAndSidecars(best.boardPath, bestBoard)
  }
  const currentSourceHash = await sha256(sourceBoard)
  const report = {
    version: 1,
    strategy: "quality-descending-escape-risk-portfolio",
    selectionOrder: [
      "final valid",
      "fewest non-GND unrouted nets",
      "fewest non-GND unconnected items",
      "fewest new native DRC errors",
      "fewest vias",
      "shortest routed copper",
      "higher quality preset",
      "shorter elapsed time",
    ],
    requestedRuns,
    maximumRuns: 32,
    plannedRuns: candidates.length,
    completedRuns: results.length,
    stoppedEarly,
    sourceBoard,
    sourceHash,
    currentSourceHash,
    sourceUnchanged: sourceHash === currentSourceHash,
    bestCandidateIndex: best?.candidate.index ?? null,
    bestBoard,
    valid: Boolean(best?.metrics.valid && sourceHash === currentSourceHash),
    results,
    totalElapsedMs: performance.now() - started,
  }
  const reportPath = join(resultDirectory, "portfolio-report.json")
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({
    valid: report.valid,
    completedRuns: report.completedRuns,
    stoppedEarly,
    bestCandidateIndex: report.bestCandidateIndex,
    bestBoard,
    report: reportPath,
  }, null, 2))
}

const invokedAsScript = process.argv[1]
  && basename(process.argv[1]).replace(/\.[^.]+$/, "") === "portfolio-routing"

if (invokedAsScript) void main()
