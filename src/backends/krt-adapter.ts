import { spawn } from "node:child_process"
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import {
  atom,
  findChild,
  listChildren,
  parsePcbSource,
  type SExpression,
} from "../internal/kicad-sexpr.js"

/**
 * Router invariant: geometry neck-down is always available. It may narrow only
 * to the effective compiled DRC minimum; adapters must never disable it.
 */
export const KRT_REQUIRED_NECKDOWN_ENVIRONMENT = Object.freeze({
  KICAD_IMPEDANCE_NECKDOWN: "1",
})

export type KrtDiagnosticSeverity = "info" | "warning" | "error"

export type KrtDiagnostic = {
  code: string
  severity: KrtDiagnosticSeverity
  message: string
  details?: unknown
}

export type KrtDiffPair =
  | readonly [positive: string, negative: string]
  | { positive: string; negative: string }

export type KrtMatchedGroup =
  | readonly string[]
  | { nets: readonly string[] }

export type KrtNumericRules = {
  trackWidth: number
  clearance: number
  viaSize: number
  viaDrill: number
  diffPairGap?: number
  gridStep?: number
  holeToHoleClearance?: number
  boardEdgeClearance?: number
  sameNetPadClearance?: number
  routingClearanceMargin?: number
  lengthMatchTolerance?: number
  meanderAmplitude?: number
  meanderSpacing?: number
}

export type KrtStageSpec = {
  pythonPath: string
  /** Managed site-package directories added without modifying the host Python. */
  pythonPathEntries?: readonly string[]
  krtDirectory: string
  /** Optional legacy process guard. Public run() relies only on AbortSignal. */
  timeoutMs?: number
  layers: readonly string[]
  rules: KrtNumericRules
  fabOverridesPath: string
  /** Geometry/fabrication floor for the route.py equal-length subcall. */
  ordinaryMatchedRules?: KrtNumericRules
  ordinaryMatchedFabOverridesPath?: string
  diffPairs: readonly KrtDiffPair[]
  matchedGroups: readonly KrtMatchedGroup[]
  remainingNets: readonly string[]
  /** Exact pre-existing nets KRT may rip only when they block remainingNets. */
  ripExistingNets?: readonly string[]
  powerNets?: readonly { net: string; width: number }[]
  ordering?: "inside_out" | "mps" | "original"
  /** Disable KRT's secondary bare-ball repartition when testing an external exact order. */
  preserveNetOrder?: boolean
  /** Allow KRT's additive rescue pass without relaxing native clearance. */
  enableNetRescue?: boolean
  /** Allow geometry fallback only when the fab overrides contain a real lower rung. */
  enableTerminalEscalation?: boolean
  maxIterations?: number
  maxProbeIterations?: number
  maxRipup?: number
  heuristicWeight?: number
  /** Route-quality costs only; these never weaken DRC geometry. */
  viaCost?: number
  viaProximityCost?: number
  turnCost?: number
  directionPreferenceCost?: number
  collectStats?: boolean
  debugMemory?: boolean
  /** Exact native filled copper was materialized as locked same-net tracks. */
  filledCopperProxy?: boolean
  /** Managed KRT patch stamps exact native filled polygons as net-aware obstacles. */
  exactFilledZoneObstacles?: boolean
  /** Abort the active KRT subprocess without throwing from the workflow. */
  signal?: AbortSignal
}

export type KrtProcessStatus =
  | "completed"
  | "skipped"
  | "preflight_failed"
  | "process_failed"

export type KrtProcessResult = {
  stage: "special" | "remaining"
  backend: "krt"
  status: KrtProcessStatus
  attempted: boolean
  inputBoard: string
  outputBoard: string
  command: string[]
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  elapsedMs: number
  stdout: string
  stderr: string
  stdoutPath?: string
  stderrPath?: string
  invocationPath?: string
  resultPath?: string
  inputArtifactPath?: string
  outputArtifactPath?: string
  protectedNetsPath?: string
  protectedNets?: string[]
  jsonSummary?: Record<string, unknown>
  jsonSummaries: Record<string, unknown>[]
  diagnostics: KrtDiagnostic[]
  /**
   * Present only when one logical special stage required more than one KRT
   * executable. Diff-only callers keep the historical single-process shape.
   */
  subcalls?: KrtProcessResult[]
}

type NormalizedPair = { positive: string; negative: string }
type NormalizedGroup = { nets: string[] }
type NormalizedSpecial = {
  pairs: NormalizedPair[]
  coupledGroups: NormalizedGroup[]
  ordinaryGroups: NormalizedGroup[]
}

type CapturedProcess = {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  elapsedMs: number
  stdout: string
  stderr: string
  error?: string
}

const BOARD_SUFFIX = ".kicad_pcb"
const SIDECAR_SUFFIXES = [".kicad_pro", ".kicad_dru", ".kicad_prl"] as const
const EPSILON = 1e-9

