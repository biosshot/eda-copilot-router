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
import { clearRouting } from "../../kicad-copilot/src/pcb/router-adapter"
import {
  netClassFor,
  readPcbRoutingRules,
  type PcbRoutingRules,
} from "../../kicad-copilot/src/pcb/router-rules"
import {
  runKrtRemaining,
  runKrtSpecial,
  type KrtProcessResult,
  type KrtStageSpec,
} from "./backends/krt-adapter"
import { isOctilinearBoundary } from "./polygon/boundary-optimizer"
import { runPolygonDsl } from "./polygon/dsl"
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

type JsonRecord = Record<string, unknown>

export type WorkflowDiagnostic = {
  code: string
  severity: "info" | "warning" | "error"
  message: string
  details?: unknown
}

export type WorkflowStage = {
  stage: "preflight" | "polygons" | "special" | "remaining" | "final"
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
}

export type FinalDrcSummary = {
  newErrorViolations: Array<{ key: string; type: string }>
  missingNonGroundNets: string[]
  missingNonGroundItems: number
  totalUnconnectedItems: number
}

export type FinalValidation = FinalDrcSummary & {
  completed: true
  valid: boolean
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
  kicadCli: string
  timeoutMs: number
}

const DEFAULT_BOARD = "D:\\MyProject\\kicad\\Powerbank\\Powerbank.kicad_pcb"
const DEFAULT_RULES_BOARD = "D:\\MyProject\\kicad\\Powerbank\\Powerbank.drc-benchmark-clean-no-gnd.kicad_pcb"
const DEFAULT_KRT = "D:\\MyProject\\kicad\\Powerbank\\tmp\\KiCadRoutingTools-v0.20.2"
const DEFAULT_KICAD = "C:\\Users\\kiril\\AppData\\Local\\Programs\\KiCad\\10.0\\bin\\kicad-cli.exe"
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

function extractNet(description: unknown) {
  return String(description ?? "").match(/\[([^\]]+)\]/)?.[1] ?? ""
}

function errorViolationIdentity(report: unknown) {
  const root = report && typeof report === "object" ? report as JsonRecord : {}
  const violations = Array.isArray(root.violations) ? root.violations : []
  return violations.flatMap((violation) => {
    if (!violation || typeof violation !== "object") return []
    const item = violation as JsonRecord
    if (item.severity !== "error") return []
    const type = typeof item.type === "string" ? item.type : "unknown"
    const subjects = (Array.isArray(item.items) ? item.items : []).map((subject) => {
      if (!subject || typeof subject !== "object") return String(subject)
      const fields = subject as JsonRecord
      if (typeof fields.uuid === "string") return fields.uuid
      return JSON.stringify({ description: fields.description, pos: fields.pos })
    }).sort()
    return [{ key: `${type}:${subjects.join("|")}`, type }]
  })
}

export function summarizeFinalDrc(baseline: unknown, final: unknown): FinalDrcSummary {
  const baselineKeys = new Set(errorViolationIdentity(baseline).map((item) => item.key))
  const newErrorViolations = errorViolationIdentity(final)
    .filter((item) => !baselineKeys.has(item.key))
    .sort((left, right) => left.key.localeCompare(right.key))
  const root = final && typeof final === "object" ? final as JsonRecord : {}
  const unconnectedItems = Array.isArray(root.unconnected_items) ? root.unconnected_items : []
  const missingNets = new Set<string>()
  let missingNonGroundItems = 0
  for (const entry of unconnectedItems) {
    if (!entry || typeof entry !== "object") continue
    const items = Array.isArray((entry as JsonRecord).items) ? (entry as JsonRecord).items : []
    const nets = new Set(items.map((item) => (
      item && typeof item === "object" ? extractNet((item as JsonRecord).description) : ""
    )).filter(Boolean))
    nets.delete("GND")
    if (!nets.size) continue
    missingNonGroundItems += 1
    for (const net of nets) missingNets.add(net)
  }
  return {
    newErrorViolations,
    missingNonGroundNets: [...missingNets].sort(),
    missingNonGroundItems,
    totalUnconnectedItems: unconnectedItems.length,
  }
}

