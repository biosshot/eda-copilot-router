import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import {
  access,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises"
import { constants } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import {
  listChildren,
  pcbNetNames,
  readPcb,
} from "../../kicad-copilot/src/kicad/pcb-reader"
import {
  parsePcbSource,
  serializePcb,
} from "../../kicad-copilot/src/kicad/pcb-writer"
import {
  atom,
  findChild,
  type SExpression,
} from "../../kicad-copilot/src/kicad/sexpr/ast"
import { clearRouting } from "./internal/legacy-kicad-wasm-adapter"
import {
  netClassFor,
  readPcbRoutingRules,
  type PcbRoutingRules,
} from "../../kicad-copilot/src/pcb/router-rules"
import {
  persistKrtProtectedNets,
  runKrtRemaining,
  runKrtSpecial,
  type KrtProcessResult,
  type KrtStageSpec,
} from "./backends/krt-adapter"
import {
  runFreeroutingRemaining,
  type FreeroutingProcessResult,
  type FreeroutingStageSpec,
} from "./backends/freerouting-adapter"
import { prepareFreeroutingRuntime } from "./backends/freerouting-runtime"
import { prepareKrtRuntime } from "./backends/krt-runtime"
import {
  runEasyEdaWasmRemaining,
  type EasyEdaWasmProcessResult,
  type EasyEdaWasmStageSpec,
} from "./backends/easyeda-wasm-adapter"
import { isOctilinearBoundary } from "./polygon/boundary-optimizer"
import { runPolygonDsl, type PlaneIntent } from "./polygon/dsl"
import {
  planPolygons,
  validateFilledPolygonPlans,
  type ZonePlan,
} from "./polygon/engine"
import {
  appendPlannedZones,
  kicadToRawPcb,
  removeKicadZones,
} from "./polygon/kicad-adapter"
import {
  appendFilledCopperProxy,
  filledCopperPadGroups,
  fullyConnectedByFilledCopperNets,
  removeFilledCopperProxy,
} from "./filled-copper-proxy"
import { scheduleNets, type NetSchedule } from "./net-scheduler"
import {
  applyPlaneStitching,
  removeInvalidPlaneVias,
} from "./ground-plane"
import {
  runKrtCompletionPortfolio,
} from "./completion-routing"
import {
  compilePowerIntent,
  parsePowerIntent,
  persistCompiledPowerRules,
  validatePowerRouting,
  withCompiledPowerRules,
  type CompiledPowerIntent,
  type PowerIntentInput,
} from "./power-intent"
import {
  deriveFinalValidation,
  summarizeFinalDrc,
  type FinalDrcSummary,
  type FinalValidation,
} from "./workflow-validation"
import {
  changedCopperGeometryNets,
  copperGeometrySignatures,
  zoneOutlineSignatures,
} from "./workflow-board"

export {
  deriveFinalValidation,
  summarizeFinalDrc,
} from "./workflow-validation"
export {
  changedCopperGeometryNets,
  copperGeometrySignatures,
} from "./workflow-board"

type JsonRecord = Record<string, unknown>

export type WorkflowDiagnostic = {
  code: string
  severity: "info" | "warning" | "error"
  message: string
  details?: unknown
}

export type WorkflowStage = {
  stage: "preflight" | "polygons" | "special" | "remaining" | "completion" | "ground" | "final"
  status: "ok" | "partial" | "error" | "skipped" | "skipped_due_to_dependency"
  inputBoard?: string
  outputBoard?: string
  diagnostics: WorkflowDiagnostic[]
  metrics?: Record<string, unknown>
  details?: unknown
}

export type SpecialIntent = {
  version: 1
  diffPairs: Array<{ positive: string; negative: string }>
  matchedGroups: string[][]
  lengthMatchToleranceMm: number
  meanderAmplitudeMm: number
  meanderSpacingWidths: number
  powerNets: NonNullable<PowerIntentInput["powerNets"]>
  manufacturing: NonNullable<PowerIntentInput["manufacturing"]>
}

type ProcessResult = {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  elapsedMs: number
  stdout: string
  stderr: string
  error?: string
}

type NativeDrcResult = {
  process: ProcessResult
  report?: JsonRecord
  reportPath: string
}

type WorkflowConfig = {
  sourceBoard: string
  rulesBoard: string
  polygonDsl: string
  specialIntentPath: string
  resultDirectory: string
  outputBoard: string
  krtDirectory: string
  pythonPath: string
  pythonPathEntries: string[]
  kicadCli: string
  timeoutMs: number
  remainingBackend: "krt" | "freerouting" | "easyeda-wasm"
  freeroutingJar: string
  javaPath: string
  javacPath: string
  kicadPythonPath: string
  freeroutingBridge: string
  freeroutingRunner: string
  freeroutingMaxPasses: number
  freeroutingThreads: number
  krtViaCost: number
  krtViaProximityCost: number
  krtTurnCost: number
  krtDirectionPreferenceCost: number
  krtMaxRipup: number
  krtMaxIterations: number
  krtMaxProbeIterations: number
  krtHeuristicWeight: number
  krtOrdering: "mps"
  netScheduling: "diagnostic" | "ordered" | "batched" | "singleton"
  krtNetRescue: boolean
  completionRuns: number
  skipSpecial: boolean
}

const DEFAULT_BOARD = "D:\\MyProject\\kicad\\Powerbank\\Powerbank.kicad_pcb"
const DEFAULT_RULES_BOARD = "D:\\MyProject\\kicad\\Powerbank\\Powerbank.drc-benchmark-clean-no-gnd.kicad_pcb"
const DEFAULT_KICAD = "C:\\Users\\kiril\\AppData\\Local\\Programs\\KiCad\\10.0\\bin\\kicad-cli.exe"
const DEFAULT_KICAD_PYTHON = "C:\\Users\\kiril\\AppData\\Local\\Programs\\KiCad\\10.0\\bin\\python.exe"
function diagnostic(
  code: string,
  severity: WorkflowDiagnostic["severity"],
  message: string,
  details?: unknown,
): WorkflowDiagnostic {
  return { code, severity, message, ...(details === undefined ? {} : { details }) }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function krtSummaryNetNames(value: unknown): string[] {
  const output = new Set<string>()
  const visit = (candidate: unknown) => {
    if (typeof candidate === "string") {
      output.add(candidate)
      return
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item)
      return
    }
    if (!candidate || typeof candidate !== "object") return
    const record = candidate as Record<string, unknown>
    for (const key of ["net", "net_name", "name"]) {
      if (typeof record[key] === "string") output.add(record[key] as string)
    }
    for (const key of ["failed_pads", "incomplete_members", "nets"]) {
      if (record[key] !== undefined) visit(record[key])
    }
  }
  visit(value)
  return [...output]
}

function incompleteKrtNets(result: KrtProcessResult, attemptedNets: readonly string[]) {
  if (!result.attempted || result.status !== "completed" || !result.jsonSummary) {
    return new Set(attemptedNets)
  }
  const summary = result.jsonSummary
  const incomplete = new Set<string>()
  for (const key of [
    "failed_single",
    "open_single",
    "failed_multipoint",
    "cleanup_disconnected",
    "coverage_gate_nets",
    "pad_pairs_open",
  ]) {
    for (const net of krtSummaryNetNames(summary[key])) incomplete.add(net)
  }
  return new Set(attemptedNets.filter((net) => incomplete.has(net)))
}

function boardStem(path: string) {
  return path.slice(0, -extname(path).length)
}

function samePath(left: string, right: string) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

async function exists(path: string) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function copySidecars(sourceBoard: string, targetBoard: string) {
  for (const suffix of [".kicad_pro", ".kicad_dru", ".kicad_prl"]) {
    const source = `${boardStem(sourceBoard)}${suffix}`
    if (await exists(source)) await copyFile(source, `${boardStem(targetBoard)}${suffix}`)
  }
}

async function nativeHoleToHoleRule(boardPath: string) {
  try {
    const source = JSON.parse(await readFile(`${boardStem(boardPath)}.kicad_pro`, "utf8")) as JsonRecord
    const board = source.board && typeof source.board === "object" ? source.board as JsonRecord : {}
    const settings = board.design_settings && typeof board.design_settings === "object"
      ? board.design_settings as JsonRecord
      : {}
    const rules = settings.rules && typeof settings.rules === "object" ? settings.rules as JsonRecord : {}
    const value = Number(rules.min_hole_to_hole)
    return Number.isFinite(value) && value > 0 ? value : 0.001
  } catch {
    return 0.001
  }
}

async function sha256(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

function nodeNetName(root: SExpression[], node: SExpression[]) {
  const net = findChild(node, "net")
  if (!net) return ""
  if (net.length >= 3) return atom(net[2]) ?? ""
  const number = atom(net[1]) ?? ""
  if (!/^\d+$/.test(number)) return number
  return atom(listChildren(root, "net").find((entry) => atom(entry[1]) === number)?.[2]) ?? ""
}

function copperCounts(root: SExpression[]) {
  const byNet = (head: "segment" | "arc" | "via") => {
    const output: Record<string, number> = {}
    for (const item of listChildren(root, head)) {
      const net = nodeNetName(root, item)
      output[net] = (output[net] ?? 0) + 1
    }
    return output
  }
  return {
    segments: listChildren(root, "segment").length,
    arcs: listChildren(root, "arc").length,
    vias: listChildren(root, "via").length,
    zones: listChildren(root, "zone").length,
    byNet: {
      segments: byNet("segment"),
      arcs: byNet("arc"),
      vias: byNet("via"),
    },
  }
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  const started = performance.now()
  return new Promise((resolvePromise) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let processError: string | undefined
    let settled = false
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    })
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => { stdout += chunk })
    child.stderr?.on("data", (chunk: string) => { stderr += chunk })
    child.on("error", (error) => { processError = errorText(error) })
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        elapsedMs: performance.now() - started,
        stdout,
        stderr,
        ...(processError ? { error: processError } : {}),
      })
    }
    child.on("close", (code, signal) => finish(code, signal))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
  })
}