function diagnostic(
  code: string,
  severity: KrtDiagnosticSeverity,
  message: string,
  details?: unknown,
): KrtDiagnostic {
  return { code, severity, message, ...(details === undefined ? {} : { details }) }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function boardStem(path: string) {
  return path.toLowerCase().endsWith(BOARD_SUFFIX)
    ? path.slice(0, -BOARD_SUFFIX.length)
    : path.slice(0, -extname(path).length)
}

function pythonCommand(path: string) {
  if (isAbsolute(path) || path.includes("/") || path.includes("\\")) return resolve(path)
  return path
}

function pythonScriptArgs(
  scriptPath: string,
  args: readonly string[],
  pythonPathEntries: readonly string[] | undefined,
) {
  if (!pythonPathEntries?.length) return [scriptPath, ...args]
  // KiCad's bundled Python uses a ._pth file on Windows and intentionally
  // ignores PYTHONPATH. Insert managed packages in-process, then execute the
  // real KRT CLI as __main__ without modifying the host interpreter.
  const bootstrap = [
    "import importlib,importlib.util,os,runpy,sys",
    "sys.dont_write_bytecode=True",
    "script=sys.argv[1]",
    `sys.path[:0]=[os.path.dirname(script),*${JSON.stringify([...pythonPathEntries])}]`,
    "importlib.import_module('copilot_router_krt_patch') if importlib.util.find_spec('copilot_router_krt_patch') else None",
    "sys.argv=sys.argv[1:]",
    "runpy.run_path(script,run_name='__main__')",
  ].join(";")
  return ["-c", bootstrap, scriptPath, ...args]
}

function unique(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function nodeNetName(root: SExpression[], node: SExpression[]) {
  const net = findChild(node, "net")
  if (!net) return ""
  if (net.length >= 3) return atom(net[2]) ?? ""
  const number = atom(net[1]) ?? ""
  if (!/^\d+$/.test(number)) return number
  return atom(listChildren(root, "net").find((entry) => atom(entry[1]) === number)?.[2]) ?? ""
}

function canonicalCopperNode(value: SExpression): unknown {
  if (!Array.isArray(value)) return { value: value.value, quoted: value.quoted }
  const head = atom(value[0]) ?? ""
  if (head === "uuid" || head === "tstamp" || head === "locked") return undefined
  return value.map(canonicalCopperNode).filter((item) => item !== undefined)
}

function copperGeometrySignatures(root: SExpression[], netName: string) {
  return (["segment", "arc", "via"] as const).flatMap((head) => (
    listChildren(root, head)
      .filter((item) => nodeNetName(root, item) === netName)
      .map((item) => `${head}:${JSON.stringify(canonicalCopperNode(item))}`)
  )).sort()
}

async function changedCopperGeometryNets(
  beforePath: string,
  afterPath: string,
  netNames: readonly string[],
) {
  const before = parsePcbSource(await readFile(beforePath, "utf8"))
  const after = parsePcbSource(await readFile(afterPath, "utf8"))
  return unique(netNames).filter((net) => !sameStrings(
    copperGeometrySignatures(before, net),
    copperGeometrySignatures(after, net),
  ))
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * KRT normally records coupled and length-matched nets as protected in the
 * output project. That write is currently coupled to KRT's DRC-settings
 * rewrite and therefore does not run with our required
 * `--no-fix-drc-settings` option. Persist the same chain-stage invariant in
 * the adapter so a later ordinary pass cannot collateral-rip special copper.
 */
export async function persistKrtProtectedNets(
  boardPath: string,
  netNames: readonly string[],
  reason = "workflow-special",
) {
  const nets = unique(netNames)
  const projectPath = `${boardStem(resolve(boardPath))}.kicad_pro`
  if (!nets.length) return { path: projectPath, nets, changed: false }

  let project: Record<string, unknown> = {}
  if (await exists(projectPath)) {
    const parsed = JSON.parse(await readFile(projectPath, "utf8"))
    const object = jsonObject(parsed)
    if (!object) throw new Error(`${projectPath} does not contain a JSON object`)
    project = object
  }

  const namespace = jsonObject(project.kicad_routing_tools) ?? {}
  const existing = jsonObject(namespace.protected_nets) ?? {}
  const protectedNets = { ...existing }
  for (const net of nets) protectedNets[net] = reason
  namespace.protected_nets = protectedNets
  project.kicad_routing_tools = namespace

  const before = JSON.stringify(existing)
  const after = JSON.stringify(protectedNets)
  if (before !== after) await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8")
  return { path: projectPath, nets, changed: before !== after }
}

function isExactKrtNetName(value: string) {
  // KRT expands fnmatch patterns and also splits comma-delimited tokens. The
  // adapter contract is exact-name routing, so ambiguous names must be
  // rejected instead of accidentally broadening a stage's scope.
  return value.length > 0 && !/[*?\[\],]/.test(value)
}

function validateExactNetNames(
  values: readonly string[],
  context: string,
  diagnostics: KrtDiagnostic[],
) {
  const invalid = unique(values).filter((value) => !isExactKrtNetName(value))
  if (invalid.length) diagnostics.push(diagnostic(
    "KRT_EXACT_NET_REQUIRED",
    "error",
    `${context} must use exact KRT net names, not wildcard or comma-delimited patterns.`,
    invalid,
  ))
}

function normalizePair(pair: KrtDiffPair): NormalizedPair {
  return Array.isArray(pair)
    ? { positive: String(pair[0] ?? "").trim(), negative: String(pair[1] ?? "").trim() }
    : {
        positive: String((pair as { positive: string }).positive ?? "").trim(),
        negative: String((pair as { negative: string }).negative ?? "").trim(),
      }
}

function normalizeGroup(group: KrtMatchedGroup): NormalizedGroup {
  return {
    nets: unique(Array.isArray(group)
      ? group.map(String)
      : (group as { nets: readonly string[] }).nets.map(String)),
  }
}

function numberArg(value: number) {
  return String(value)
}

function pushNumericArg(args: string[], flag: string, value: number | undefined) {
  if (value !== undefined) args.push(flag, numberArg(value))
}

async function exists(path: string) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function copyIfDifferent(source: string, target: string) {
  if (resolve(source).toLowerCase() === resolve(target).toLowerCase()) return
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
}

async function copyBoardAndSidecars(
  sourceBoard: string,
  targetBoard: string,
  diagnostics: KrtDiagnostic[],
) {
  try {
    await copyIfDifferent(sourceBoard, targetBoard)
  } catch (error) {
    diagnostics.push(diagnostic(
      "KRT_BOARD_COPY_FAILED",
      "error",
      `Could not create the KRT output snapshot: ${errorText(error)}`,
      { sourceBoard, targetBoard },
    ))
    return false
  }

  const sourceStem = boardStem(sourceBoard)
  const targetStem = boardStem(targetBoard)
  for (const suffix of SIDECAR_SUFFIXES) {
    const source = `${sourceStem}${suffix}`
    if (!(await exists(source))) continue
    try {
      await copyIfDifferent(source, `${targetStem}${suffix}`)
    } catch (error) {
      diagnostics.push(diagnostic(
        "KRT_SIDECAR_COPY_FAILED",
        "warning",
        `Could not copy ${suffix} sidecar: ${errorText(error)}`,
        { source, target: `${targetStem}${suffix}` },
      ))
    }
  }
  return true
}

async function removeBoardAndSidecars(board: string) {
  await rm(board, { force: true })
  const stem = boardStem(board)
  await Promise.all(SIDECAR_SUFFIXES.map((suffix) => rm(`${stem}${suffix}`, { force: true })))
}

async function writeArtifact(
  path: string,
  content: string,
  diagnostics: KrtDiagnostic[],
) {
  try {
    await writeFile(path, content, "utf8")
    return true
  } catch (error) {
    diagnostics.push(diagnostic(
      "KRT_ARTIFACT_WRITE_FAILED",
      "warning",
      `Could not write ${basename(path)}: ${errorText(error)}`,
      { path },
    ))
    return false
  }
}

function parseJsonSummaries(stdout: string, diagnostics: KrtDiagnostic[]) {
  const summaries: Record<string, unknown>[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const marker = line.indexOf("JSON_SUMMARY:")
    if (marker < 0) continue
    const source = line.slice(marker + "JSON_SUMMARY:".length).trim()
    try {
      const value: unknown = JSON.parse(source)
      if (value && typeof value === "object" && !Array.isArray(value)) {
        summaries.push(value as Record<string, unknown>)
      } else {
        diagnostics.push(diagnostic(
          "KRT_INVALID_JSON_SUMMARY",
          "warning",
          "KRT emitted a JSON_SUMMARY that was not an object.",
          { source },
        ))
      }
    } catch (error) {
      diagnostics.push(diagnostic(
        "KRT_INVALID_JSON_SUMMARY",
        "warning",
        `Could not parse a KRT JSON_SUMMARY: ${errorText(error)}`,
        { source },
      ))
    }
  }
  return summaries
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : []
}

function recordArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item)
      && typeof item === "object" && !Array.isArray(item))
    : []
}