export function deriveFinalValidation(baseline: unknown, final: unknown): FinalValidation {
  const summary = summarizeFinalDrc(baseline, final)
  return {
    completed: true,
    valid: summary.newErrorViolations.length === 0 && summary.missingNonGroundItems === 0,
    ...summary,
  }
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

function canonicalCopperNode(value: SExpression): unknown {
  if (!Array.isArray(value)) return { value: value.value, quoted: value.quoted }
  const head = atom(value[0]) ?? ""
  if (head === "uuid" || head === "tstamp") return undefined
  return value
    .map(canonicalCopperNode)
    .filter((item) => item !== undefined)
}

/** Exact geometry multiset for a net, ignoring only object identity fields. */
export function copperGeometrySignatures(root: SExpression[], netName: string) {
  return (["segment", "arc", "via"] as const).flatMap((head) => (
    listChildren(root, head)
      .filter((item) => nodeNetName(root, item) === netName)
      .map((item) => `${head}:${JSON.stringify(canonicalCopperNode(item))}`)
  )).sort()
}

export function changedCopperGeometryNets(
  before: SExpression[],
  after: SExpression[],
  netNames: readonly string[],
) {
  return [...new Set(netNames)].filter((net) => !sameStrings(
    copperGeometrySignatures(before, net),
    copperGeometrySignatures(after, net),
  ))
}

function zoneOutlineSignatures(root: SExpression[]) {
  return listChildren(root, "zone").map((zone) => {
    const clone = structuredClone(zone)
    for (let index = clone.length - 1; index >= 0; index -= 1) {
      if (Array.isArray(clone[index]) && atom((clone[index] as SExpression[])[0]) === "filled_polygon") {
        clone.splice(index, 1)
      }
    }
    return JSON.stringify(clone)
  }).sort()
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
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<SpecialIntent>
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

function krtStageStatus(result: KrtProcessResult): WorkflowStage["status"] {
  if (result.status === "skipped") return "skipped"
  if (result.status !== "completed") return "error"
  return result.diagnostics.some((item) => item.severity === "error") ? "partial" : "ok"
}

function krtDiagnostics(result: KrtProcessResult): WorkflowDiagnostic[] {
  return result.diagnostics.map((item) => ({ ...item }))
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
    krtDirectory: resolve(process.env.COPILOT_ROUTER_KRT_DIR ?? DEFAULT_KRT),
    pythonPath: process.env.COPILOT_ROUTER_PYTHON ?? "python",
    kicadCli: resolve(process.env.COPILOT_ROUTER_KICAD_CLI ?? DEFAULT_KICAD),
    timeoutMs: Number(process.env.COPILOT_ROUTER_FULL_TIMEOUT_MS ?? 10 * 60_000),
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
  let specialIntent: SpecialIntent | undefined
  let preflightBlocked = false

  try {
    const preflightDiagnostics: WorkflowDiagnostic[] = []
    for (const [label, path] of [
      ["source board", config.sourceBoard],
      ["rules board", config.rulesBoard],
      ["polygon DSL", config.polygonDsl],
      ["special intent", config.specialIntentPath],
      ["KRT route_diff", join(config.krtDirectory, "py_router", "route_diff.py")],
      ["KRT route", join(config.krtDirectory, "py_router", "route.py")],
      ["KiCad CLI", config.kicadCli],
    ] as const) {
      if (!(await exists(path))) preflightDiagnostics.push(diagnostic(
        "PREFLIGHT_INPUT_MISSING", "error", `${label} was not found.`, { path },
      ))
    }
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
      preflightDiagnostics.push(diagnostic("PREFLIGHT_INVALID_TIMEOUT", "error", "Workflow timeout must be positive."))
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
      const unsupported = specialIntent.matchedGroups.flatMap((group) => group.filter((net) => !memberSet.has(net)))
      if (unsupported.length) preflightDiagnostics.push(diagnostic(
        "CAPABILITY_MISMATCH",
        "error",
        "This KRT adapter cannot route ordinary matched groups in the same one-call special pass.",
        unsupported,
      ))
    }
    preflightBlocked = preflightDiagnostics.some((item) => item.severity === "error")
    stages.push({
      stage: "preflight",
      status: preflightBlocked ? "error" : "ok",
      diagnostics: preflightDiagnostics,
      metrics: { sourceHash },
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
        const rules = await readPcbRoutingRules(config.rulesBoard)
        const program = runPolygonDsl(await readFile(config.polygonDsl, "utf8"))
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
        routingRules = await readPcbRoutingRules(config.rulesBoard)
        const board = await readPcb(latestBoard)
        allNets = [...pcbNetNames(parsePcbSource(board.source))]
      } catch {}
    }

    if (latestBoard && specialIntent && routingRules) {
      const specialInput = latestBoard
      const specialStarted = performance.now()
      try {
      const before = parsePcbSource((await readPcb(specialInput)).source)
      const zonesBefore = zoneOutlineSignatures(before)
      const specialNets = specialIntent.diffPairs.flatMap((pair) => [pair.positive, pair.negative])
      const specialRules = specialNets.map((net) => classRule(routingRules!, net))
      const widths = new Set(specialRules.map((rule) => Math.max(routingRules!.minimumTrackWidth, rule.diffPairWidth)))
      const clearances = new Set(specialRules.map((rule) => Math.max(routingRules!.minimumClearance, rule.clearance)))
      // KiCad netclass diff gap is an optimum, not a DRC minimum. KRT cannot
      // use a pair gap smaller than its routing clearance, so select the
      // stricter of the two without weakening either native hard rule.
      const gaps = new Set(specialRules.map((rule) => Math.max(
        Math.max(routingRules!.minimumClearance, rule.clearance),
        rule.diffPairGap,
      )))
      const viaSizes = new Set(specialRules.map((rule) => Math.max(routingRules!.minimumViaDiameter, rule.viaDiameter)))
      const viaDrills = new Set(specialRules.map((rule) => Math.max(routingRules!.minimumViaDrill, rule.viaDrill)))
      const specDiagnostics: WorkflowDiagnostic[] = []
      if ([widths, clearances, gaps, viaSizes, viaDrills].some((set) => set.size > 1)) {
        specDiagnostics.push(diagnostic(
          "LOSSY_RULE_TRANSLATION",
          "error",
          "The one-call KRT special backend requires common geometry across every submitted pair.",
          { widths: [...widths], clearances: [...clearances], gaps: [...gaps], viaSizes: [...viaSizes], viaDrills: [...viaDrills] },
        ))
      }
      if (!specDiagnostics.length) {
        const specialOutput = resolve(config.resultDirectory, "02-special.kicad_pcb")
        const fabPath = resolve(config.resultDirectory, "02-special-fab.txt")
        const values = {
          trackWidth: [...widths][0],
          clearance: [...clearances][0],
          viaSize: [...viaSizes][0],
          viaDrill: [...viaDrills][0],
          holeToHole: await nativeHoleToHoleRule(config.rulesBoard),
          boardEdge: Math.max(0.001, routingRules.copperEdgeClearance),
        }
        await writeFabOverrides(fabPath, values)
        const krtSpec: KrtStageSpec = {
          pythonPath: config.pythonPath,
          krtDirectory: config.krtDirectory,
          timeoutMs: config.timeoutMs,
          layers: ["F.Cu", "B.Cu"],
          rules: {
            ...values,
            diffPairGap: [...gaps][0],
            gridStep: 0.05,
            holeToHoleClearance: values.holeToHole,
            boardEdgeClearance: values.boardEdge,
            routingClearanceMargin: 1,
            lengthMatchTolerance: specialIntent.lengthMatchToleranceMm,
            meanderAmplitude: specialIntent.meanderAmplitudeMm,
            meanderSpacing: specialIntent.meanderSpacingWidths,
          },
          fabOverridesPath: fabPath,
          diffPairs: specialIntent.diffPairs,
          matchedGroups: specialIntent.matchedGroups,
          remainingNets: [],
          ordering: "mps",
          maxIterations: 1_000_000,
          maxProbeIterations: 50_000,
          maxRipup: 5,
          heuristicWeight: 1.2,
          debugMemory: true,
        }
        const result = await runKrtSpecial(specialInput, specialOutput, krtSpec, config.resultDirectory)
        const afterBoard = await exists(specialOutput) ? specialOutput : specialInput
        const diagnostics = krtDiagnostics(result)
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
      const specialNets = new Set(specialIntent.diffPairs.flatMap((pair) => [pair.positive, pair.negative]))
      // Polygon intents are local copper ownership, not whole-net ownership.
      // A multi-point power net can have several valid local islands that still
      // need the ordinary router to connect them. KRT receives the complete
      // remaining non-GND scope and skips the portions already connected by
      // the native refill.
      const remainingNets = allNets.filter((net) => net !== "GND" && !specialNets.has(net))
      const remainingOutput = resolve(config.resultDirectory, "03-remaining.kicad_pcb")
      const remainingRules = remainingNets.map((net) => classRule(routingRules!, net))
      const values = {
        // route.py reads each netclass when --track-width is omitted. This is
        // only the hard fabrication floor. Stock KRT still has a few fallback
        // paths that use its Default width; final native DRC records those as
        // errors instead of the adapter weakening or globally widening rules.
        trackWidth: Math.max(routingRules.minimumTrackWidth, 0.001),
        clearance: Math.max(
          routingRules.minimumClearance,
          ...remainingRules.map((rule) => rule.clearance),
        ),
        // One KRT invocation has one via floor. Use the largest required
        // geometry across remaining classes; a larger via is legal for the
        // signal classes, while a smaller one would silently weaken Power.
        viaSize: Math.max(
          routingRules.minimumViaDiameter,
          ...remainingRules.map((rule) => rule.viaDiameter),
        ),
        viaDrill: Math.max(
          routingRules.minimumViaDrill,
          ...remainingRules.map((rule) => rule.viaDrill),
        ),
        holeToHole: await nativeHoleToHoleRule(config.rulesBoard),
        boardEdge: Math.max(0.001, routingRules.copperEdgeClearance),
      }
      const fabPath = resolve(config.resultDirectory, "03-remaining-fab.txt")
      await writeFabOverrides(fabPath, values)
      const before = parsePcbSource((await readPcb(remainingInput)).source)
      const zonesBefore = zoneOutlineSignatures(before)
      const powerNets = remainingNets.flatMap((net) => {
        const rule = classRule(routingRules!, net)
        return rule.name === "Power" ? [{ net, width: rule.trackWidth }] : []
      })
      const krtSpec: KrtStageSpec = {
        pythonPath: config.pythonPath,
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
        diffPairs: specialIntent.diffPairs,
        matchedGroups: specialIntent.matchedGroups,
        remainingNets,
        powerNets,
        ordering: "mps",
        maxIterations: 1_000_000,
        maxProbeIterations: 50_000,
        maxRipup: 5,
        heuristicWeight: 1.2,
        collectStats: true,
        debugMemory: true,
      }
      const result = await runKrtRemaining(remainingInput, remainingOutput, krtSpec, config.resultDirectory)
      const afterBoard = await exists(remainingOutput) ? remainingOutput : remainingInput
      const after = parsePcbSource((await readPcb(afterBoard)).source)
      const diagnostics = krtDiagnostics(result)
      if (!sameStrings(zonesBefore, zoneOutlineSignatures(after))) diagnostics.push(diagnostic(
        "KRT_ZONE_OUTLINES_CHANGED", "error", "KRT changed or removed power zone outlines.",
      ))
      const changedSpecial = changedCopperGeometryNets(before, after, [...specialNets])
      if (changedSpecial.length) diagnostics.push(diagnostic(
        "KRT_SPECIAL_COPPER_CHANGED", "error", "The remaining pass changed special-net copper.", changedSpecial,
      ))
      latestBoard = afterBoard
      stages.push({
        stage: "remaining",
        status: diagnostics.some((item) => item.severity === "error")
          ? (result.attempted ? "partial" : "error")
          : krtStageStatus(result),
        inputBoard: result.inputBoard,
        outputBoard: latestBoard,
        diagnostics,
        metrics: { elapsedMs: result.elapsedMs, attempted: result.attempted, exitCode: result.exitCode, nets: remainingNets.length },
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
        finalValidation = deriveFinalValidation(baselineReport, finalDrc.report)
        const finalRoot = parsePcbSource((await readPcb(config.outputBoard)).source)
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
      workflow: "power-polygons-krt-special-krt-remaining",
      sourceBoard: config.sourceBoard,
      rulesBoard: config.rulesBoard,
      polygonDsl: config.polygonDsl,
      specialIntentPath: config.specialIntentPath,
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