async function runNativeDrc(
  boardPath: string,
  reportPath: string,
  config: WorkflowConfig,
  refill: boolean,
): Promise<NativeDrcResult> {
  const args = [
    "pcb", "drc",
    "--format", "json",
    "--severity-all",
    "--all-track-errors",
    ...(refill ? ["--refill-zones", "--save-board"] : []),
    "--output", reportPath,
    boardPath,
  ]
  const process = await runProcess(config.kicadCli, args, dirname(boardPath), config.timeoutMs)
  let report: JsonRecord | undefined
  try {
    report = JSON.parse(await readFile(reportPath, "utf8")) as JsonRecord
  } catch {}
  await Promise.all([
    writeFile(`${reportPath}.stdout.log`, process.stdout),
    writeFile(`${reportPath}.stderr.log`, process.stderr),
    writeFile(`${reportPath}.process.json`, `${JSON.stringify({ ...process, stdout: undefined, stderr: undefined }, null, 2)}\n`),
  ])
  return { process, report, reportPath }
}

function classRule(rules: PcbRoutingRules, net: string) {
  const name = netClassFor(rules, net)
  return rules.classes.find((rule) => rule.name === name)
    ?? rules.classes.find((rule) => rule.name === "Default")!
}

function geometryRulesForNet(rules: PcbRoutingRules, net: string) {
  const netRule = classRule(rules, net)
  const trackWidth = Math.max(rules.minimumTrackWidth, netRule.trackWidth)
  return {
    obstacleClearanceMm: Math.max(rules.minimumClearance, netRule.clearance),
    minimumCorridorWidthMm: trackWidth * 3,
  }
}

async function readSpecialIntent(path: string): Promise<SpecialIntent> {
  const source = JSON.parse(await readFile(path, "utf8")) as unknown
  const raw = source && typeof source === "object" ? source as Partial<SpecialIntent> : {}
  const power = parsePowerIntent(source)
  return {
    version: 1,
    diffPairs: Array.isArray(raw.diffPairs) ? raw.diffPairs.map((pair) => ({
      positive: String(pair.positive ?? ""),
      negative: String(pair.negative ?? ""),
    })) : [],
    matchedGroups: Array.isArray(raw.matchedGroups)
      ? raw.matchedGroups.map((group) => group.map(String))
      : [],
    lengthMatchToleranceMm: Number(raw.lengthMatchToleranceMm ?? 0.1),
    meanderAmplitudeMm: Number(raw.meanderAmplitudeMm ?? 0.2),
    meanderSpacingWidths: Number(raw.meanderSpacingWidths ?? 2),
    powerNets: power.powerNets ?? [],
    manufacturing: power.manufacturing ?? {},
  }
}

async function writeFabOverrides(
  path: string,
  values: { trackWidth: number; clearance: number; viaSize: number; viaDrill: number; holeToHole: number; boardEdge: number },
) {
  const annular = Math.max((values.viaSize - values.viaDrill) / 2, 0.001)
  await writeFile(path, [
    `track_width = ${values.trackWidth}`,
    `clearance = ${values.clearance}`,
    `via_diameter = ${values.viaSize}`,
    `via_drill = ${values.viaDrill}`,
    `hole_to_hole = ${values.holeToHole}`,
    `pad_hole_to_hole = ${values.holeToHole}`,
    `annular = ${annular}`,
    `board_edge = ${values.boardEdge}`,
    "",
  ].join("\n"))
}

async function buildKrtRemainingSpec(
  config: WorkflowConfig,
  routingRules: PcbRoutingRules,
  powerIntent: CompiledPowerIntent | undefined,
  specialIntent: SpecialIntent,
  nets: readonly string[],
  fabPath: string,
): Promise<KrtStageSpec> {
  const netRules = nets.map((net) => classRule(routingRules, net))
  const values = {
    trackWidth: Math.max(routingRules.minimumTrackWidth, 0.001),
    clearance: Math.max(
      routingRules.minimumClearance,
      ...netRules.map((rule) => rule.clearance),
    ),
    viaSize: Math.max(
      routingRules.minimumViaDiameter,
      ...[...(powerIntent?.nets ?? [])
        .filter((item) => item.status === "ready")
        .map((item) => item.viaDiameterMm), 0.001],
    ),
    viaDrill: Math.max(
      routingRules.minimumViaDrill,
      ...[...(powerIntent?.nets ?? [])
        .filter((item) => item.status === "ready")
        .map((item) => item.viaDrillMm), 0.001],
    ),
    holeToHole: await nativeHoleToHoleRule(config.rulesBoard),
    boardEdge: Math.max(0.001, routingRules.copperEdgeClearance),
  }
  await writeFabOverrides(fabPath, values)
  const compiledPowerByNet = new Map((powerIntent?.nets ?? [])
    .filter((item) => item.status === "ready")
    .map((item) => [item.net, item]))
  return {
    pythonPath: config.pythonPath,
    pythonPathEntries: config.pythonPathEntries,
    krtDirectory: config.krtDirectory,
    timeoutMs: config.timeoutMs,
    layers: ["F.Cu", "B.Cu"],
    rules: {
      ...values,
      gridStep: 0.05,
      holeToHoleClearance: values.holeToHole,
      boardEdgeClearance: values.boardEdge,
      routingClearanceMargin: 1,
    },
    fabOverridesPath: fabPath,
    diffPairs: config.skipSpecial ? [] : specialIntent.diffPairs,
    matchedGroups: config.skipSpecial ? [] : specialIntent.matchedGroups,
    remainingNets: [...nets],
    powerNets: nets.flatMap((net) => {
      const power = compiledPowerByNet.get(net)
      return power ? [{ net, width: power.requiredTrackWidthMm }] : []
    }),
    ordering: config.krtOrdering,
    preserveNetOrder: true,
    enableNetRescue: config.krtNetRescue,
    enableTerminalEscalation: false,
    maxIterations: config.krtMaxIterations,
    maxProbeIterations: config.krtMaxProbeIterations,
    maxRipup: config.krtMaxRipup,
    heuristicWeight: config.krtHeuristicWeight,
    viaCost: config.krtViaCost,
    viaProximityCost: config.krtViaProximityCost,
    turnCost: config.krtTurnCost,
    directionPreferenceCost: config.krtDirectionPreferenceCost,
    collectStats: true,
    debugMemory: true,
    filledCopperProxy: true,
  }
}

function krtStageStatus(result: KrtProcessResult): WorkflowStage["status"] {
  if (result.status === "skipped") return "skipped"
  if (result.status !== "completed") return "error"
  return result.diagnostics.some((item) => item.severity === "error") ? "partial" : "ok"
}

function krtDiagnostics(result: KrtProcessResult): WorkflowDiagnostic[] {
  return result.diagnostics.map((item) => ({ ...item }))
}

function freeroutingStageStatus(result: FreeroutingProcessResult): WorkflowStage["status"] {
  if (result.status === "skipped") return "skipped"
  if (result.status !== "completed") return "error"
  return result.diagnostics.some((item) => item.severity === "error") ? "partial" : "ok"
}

function easyEdaWasmStageStatus(result: EasyEdaWasmProcessResult): WorkflowStage["status"] {
  if (result.status === "skipped") return "skipped"
  if (result.status !== "completed") return result.attempted ? "partial" : "error"
  return result.diagnostics.some((item) => item.severity === "error") ? "partial" : "ok"
}

function readRemainingBackend(value: string | undefined): WorkflowConfig["remainingBackend"] {
  const normalized = String(value ?? "krt").trim().toLowerCase()
  if (normalized === "krt" || normalized === "freerouting" || normalized === "easyeda-wasm") return normalized
  return "krt"
}

function readKrtOrdering(value: string | undefined): WorkflowConfig["krtOrdering"] {
  // Retain the legacy environment reader without allowing it to change the
  // single managed ordering policy.
  void value
  return "mps"
}

function readNetScheduling(value: string | undefined): WorkflowConfig["netScheduling"] {
  return value === "ordered" || value === "batched" || value === "singleton"
    ? value
    : "diagnostic"
}