function addSpecialSummaryDiagnostics(
  summary: Record<string, unknown>,
  rules: KrtNumericRules,
  diagnostics: KrtDiagnostic[],
) {
  const failed = stringArray(summary.failed_diff_pairs)
  const partial = stringArray(summary.partial_diff_pairs)
  const singleEnded = stringArray(summary.single_ended_diff_pairs)
  const followups = stringArray(summary.single_ended_followup_nets)
  const skipped = stringArray(summary.skipped_bad_fanout)
  const fallback = summary.single_ended_fallback
    && typeof summary.single_ended_fallback === "object"
    ? summary.single_ended_fallback as Record<string, unknown>
    : {}
  const fallbackMembers = unique([
    ...stringArray(fallback.attempted),
    ...stringArray(fallback.routed),
    ...stringArray(fallback.partial),
    ...stringArray(fallback.failed),
  ])

  if (failed.length) diagnostics.push(diagnostic(
    "KRT_DIFF_UNROUTED", "error", "KRT could not route every differential pair.", failed,
  ))
  if (partial.length) diagnostics.push(diagnostic(
    "KRT_DIFF_PARTIAL", "error", "KRT reported partially routed differential pairs.", partial,
  ))
  if (singleEnded.length || followups.length || fallbackMembers.length) {
    diagnostics.push(diagnostic(
      "KRT_DIFF_NOT_FULLY_COUPLED",
      "error",
      "At least one special pair used or requested single-ended copper; no pair receives an exception.",
      { pairs: singleEnded, followupNets: followups, fallbackMembers },
    ))
  }
  if (skipped.length) diagnostics.push(diagnostic(
    "KRT_DIFF_SKIPPED", "error", "KRT skipped pairs because of invalid fanout geometry.", skipped,
  ))

  const badReports = recordArray(summary.pair_reports).filter((report) => (
    report.outcome !== "coupled"
    || report.member_audit_mismatch === true
    || stringArray(report.incomplete_members).length > 0
  ))
  if (badReports.length) diagnostics.push(diagnostic(
    "KRT_DIFF_PAIR_AUDIT_FAILED",
    "error",
    "KRT's own pair/member audit did not prove a complete coupled route.",
    badReports,
  ))

  const polaritySwaps = stringArray(summary.polarity_swapped_pairs)
  if (polaritySwaps.length) diagnostics.push(diagnostic(
    "KRT_UNREQUESTED_POLARITY_SWAP",
    "error",
    "KRT reported polarity swaps although the adapter never authorizes them.",
    polaritySwaps,
  ))
  addGeometryFloorDiagnostic(summary, rules, diagnostics)
}

function addRemainingSummaryDiagnostics(
  summary: Record<string, unknown>,
  rules: KrtNumericRules,
  diagnostics: KrtDiagnostic[],
  authorizedRipNets: readonly string[] = [],
) {
  const failed = stringArray(summary.failed_single)
  const open = stringArray(summary.open_single)
  const multipoint = recordArray(summary.failed_multipoint)
  const cleanupDisconnected = stringArray(summary.cleanup_disconnected)
  const coverage = stringArray(summary.coverage_gate_nets)
  const padPairsOpen = recordArray(summary.pad_pairs_open)

  if (failed.length) diagnostics.push(diagnostic(
    "KRT_NETS_UNROUTED", "error", "KRT could not route every remaining net.", failed,
  ))
  if (open.length) diagnostics.push(diagnostic(
    "KRT_NETS_OPEN", "error", "KRT kept copper for nets that remain electrically open.", open,
  ))
  if (multipoint.length) diagnostics.push(diagnostic(
    "KRT_MULTIPOINT_INCOMPLETE",
    "error",
    "KRT left one or more multi-point pads disconnected.",
    multipoint,
  ))
  if (cleanupDisconnected.length) diagnostics.push(diagnostic(
    "KRT_CLEANUP_DISCONNECTED",
    "error",
    "KRT cleanup disconnected routed nets.",
    cleanupDisconnected,
  ))
  if (coverage.length) diagnostics.push(diagnostic(
    "KRT_COVERAGE_GATE_FAILED",
    "error",
    "KRT disturbed out-of-scope nets.",
    coverage,
  ))
  if (padPairsOpen.length) diagnostics.push(diagnostic(
    "KRT_PAD_PAIRS_OPEN", "error", "KRT's final pad-pair report contains open nets.", padPairsOpen,
  ))
  if (summary.preexisting_rips && Object.keys(summary.preexisting_rips as object).length) {
    const outcomes = summary.preexisting_rips as Record<string, unknown>
    const authorized = new Set(authorizedRipNets)
    const unauthorized = Object.fromEntries(Object.entries(outcomes)
      .filter(([net]) => !authorized.has(net)))
    const casualties = Object.fromEntries(Object.entries(outcomes)
      .filter(([, outcome]) => /NOT RECOVERED|PARTIAL|still open/i.test(String(outcome))))
    if (Object.keys(unauthorized).length) diagnostics.push(diagnostic(
      "KRT_PREEXISTING_COPPER_RIPPED",
      "error",
      "KRT ripped pre-existing copper outside the explicit blocker-repair allowlist.",
      unauthorized,
    ))
    if (Object.keys(casualties).length) diagnostics.push(diagnostic(
      "KRT_RIP_VICTIM_INCOMPLETE",
      "error",
      "KRT did not fully recover every explicitly authorized blocker net.",
      casualties,
    ))
    const safe = Object.fromEntries(Object.entries(outcomes)
      .filter(([net]) => authorized.has(net) && !(net in casualties)))
    if (Object.keys(safe).length) diagnostics.push(diagnostic(
      "KRT_AUTHORIZED_BLOCKER_RIP",
      "info",
      "KRT rerouted or restored explicitly authorized blocker copper.",
      safe,
    ))
  }
  if (summary.terminal_escalations && Object.keys(summary.terminal_escalations as object).length) {
    diagnostics.push(diagnostic(
      "KRT_GEOMETRY_ESCALATION_USED",
      "error",
      "KRT reported terminal geometry escalation despite the adapter kill switch.",
      summary.terminal_escalations,
    ))
  }
  addGeometryFloorDiagnostic(summary, rules, diagnostics)
}

function addGeometryFloorDiagnostic(
  summary: Record<string, unknown>,
  rules: KrtNumericRules,
  diagnostics: KrtDiagnostic[],
) {
  const minimum = Number(summary.min_clearance_used)
  if (Number.isFinite(minimum) && minimum + EPSILON < rules.clearance) {
    diagnostics.push(diagnostic(
      "KRT_CLEARANCE_WEAKENED",
      "error",
      `KRT reports a ${minimum} mm clearance floor below the compiled ${rules.clearance} mm rule.`,
      { minimum, required: rules.clearance },
    ))
  }
}

async function runCaptured(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number | undefined,
  environment: Record<string, string> = {},
  abortSignal?: AbortSignal,
) : Promise<CapturedProcess> {
  const started = performance.now()
  return await new Promise((resolvePromise) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let spawnError: string | undefined
    let settled = false

    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        KICAD_RIP_PREEXISTING: "0",
        KICAD_PLANE_FINALIZE: "0",
        KICAD_FINALIZE_RIP: "0",
        KICAD_NET_RESCUE: "0",
        KICAD_TERMINAL_ESCALATION: "0",
        ...KRT_REQUIRED_NECKDOWN_ENVIRONMENT,
        PYTHONDONTWRITEBYTECODE: "1",
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => { stdout += chunk })
    child.stderr?.on("data", (chunk: string) => { stderr += chunk })
    child.on("error", (error) => { spawnError = errorText(error) })

    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => child.kill("SIGKILL")
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      abortSignal?.removeEventListener("abort", abort)
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        elapsedMs: performance.now() - started,
        stdout,
        stderr,
        ...(spawnError ? { error: spawnError } : {}),
      })
    }
    child.on("close", (code, signal) => finish(code, signal))

    if (abortSignal?.aborted) {
      timedOut = false
      abort()
    } else {
      abortSignal?.addEventListener("abort", abort, { once: true })
    }

    if (timeoutMs !== undefined) timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
  })
}

async function readFabOverrides(path: string) {
  const values = new Map<string, number>()
  const source = await readFile(path, "utf8")
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim()
    if (!line) continue
    const match = line.match(/^([^\s=:]+)\s*(?:=|:|\s)\s*([^\s]+)$/)
    if (!match) continue
    const value = Number(match[2])
    if (Number.isFinite(value)) values.set(match[1], value)
  }
  return values
}

function validatePositiveNumber(
  value: number | undefined,
  field: string,
  diagnostics: KrtDiagnostic[],
  required = false,
) {
  if (value === undefined && !required) return
  if (!Number.isFinite(value) || Number(value) <= 0) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC",
    "error",
    `${field} must be a positive finite number.`,
    { field, value },
  ))
}

function validateNonNegativeNumber(
  value: number | undefined,
  field: string,
  diagnostics: KrtDiagnostic[],
) {
  if (value === undefined) return
  if (!Number.isFinite(value) || Number(value) < 0) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC",
    "error",
    `${field} must be a non-negative finite number.`,
    { field, value },
  ))
}