function configFromEnvironment(): WorkflowConfig {
  const sourceBoard = resolve(process.argv[2] ?? process.env.COPILOT_ROUTER_BOARD ?? DEFAULT_BOARD)
  const rulesBoard = resolve(process.argv[3] ?? process.env.COPILOT_ROUTER_RULES_BOARD ?? DEFAULT_RULES_BOARD)
  const polygonDsl = resolve(process.argv[4] ?? process.env.COPILOT_ROUTER_POLYGON_DSL ?? "examples/powerbank.polygons.js")
  const specialIntentPath = resolve(process.argv[5] ?? process.env.COPILOT_ROUTER_SPECIAL_INTENT ?? "examples/powerbank.special.json")
  const resultDirectory = resolve(process.argv[6] ?? process.env.COPILOT_ROUTER_FULL_RESULT ?? "results/full-cycle")
  return {
    sourceBoard,
    rulesBoard,
    polygonDsl,
    specialIntentPath,
    resultDirectory,
    outputBoard: resolve(process.env.COPILOT_ROUTER_FULL_OUTPUT ?? join(resultDirectory, "Powerbank.full-cycle.kicad_pcb")),
    krtDirectory: process.env.COPILOT_ROUTER_KRT_DIR
      ? resolve(process.env.COPILOT_ROUTER_KRT_DIR)
      : "",
    pythonPath: process.env.COPILOT_ROUTER_PYTHON ?? "",
    pythonPathEntries: [],
    kicadCli: resolve(process.env.COPILOT_ROUTER_KICAD_CLI ?? DEFAULT_KICAD),
    timeoutMs: Number(process.env.COPILOT_ROUTER_FULL_TIMEOUT_MS ?? 10 * 60_000),
    remainingBackend: readRemainingBackend(process.env.COPILOT_ROUTER_REMAINING_BACKEND),
    freeroutingJar: process.env.COPILOT_ROUTER_FREEROUTING_JAR
      ? resolve(process.env.COPILOT_ROUTER_FREEROUTING_JAR)
      : "",
    javaPath: process.env.COPILOT_ROUTER_JAVA ?? "java",
    javacPath: process.env.COPILOT_ROUTER_JAVAC ?? "javac",
    kicadPythonPath: resolve(process.env.COPILOT_ROUTER_KICAD_PYTHON ?? DEFAULT_KICAD_PYTHON),
    freeroutingBridge: resolve(process.env.COPILOT_ROUTER_FREEROUTING_BRIDGE ?? "scripts/freerouting-kicad-bridge.py"),
    freeroutingRunner: resolve(process.env.COPILOT_ROUTER_FREEROUTING_RUNNER ?? "scripts/freerouting/ScopedFreeroutingRunner.java"),
    freeroutingMaxPasses: Number(process.env.COPILOT_ROUTER_FREEROUTING_MAX_PASSES ?? 100),
    freeroutingThreads: Number(process.env.COPILOT_ROUTER_FREEROUTING_THREADS ?? 4),
    krtViaCost: Number(process.env.COPILOT_ROUTER_KRT_VIA_COST ?? 50),
    krtViaProximityCost: Number(process.env.COPILOT_ROUTER_KRT_VIA_PROXIMITY_COST ?? 10),
    krtTurnCost: Number(process.env.COPILOT_ROUTER_KRT_TURN_COST ?? 1000),
    krtDirectionPreferenceCost: Number(process.env.COPILOT_ROUTER_KRT_DIRECTION_PREFERENCE_COST ?? 250),
    krtMaxRipup: Number(process.env.COPILOT_ROUTER_KRT_MAX_RIPUP ?? 5),
    krtMaxIterations: Number(process.env.COPILOT_ROUTER_KRT_MAX_ITERATIONS ?? 1_000_000),
    krtMaxProbeIterations: Number(process.env.COPILOT_ROUTER_KRT_MAX_PROBE_ITERATIONS ?? 50_000),
    krtHeuristicWeight: Number(process.env.COPILOT_ROUTER_KRT_HEURISTIC_WEIGHT ?? 1.2),
    krtOrdering: readKrtOrdering(process.env.COPILOT_ROUTER_KRT_ORDERING),
    netScheduling: readNetScheduling(process.env.COPILOT_ROUTER_NET_SCHEDULING),
    krtNetRescue: process.env.COPILOT_ROUTER_KRT_NET_RESCUE === "1",
    completionRuns: Number(process.env.COPILOT_ROUTER_COMPLETION_MAX_RUNS ?? 5),
    skipSpecial: process.env.COPILOT_ROUTER_SKIP_SPECIAL === "1",
  }
}