async function commonPreflight(
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  scriptName: "route_diff.py" | "route.py",
  diagnostics: KrtDiagnostic[],
) {
  if (resolve(inputBoard).toLowerCase() === resolve(outputBoard).toLowerCase()) {
    diagnostics.push(diagnostic(
      "KRT_SOURCE_OUTPUT_COLLISION",
      "error",
      "KRT input and output boards must be different; the source snapshot is immutable.",
    ))
  }
  if (!(await exists(inputBoard))) diagnostics.push(diagnostic(
    "KRT_INPUT_NOT_FOUND", "error", `KRT input board does not exist: ${inputBoard}`,
  ))
  if (!(await exists(join(spec.krtDirectory, "py_router", scriptName)))) diagnostics.push(diagnostic(
    "KRT_SCRIPT_NOT_FOUND",
    "error",
    `KRT script was not found: py_router/${scriptName}`,
    { krtDirectory: spec.krtDirectory },
  ))
  if (!spec.pythonPath.trim()) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC", "error", "pythonPath must not be empty.",
  ))
  if (spec.timeoutMs !== undefined && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0)) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC", "error", "timeoutMs must be a positive finite number.",
  ))
  if (!unique(spec.layers).length) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC", "error", "At least one routing layer is required.",
  ))

  validatePositiveNumber(spec.rules.trackWidth, "rules.trackWidth", diagnostics, true)
  validatePositiveNumber(spec.rules.clearance, "rules.clearance", diagnostics, true)
  validatePositiveNumber(spec.rules.viaSize, "rules.viaSize", diagnostics, true)
  validatePositiveNumber(spec.rules.viaDrill, "rules.viaDrill", diagnostics, true)
  validatePositiveNumber(spec.rules.diffPairGap, "rules.diffPairGap", diagnostics)
  validatePositiveNumber(spec.rules.gridStep, "rules.gridStep", diagnostics)
  validatePositiveNumber(spec.rules.holeToHoleClearance, "rules.holeToHoleClearance", diagnostics)
  validatePositiveNumber(spec.rules.boardEdgeClearance, "rules.boardEdgeClearance", diagnostics)
  validatePositiveNumber(spec.rules.sameNetPadClearance, "rules.sameNetPadClearance", diagnostics)
  validatePositiveNumber(spec.rules.routingClearanceMargin, "rules.routingClearanceMargin", diagnostics)
  validatePositiveNumber(spec.rules.lengthMatchTolerance, "rules.lengthMatchTolerance", diagnostics)
  validatePositiveNumber(spec.rules.meanderAmplitude, "rules.meanderAmplitude", diagnostics)
  validatePositiveNumber(spec.rules.meanderSpacing, "rules.meanderSpacing", diagnostics)
  validatePositiveNumber(spec.maxIterations, "maxIterations", diagnostics)
  validatePositiveNumber(spec.maxProbeIterations, "maxProbeIterations", diagnostics)
  validatePositiveNumber(spec.maxRipup, "maxRipup", diagnostics)
  validatePositiveNumber(spec.heuristicWeight, "heuristicWeight", diagnostics)
  validatePositiveNumber(spec.viaCost, "viaCost", diagnostics)
  validateNonNegativeNumber(spec.viaProximityCost, "viaProximityCost", diagnostics)
  validateNonNegativeNumber(spec.turnCost, "turnCost", diagnostics)
  validateNonNegativeNumber(spec.directionPreferenceCost, "directionPreferenceCost", diagnostics)

  if (spec.rules.viaDrill >= spec.rules.viaSize) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC",
    "error",
    "rules.viaDrill must be smaller than rules.viaSize.",
  ))

  if (!(await exists(spec.fabOverridesPath))) {
    diagnostics.push(diagnostic(
      "KRT_HARD_FAB_REQUIRED",
      "error",
      `A readable fabOverridesPath is required to disable KRT geometry escalation: ${spec.fabOverridesPath}`,
    ))
  } else {
    try {
      const values = await readFabOverrides(spec.fabOverridesPath)
      const required: Array<[string, number]> = [
        ["track_width", spec.rules.trackWidth],
        ["clearance", spec.rules.clearance],
        ["via_diameter", spec.rules.viaSize],
        ["via_drill", spec.rules.viaDrill],
      ]
      for (const [key, expected] of required) {
        const actual = values.get(key)
        if (actual === undefined || Math.abs(actual - expected) > EPSILON) {
          diagnostics.push(diagnostic(
            "LOSSY_RULE_TRANSLATION",
            "error",
            `Hard fab override ${key} must equal the compiled rule (${expected} mm).`,
            { key, expected, actual },
          ))
        }
      }
    } catch (error) {
      diagnostics.push(diagnostic(
        "KRT_HARD_FAB_REQUIRED",
        "error",
        `Could not read fab overrides: ${errorText(error)}`,
        { path: spec.fabOverridesPath },
      ))
    }
  }

  try {
    const source = await readFile(inputBoard, "utf8")
    if (!spec.filledCopperProxy && !spec.exactFilledZoneObstacles
      && /(?:^|\s)\(zone(?=[\s(])/m.test(source)) diagnostics.push(diagnostic(
      "KRT_ZONE_OBSTACLE_UNSUPPORTED",
      "warning",
      "Stock KRT does not stamp native filled-zone contours as routing obstacles. Native refill and final verification are authoritative.",
    ))
  } catch {
    // The input-not-found/copy diagnostics above already explain this case.
  }
}

function specialPreflight(spec: KrtStageSpec, diagnostics: KrtDiagnostic[]): NormalizedSpecial {
  const pairs = spec.diffPairs.map(normalizePair)
  const groups = spec.matchedGroups.map(normalizeGroup)
  const memberOwner = new Map<string, number>()
  const groupOwner = new Map<string, number>()

  pairs.forEach((pair, index) => {
    validateExactNetNames([pair.positive, pair.negative], `diffPairs[${index}]`, diagnostics)
    if (!pair.positive || !pair.negative || pair.positive === pair.negative) {
      diagnostics.push(diagnostic(
        "KRT_INVALID_DIFF_PAIR",
        "error",
        "Every differential pair must contain two distinct, non-empty exact net names.",
        { index, pair },
      ))
      return
    }
    for (const member of [pair.positive, pair.negative]) {
      if (member.toUpperCase() === "GND") diagnostics.push(diagnostic(
        "KRT_GND_EXCLUDED", "error", "GND cannot be a special routed net.", { pair },
      ))
      const previous = memberOwner.get(member)
      if (previous !== undefined) diagnostics.push(diagnostic(
        "KRT_INVALID_DIFF_PAIR",
        "error",
        `Net ${member} belongs to more than one differential pair.`,
        { firstPair: previous, secondPair: index },
      ))
      else memberOwner.set(member, index)
    }
  })

  groups.forEach((group, index) => {
    validateExactNetNames(group.nets, `matchedGroups[${index}]`, diagnostics)
    if (group.nets.length < 2) diagnostics.push(diagnostic(
      "KRT_INVALID_MATCHED_GROUP",
      "error",
      "Every matched group must contain at least two exact net names.",
      { index, group },
    ))
    for (const net of group.nets) {
      if (net.toUpperCase() === "GND") diagnostics.push(diagnostic(
        "KRT_GND_EXCLUDED", "error", "GND cannot belong to a matched group.", { index, net },
      ))
      const previous = groupOwner.get(net)
      if (previous !== undefined) diagnostics.push(diagnostic(
        "KRT_MATCHED_GROUP_CONFLICT",
        "error",
        `Net ${net} belongs to more than one matched group.`,
        { firstGroup: previous, secondGroup: index },
      ))
      else groupOwner.set(net, index)
    }
    const diffMembers = group.nets.filter((net) => memberOwner.has(net))
    if (diffMembers.length && diffMembers.length !== group.nets.length) diagnostics.push(diagnostic(
      "CAPABILITY_MISMATCH",
      "error",
      "KRT cannot route one matched group partly as coupled pairs and partly as ordinary single-ended nets.",
      { group: group.nets, diffMembers, ordinaryMembers: group.nets.filter((net) => !memberOwner.has(net)) },
    ))
  })

  if (groups.length && spec.rules.lengthMatchTolerance === undefined) diagnostics.push(diagnostic(
    "KRT_INVALID_MATCHED_GROUP",
    "error",
    "rules.lengthMatchTolerance is required when matchedGroups are present.",
  ))
  if (pairs.length && spec.rules.diffPairGap === undefined) diagnostics.push(diagnostic(
    "KRT_INVALID_DIFF_PAIR",
    "error",
    "rules.diffPairGap is required for special differential-pair routing.",
  ))
  if (spec.rules.diffPairGap !== undefined
      && spec.rules.diffPairGap + EPSILON < spec.rules.clearance) {
    diagnostics.push(diagnostic(
      "LOSSY_RULE_TRANSLATION",
      "error",
      "KRT forcibly raises a differential-pair gap below its routing clearance, so this rule set cannot be preserved exactly.",
      { diffPairGap: spec.rules.diffPairGap, clearance: spec.rules.clearance },
    ))
  }
  return {
    pairs,
    coupledGroups: groups.filter((group) => group.nets.every((net) => memberOwner.has(net))),
    ordinaryGroups: groups.filter((group) => group.nets.every((net) => !memberOwner.has(net))),
  }
}

function remainingPreflight(spec: KrtStageSpec, diagnostics: KrtDiagnostic[]) {
  const nets = unique(spec.remainingNets)
  validateExactNetNames(nets, "remainingNets", diagnostics)
  const specialNets = new Set(spec.diffPairs.flatMap((pair) => {
    const normalized = normalizePair(pair)
    return [normalized.positive, normalized.negative]
  }))
  const forbidden = nets.filter((net) => net.toUpperCase() === "GND" || specialNets.has(net))
  if (forbidden.length) diagnostics.push(diagnostic(
    "KRT_REMAINING_SCOPE_CONFLICT",
    "error",
    "The remaining pass must explicitly exclude GND and every special net.",
    forbidden,
  ))
  const ripExistingNets = unique(spec.ripExistingNets ?? [])
  validateExactNetNames(ripExistingNets, "ripExistingNets", diagnostics)
  const invalidRipNets = ripExistingNets.filter((net) => (
    net.toUpperCase() === "GND" || specialNets.has(net) || nets.includes(net)
  ))
  if (invalidRipNets.length) diagnostics.push(diagnostic(
    "KRT_RIP_SCOPE_CONFLICT",
    "error",
    "Blocker repair may rip only exact, non-GND, non-special nets outside remainingNets.",
    invalidRipNets,
  ))
  const routed = new Set(nets)
  const powerNames = unique((spec.powerNets ?? []).map((item) => item.net))
  validateExactNetNames(powerNames, "powerNets", diagnostics)
  const invalidPower = (spec.powerNets ?? []).filter((item) => (
    !routed.has(item.net) || !Number.isFinite(item.width) || item.width <= 0
  ))
  if (invalidPower.length) diagnostics.push(diagnostic(
    "KRT_INVALID_POWER_SCOPE",
    "error",
    "Every power-net width must be positive and belong to remainingNets.",
    invalidPower,
  ))
  return nets
}

function commonArgs(
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  options: { omitClearanceCeiling?: boolean } = {},
) {
  const args = [resolve(inputBoard), resolve(outputBoard)]
  args.push("--layers", ...unique(spec.layers))
  // route.py treats --clearance as a ceiling on native netclass clearance.
  // Ordinary groups can span classes, so omitting it is the only lossless
  // translation; the fab-overrides floor remains mandatory below.
  if (!options.omitClearanceCeiling) args.push("--clearance", numberArg(spec.rules.clearance))
  args.push("--via-size", numberArg(spec.rules.viaSize))
  args.push("--via-drill", numberArg(spec.rules.viaDrill))
  pushNumericArg(args, "--grid-step", spec.rules.gridStep)
  pushNumericArg(args, "--hole-to-hole-clearance", spec.rules.holeToHoleClearance)
  pushNumericArg(args, "--board-edge-clearance", spec.rules.boardEdgeClearance)
  pushNumericArg(args, "--same-net-pad-clearance", spec.rules.sameNetPadClearance)
  pushNumericArg(args, "--routing-clearance-margin", spec.rules.routingClearanceMargin)
  if (spec.ordering) args.push("--ordering", spec.ordering)
  pushNumericArg(args, "--max-iterations", spec.maxIterations)
  pushNumericArg(args, "--max-probe-iterations", spec.maxProbeIterations)
  pushNumericArg(args, "--max-ripup", spec.maxRipup)
  pushNumericArg(args, "--heuristic-weight", spec.heuristicWeight)
  pushNumericArg(args, "--via-cost", spec.viaCost)
  pushNumericArg(args, "--via-proximity-cost", spec.viaProximityCost)
  pushNumericArg(args, "--turn-cost", spec.turnCost)
  pushNumericArg(args, "--direction-preference-cost", spec.directionPreferenceCost)
  if (spec.debugMemory) args.push("--debug-memory")
  args.push("--keep-input-copper", "--no-fix-drc-settings")
  args.push("--fab-overrides", resolve(spec.fabOverridesPath))
  return args
}

function specialArgs(
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  pairs: NormalizedPair[],
  groups: NormalizedGroup[],
) {
  const args = commonArgs(inputBoard, outputBoard, spec)
  args.push("--track-width", numberArg(spec.rules.trackWidth))
  const nets = unique(pairs.flatMap((pair) => [pair.positive, pair.negative]))
  args.push("--nets", ...nets)
  args.push("--diff-pair-gap", numberArg(spec.rules.diffPairGap!))
  args.push("--diff-pair-intra-match", "--no-gnd-vias")
  for (const group of groups) args.push("--length-match-group", ...group.nets)
  pushNumericArg(args, "--length-match-tolerance", spec.rules.lengthMatchTolerance)
  pushNumericArg(args, "--meander-amplitude", spec.rules.meanderAmplitude)
  pushNumericArg(args, "--meander-spacing", spec.rules.meanderSpacing)
  return args
}

function matchedOrdinaryArgs(
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  groups: NormalizedGroup[],
) {
  const args = commonArgs(inputBoard, outputBoard, spec, { omitClearanceCeiling: true })
  const nets = unique(groups.flatMap((group) => group.nets))
  args.push("--nets", ...nets)
  // route.py performs matching only over results produced by this invocation,
  // so every ordinary member is deliberately submitted together.
  for (const group of groups) args.push("--length-match-group", ...group.nets)
  pushNumericArg(args, "--length-match-tolerance", spec.rules.lengthMatchTolerance)
  pushNumericArg(args, "--meander-amplitude", spec.rules.meanderAmplitude)
  pushNumericArg(args, "--meander-spacing", spec.rules.meanderSpacing)
  return args
}

function remainingArgs(
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  nets: string[],
) {
  // The board sidecar already carries the fully materialized per-net rules.
  // KRT treats --clearance as a global ceiling, so passing it here would
  // silently flatten stricter classes.
  const args = commonArgs(inputBoard, outputBoard, spec, { omitClearanceCeiling: true })
  args.push("--nets", ...nets)
  const ripExistingNets = unique(spec.ripExistingNets ?? [])
  if (ripExistingNets.length) args.push("--rip-existing-nets", ...ripExistingNets)
  if (spec.collectStats) args.push("--stats")
  if (spec.powerNets?.length) {
    args.push("--power-nets", ...spec.powerNets.map((item) => item.net))
    args.push("--power-nets-widths", ...spec.powerNets.map((item) => numberArg(item.width)))
  }
  return args
}

async function executeStage(
  stage: "special" | "remaining",
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  artifactsDir: string,
  scriptName: "route_diff.py" | "route.py",
  buildArgs: (diagnostics: KrtDiagnostic[]) => string[] | undefined,
  summaryKind: "special" | "remaining" = stage,
) : Promise<KrtProcessResult> {
  const diagnostics: KrtDiagnostic[] = []
  const normalizedInput = resolve(inputBoard)
  const normalizedOutput = resolve(outputBoard)
  const normalizedKrt = resolve(spec.krtDirectory)
  const normalizedArtifacts = resolve(artifactsDir)
  const executable = pythonCommand(spec.pythonPath)
  const result: KrtProcessResult = {
    stage,
    backend: "krt",
    status: "preflight_failed",
    attempted: false,
    inputBoard: normalizedInput,
    outputBoard: normalizedOutput,
    command: [],
    exitCode: null,
    signal: null,
    timedOut: false,
    elapsedMs: 0,
    stdout: "",
    stderr: "",
    jsonSummaries: [],
    diagnostics,
  }

  try {
    try {
      await mkdir(normalizedArtifacts, { recursive: true })
    } catch (error) {
      diagnostics.push(diagnostic(
        "KRT_ARTIFACT_DIRECTORY_FAILED",
        "warning",
        `Could not create artifacts directory: ${errorText(error)}`,
        { artifactsDir: normalizedArtifacts },
      ))
    }

    await commonPreflight(
      normalizedInput,
      normalizedOutput,
      { ...spec, krtDirectory: normalizedKrt, fabOverridesPath: resolve(spec.fabOverridesPath) },
      scriptName,
      diagnostics,
    )
    if (resolve(normalizedInput).toLowerCase() !== resolve(normalizedOutput).toLowerCase()) {
      await removeBoardAndSidecars(normalizedOutput)
    }
    await copyBoardAndSidecars(normalizedInput, normalizedOutput, diagnostics)

    const inputArtifactPath = join(normalizedArtifacts, `krt-${stage}-input.kicad_pcb`)
    try {
      await copyIfDifferent(normalizedInput, inputArtifactPath)
      result.inputArtifactPath = inputArtifactPath
    } catch (error) {
      diagnostics.push(diagnostic(
        "KRT_ARTIFACT_COPY_FAILED",
        "warning",
        `Could not save the ${stage} input artifact: ${errorText(error)}`,
      ))
    }

    const args = buildArgs(diagnostics)
    if (!args || diagnostics.some((item) => item.severity === "error")) {
      await saveOutputArtifact(result, normalizedArtifacts)
      await persistResultArtifacts(result, normalizedArtifacts)
      return result
    }
    if (!args.length) {
      result.status = "skipped"
      diagnostics.push(diagnostic(
        "KRT_STAGE_EMPTY", "info", `The ${stage} stage has no nets to route.`,
      ))
      await saveOutputArtifact(result, normalizedArtifacts)
      await persistResultArtifacts(result, normalizedArtifacts)
      return result
    }

    const scriptPath = join(normalizedKrt, "py_router", scriptName)
    const processArgs = pythonScriptArgs(scriptPath, args, spec.pythonPathEntries)
    result.command = [executable, ...processArgs]
    result.invocationPath = join(normalizedArtifacts, `krt-${stage}-invocation.json`)
    await writeArtifact(result.invocationPath, `${JSON.stringify({
      stage,
      executable,
      args: processArgs,
      cwd: normalizedKrt,
      timeoutMs: spec.timeoutMs,
      environment: {
        ...(spec.pythonPathEntries?.length
          ? { PYTHONPATH: [...spec.pythonPathEntries, ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])].join(delimiter) }
          : {}),
        KICAD_RIP_PREEXISTING: "0",
        KICAD_PLANE_FINALIZE: "0",
        KICAD_FINALIZE_RIP: "0",
        KICAD_NET_RESCUE: spec.enableNetRescue ? "1" : "0",
        KICAD_TERMINAL_ESCALATION: spec.enableTerminalEscalation ? "1" : "0",
        PYTHONDONTWRITEBYTECODE: "1",
        ...KRT_REQUIRED_NECKDOWN_ENVIRONMENT,
        ...(spec.preserveNetOrder ? { KICAD_DIRECT_FIRST: "0" } : {}),
      },
    }, null, 2)}\n`, diagnostics)

    result.attempted = true
    const captured = await runCaptured(
      executable,
      processArgs,
      normalizedKrt,
      spec.timeoutMs,
      {
        ...(spec.pythonPathEntries?.length
          ? { PYTHONPATH: [...spec.pythonPathEntries, ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])].join(delimiter) }
          : {}),
        ...(spec.preserveNetOrder ? { KICAD_DIRECT_FIRST: "0" } : {}),
        KICAD_NET_RESCUE: spec.enableNetRescue ? "1" : "0",
        KICAD_TERMINAL_ESCALATION: spec.enableTerminalEscalation ? "1" : "0",
      },
      spec.signal,
    )
    result.exitCode = captured.exitCode
    result.signal = captured.signal
    result.timedOut = captured.timedOut
    result.elapsedMs = captured.elapsedMs
    result.stdout = captured.stdout
    result.stderr = captured.stderr

    result.stdoutPath = join(normalizedArtifacts, `krt-${stage}.stdout.log`)
    result.stderrPath = join(normalizedArtifacts, `krt-${stage}.stderr.log`)
    await writeArtifact(result.stdoutPath, result.stdout, diagnostics)
    await writeArtifact(result.stderrPath, result.stderr, diagnostics)

    if (captured.error) diagnostics.push(diagnostic(
      "KRT_PROCESS_START_FAILED", "error", `Could not start KRT: ${captured.error}`,
    ))
    if (captured.timedOut) diagnostics.push(diagnostic(
      "KRT_TIMEOUT",
      "error",
      `KRT ${stage} exceeded its ${spec.timeoutMs} ms timeout.`,
    ))
    if (spec.signal?.aborted) diagnostics.push(diagnostic(
      "KRT_ABORTED",
      "error",
      `KRT ${stage} was cancelled.`,
    ))
    if (captured.exitCode !== 0) diagnostics.push(diagnostic(
      "KRT_NONZERO_EXIT",
      "error",
      `KRT ${stage} exited with code ${String(captured.exitCode)}.`,
      { signal: captured.signal },
    ))

    result.jsonSummaries = parseJsonSummaries(result.stdout, diagnostics)
    result.jsonSummary = result.jsonSummaries[0]
    if (result.jsonSummaries.length > 1) diagnostics.push(diagnostic(
      "KRT_MULTIPLE_JSON_SUMMARIES",
      "warning",
      "KRT emitted reconciliation sub-run summaries after the authoritative first summary; they are retained separately.",
      { count: result.jsonSummaries.length },
    ))
    if (!result.jsonSummary) diagnostics.push(diagnostic(
      "KRT_SUMMARY_MISSING",
      "error",
      "KRT produced no parseable JSON_SUMMARY; exit code alone is not a routing result.",
    ))
    else if (summaryKind === "special") addSpecialSummaryDiagnostics(
      result.jsonSummary, spec.rules, diagnostics,
    )
    else addRemainingSummaryDiagnostics(
      result.jsonSummary,
      spec.rules,
      diagnostics,
      spec.ripExistingNets,
    )

    if (!(await exists(normalizedOutput))) diagnostics.push(diagnostic(
      "KRT_OUTPUT_MISSING",
      "error",
      "KRT did not leave an output board artifact.",
      { outputBoard: normalizedOutput },
    ))
    if (stage === "special" && await exists(normalizedOutput)) {
      const specialNets = unique([
        ...spec.diffPairs.flatMap((pair) => {
          const normalized = normalizePair(pair)
          return [normalized.positive, normalized.negative]
        }),
        ...spec.matchedGroups.flatMap((group) => normalizeGroup(group).nets),
      ])
      try {
        const persisted = await persistKrtProtectedNets(normalizedOutput, specialNets)
        result.protectedNetsPath = persisted.path
        result.protectedNets = persisted.nets
      } catch (error) {
        diagnostics.push(diagnostic(
          "KRT_SPECIAL_PROTECTION_FAILED",
          "error",
          `Could not protect special-net copper for later stages: ${errorText(error)}`,
          { board: normalizedOutput, nets: specialNets },
        ))
      }
    }
    await saveOutputArtifact(result, normalizedArtifacts)

    const transportFailed = captured.error
      || captured.timedOut
      || captured.exitCode !== 0
      || !result.jsonSummary
      || !(await exists(normalizedOutput))
    result.status = transportFailed ? "process_failed" : "completed"
    await persistResultArtifacts(result, normalizedArtifacts)
    return result
  } catch (error) {
    diagnostics.push(diagnostic(
      "KRT_ADAPTER_FAILURE",
      "error",
      `Unexpected KRT adapter failure was captured: ${errorText(error)}`,
    ))
    result.status = result.attempted ? "process_failed" : "preflight_failed"
    await persistResultArtifacts(result, normalizedArtifacts).catch(() => undefined)
    return result
  }
}

async function saveOutputArtifact(result: KrtProcessResult, artifactsDir: string) {
  if (!(await exists(result.outputBoard))) return
  const target = join(artifactsDir, `krt-${result.stage}-output.kicad_pcb`)
  try {
    await copyIfDifferent(result.outputBoard, target)
    result.outputArtifactPath = target
  } catch (error) {
    result.diagnostics.push(diagnostic(
      "KRT_ARTIFACT_COPY_FAILED",
      "warning",
      `Could not save the ${result.stage} output artifact: ${errorText(error)}`,
    ))
  }
}

async function persistResultArtifacts(result: KrtProcessResult, artifactsDir: string) {
  result.resultPath = join(artifactsDir, `krt-${result.stage}-result.json`)
  const serializable = {
    ...result,
    stdout: result.stdout.length ? `<stored in ${result.stdoutPath ?? "result"}>` : "",
    stderr: result.stderr.length ? `<stored in ${result.stderrPath ?? "result"}>` : "",
  }
  await writeArtifact(
    result.resultPath,
    `${JSON.stringify(serializable, null, 2)}\n`,
    result.diagnostics,
  )
}

export async function runKrtSpecial(
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  artifactsDir: string,
): Promise<KrtProcessResult> {
  const initialDiagnostics: KrtDiagnostic[] = []
  const normalized = specialPreflight(spec, initialDiagnostics)
  if (initialDiagnostics.some((item) => item.severity === "error")) {
    const scriptName = normalized.ordinaryGroups.length ? "route.py" : "route_diff.py"
    return executeStage(
      "special",
      inputBoard,
      outputBoard,
      spec,
      artifactsDir,
      scriptName,
      (diagnostics) => {
        specialPreflight(spec, diagnostics)
        return undefined
      },
      scriptName === "route.py" ? "remaining" : "special",
    )
  }
  if (!normalized.ordinaryGroups.length) {
    return executeStage(
      "special",
      inputBoard,
      outputBoard,
      spec,
      artifactsDir,
      "route_diff.py",
      (diagnostics) => {
        const current = specialPreflight(spec, diagnostics)
        if (!current.pairs.length) return []
        if (diagnostics.some((item) => item.severity === "error")) return undefined
        return specialArgs(inputBoard, outputBoard, spec, current.pairs, current.coupledGroups)
      },
    )
  }

  const subcalls: KrtProcessResult[] = []
  const diffNets = unique(normalized.pairs.flatMap((pair) => [pair.positive, pair.negative]))
  let ordinaryInput = resolve(inputBoard)

  if (normalized.pairs.length) {
    const diffOutput = join(resolve(artifactsDir), "special-diff-board.kicad_pcb")
    const diffSpec: KrtStageSpec = {
      ...spec,
      matchedGroups: normalized.coupledGroups.map((group) => group.nets),
    }
    const diff = await executeStage(
      "special",
      inputBoard,
      diffOutput,
      diffSpec,
      join(artifactsDir, "special-diff"),
      "route_diff.py",
      (diagnostics) => {
        const current = specialPreflight(diffSpec, diagnostics)
        if (diagnostics.some((item) => item.severity === "error")) return undefined
        return specialArgs(inputBoard, diffOutput, diffSpec, current.pairs, current.coupledGroups)
      },
    )
    subcalls.push(diff)
    if (diff.status === "completed" && !diff.diagnostics.some((item) => item.severity === "error")) {
      ordinaryInput = diffOutput
    }
  }

  const ordinarySpec: KrtStageSpec = {
    ...spec,
    rules: spec.ordinaryMatchedRules ?? spec.rules,
    fabOverridesPath: spec.ordinaryMatchedFabOverridesPath ?? spec.fabOverridesPath,
    diffPairs: [],
    matchedGroups: normalized.ordinaryGroups.map((group) => group.nets),
  }
  const ordinary = await executeStage(
    "special",
    ordinaryInput,
    outputBoard,
    ordinarySpec,
    join(artifactsDir, "special-ordinary"),
    "route.py",
    (diagnostics) => {
      const current = specialPreflight(ordinarySpec, diagnostics)
      if (diagnostics.some((item) => item.severity === "error")) return undefined
      return matchedOrdinaryArgs(
        ordinaryInput,
        outputBoard,
        ordinarySpec,
        current.ordinaryGroups,
      )
    },
    "remaining",
  )
  subcalls.push(ordinary)

  const diagnostics = subcalls.flatMap((item) => item.diagnostics)
  const diffSucceeded = !normalized.pairs.length || ordinaryInput !== resolve(inputBoard)
  if (diffNets.length && diffSucceeded && await exists(ordinaryInput) && await exists(resolve(outputBoard))) {
    try {
      const changed = await changedCopperGeometryNets(ordinaryInput, resolve(outputBoard), diffNets)
      if (changed.length) diagnostics.push(diagnostic(
        "KRT_SPECIAL_PROTECTED_COPPER_CHANGED",
        "error",
        "The ordinary matched-group subcall changed differential copper from the preceding special subcall.",
        changed,
      ))
      if (changed.length) await copyBoardAndSidecars(ordinaryInput, resolve(outputBoard), diagnostics)
    } catch (error) {
      diagnostics.push(diagnostic(
        "KRT_SPECIAL_PROTECTION_GUARD_FAILED",
        "error",
        `Could not compare protected special copper: ${errorText(error)}`,
      ))
      await copyBoardAndSidecars(ordinaryInput, resolve(outputBoard), diagnostics)
    }
  }
  if (/\bWARNING:.*(?:NOT fully matched|SHORT of the group target)/i.test(ordinary.stdout)) {
    diagnostics.push(diagnostic(
      "KRT_LENGTH_MATCH_INCOMPLETE",
      "error",
      "KRT reported that an ordinary equal-length group did not meet its requested tolerance.",
    ))
  }

  const specialNets = unique([
    ...diffNets,
    ...normalized.coupledGroups.flatMap((group) => group.nets),
    ...normalized.ordinaryGroups.flatMap((group) => group.nets),
  ])
  let protectedNetsPath: string | undefined
  let protectedNets: string[] | undefined
  if (await exists(resolve(outputBoard))) {
    try {
      const persisted = await persistKrtProtectedNets(resolve(outputBoard), specialNets)
      protectedNetsPath = persisted.path
      protectedNets = persisted.nets
    } catch (error) {
      diagnostics.push(diagnostic(
        "KRT_SPECIAL_PROTECTION_FAILED",
        "error",
        `Could not protect special-net copper for later stages: ${errorText(error)}`,
      ))
    }
  }

  const aggregate: KrtProcessResult = {
    stage: "special",
    backend: "krt",
    status: subcalls.some((item) => item.status === "process_failed")
      ? "process_failed"
      : subcalls.some((item) => item.status === "preflight_failed")
        ? "preflight_failed"
        : subcalls.every((item) => item.status === "skipped") ? "skipped" : "completed",
    attempted: subcalls.some((item) => item.attempted),
    inputBoard: resolve(inputBoard),
    outputBoard: resolve(outputBoard),
    command: [],
    exitCode: subcalls.find((item) => item.exitCode !== null && item.exitCode !== 0)?.exitCode
      ?? ordinary.exitCode,
    signal: subcalls.find((item) => item.signal)?.signal ?? null,
    timedOut: subcalls.some((item) => item.timedOut),
    elapsedMs: subcalls.reduce((sum, item) => sum + item.elapsedMs, 0),
    stdout: subcalls.map((item) => item.stdout).filter(Boolean).join("\n"),
    stderr: subcalls.map((item) => item.stderr).filter(Boolean).join("\n"),
    jsonSummary: ordinary.jsonSummary,
    jsonSummaries: subcalls.flatMap((item) => item.jsonSummaries),
    diagnostics,
    subcalls,
    ...(protectedNetsPath ? { protectedNetsPath } : {}),
    ...(protectedNets ? { protectedNets } : {}),
  }
  await mkdir(resolve(artifactsDir), { recursive: true }).catch(() => undefined)
  await saveOutputArtifact(aggregate, resolve(artifactsDir))
  await persistResultArtifacts(aggregate, resolve(artifactsDir)).catch(() => undefined)
  return aggregate
}

export async function runKrtRemaining(
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  artifactsDir: string,
): Promise<KrtProcessResult> {
  return executeStage(
    "remaining",
    inputBoard,
    outputBoard,
    spec,
    artifactsDir,
    "route.py",
    (diagnostics) => {
      const nets = remainingPreflight(spec, diagnostics)
      if (!nets.length) return []
      if (diagnostics.some((item) => item.severity === "error")) return undefined
      return remainingArgs(inputBoard, outputBoard, spec, nets)
    },
  )
}