async function main() {
  const config = configFromEnvironment()
  await mkdir(config.resultDirectory, { recursive: true })
  const stages: WorkflowStage[] = []
  const started = performance.now()
  let sourceHash = ""
  let baselineReport: JsonRecord | undefined
  let latestBoard: string | undefined
  let baselineBoard: string | undefined
  let plans: ZonePlan[] = []
  let planeIntents: PlaneIntent[] = []
  let specialIntent: SpecialIntent | undefined
  let compiledPowerIntent: CompiledPowerIntent | undefined
  let sourcePlacementRoot: SExpression[] | undefined
  let remainingKrtSummary: Record<string, unknown> | undefined
  let preflightBlocked = false

  try {
    const preflightDiagnostics: WorkflowDiagnostic[] = []
    const needsKrt = !config.skipSpecial
      || config.remainingBackend === "krt"
      || config.completionRuns > 0
    if (needsKrt) {
      try {
        const runtime = await prepareKrtRuntime({
          krtDirectory: config.krtDirectory || undefined,
          pythonPath: config.pythonPath || undefined,
        })
        config.krtDirectory = runtime.directory
        config.pythonPath = runtime.pythonPath
        config.pythonPathEntries = [...runtime.pythonPathEntries]
        preflightDiagnostics.push(diagnostic(
          "KRT_RUNTIME_READY",
          "info",
          `KRT ${runtime.version} is ready from the managed ${runtime.source}.`,
          { cacheDirectory: runtime.cacheDirectory },
        ))
      } catch (error) {
        preflightDiagnostics.push(diagnostic(
          "KRT_RUNTIME_UNAVAILABLE",
          "error",
          `Could not prepare the managed KRT backend: ${errorText(error)}`,
        ))
      }
    }
    if (config.remainingBackend === "freerouting") {
      try {
        const runtime = await prepareFreeroutingRuntime({
          jarPath: config.freeroutingJar || undefined,
        })
        config.freeroutingJar = runtime.jarPath
        preflightDiagnostics.push(diagnostic(
          "FREEROUTING_RUNTIME_READY",
          "info",
          `Freerouting ${runtime.version} is ready from the managed ${runtime.source}.`,
          { cacheDirectory: runtime.cacheDirectory },
        ))
      } catch (error) {
        preflightDiagnostics.push(diagnostic(
          "FREEROUTING_RUNTIME_UNAVAILABLE",
          "error",
          `Could not prepare the managed Freerouting backend: ${errorText(error)}`,
        ))
      }
    }
    const requiredPaths: Array<readonly [string, string]> = [
      ["source board", config.sourceBoard],
      ["rules board", config.rulesBoard],
      ["polygon DSL", config.polygonDsl],
      ["special intent", config.specialIntentPath],
      ["KiCad CLI", config.kicadCli],
    ]
    if (!config.skipSpecial && config.krtDirectory) requiredPaths.push([
      "KRT route_diff", join(config.krtDirectory, "py_router", "route_diff.py"),
    ])
    if ((config.remainingBackend === "krt" || config.completionRuns > 0) && config.krtDirectory) requiredPaths.push([
      "KRT route", join(config.krtDirectory, "py_router", "route.py"),
    ])
    if (config.remainingBackend === "freerouting") requiredPaths.push(
      ...(config.freeroutingJar ? [["Freerouting JAR", config.freeroutingJar] as const] : []),
      ["KiCad Python", config.kicadPythonPath],
      ["Freerouting KiCad bridge", config.freeroutingBridge],
      ["scoped Freerouting runner", config.freeroutingRunner],
    )
    for (const [label, path] of requiredPaths) {
      if (!(await exists(path))) preflightDiagnostics.push(diagnostic(
        "PREFLIGHT_INPUT_MISSING", "error", `${label} was not found.`, { path },
      ))
    }
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
      preflightDiagnostics.push(diagnostic("PREFLIGHT_INVALID_TIMEOUT", "error", "Workflow timeout must be positive."))
    }
    if (!Number.isInteger(config.completionRuns) || config.completionRuns < 0 || config.completionRuns > 5) {
      preflightDiagnostics.push(diagnostic(
        "PREFLIGHT_INVALID_COMPLETION_RUNS",
        "error",
        "Completion portfolio size must be an integer from 0 to 5.",
        { value: config.completionRuns },
      ))
    }
    const krtQualityValues = [
      ["via cost", config.krtViaCost, false],
      ["via proximity cost", config.krtViaProximityCost, true],
      ["turn cost", config.krtTurnCost, true],
      ["direction preference cost", config.krtDirectionPreferenceCost, true],
      ["max rip-up", config.krtMaxRipup, false],
      ["maximum iterations", config.krtMaxIterations, false],
      ["maximum probe iterations", config.krtMaxProbeIterations, false],
      ["heuristic weight", config.krtHeuristicWeight, false],
    ] as const
    for (const [label, value, allowZero] of krtQualityValues) {
      if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) preflightDiagnostics.push(diagnostic(
        "PREFLIGHT_INVALID_KRT_QUALITY",
        "error",
        `KRT ${label} must be ${allowZero ? "non-negative" : "positive"}.`,
        { value },
      ))
    }
    if (config.remainingBackend === "freerouting"
      && (!Number.isInteger(config.freeroutingMaxPasses) || config.freeroutingMaxPasses <= 0)) {
      preflightDiagnostics.push(diagnostic(
        "PREFLIGHT_INVALID_FREEROUTING_CONFIG", "error", "Freerouting max passes must be a positive integer.",
      ))
    }
    if (config.remainingBackend === "freerouting"
      && (!Number.isInteger(config.freeroutingThreads) || config.freeroutingThreads <= 0)) {
      preflightDiagnostics.push(diagnostic(
        "PREFLIGHT_INVALID_FREEROUTING_CONFIG", "error", "Freerouting threads must be a positive integer.",
      ))
    }
    if (samePath(config.sourceBoard, config.outputBoard)) {
      preflightDiagnostics.push(diagnostic(
        "PREFLIGHT_SOURCE_OUTPUT_COLLISION",
        "error",
        "The final output board must not overwrite the immutable source board.",
        { sourceBoard: config.sourceBoard, outputBoard: config.outputBoard },
      ))
    }

    if (!preflightDiagnostics.some((item) => item.severity === "error")) {
      sourceHash = await sha256(config.sourceBoard)
      specialIntent = await readSpecialIntent(config.specialIntentPath)
      const memberSet = new Set<string>()
      for (const pair of specialIntent.diffPairs) {
        if (!pair.positive || !pair.negative || pair.positive === pair.negative) {
          preflightDiagnostics.push(diagnostic("SPECIAL_INTENT_INVALID", "error", "Every diff pair needs two distinct nets.", pair))
        }
        for (const net of [pair.positive, pair.negative]) {
          if (memberSet.has(net)) preflightDiagnostics.push(diagnostic("SPECIAL_INTENT_INVALID", "error", `${net} belongs to multiple pairs.`))
          memberSet.add(net)
        }
      }
      for (const [index, group] of specialIntent.matchedGroups.entries()) {
        if (group.length < 2 || new Set(group).size !== group.length) preflightDiagnostics.push(diagnostic(
          "SPECIAL_INTENT_INVALID",
          "error",
          `Matched group ${index} needs at least two distinct nets.`,
          group,
        ))
      }
      const sourceDocument = await readPcb(config.sourceBoard)
      const sourceRoot = parsePcbSource(sourceDocument.source)
      sourcePlacementRoot = structuredClone(sourceRoot)
      const sourceRules = await readPcbRoutingRules(config.rulesBoard)
      compiledPowerIntent = compilePowerIntent(
        specialIntent,
        sourceRoot,
        sourceRules,
        [...pcbNetNames(sourceRoot)],
      )
      await writeFile(
        resolve(config.resultDirectory, "00-power-intent.json"),
        `${JSON.stringify(compiledPowerIntent, null, 2)}\n`,
      )
      for (const item of compiledPowerIntent.diagnostics) preflightDiagnostics.push(diagnostic(
        item.code,
        item.severity,
        item.message,
        { net: item.net, details: item.details },
      ))
    }
    preflightBlocked = preflightDiagnostics.some((item) => item.severity === "error")
    stages.push({
      stage: "preflight",
      status: preflightBlocked ? "error" : "ok",
      diagnostics: preflightDiagnostics,
      metrics: { sourceHash, remainingBackend: config.remainingBackend },
    })

    if (!preflightBlocked) {
      baselineBoard = resolve(config.resultDirectory, "00-baseline.kicad_pcb")
      const source = await readPcb(config.sourceBoard)
      const baselineRoot = parsePcbSource(source.source)
      clearRouting(baselineRoot)
      removeKicadZones(baselineRoot)
      await writeFile(baselineBoard, serializePcb(baselineRoot))
      await copySidecars(config.rulesBoard, baselineBoard)
      // This clean snapshot remains a technically valid hand-off artifact when
      // polygon planning itself fails. Stage diagnostics are non-fatal; later
      // routers must not be skipped merely because no polygon board was made.
      latestBoard = baselineBoard
      const baseline = await runNativeDrc(
        baselineBoard,
        resolve(config.resultDirectory, "00-baseline-drc.json"),
        config,
        false,
      )
      const baselineCompleted = baseline.process.exitCode === 0
        && !baseline.process.error
        && !baseline.process.timedOut
      baselineReport = baselineCompleted ? baseline.report : undefined
      if (!baselineReport) stages[0].diagnostics.push(diagnostic(
        "BASELINE_DRC_UNAVAILABLE",
        "error",
        "KiCad did not complete a readable baseline DRC run.",
        { exitCode: baseline.process.exitCode, timedOut: baseline.process.timedOut, error: baseline.process.error },
      ))
    }

    if (!preflightBlocked) {
      const polygonStarted = performance.now()
      const polygonDiagnostics: WorkflowDiagnostic[] = []
      const polygonBoard = resolve(config.resultDirectory, "01-polygons.kicad_pcb")
      try {
        const source = await readPcb(config.sourceBoard)
        const root = parsePcbSource(source.source)
        const removedRouting = clearRouting(root)
        const removedZones = removeKicadZones(root)
        const raw = kicadToRawPcb(root, { includeZones: false })
        // Compact zones derive their useful cross-section from target pads and
        // native polygon geometry. Applying the trace-current class here would
        // multiply its width again (`minimumCorridorWidth = 3 * trackWidth`),
        // making both the outline and obstacle search needlessly huge. Power
        // intent is compiled into trace backends and checked against final
        // exposed copper; the polygon planner keeps its independent geometry.
        const nativeRules = await readPcbRoutingRules(config.rulesBoard)
        const rules = nativeRules
        const program = runPolygonDsl(await readFile(config.polygonDsl, "utf8"))
        planeIntents = program.planes
        const result = planPolygons(raw, program, {
          rulesForNet: (net) => geometryRulesForNet(rules, net),
        })
        plans = result.plans
        for (const plan of plans) {
          if (plan.status === "error") polygonDiagnostics.push(diagnostic(
            "POLYGON_PLAN_ERROR", "error", plan.reason ?? `Polygon plan failed for ${plan.net}.`,
            { net: plan.net, layer: plan.layer },
          ))
          if (plan.status === "ready" && plan.boundary && !isOctilinearBoundary(plan.boundary)) {
            polygonDiagnostics.push(diagnostic(
              "POLYGON_NON_OCTILINEAR", "error", `Polygon ${plan.net} contains a non-0/45/90 edge.`,
            ))
            plan.status = "error"
            plan.reason = "compact boundary contains an angle other than 0/45/90 degrees"
          }
        }
        const readyPlans = plans.filter((plan) => plan.status === "ready")
        const failedPolygonNets = new Set(plans
          .filter((plan) => plan.status === "error")
          .map((plan) => plan.net))
        const exported = appendPlannedZones(root, readyPlans, {
          clearanceForNet: (net) => Math.max(rules.minimumClearance, classRule(rules, net).clearance),
          minThickness: Math.max(0.05, rules.minimumTrackWidth),
        })
        await writeFile(polygonBoard, serializePcb(root))
        await copySidecars(config.rulesBoard, polygonBoard)
        if (compiledPowerIntent) await persistCompiledPowerRules(
          polygonBoard,
          nativeRules,
          compiledPowerIntent,
        )
        await Promise.all([
          writeFile(resolve(config.resultDirectory, "01-polygon-plans.json"), `${JSON.stringify(plans, null, 2)}\n`),
          writeFile(resolve(config.resultDirectory, "01-polygon-metrics.json"), `${JSON.stringify({
            removedRouting,
            removedZones,
            exported,
            failedPolygonNets: [...failedPolygonNets].sort(),
            ...result.metrics,
          }, null, 2)}\n`),
        ])
        const refill = await runNativeDrc(
          polygonBoard,
          resolve(config.resultDirectory, "01-polygons-drc.json"),
          config,
          true,
        )
        if (!refill.report) polygonDiagnostics.push(diagnostic(
          "POLYGON_REFILL_FAILED", "error", "KiCad did not produce a readable post-polygon DRC report.",
        ))
        if (refill.process.error || refill.process.timedOut) polygonDiagnostics.push(diagnostic(
          "POLYGON_REFILL_FAILED", "error", "KiCad polygon refill failed.", refill.process,
        ))
        if (await exists(polygonBoard)) {
          latestBoard = polygonBoard
          const refilled = await readPcb(polygonBoard)
          const validation = validateFilledPolygonPlans(
            kicadToRawPcb(parsePcbSource(refilled.source), { includeZones: true }),
            plans,
          )
          await writeFile(resolve(config.resultDirectory, "01-polygon-fill-validation.json"), `${JSON.stringify(validation, null, 2)}\n`)
          for (const item of validation.diagnostics.filter((entry) => entry.status === "error")) {
            polygonDiagnostics.push(diagnostic(
              "POLYGON_REFILL_CONNECTIVITY", "error", item.reason ?? "Polygon refill did not connect its targets.", item,
            ))
          }
        }
        stages.push({
          stage: "polygons",
          status: polygonDiagnostics.some((item) => item.severity === "error") ? "partial" : "ok",
          inputBoard: config.sourceBoard,
          outputBoard: latestBoard,
          diagnostics: polygonDiagnostics,
          metrics: { elapsedMs: performance.now() - polygonStarted, ...result.metrics },
        })
      } catch (error) {
        stages.push({
          stage: "polygons",
          status: "error",
          inputBoard: config.sourceBoard,
          outputBoard: latestBoard,
          diagnostics: [diagnostic("POLYGON_STAGE_FAILED", "error", errorText(error))],
          metrics: { elapsedMs: performance.now() - polygonStarted },
        })
      }
    } else {
      stages.push({ stage: "polygons", status: "skipped_due_to_dependency", diagnostics: [] })
    }

    let routingRules: PcbRoutingRules | undefined
    let allNets: string[] = []
    if (latestBoard && specialIntent) {
      try {
        const nativeRules = await readPcbRoutingRules(config.rulesBoard)
        routingRules = compiledPowerIntent
          ? withCompiledPowerRules(nativeRules, compiledPowerIntent)
          : nativeRules
        if (compiledPowerIntent) await persistCompiledPowerRules(
          latestBoard,
          nativeRules,
          compiledPowerIntent,
        )
        const board = await readPcb(latestBoard)
        allNets = [...pcbNetNames(parsePcbSource(board.source))]
      } catch {}
    }

    if (config.skipSpecial && latestBoard && specialIntent && routingRules) {
      stages.push({
        stage: "special",
        status: "skipped",
        inputBoard: latestBoard,
        outputBoard: latestBoard,
        diagnostics: [diagnostic(
          "SPECIAL_DISABLED_FOR_EXPERIMENT",
          "warning",
          "Special routing was deliberately skipped; all non-GND nets are delegated to Remaining.",
        )],
      })
    } else if (latestBoard && specialIntent && routingRules) {
      const specialInput = latestBoard
      const specialStarted = performance.now()
      try {
      const before = parsePcbSource((await readPcb(specialInput)).source)
      const zonesBefore = zoneOutlineSignatures(before)
      const specialNets = [...new Set([
        ...specialIntent.diffPairs.flatMap((pair) => [pair.positive, pair.negative]),
        ...specialIntent.matchedGroups.flat(),
      ])]
      const diffNets = [...new Set(specialIntent.diffPairs.flatMap((pair) => [pair.positive, pair.negative]))]
      const diffMemberSet = new Set(diffNets)
      const ordinaryMatchedNets = [...new Set(specialIntent.matchedGroups.flat()
        .filter((net) => !diffMemberSet.has(net)))]
      const diffRules = diffNets.map((net) => classRule(routingRules!, net))
      const ordinaryRules = ordinaryMatchedNets.map((net) => classRule(routingRules!, net))
      const widths = new Set(diffRules.map((rule) => Math.max(routingRules!.minimumTrackWidth, rule.diffPairWidth)))
      const clearances = new Set(diffRules.map((rule) => Math.max(routingRules!.minimumClearance, rule.clearance)))
      // KiCad netclass diff gap is an optimum, not a DRC minimum. KRT cannot
      // use a pair gap smaller than its routing clearance, so select the
      // stricter of the two without weakening either native hard rule.
      const gaps = new Set(diffRules.map((rule) => Math.max(
        Math.max(routingRules!.minimumClearance, rule.clearance),
        rule.diffPairGap,
      )))
      const viaSizes = new Set(diffRules.map((rule) => Math.max(routingRules!.minimumViaDiameter, rule.viaDiameter)))
      const viaDrills = new Set(diffRules.map((rule) => Math.max(routingRules!.minimumViaDrill, rule.viaDrill)))
      const ordinaryWidths = new Set(ordinaryRules.map((rule) => Math.max(routingRules!.minimumTrackWidth, rule.trackWidth)))
      const ordinaryClearances = new Set(ordinaryRules.map((rule) => Math.max(routingRules!.minimumClearance, rule.clearance)))
      const ordinaryViaSizes = new Set(ordinaryRules.map((rule) => Math.max(routingRules!.minimumViaDiameter, rule.viaDiameter)))
      const ordinaryViaDrills = new Set(ordinaryRules.map((rule) => Math.max(routingRules!.minimumViaDrill, rule.viaDrill)))
      const specDiagnostics: WorkflowDiagnostic[] = []
      if ([widths, clearances, gaps, viaSizes, viaDrills, ordinaryViaSizes, ordinaryViaDrills]
        .some((set) => set.size > 1)) {
        specDiagnostics.push(diagnostic(
          "LOSSY_RULE_TRANSLATION",
          "error",
          "Each batched KRT special subcall requires common clearance/via geometry across its submitted nets.",
          {
            diff: { widths: [...widths], clearances: [...clearances], gaps: [...gaps], viaSizes: [...viaSizes], viaDrills: [...viaDrills] },
            ordinary: { widths: [...ordinaryWidths], clearances: [...ordinaryClearances], viaSizes: [...ordinaryViaSizes], viaDrills: [...ordinaryViaDrills] },
          },
        ))
      }
      if (!specDiagnostics.length) {
        const specialOutput = resolve(config.resultDirectory, "02-special.kicad_pcb")
        const specialProxyInput = resolve(config.resultDirectory, "02-special-proxy-input.kicad_pcb")
        const specialProxyOutput = resolve(config.resultDirectory, "02-special-proxy-output.kicad_pcb")
        const specialProxyRoot = structuredClone(before)
        const specialProxyManifest = appendFilledCopperProxy(specialProxyRoot, {
          widthMm: 0.1,
          pitchMm: Math.max(0.2, routingRules.minimumClearance),
        })
        await writeFile(specialProxyInput, serializePcb(specialProxyRoot))
        await copySidecars(specialInput, specialProxyInput)
        await writeFile(
          resolve(config.resultDirectory, "02-filled-copper-proxy.json"),
          `${JSON.stringify(specialProxyManifest, null, 2)}\n`,
        )
        const fabPath = resolve(config.resultDirectory, "02-special-fab.txt")
        const ordinaryFabPath = resolve(config.resultDirectory, "02-special-ordinary-fab.txt")
        const fallbackRule = classRule(routingRules!, specialNets[0] ?? "")
        const values = {
          trackWidth: [...widths][0] ?? Math.max(routingRules.minimumTrackWidth, fallbackRule.diffPairWidth),
          clearance: [...clearances][0] ?? Math.max(routingRules.minimumClearance, fallbackRule.clearance),
          viaSize: [...viaSizes][0] ?? Math.max(routingRules.minimumViaDiameter, fallbackRule.viaDiameter),
          viaDrill: [...viaDrills][0] ?? Math.max(routingRules.minimumViaDrill, fallbackRule.viaDrill),
          holeToHole: await nativeHoleToHoleRule(config.rulesBoard),
          boardEdge: Math.max(0.001, routingRules.copperEdgeClearance),
        }
        const ordinaryValues = {
          trackWidth: Math.min(...ordinaryWidths, values.trackWidth),
          // route.py honors per-net netclass clearances when --clearance is
          // omitted; this value is only the hard fabrication floor.
          clearance: ordinaryClearances.size
            ? Math.min(...ordinaryClearances)
            : values.clearance,
          viaSize: [...ordinaryViaSizes][0] ?? values.viaSize,
          viaDrill: [...ordinaryViaDrills][0] ?? values.viaDrill,
          holeToHole: values.holeToHole,
          boardEdge: values.boardEdge,
        }
        await writeFabOverrides(fabPath, values)
        if (ordinaryMatchedNets.length) await writeFabOverrides(ordinaryFabPath, ordinaryValues)
        const krtSpec: KrtStageSpec = {
          pythonPath: config.pythonPath,
          pythonPathEntries: config.pythonPathEntries,
          krtDirectory: config.krtDirectory,
          timeoutMs: config.timeoutMs,
          layers: ["F.Cu", "B.Cu"],
          rules: {
            ...values,
            diffPairGap: [...gaps][0] ?? values.clearance,
            gridStep: 0.05,
            holeToHoleClearance: values.holeToHole,
            boardEdgeClearance: values.boardEdge,
            routingClearanceMargin: 1,
            lengthMatchTolerance: specialIntent.lengthMatchToleranceMm,
            meanderAmplitude: specialIntent.meanderAmplitudeMm,
            meanderSpacing: specialIntent.meanderSpacingWidths,
          },
          fabOverridesPath: fabPath,
          ordinaryMatchedRules: {
            ...ordinaryValues,
            gridStep: 0.05,
            holeToHoleClearance: ordinaryValues.holeToHole,
            boardEdgeClearance: ordinaryValues.boardEdge,
            routingClearanceMargin: 1,
            lengthMatchTolerance: specialIntent.lengthMatchToleranceMm,
            meanderAmplitude: specialIntent.meanderAmplitudeMm,
            meanderSpacing: specialIntent.meanderSpacingWidths,
          },
          ordinaryMatchedFabOverridesPath: ordinaryFabPath,
          diffPairs: config.skipSpecial ? [] : specialIntent.diffPairs,
          matchedGroups: config.skipSpecial ? [] : specialIntent.matchedGroups,
          remainingNets: [],
          ordering: config.krtOrdering,
          preserveNetOrder: true,
          maxIterations: config.krtMaxIterations,
          maxProbeIterations: config.krtMaxProbeIterations,
          maxRipup: config.krtMaxRipup,
          heuristicWeight: config.krtHeuristicWeight,
          viaCost: config.krtViaCost,
          viaProximityCost: config.krtViaProximityCost,
          turnCost: config.krtTurnCost,
          directionPreferenceCost: config.krtDirectionPreferenceCost,
          debugMemory: true,
          filledCopperProxy: true,
        }
        const result = await runKrtSpecial(
          specialProxyInput,
          specialProxyOutput,
          krtSpec,
          config.resultDirectory,
        )
        const backendBoard = await exists(specialProxyOutput) ? specialProxyOutput : specialProxyInput
        const diagnostics = krtDiagnostics(result)
        const specialAfter = parsePcbSource((await readPcb(backendBoard)).source)
        const specialProxyRemoval = removeFilledCopperProxy(specialAfter, specialProxyManifest)
        if (specialProxyManifest.zonesWithoutNativeFill.length
          || specialProxyManifest.components.some((component) => component.proxySegments === 0)) {
          diagnostics.push(diagnostic(
            "SPECIAL_FILLED_COPPER_PROXY_INCOMPLETE",
            "error",
            "KRT special did not receive a complete model of native filled power copper.",
            specialProxyManifest,
          ))
        }
        if (specialProxyRemoval.missingUuids.length) diagnostics.push(diagnostic(
          "SPECIAL_FILLED_COPPER_PROXY_CUSTODY_LOST",
          "error",
          "KRT special changed or removed temporary filled-copper geometry before cleanup.",
          specialProxyRemoval,
        ))
        await writeFile(specialOutput, serializePcb(specialAfter))
        await copySidecars(backendBoard, specialOutput)
        const afterBoard = specialOutput
        if (await exists(specialOutput)) {
          // KRT preserves zone nodes but does not route against exact native
          // fill contours. Refill immediately so the remaining pass sees the
          // real post-special copper, not stale pre-route filled polygons.
          const refill = await runNativeDrc(
            specialOutput,
            resolve(config.resultDirectory, "02-special-drc.json"),
            config,
            true,
          )
          if (!refill.report || refill.process.error || refill.process.timedOut) {
            diagnostics.push(diagnostic(
              "SPECIAL_REFILL_FAILED",
              "error",
              "KiCad did not complete the refill between special and remaining routing.",
              refill.process,
            ))
          }
        }
        const after = parsePcbSource((await readPcb(afterBoard)).source)
        if (!sameStrings(zonesBefore, zoneOutlineSignatures(after))) diagnostics.push(diagnostic(
          "KRT_ZONE_OUTLINES_CHANGED", "error", "KRT changed or removed power zone outlines.",
        ))
        latestBoard = afterBoard
        stages.push({
          stage: "special",
          status: diagnostics.some((item) => item.severity === "error")
            ? (result.attempted ? "partial" : "error")
            : krtStageStatus(result),
          inputBoard: result.inputBoard,
          outputBoard: latestBoard,
          diagnostics,
          metrics: { elapsedMs: result.elapsedMs, attempted: result.attempted, exitCode: result.exitCode },
          details: result,
        })
      } else {
        stages.push({ stage: "special", status: "error", inputBoard: specialInput, outputBoard: specialInput, diagnostics: specDiagnostics })
      }
      } catch (error) {
        // A failed backend invocation, refill, or artifact inspection must not
        // poison the hand-off chain. Keep the last board that was known usable
        // before this stage and let ordinary routing/final validation continue.
        latestBoard = specialInput
        stages.push({
          stage: "special",
          status: "error",
          inputBoard: specialInput,
          outputBoard: specialInput,
          diagnostics: [diagnostic("SPECIAL_STAGE_FAILED", "error", errorText(error))],
          metrics: { elapsedMs: performance.now() - specialStarted },
        })
      }
    } else {
      stages.push({ stage: "special", status: "skipped_due_to_dependency", diagnostics: [] })
    }

    if (latestBoard && specialIntent && routingRules) {
      const remainingInput = latestBoard
      const remainingStarted = performance.now()
      try {
      const specialNets = new Set(config.skipSpecial ? [] : [
        ...specialIntent.diffPairs.flatMap((pair) => [pair.positive, pair.negative]),
        ...specialIntent.matchedGroups.flat(),
      ])
      // Polygon intents are local copper ownership, not whole-net ownership.
      // A multi-point power net can have several valid local islands that still
      // need the ordinary router to connect them. The selected backend receives
      // the complete remaining non-GND scope and may reuse portions already
      // connected by native refill.
      const groundNets = allNets.filter((net) => net.toUpperCase() === "GND")
      const remainingBoardRoot = parsePcbSource((await readPcb(remainingInput)).source)
      const filledConnectedNets = fullyConnectedByFilledCopperNets(remainingBoardRoot)
      const filledConnectedNetSet = new Set(filledConnectedNets)
      const remainingNets = allNets.filter((net) => net.toUpperCase() !== "GND"
        && !specialNets.has(net)
        && !filledConnectedNetSet.has(net))
      const netSchedule: NetSchedule = scheduleNets(
        kicadToRawPcb(remainingBoardRoot, { includeZones: true }),
        routingRules!,
        {
          nets: remainingNets,
          excludedNets: [...groundNets, ...specialNets, ...filledConnectedNets],
          layers: ["TOP", "BOTTOM"],
        },
      )
      const scheduledRemainingNets = config.netScheduling === "diagnostic"
        ? remainingNets
        : [
            ...netSchedule.orderedNets,
            ...remainingNets.filter((net) => !netSchedule.orderedNets.includes(net)).sort(),
          ]
      await writeFile(
        resolve(config.resultDirectory, "03-net-schedule.json"),
        `${JSON.stringify(netSchedule, null, 2)}\n`,
      )
      const remainingOutput = resolve(config.resultDirectory, "03-remaining.kicad_pcb")
      const proxyInput = resolve(config.resultDirectory, "03-remaining-proxy-input.kicad_pcb")
      const proxyOutput = resolve(config.resultDirectory, "03-remaining-proxy-output.kicad_pcb")
      const before = remainingBoardRoot
      const zonesBefore = zoneOutlineSignatures(before)
      const proxyRoot = structuredClone(before)
      const proxyManifest = appendFilledCopperProxy(proxyRoot, {
        // Native zone min_thickness is 0.1 mm on this workflow.  The proxy is
        // staging-only, so use that exact copper resolution rather than
        // weakening any routed track rule.
        widthMm: 0.1,
        pitchMm: Math.max(0.2, routingRules.minimumClearance),
      })
      await writeFile(proxyInput, serializePcb(proxyRoot))
      await copySidecars(remainingInput, proxyInput)
      await writeFile(
        resolve(config.resultDirectory, "03-filled-copper-proxy.json"),
        `${JSON.stringify(proxyManifest, null, 2)}\n`,
      )
      const proxyDiagnostics: WorkflowDiagnostic[] = []
      if (zonesBefore.length && !proxyManifest.segmentUuids.length) proxyDiagnostics.push(diagnostic(
        "FILLED_COPPER_PROXY_EMPTY",
        "error",
        "Native zones exist but no refilled copper could be materialized for the remaining router.",
      ))
      if (proxyManifest.zonesWithoutNativeFill.length) proxyDiagnostics.push(diagnostic(
        "FILLED_COPPER_PROXY_UNFILLED_ZONE",
        "error",
        "One or more power zones had no native filled_polygon after the special-stage refill.",
        proxyManifest.zonesWithoutNativeFill,
      ))
      const emptyComponents = proxyManifest.components.filter((component) => component.proxySegments === 0)
      if (emptyComponents.length) proxyDiagnostics.push(diagnostic(
        "FILLED_COPPER_PROXY_COMPONENT_EMPTY",
        "error",
        "One or more filled copper components were too narrow to model safely for the remaining router.",
        emptyComponents,
      ))
      let result: KrtProcessResult | FreeroutingProcessResult | EasyEdaWasmProcessResult
      if (config.remainingBackend === "freerouting") {
        const freeroutingSpec: FreeroutingStageSpec = {
          javaPath: config.javaPath,
          javacPath: config.javacPath,
          jarPath: config.freeroutingJar,
          kicadPythonPath: config.kicadPythonPath,
          bridgePath: config.freeroutingBridge,
          runnerSourcePath: config.freeroutingRunner,
          timeoutMs: config.timeoutMs,
          remainingNets: scheduledRemainingNets,
          excludedNets: [...groundNets, ...specialNets, ...filledConnectedNets],
          maxPasses: config.freeroutingMaxPasses,
          threads: config.freeroutingThreads,
          optimizerImprovementThreshold: 0.1,
          updateStrategy: "hybrid",
          itemSelectionStrategy: "prioritized",
          filledCopperProxy: true,
          filledCopperPadGroups: filledCopperPadGroups(before),
        }
        result = await runFreeroutingRemaining(
          proxyInput,
          proxyOutput,
          freeroutingSpec,
          config.resultDirectory,
        )
      } else if (config.remainingBackend === "easyeda-wasm") {
        const easyEdaSpec: EasyEdaWasmStageSpec = {
          timeoutMs: config.timeoutMs,
          remainingNets: scheduledRemainingNets,
          excludedNets: [...groundNets, ...specialNets, ...filledConnectedNets],
          routeLayers: ["F.Cu", "B.Cu"],
          rules: routingRules,
          clearanceMarginMm: 0,
          filledCopperProxy: true,
        }
        result = await runEasyEdaWasmRemaining(
          proxyInput,
          proxyOutput,
          easyEdaSpec,
          config.resultDirectory,
        )
      } else {
        const fabPath = resolve(config.resultDirectory, "03-remaining-fab.txt")
        const krtSpec = await buildKrtRemainingSpec(
          config,
          routingRules,
          compiledPowerIntent,
          specialIntent,
          scheduledRemainingNets,
          fabPath,
        )
        const powerNets = krtSpec.powerNets ?? []
        if (config.netScheduling === "ordered" || config.netScheduling === "batched") {
          krtSpec.ordering = "mps"
          krtSpec.preserveNetOrder = true
        }
        const priorityNets = netSchedule.tiers
          .find((tier) => tier.tier === "escape_critical")?.nets ?? []
        const laterNets = scheduledRemainingNets.filter((net) => !priorityNets.includes(net))
        if (config.netScheduling === "singleton") {
          const singletonCandidates = netSchedule.items
            .filter((item) => item.densePadCount > 0
              && item.denseDirectionChoices > 0
              && item.denseMinFreeDirections / item.denseDirectionChoices <= 0.25)
            .sort((left, right) =>
              left.denseMinFreeDirections / left.denseDirectionChoices
                - right.denseMinFreeDirections / right.denseDirectionChoices
              || right.spanMm - left.spanMm
              || right.priority - left.priority
              || left.net.localeCompare(right.net))
            .map((item) => item.net)
          let singletonBoard = proxyInput
          const acceptedSingletons: string[] = []
          const rejectedSingletons: string[] = []
          const singletonSubcalls: KrtProcessResult[] = []
          for (const [index, net] of singletonCandidates.entries()) {
            const singletonOutput = resolve(
              config.resultDirectory,
              `03-singleton-${String(index + 1).padStart(2, "0")}.kicad_pcb`,
            )
            const singletonResult = await runKrtRemaining(
              singletonBoard,
              singletonOutput,
              {
                ...krtSpec,
                remainingNets: [net],
                powerNets: powerNets.filter((item) => item.net === net),
              },
              resolve(config.resultDirectory, `03-singleton-${String(index + 1).padStart(2, "0")}-krt`),
            )
            singletonSubcalls.push(singletonResult)
            const complete = incompleteKrtNets(singletonResult, [net]).size === 0
              && !singletonResult.diagnostics.some((item) => item.severity === "error")
              && await exists(singletonOutput)
            if (!complete) {
              rejectedSingletons.push(net)
              continue
            }
            singletonBoard = singletonOutput
            acceptedSingletons.push(net)
            await persistKrtProtectedNets(singletonBoard, [net], "workflow-escape-singleton")
          }
          const recoveryNets = scheduledRemainingNets.filter((net) => !acceptedSingletons.includes(net))
          if (recoveryNets.length) {
            const recoveryResult = await runKrtRemaining(
              singletonBoard,
              proxyOutput,
              {
                ...krtSpec,
                remainingNets: recoveryNets,
                powerNets: powerNets.filter((item) => recoveryNets.includes(item.net)),
              },
              resolve(config.resultDirectory, "03-recovery-krt"),
            )
            result = {
              ...recoveryResult,
              inputBoard: proxyInput,
              elapsedMs: singletonSubcalls.reduce((sum, item) => sum + item.elapsedMs, 0)
                + recoveryResult.elapsedMs,
              jsonSummaries: [
                ...singletonSubcalls.flatMap((item) => item.jsonSummaries),
                ...recoveryResult.jsonSummaries,
              ],
              subcalls: [...singletonSubcalls, recoveryResult],
            }
          } else {
            await copyFile(singletonBoard, proxyOutput)
            await copySidecars(singletonBoard, proxyOutput)
            result = {
              ...singletonSubcalls[singletonSubcalls.length - 1],
              inputBoard: proxyInput,
              outputBoard: proxyOutput,
              elapsedMs: singletonSubcalls.reduce((sum, item) => sum + item.elapsedMs, 0),
              subcalls: singletonSubcalls,
            }
          }
          ;(result as KrtProcessResult & { singletonScheduling?: unknown }).singletonScheduling = {
            candidates: singletonCandidates,
            accepted: acceptedSingletons,
            rejected: rejectedSingletons,
          }
        } else if (config.netScheduling === "batched" && priorityNets.length && laterNets.length) {
          const priorityOutput = resolve(config.resultDirectory, "03-priority-proxy-output.kicad_pcb")
          const priorityResult = await runKrtRemaining(
            proxyInput,
            priorityOutput,
            {
              ...krtSpec,
              remainingNets: priorityNets,
              powerNets: powerNets.filter((item) => priorityNets.includes(item.net)),
            },
            resolve(config.resultDirectory, "03-priority-krt"),
          )
          const priorityBoard = await exists(priorityOutput) ? priorityOutput : proxyInput
          const incompletePriority = incompleteKrtNets(priorityResult, priorityNets)
          const protectedPriority = priorityNets.filter((net) => !incompletePriority.has(net))
          if (protectedPriority.length) await persistKrtProtectedNets(
            priorityBoard,
            protectedPriority,
            "workflow-escape-critical",
          )
          const recoveryNets = [
            ...priorityNets.filter((net) => incompletePriority.has(net)),
            ...laterNets,
          ]
          const recoveryResult = await runKrtRemaining(
            priorityBoard,
            proxyOutput,
            {
              ...krtSpec,
              remainingNets: recoveryNets,
              powerNets: powerNets.filter((item) => recoveryNets.includes(item.net)),
            },
            resolve(config.resultDirectory, "03-recovery-krt"),
          )
          result = {
            ...recoveryResult,
            inputBoard: proxyInput,
            elapsedMs: priorityResult.elapsedMs + recoveryResult.elapsedMs,
            jsonSummaries: [
              ...priorityResult.jsonSummaries,
              ...recoveryResult.jsonSummaries,
            ],
            subcalls: [priorityResult, recoveryResult],
          }
        } else {
          result = await runKrtRemaining(proxyInput, proxyOutput, krtSpec, config.resultDirectory)
        }
      }
      const backendBoard = await exists(proxyOutput) ? proxyOutput : proxyInput
      const after = parsePcbSource((await readPcb(backendBoard)).source)
      const proxyRemoval = removeFilledCopperProxy(after, proxyManifest)
      await writeFile(remainingOutput, serializePcb(after))
      await copySidecars(backendBoard, remainingOutput)
      const afterBoard = remainingOutput
      if (result.backend === "krt") remainingKrtSummary = result.jsonSummary
      const diagnostics: WorkflowDiagnostic[] = [
        ...proxyDiagnostics,
        ...result.diagnostics.map((item) => ({ ...item })),
      ]
      if (proxyRemoval.missingUuids.length) diagnostics.push(diagnostic(
        "FILLED_COPPER_PROXY_CUSTODY_LOST",
        "error",
        "The remaining backend changed or removed temporary filled-copper geometry before cleanup.",
        proxyRemoval,
      ))
      const leakedProxyUuids = new Set(proxyManifest.segmentUuids)
      const leakedProxy = listChildren(after, "segment")
        .map((segment) => atom(findChild(segment, "uuid")?.[1]) ?? "")
        .filter((uuid) => leakedProxyUuids.has(uuid))
      if (leakedProxy.length) diagnostics.push(diagnostic(
        "FILLED_COPPER_PROXY_LEAKED",
        "error",
        "Temporary filled-copper geometry leaked into the user-visible remaining board.",
        leakedProxy,
      ))
      if (!sameStrings(zonesBefore, zoneOutlineSignatures(after))) diagnostics.push(diagnostic(
        "REMAINING_ZONE_OUTLINES_CHANGED", "error", `${config.remainingBackend} changed or removed power zone outlines.`,
      ))
      const changedSpecial = changedCopperGeometryNets(before, after, [...specialNets])
      if (changedSpecial.length) diagnostics.push(diagnostic(
        "REMAINING_SPECIAL_COPPER_CHANGED", "error", "The remaining pass changed special-net copper.", changedSpecial,
      ))
      latestBoard = afterBoard
      stages.push({
        stage: "remaining",
        status: diagnostics.some((item) => item.severity === "error")
          ? (result.attempted ? "partial" : "error")
          : (result.backend === "freerouting"
            ? freeroutingStageStatus(result)
            : result.backend === "easyeda-wasm"
              ? easyEdaWasmStageStatus(result)
              : krtStageStatus(result)),
        inputBoard: result.inputBoard,
        outputBoard: latestBoard,
        diagnostics,
        metrics: {
          backend: config.remainingBackend,
          elapsedMs: result.elapsedMs,
          attempted: result.attempted,
          exitCode: result.exitCode,
          nets: scheduledRemainingNets.length,
          netSchedule: {
            strategy: netSchedule.strategy,
            tiers: netSchedule.tiers,
            orderedNets: netSchedule.orderedNets,
            backendOrderMode: config.remainingBackend === "krt"
              ? config.netScheduling
              : "diagnostic_only",
          },
          filledConnectedNets,
          filledCopperProxy: {
            segments: proxyManifest.segmentUuids.length,
            components: proxyManifest.components.length,
            removal: proxyRemoval,
          },
          ...(result.backend === "freerouting" || result.backend === "easyeda-wasm"
            ? { routerSummary: result.routerSummary }
            : {}),
        },
        details: result,
      })
      } catch (error) {
        latestBoard = remainingInput
        stages.push({
          stage: "remaining",
          status: "error",
          inputBoard: remainingInput,
          outputBoard: remainingInput,
          diagnostics: [diagnostic("REMAINING_STAGE_FAILED", "error", errorText(error))],
          metrics: { elapsedMs: performance.now() - remainingStarted },
        })
      }
    } else {
      stages.push({ stage: "remaining", status: "skipped_due_to_dependency", diagnostics: [] })
    }

    if (latestBoard && routingRules && specialIntent && baselineReport && sourcePlacementRoot) {
      const completionInput = latestBoard
      const completionBase = resolve(config.resultDirectory, "04-completion-base.kicad_pcb")
      const completionOutput = resolve(config.resultDirectory, "04-completion.kicad_pcb")
      const completionStarted = performance.now()
      try {
        await copyFile(completionInput, completionBase)
        await copySidecars(completionInput, completionBase)
        const baseValidation = await runNativeDrc(
          completionBase,
          resolve(config.resultDirectory, "04-completion-base-drc.json"),
          config,
          true,
        )
        const baseCompleted = baseValidation.process.exitCode === 0
          && !baseValidation.process.error
          && !baseValidation.process.timedOut
          && Boolean(baseValidation.report)
        if (!baseCompleted || !baseValidation.report) {
          latestBoard = completionBase
          stages.push({
            stage: "completion",
            status: "error",
            inputBoard: completionInput,
            outputBoard: completionBase,
            diagnostics: [diagnostic(
              "COMPLETION_BASE_VALIDATION_FAILED",
              "error",
              "KiCad did not produce a readable refilled board before completion routing.",
              baseValidation.process,
            )],
            metrics: { elapsedMs: performance.now() - completionStarted },
          })
        } else {
          const residual = summarizeFinalDrc(baselineReport, baseValidation.report).missingNonGroundNets
          const specialMembers = new Set(config.skipSpecial ? [] : [
            ...specialIntent.diffPairs.flatMap((pair) => [pair.positive, pair.negative]),
            ...specialIntent.matchedGroups.flat(),
          ])
          const routableResidual = residual.filter((net) => !specialMembers.has(net))
          const completionRoot = parsePcbSource((await readPcb(completionBase)).source)
          const completionSchedule = scheduleNets(
            kicadToRawPcb(completionRoot, { includeZones: true }),
            routingRules,
            {
              nets: routableResidual,
              excludedNets: [...pcbNetNames(completionRoot)].filter((net) => !routableResidual.includes(net)),
              layers: ["TOP", "BOTTOM"],
            },
          )
          const orderedResidual = [
            ...completionSchedule.orderedNets,
            ...routableResidual.filter((net) => !completionSchedule.orderedNets.includes(net)),
          ]
          const fabPath = resolve(config.resultDirectory, "04-completion-fab.txt")
          const krtSpec = await buildKrtRemainingSpec(
            config,
            routingRules,
            compiledPowerIntent,
            specialIntent,
            orderedResidual,
            fabPath,
          )
          const result = await runKrtCompletionPortfolio({
            inputBoard: completionBase,
            outputBoard: completionOutput,
            resultDirectory: resolve(config.resultDirectory, "04-completion-candidates"),
            residualNets: orderedResidual,
            baselineDrc: baselineReport,
            inputDrc: baseValidation.report,
            sourcePlacementBoard: config.sourceBoard,
            krtSpec,
            maximumRuns: config.completionRuns,
            blockerSummary: remainingKrtSummary,
            maximumBlockers: 8,
            proxyWidthMm: 0.1,
            proxyPitchMm: Math.max(0.2, routingRules.minimumClearance),
            runNativeValidation: async (boardPath, reportPath) => {
              const native = await runNativeDrc(boardPath, reportPath, config, true)
              return {
                completed: native.process.exitCode === 0
                  && !native.process.error
                  && !native.process.timedOut
                  && Boolean(native.report),
                report: native.report,
                elapsedMs: native.process.elapsedMs,
              }
            },
          })
          latestBoard = result.outputBoard
          const selected = result.candidates.find((candidate) => (
            candidate.index === result.selectedCandidateIndex
          ))!
          const diagnostics = result.diagnostics.map((item) => ({ ...item }))
          const specialResidual = residual.filter((net) => specialMembers.has(net))
          if (specialResidual.length) diagnostics.push(diagnostic(
            "COMPLETION_SPECIAL_NET_OPEN",
            "warning",
            "Special-net residuals stay owned by the atomic special stage and are not routed single-ended.",
            specialResidual,
          ))
          if (config.completionRuns > 0 && selected.metrics.missingNonGroundNets.length) diagnostics.push(diagnostic(
            "COMPLETION_NETS_REMAIN_OPEN",
            "warning",
            `${selected.metrics.missingNonGroundNets.length} non-GND net(s) remain after the completion portfolio.`,
            selected.metrics.missingNonGroundNets,
          ))
          stages.push({
            stage: "completion",
            status: config.completionRuns === 0
              ? "skipped"
              : diagnostics.some((item) => item.severity === "error")
              ? "error"
              : selected.metrics.missingNonGroundNets.length ? "partial" : "ok",
            inputBoard: completionInput,
            outputBoard: latestBoard,
            diagnostics,
            metrics: {
              elapsedMs: result.elapsedMs,
              requestedRuns: config.completionRuns,
              completedRuns: result.completedRuns,
              stoppedEarly: result.stoppedEarly,
              attemptedNets: result.attemptedNets,
              netSchedule: completionSchedule,
              selectedCandidateIndex: result.selectedCandidateIndex,
              selectedMetrics: selected.metrics,
            },
            details: result,
          })
        }
      } catch (error) {
        latestBoard = completionInput
        stages.push({
          stage: "completion",
          status: "error",
          inputBoard: completionInput,
          outputBoard: completionInput,
          diagnostics: [diagnostic("COMPLETION_STAGE_FAILED", "error", errorText(error))],
          metrics: { elapsedMs: performance.now() - completionStarted },
        })
      }
    } else {
      stages.push({
        stage: "completion",
        status: config.completionRuns > 0 ? "skipped_due_to_dependency" : "skipped",
        diagnostics: [],
      })
    }

    if (latestBoard && routingRules && planeIntents.length) {
      const groundInput = latestBoard
      const groundOutput = resolve(config.resultDirectory, "05-ground.kicad_pcb")
      const groundStarted = performance.now()
      try {
        await copyFile(groundInput, groundOutput)
        await copySidecars(groundInput, groundOutput)
        const document = await readPcb(groundOutput)
        const root = parsePcbSource(document.source)
        const manifest = applyPlaneStitching(root, planeIntents, routingRules, {
          holeToHoleMm: await nativeHoleToHoleRule(groundInput),
        })
        await writeFile(groundOutput, serializePcb(root))
        let refill = await runNativeDrc(
          groundOutput,
          resolve(config.resultDirectory, "05-ground-drc.json"),
          config,
          true,
        )
        await writeFile(
          resolve(config.resultDirectory, "05-ground-manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
        )
        let cleanup = { expected: manifest.generatedViaUuids.length, removed: 0, removedUuids: [] as string[] }
        if (refill.report && await exists(groundOutput)) {
          const refilled = await readPcb(groundOutput)
          const refilledRoot = parsePcbSource(refilled.source)
          cleanup = removeInvalidPlaneVias(refilledRoot, manifest, refill.report)
          if (cleanup.removed) {
            await writeFile(groundOutput, serializePcb(refilledRoot))
            refill = await runNativeDrc(
              groundOutput,
              resolve(config.resultDirectory, "05-ground-cleaned-drc.json"),
              config,
              true,
            )
          }
        }
        await writeFile(
          resolve(config.resultDirectory, "05-ground-cleanup.json"),
          `${JSON.stringify(cleanup, null, 2)}\n`,
        )
        latestBoard = groundOutput
        const diagnostics: WorkflowDiagnostic[] = []
        if (manifest.unsupportedRegions.length) diagnostics.push(diagnostic(
          "GROUND_REGION_UNSUPPORTED",
          "error",
          "components(...) plane regions are reserved but not implemented.",
          manifest.unsupportedRegions,
        ))
        if (manifest.padViaFailures.length) diagnostics.push(diagnostic(
          "GROUND_PAD_VIA_UNAVAILABLE",
          "warning",
          `${manifest.padViaFailures.length} GND pad(s) have no visible stitching via and could not accept via-in-pad.`,
          manifest.padViaFailures,
        ))
        if (!refill.report || refill.process.error || refill.process.timedOut) diagnostics.push(diagnostic(
          "GROUND_REFILL_FAILED",
          "error",
          "KiCad did not complete a readable GND plane refill.",
          refill.process,
        ))
        stages.push({
          stage: "ground",
          status: diagnostics.some((item) => item.severity === "error")
            ? "error"
            : diagnostics.length ? "partial" : "ok",
          inputBoard: groundInput,
          outputBoard: groundOutput,
          diagnostics,
          metrics: {
            elapsedMs: performance.now() - groundStarted,
            zonesAdded: manifest.zonesAdded,
            gridVias: manifest.gridVias,
            padVias: manifest.padVias,
            padsCoveredByVisibleVia: manifest.padsCoveredByVisibleVia,
            pthPadsSkipped: manifest.pthPadsSkipped,
            invalidViasRemoved: cleanup.removed,
          },
          details: { manifest, cleanup },
        })
      } catch (error) {
        latestBoard = groundInput
        stages.push({
          stage: "ground",
          status: "error",
          inputBoard: groundInput,
          outputBoard: groundInput,
          diagnostics: [diagnostic("GROUND_STAGE_FAILED", "error", errorText(error))],
          metrics: { elapsedMs: performance.now() - groundStarted },
        })
      }
    } else {
      stages.push({
        stage: "ground",
        status: planeIntents.length ? "skipped_due_to_dependency" : "skipped",
        diagnostics: [],
      })
    }

    let finalValidation: FinalValidation | { completed: false; valid: false; reason: string }
    if (latestBoard && baselineReport) {
      await copyFile(latestBoard, config.outputBoard)
      await copySidecars(latestBoard, config.outputBoard)
      const finalDrc = await runNativeDrc(
        config.outputBoard,
        resolve(config.resultDirectory, "99-final-drc.json"),
        config,
        true,
      )
      const finalCompleted = finalDrc.process.exitCode === 0
        && !finalDrc.process.error
        && !finalDrc.process.timedOut
      if (finalDrc.report && finalCompleted) {
        const finalRoot = parsePcbSource((await readPcb(config.outputBoard)).source)
        const powerValidation = compiledPowerIntent
          ? validatePowerRouting(finalRoot, compiledPowerIntent)
          : undefined
        if (powerValidation) await writeFile(
          resolve(config.resultDirectory, "99-final-power-validation.json"),
          `${JSON.stringify(powerValidation, null, 2)}\n`,
        )
        finalValidation = deriveFinalValidation(baselineReport, finalDrc.report, powerValidation, {
          requiredGroundNets: planeIntents.map((plane) => plane.net),
        })
        const finalPolygonValidation = validateFilledPolygonPlans(
          kicadToRawPcb(finalRoot, { includeZones: true }),
          plans,
        )
        await writeFile(resolve(config.resultDirectory, "99-final-polygon-diagnostics.json"), `${JSON.stringify(finalPolygonValidation, null, 2)}\n`)
        stages.push({
          stage: "final",
          status: finalValidation.valid ? "ok" : "error",
          inputBoard: latestBoard,
          outputBoard: config.outputBoard,
          diagnostics: [
            ...finalValidation.newErrorViolations.map((item) => diagnostic("FINAL_NEW_DRC_ERROR", "error", item.type, item)),
            ...finalValidation.missingNonGroundNets.map((net) => diagnostic("FINAL_NET_OPEN", "error", `${net} remains unconnected.`)),
            ...finalValidation.missingRequiredGroundNets.map((net) => diagnostic(
              "FINAL_GROUND_NET_OPEN",
              "error",
              `${net} remains unconnected after plane stitching.`,
            )),
            ...(finalValidation.powerValidation?.violations ?? []).map((item) => diagnostic(
              item.code,
              "error",
              item.message,
              item.details,
            )),
            ...finalPolygonValidation.diagnostics.filter((item) => item.status === "error").map((item) => diagnostic(
              "FINAL_POLYGON_DIAGNOSTIC",
              "warning",
              item.reason ?? "A polygon target is not connected by filled zone copper alone.",
              item,
            )),
          ],
          metrics: {
            elapsedMs: finalDrc.process.elapsedMs,
            copper: copperCounts(finalRoot),
            polygonFillErrors: finalPolygonValidation.errors,
            powerViolationCount: finalValidation.powerViolationCount ?? 0,
          },
        })
      } else {
        finalValidation = { completed: false, valid: false, reason: "KiCad did not complete a final DRC/refill run." }
        stages.push({
          stage: "final",
          status: "error",
          inputBoard: latestBoard,
          outputBoard: config.outputBoard,
          diagnostics: [diagnostic("FINAL_VALIDATION_FAILED", "error", finalValidation.reason)],
        })
      }
    } else {
      finalValidation = { completed: false, valid: false, reason: "No usable board or baseline DRC report reached final validation." }
      stages.push({ stage: "final", status: "skipped_due_to_dependency", diagnostics: [] })
    }

    const currentSourceHash = sourceHash && await exists(config.sourceBoard) ? await sha256(config.sourceBoard) : ""
    const sourceUnchanged = Boolean(sourceHash) && sourceHash === currentSourceHash
    const report = {
      workflow: `power-polygons-krt-special-${config.remainingBackend}-remaining-krt-completion-ground`,
      remainingBackend: config.remainingBackend,
      krtQuality: {
        viaCost: config.krtViaCost,
        viaProximityCost: config.krtViaProximityCost,
        turnCost: config.krtTurnCost,
        directionPreferenceCost: config.krtDirectionPreferenceCost,
        maxRipup: config.krtMaxRipup,
        maxIterations: config.krtMaxIterations,
        maxProbeIterations: config.krtMaxProbeIterations,
        heuristicWeight: config.krtHeuristicWeight,
        ordering: config.krtOrdering,
        netScheduling: config.netScheduling,
        netRescue: config.krtNetRescue,
      },
      skipSpecial: config.skipSpecial,
      completionRuns: config.completionRuns,
      sourceBoard: config.sourceBoard,
      rulesBoard: config.rulesBoard,
      polygonDsl: config.polygonDsl,
      specialIntentPath: config.specialIntentPath,
      powerIntent: compiledPowerIntent,
      outputBoard: await exists(config.outputBoard) ? config.outputBoard : null,
      sourceHash,
      currentSourceHash,
      sourceUnchanged,
      stages,
      finalValidation,
      valid: finalValidation.valid,
      totalElapsedMs: performance.now() - started,
    }
    await writeFile(resolve(config.resultDirectory, "workflow-report.json"), `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({
      valid: report.valid,
      sourceUnchanged,
      outputBoard: report.outputBoard,
      report: resolve(config.resultDirectory, "workflow-report.json"),
      stages: stages.map((stage) => ({ stage: stage.stage, status: stage.status })),
    }, null, 2))
  } catch (error) {
    const failure = {
      valid: false,
      sourceBoard: config.sourceBoard,
      outputBoard: await exists(config.outputBoard) ? config.outputBoard : null,
      stages,
      finalValidation: { completed: false, valid: false, reason: errorText(error) },
      fatalOrchestratorDiagnostic: diagnostic("WORKFLOW_ORCHESTRATOR_ERROR", "error", errorText(error)),
      totalElapsedMs: performance.now() - started,
    }
    await writeFile(resolve(config.resultDirectory, "workflow-report.json"), `${JSON.stringify(failure, null, 2)}\n`)
    console.log(JSON.stringify(failure, null, 2))
  }
}

const invokedAsScript = process.argv[1]
  && basename(process.argv[1]).replace(/\.[^.]+$/, "") === "staged-routing"

if (invokedAsScript) void main()
