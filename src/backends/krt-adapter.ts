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
  printSExpression,
  token,
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

/** Exact argparse choices in KiCadRoutingTools 0.21.3. */
export const KRT_RIPUP_BLOCKER_SELECT_CHOICES = Object.freeze([
  "count", "near-target", "bidir", "mincut", "cost",
] as const)

/** Exact route.py argparse choices in KiCadRoutingTools 0.21.3. */
export const KRT_RIPUP_ABANDON_METRIC_CHOICES = Object.freeze([
  "stranded", "total-pads", "complete-nets", "congestion",
  "history", "weighted", "probe", "weighted-probe",
] as const)

export type KrtRipupBlockerSelect = typeof KRT_RIPUP_BLOCKER_SELECT_CHOICES[number]
export type KrtRipupAbandonMetric = typeof KRT_RIPUP_ABANDON_METRIC_CHOICES[number]
export type KrtOrdering = "mps" | "original" | "inside_out"

export type KrtSpecialCandidate = Readonly<{
  id: string
  ordering: KrtOrdering
  mpsReverseRounds: boolean
  maxRipup: number
}>

/** Parse check_drc.py's stable human summary without assuming OK starts a line. */
export function parseKrtDrcViolationCount(stdout: string): number | undefined {
  const failedMatch = stdout.match(/FAILED\s*\((\d+)\s+violations?\)/i)
  if (failedMatch) return Number(failedMatch[1])
  return /(?:^|\s)OK(?:\s*(?:\(|$))/m.test(stdout) ? 0 : undefined
}

/**
 * Deterministic special-stage search variants. Every variant is run from the
 * same immutable board, so a permissive rip-up attempt cannot damage copper
 * produced by a safer candidate.
 */
export function buildKrtSpecialCandidates(
  maxCandidates = 1,
  configuredMaxRipup = 0,
): KrtSpecialCandidate[] {
  const limit = Number.isFinite(maxCandidates)
    ? Math.max(1, Math.min(16, Math.trunc(maxCandidates)))
    : 1
  const maximumRipup = Number.isFinite(configuredMaxRipup)
    ? Math.max(0, Math.trunc(configuredMaxRipup))
    : 0
  const variants: KrtSpecialCandidate[] = []
  const seen = new Set<string>()
  const append = (ordering: KrtOrdering, mpsReverseRounds: boolean, maxRipup: number) => {
    const reverse = ordering === "mps" && mpsReverseRounds
    const ripup = Math.max(0, Math.trunc(maxRipup))
    const key = `${ordering}:${reverse ? 1 : 0}:${ripup}`
    if (seen.has(key)) return
    seen.add(key)
    variants.push({
      id: `${ordering}${reverse ? "-reverse" : ""}-rip${ripup}`,
      ordering,
      mpsReverseRounds: reverse,
      maxRipup: ripup,
    })
  }

  // The first variant is the measured PowerBank winner: preserve declared
  // pair order and never sacrifice a completed pair. Keep ordinary MPS and a
  // bounded rip-up alternative near the front so small portfolios are useful.
  append("original", false, 0)
  append("mps", false, 0)
  if (maximumRipup > 0) append("original", false, maximumRipup)
  append("mps", true, 0)
  if (maximumRipup > 0) {
    append("mps", false, maximumRipup)
    append("mps", true, maximumRipup)
  }
  append("inside_out", false, 0)
  if (maximumRipup > 0) append("inside_out", false, maximumRipup)

  for (const ripup of [...new Set([
    maximumRipup > 1 ? Math.ceil(maximumRipup / 2) : maximumRipup,
    maximumRipup > 0 ? 1 : 0,
  ])]) {
    if (ripup <= 0) continue
    append("original", false, ripup)
    append("mps", false, ripup)
    append("mps", true, ripup)
    append("inside_out", false, ripup)
  }
  return variants.slice(0, limit)
}

export type KrtNumericRules = {
  /** Nominal CLI width. KRT may neck down only to hardTrackWidth. */
  trackWidth: number
  hardTrackWidth?: number
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
  /** KRT centre-to-centre meander pitch, expressed as a track-width multiplier. */
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
  /** Match P/N inside each pair only when native DRC or DSL requested skew. */
  matchDifferentialPairLengths?: boolean
  /** Core-owned return-via stitching replaces KRT's search-time return-via heuristic. */
  suppressGroundReturnVias?: boolean
  /** Exact pre-existing nets KRT may rip only when they block remainingNets. */
  ripExistingNets?: readonly string[]
  powerNets?: readonly { net: string; width: number }[]
  /** Ordinary routing normally uses MPS; special candidates may vary ordering. */
  ordering?: KrtOrdering
  /** Reverse MPS rounds so the most-conflicting groups route first. */
  mpsReverseRounds?: boolean
  /** Number of isolated special-stage candidates, hard-capped at 16. */
  specialMaxCandidates?: number
  /** Persist protected_nets only after the complete special pipeline wins. */
  protectSpecialOutput?: boolean
  /** Legacy compatibility; explicit ordering remains authoritative. */
  preserveNetOrder?: boolean
  /** Allow KRT's additive rescue pass without relaxing native clearance. */
  enableNetRescue?: boolean
  /** Allow geometry fallback only when the fab overrides contain a real lower rung. */
  enableTerminalEscalation?: boolean
  maxIterations?: number
  maxProbeIterations?: number
  maxRipup?: number
  heuristicWeight?: number
  /** KRT full-search tranche extension. Undefined preserves the upstream default. */
  dynamicIterations?: boolean
  ripupBlockerSelect?: KrtRipupBlockerSelect
  /** route.py only; route_diff.py has no abandon-metric phase. */
  ripupAbandonMetric?: KrtRipupAbandonMetric
  neckdownLength?: number
  neckdownTaperLength?: number
  /** Route-quality costs only; these never weaken DRC geometry. */
  viaCost?: number
  viaProximityCost?: number
  turnCost?: number
  directionPreferenceCost?: number
  collectStats?: boolean
  debugMemory?: boolean
  /** Native route.py bus detection. true emits only --bus and preserves KRT defaults. */
  busDetect?: true | Readonly<{
    detectionRadiusMm?: number
    minNets?: number
    attractionRadiusMm?: number
  }>
  /** Exact native filled copper was materialized as locked same-net tracks. */
  filledCopperProxy?: boolean
  /** Managed KRT patch stamps exact native filled polygons as net-aware obstacles. */
  exactFilledZoneObstacles?: boolean
  /** Abort the active KRT subprocess without throwing from the workflow. */
  signal?: AbortSignal
}

export type KrtQfnFanoutSpec = KrtStageSpec & Readonly<{
  component: string
  /** Exact logical pad numbers; duplicate physical pads with the same number are treated together. */
  padNumbers: readonly string[]
  nets: readonly string[]
  layer: string
  extension?: number
  method: "stub" | "underpad"
}>

export type KrtProcessStatus =
  | "completed"
  | "skipped"
  | "preflight_failed"
  | "process_failed"

export type KrtProcessResult = {
  stage: "fanout" | "special" | "remaining"
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
  /** KRT 0.21.3 route.py --json-out artifact with merged reconciliation state. */
  mergedSummaryPath?: string
  jsonSummary?: Record<string, unknown>
  /** Compact authoritative verdict emitted once by KRT 0.21.3 route.py. */
  jsonSummaryMin?: Record<string, unknown>
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

const GND_NET_NAMES = new Set(["GND", "/GND"])

function isGroundNetName(net: string) {
  return GND_NET_NAMES.has(net.trim().toUpperCase())
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

function isMultisetSubset(required: readonly string[], available: readonly string[]) {
  const counts = new Map<string, number>()
  for (const signature of available) counts.set(signature, (counts.get(signature) ?? 0) + 1)
  for (const signature of required) {
    const count = counts.get(signature) ?? 0
    if (count <= 0) return false
    counts.set(signature, count - 1)
  }
  return true
}

async function removedCopperGeometryNets(
  beforePath: string,
  afterPath: string,
  netNames: readonly string[],
) {
  const before = parsePcbSource(await readFile(beforePath, "utf8"))
  const after = parsePcbSource(await readFile(afterPath, "utf8"))
  return unique(netNames).filter((net) => !isMultisetSubset(
    copperGeometrySignatures(before, net),
    copperGeometrySignatures(after, net),
  ))
}

function canonicalCopperSignature(value: SExpression) {
  return JSON.stringify(canonicalCopperNode(value))
}

/** Lock only copper added by a fanout subprocess, preserving all source nodes byte-semantically. */
async function lockAddedCopper(inputPath: string, outputPath: string) {
  const before = parsePcbSource(await readFile(inputPath, "utf8"))
  const after = parsePcbSource(await readFile(outputPath, "utf8"))
  const available = new Map<string, number>()
  for (const head of ["segment", "arc", "via"] as const) for (const node of listChildren(before, head)) {
    const signature = `${head}:${canonicalCopperSignature(node)}`
    available.set(signature, (available.get(signature) ?? 0) + 1)
  }
  let locked = 0
  for (const head of ["segment", "arc", "via"] as const) for (const node of listChildren(after, head)) {
    const signature = `${head}:${canonicalCopperSignature(node)}`
    const count = available.get(signature) ?? 0
    if (count > 0) {
      available.set(signature, count - 1)
      continue
    }
    if (!findChild(node, "locked")) node.push([token("locked"), token("yes")])
    locked += 1
  }
  if (locked) await writeFile(outputPath, `${printSExpression(after)}\n`, "utf8")
  return locked
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function fanoutDrcGrazeCount(summary: Record<string, unknown> | undefined) {
  const grazes = jsonObject(summary?.drc_grazes)
  if (!grazes || typeof grazes.error === "string") return undefined
  return ["pad_via", "via_segment", "pad_segment", "segment_segment"]
    .reduce((total, key) => total + Math.max(0, Number(grazes[key]) || 0), 0)
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

/** Parse KRT 0.21.3's one-per-outer-run compact merged verdict. */
export function parseKrtJsonSummaryMin(stdout: string): Record<string, unknown> | undefined {
  const values: Record<string, unknown>[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const marker = line.indexOf("JSON_SUMMARY_MIN:")
    if (marker < 0) continue
    try {
      const value: unknown = JSON.parse(line.slice(marker + "JSON_SUMMARY_MIN:".length).trim())
      if (value && typeof value === "object" && !Array.isArray(value)) {
        values.push(value as Record<string, unknown>)
      }
    } catch {
      // executeStage retains the raw log and reports the missing compact verdict.
    }
  }
  return values.length === 1 ? values[0] : undefined
}

async function readMergedJsonSummary(path: string, diagnostics: KrtDiagnostic[]) {
  if (!(await exists(path))) return undefined
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    diagnostics.push(diagnostic(
      "KRT_MERGED_SUMMARY_INVALID",
      "warning",
      "KRT --json-out did not contain a JSON object; falling back to the first log summary.",
      { path },
    ))
  } catch (error) {
    diagnostics.push(diagnostic(
      "KRT_MERGED_SUMMARY_INVALID",
      "warning",
      `Could not read KRT --json-out: ${errorText(error)}`,
      { path },
    ))
  }
  return undefined
}

const KRT_ALREADY_CONNECTED_MARKER = "All nets are already fully connected - nothing to route!"

async function alreadyConnectedNoOpSummary(
  inputBoard: string,
  outputBoard: string,
  exitCode: number | null | undefined,
  stdout: string,
) {
  if (exitCode !== 0 || !stdout.includes(KRT_ALREADY_CONNECTED_MARKER) || !(await exists(outputBoard))) return undefined
  const [input, output] = await Promise.all([readFile(inputBoard), readFile(outputBoard)])
  if (!input.equals(output)) return undefined
  return {
    successful: 0,
    failed: 0,
    failed_single: [],
    open_single: [],
    failed_multipoint: [],
    cleanup_disconnected: [],
    coverage_gate_nets: [],
    pad_pairs_open: [],
    no_op: "already-connected",
  }
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
  terminalEscalationAllowed = false,
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
      terminalEscalationAllowed ? "warning" : "error",
      terminalEscalationAllowed
        ? "KRT used an allowed local terminal neck-down to complete a dense pad escape."
        : "KRT reported terminal geometry escalation despite the adapter kill switch.",
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
): Promise<CapturedProcess> {
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

function validatePositiveInteger(
  value: number | undefined,
  field: string,
  diagnostics: KrtDiagnostic[],
) {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value <= 0) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC",
    "error",
    `${field} must be a positive safe integer.`,
    { field, value },
  ))
}

function validateNonNegativeInteger(
  value: number | undefined,
  field: string,
  diagnostics: KrtDiagnostic[],
) {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 0) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC",
    "error",
    `${field} must be a non-negative safe integer.`,
    { field, value },
  ))
}

function validateChoice(
  value: string | undefined,
  field: string,
  choices: readonly string[],
  diagnostics: KrtDiagnostic[],
) {
  if (value === undefined) return
  if (!choices.includes(value)) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC",
    "error",
    `${field} must be one of: ${choices.join(", ")}.`,
    { field, value, choices },
  ))
}

async function commonPreflight(
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  scriptName: "qfn_fanout.py" | "route_diff.py" | "route.py",
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
  validatePositiveNumber(spec.rules.hardTrackWidth, "rules.hardTrackWidth", diagnostics)
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
  validateNonNegativeNumber(spec.neckdownLength, "neckdownLength", diagnostics)
  validateNonNegativeNumber(spec.neckdownTaperLength, "neckdownTaperLength", diagnostics)
  validatePositiveInteger(spec.maxIterations, "maxIterations", diagnostics)
  validatePositiveInteger(spec.maxProbeIterations, "maxProbeIterations", diagnostics)
  validateNonNegativeInteger(spec.maxRipup, "maxRipup", diagnostics)
  validatePositiveInteger(spec.specialMaxCandidates, "specialMaxCandidates", diagnostics)
  if (spec.specialMaxCandidates !== undefined && spec.specialMaxCandidates > 16) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC", "error", "specialMaxCandidates must not exceed 16.",
    { field: "specialMaxCandidates", value: spec.specialMaxCandidates },
  ))
  validateChoice(spec.ordering, "ordering", ["mps", "original", "inside_out"], diagnostics)
  if (spec.mpsReverseRounds && spec.ordering !== undefined && spec.ordering !== "mps") diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC",
    "error",
    "mpsReverseRounds is valid only with ordering='mps'.",
    { ordering: spec.ordering },
  ))
  validatePositiveNumber(spec.heuristicWeight, "heuristicWeight", diagnostics)
  validateNonNegativeInteger(spec.viaCost, "viaCost", diagnostics)
  validateNonNegativeInteger(spec.viaProximityCost, "viaProximityCost", diagnostics)
  validateNonNegativeInteger(spec.turnCost, "turnCost", diagnostics)
  validateNonNegativeInteger(spec.directionPreferenceCost, "directionPreferenceCost", diagnostics)
  validateChoice(spec.ripupBlockerSelect, "ripupBlockerSelect", KRT_RIPUP_BLOCKER_SELECT_CHOICES, diagnostics)
  validateChoice(spec.ripupAbandonMetric, "ripupAbandonMetric", KRT_RIPUP_ABANDON_METRIC_CHOICES, diagnostics)
  if (spec.dynamicIterations !== undefined && typeof spec.dynamicIterations !== "boolean") diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC", "error", "dynamicIterations must be a boolean.",
    { field: "dynamicIterations", value: spec.dynamicIterations },
  ))

  const hardTrackWidth = spec.rules.hardTrackWidth ?? spec.rules.trackWidth
  if (hardTrackWidth > spec.rules.trackWidth + EPSILON) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC",
    "error",
    "rules.hardTrackWidth must not exceed the nominal rules.trackWidth.",
    { hardTrackWidth, trackWidth: spec.rules.trackWidth },
  ))

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
      const holeToHoleClearance = spec.rules.holeToHoleClearance ?? spec.rules.clearance
      const required: Array<[string, number]> = [
        ["track_width", hardTrackWidth],
        ["clearance", spec.rules.clearance],
        ["via_diameter", spec.rules.viaSize],
        ["via_drill", spec.rules.viaDrill],
        ["hole_to_hole", holeToHoleClearance],
        ["pad_hole_to_hole", holeToHoleClearance],
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
      if (isGroundNetName(member)) diagnostics.push(diagnostic(
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
    if (group.nets.length < 2) diagnostics.push(diagnostic(
      "KRT_INVALID_MATCHED_GROUP",
      "error",
      "Every matched group must contain at least two exact net names.",
      { index, group },
    ))
    for (const net of group.nets) {
      if (isGroundNetName(net)) diagnostics.push(diagnostic(
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
  const specialNets = new Set(spec.diffPairs.flatMap((pair) => {
    const normalized = normalizePair(pair)
    return [normalized.positive, normalized.negative]
  }))
  const forbidden = nets.filter((net) => isGroundNetName(net) || specialNets.has(net))
  if (forbidden.length) diagnostics.push(diagnostic(
    "KRT_REMAINING_SCOPE_CONFLICT",
    "error",
    "The remaining pass must explicitly exclude GND and every special net.",
    forbidden,
  ))
  const ripExistingNets = unique(spec.ripExistingNets ?? [])
  const invalidRipNets = ripExistingNets.filter((net) => (
    isGroundNetName(net) || specialNets.has(net) || nets.includes(net)
  ))
  if (invalidRipNets.length) diagnostics.push(diagnostic(
    "KRT_RIP_SCOPE_CONFLICT",
    "error",
    "Blocker repair may rip only exact, non-GND, non-special nets outside remainingNets.",
    invalidRipNets,
  ))
  const routed = new Set(nets)
  const powerNames = unique((spec.powerNets ?? []).map((item) => item.net))
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
  // Scope selectors never choose priority implicitly. Ordinary calls keep MPS;
  // isolated special candidates may explicitly test declared order, reversed
  // MPS rounds, or inside-out ordering.
  const ordering = spec.ordering ?? "mps"
  args.push("--ordering", ordering)
  if (ordering === "mps" && spec.mpsReverseRounds) args.push("--mps-reverse-rounds")
  pushNumericArg(args, "--max-iterations", spec.maxIterations)
  pushNumericArg(args, "--max-probe-iterations", spec.maxProbeIterations)
  pushNumericArg(args, "--max-ripup", spec.maxRipup)
  if (spec.ripupBlockerSelect) args.push("--ripup-blocker-select", spec.ripupBlockerSelect)
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

function appendRoutePyQualityArgs(args: string[], spec: KrtStageSpec) {
  if (spec.ripupAbandonMetric) args.push("--ripup-abandon-metric", spec.ripupAbandonMetric)
  pushNumericArg(args, "--neckdown-length", spec.neckdownLength)
  pushNumericArg(args, "--neckdown-taper-length", spec.neckdownTaperLength)
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
  if (spec.matchDifferentialPairLengths) args.push("--diff-pair-intra-match")
  if (spec.suppressGroundReturnVias) args.push("--no-gnd-vias")
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
  appendRoutePyQualityArgs(args, spec)
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
  if (spec.busDetect) {
    args.push("--bus")
    if (spec.busDetect !== true) {
      pushNumericArg(args, "--bus-detection-radius", spec.busDetect.detectionRadiusMm)
      pushNumericArg(args, "--bus-min-nets", spec.busDetect.minNets)
      pushNumericArg(args, "--bus-attraction-radius", spec.busDetect.attractionRadiusMm)
    }
  }
  const ripExistingNets = unique(spec.ripExistingNets ?? [])
  if (ripExistingNets.length) args.push("--rip-existing-nets", ...ripExistingNets)
  if (spec.collectStats) args.push("--stats")
  appendRoutePyQualityArgs(args, spec)
  if (spec.powerNets?.length) {
    args.push("--power-nets", ...spec.powerNets.map((item) => item.net))
    args.push("--power-nets-widths", ...spec.powerNets.map((item) => numberArg(item.width)))
  }

  // console.log(args)
  return args //.slice(0, 2)
}

/** Deterministic command-contract helper used by adapter contract tests. */
export function buildKrtRemainingArgs(
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  nets: readonly string[],
) {
  return remainingArgs(inputBoard, outputBoard, spec, [...nets])
}

function qfnFanoutArgs(
  inputBoard: string,
  outputBoard: string,
  spec: KrtQfnFanoutSpec,
  diagnostics: KrtDiagnostic[],
) {
  const component = spec.component.trim()
  const pads = unique(spec.padNumbers)
  const nets = unique(spec.nets)
  if (!component) diagnostics.push(diagnostic(
    "KRT_INVALID_FANOUT_SCOPE", "error", "QFN fanout requires one exact component designator.",
  ))
  if (!pads.length) diagnostics.push(diagnostic(
    "KRT_INVALID_FANOUT_SCOPE", "error", "QFN fanout requires at least one exact logical pad number.",
  ))
  if (!nets.length) diagnostics.push(diagnostic(
    "KRT_INVALID_FANOUT_SCOPE", "error", "QFN fanout requires at least one exact net name.",
  ))
  if (!spec.layer.trim() || !spec.layers.includes(spec.layer)) diagnostics.push(diagnostic(
    "KRT_INVALID_FANOUT_LAYER",
    "error",
    "QFN fanout layer must be one of the compiled routing layers.",
    { layer: spec.layer, layers: spec.layers },
  ))
  validateNonNegativeNumber(spec.extension, "fanout extension", diagnostics)
  if (diagnostics.some((item) => item.severity === "error")) return undefined

  const args = [resolve(inputBoard), "--output", resolve(outputBoard)]
  args.push("--component", component)
  args.push("--layer", spec.layer)
  args.push("--width", numberArg(spec.rules.trackWidth))
  args.push("--extension", numberArg(spec.extension ?? 0.1))
  args.push("--clearance", numberArg(spec.rules.clearance))
  args.push("--nets", ...nets)
  pushNumericArg(args, "--grid-step", spec.rules.gridStep)
  args.push("--escape-method", spec.method)
  args.push("--via-size", numberArg(spec.rules.viaSize))
  args.push("--via-drill", numberArg(spec.rules.viaDrill))
  pushNumericArg(args, "--board-edge-clearance", spec.rules.boardEdgeClearance)
  // Completion-first fanout always permits via-in-pad. KRT's positive
  // same-net pad clearance otherwise overrides --allow-via-in-pad, so pin it
  // to the explicit "allowed" sentinel for this isolated fanout subprocess.
  args.push("--same-net-pad-clearance", "-1", "--allow-via-in-pad")
  args.push("--fab-overrides", resolve(spec.fabOverridesPath), "--no-fix-drc-settings")
  return args
}

function dynamicIterationsEnvironment(spec: KrtStageSpec): Record<string, string> {
  return spec.dynamicIterations === undefined
    ? {}
    : { KICAD_DYNAMIC_ITERATIONS: spec.dynamicIterations ? "1" : "0" }
}

function explicitDiffPairEnvironment(
  pairs: readonly NormalizedPair[],
): Record<string, string> {
  return pairs.length
    ? {
        COPILOT_ROUTER_DIFF_PAIRS: JSON.stringify(
          pairs.map((pair) => [pair.positive, pair.negative]),
        ),
      }
    : {}
}

async function executeStage(
  stage: "fanout" | "special" | "remaining",
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  artifactsDir: string,
  scriptName: "qfn_fanout.py" | "route_diff.py" | "route.py",
  buildArgs: (diagnostics: KrtDiagnostic[]) => string[] | undefined,
  summaryKind: "fanout" | "special" | "remaining" = stage,
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<KrtProcessResult> {
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

    // route.py may emit a run-scope summary followed by a reconciliation
    // subset. KRT 0.21.3 owns their state/effort merge and exposes the result
    // through --json-out; consuming that file avoids reimplementing upstream's
    // scope semantics in TypeScript. route_diff.py and qfn_fanout.py retain
    // their existing single-summary contracts.
    if (scriptName === "route.py") {
      result.mergedSummaryPath = join(normalizedArtifacts, `krt-${stage}-summary.json`)
      await rm(result.mergedSummaryPath, { force: true }).catch(() => undefined)
      args.push("--json-out", result.mergedSummaryPath)
    }

    const scriptPath = join(normalizedKrt, "py_router", scriptName)
    const processArgs = pythonScriptArgs(scriptPath, args, spec.pythonPathEntries)
    result.command = [executable, ...processArgs]
    result.invocationPath = join(normalizedArtifacts, `krt-${stage}-invocation.json`)
    // console.log(result.command)
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
        ...dynamicIterationsEnvironment(spec),
        PYTHONDONTWRITEBYTECODE: "1",
        ...KRT_REQUIRED_NECKDOWN_ENVIRONMENT,
        // KRT otherwise performs a second bare-BGA "direct first" partition
        // after MPS. Disable it so MPS remains the actual final order.
        KICAD_DIRECT_FIRST: "0",
        ...extraEnvironment,
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
        KICAD_DIRECT_FIRST: "0",
        KICAD_NET_RESCUE: spec.enableNetRescue ? "1" : "0",
        KICAD_TERMINAL_ESCALATION: spec.enableTerminalEscalation ? "1" : "0",
        ...dynamicIterationsEnvironment(spec),
        ...extraEnvironment,
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
    result.jsonSummaryMin = parseKrtJsonSummaryMin(result.stdout)
    const mergedSummary = result.mergedSummaryPath
      ? await readMergedJsonSummary(result.mergedSummaryPath, diagnostics)
      : undefined
    if (!mergedSummary && !result.jsonSummaries.length) {
      const noOp = await alreadyConnectedNoOpSummary(
        normalizedInput,
        normalizedOutput,
        captured.exitCode,
        result.stdout,
      )
      if (noOp) {
        result.jsonSummaries = [noOp]
        diagnostics.push(diagnostic(
          "KRT_ALREADY_CONNECTED",
          "info",
          "KRT confirmed that every selected net was already connected; the unchanged output is a valid no-op result.",
        ))
      }
    }
    result.jsonSummary = mergedSummary ?? result.jsonSummaries[0]
    if (mergedSummary && result.jsonSummaries.length > 1) diagnostics.push(diagnostic(
      "KRT_RECONCILIATION_SUMMARY_MERGED",
      "info",
      "Consumed KRT's authoritative merged reconciliation summary.",
      { count: result.jsonSummaries.length, path: result.mergedSummaryPath },
    ))
    else if (result.jsonSummaries.length > 1) diagnostics.push(diagnostic(
      "KRT_MULTIPLE_JSON_SUMMARIES",
      "warning",
      "KRT emitted reconciliation sub-run summaries without a readable merged --json-out artifact; the first summary is retained as a compatibility fallback.",
      { count: result.jsonSummaries.length },
    ))
    if (scriptName === "route.py" && result.attempted && !result.jsonSummaryMin) diagnostics.push(diagnostic(
      "KRT_SUMMARY_MIN_MISSING",
      "warning",
      "KRT route.py did not emit exactly one parseable JSON_SUMMARY_MIN verdict.",
    ))
    if (!result.jsonSummary) diagnostics.push(diagnostic(
      "KRT_SUMMARY_MISSING",
      "error",
      "KRT produced no parseable JSON_SUMMARY; exit code alone is not a routing result.",
    ))
    else if (summaryKind === "special") addSpecialSummaryDiagnostics(
      result.jsonSummary, spec.rules, diagnostics,
    )
    else if (summaryKind === "remaining") addRemainingSummaryDiagnostics(
      result.jsonSummary,
      spec.rules,
      diagnostics,
      spec.ripExistingNets,
      spec.enableTerminalEscalation,
    )
    else {
      const unescaped = stringArray(result.jsonSummary.unescaped_nets)
      if (unescaped.length) diagnostics.push(diagnostic(
        "KRT_FANOUT_PARTIAL",
        "warning",
        `KRT could not place a legal fanout stub for ${unescaped.length} net(s).`,
        { component: result.jsonSummary.component, unescapedNets: unescaped },
      ))
      const grazes = jsonObject(result.jsonSummary.drc_grazes)
      if (typeof grazes?.error === "string") diagnostics.push(diagnostic(
        "KRT_FANOUT_DRC_CHECK_FAILED",
        "warning",
        `KRT's built-in post-fanout DRC check could not complete: ${grazes.error}`,
      ))
    }

    if (!(await exists(normalizedOutput))) diagnostics.push(diagnostic(
      "KRT_OUTPUT_MISSING",
      "error",
      "KRT did not leave an output board artifact.",
      { outputBoard: normalizedOutput },
    ))
    if (stage === "special" && spec.protectSpecialOutput !== false && await exists(normalizedOutput)) {
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

type KrtConnectivityAudit = Readonly<{
  openNets: string[]
  elapsedMs: number
  stdout: string
  stderr: string
  failed: boolean
}>

type KrtDrcAudit = Readonly<{
  violationCount: number
  elapsedMs: number
  stdout: string
  stderr: string
  failed: boolean
}>

async function auditKrtConnectivity(
  boardPath: string,
  netNames: readonly string[],
  spec: KrtStageSpec,
  artifactsDir: string,
): Promise<KrtConnectivityAudit> {
  const marker = "COPILOT_ROUTER_CONNECTIVITY:"
  const modulePaths = [
    join(resolve(spec.krtDirectory), "py_router"),
    ...unique(spec.pythonPathEntries ?? []),
  ]
  const bootstrap = [
    "import json,sys",
    "sys.dont_write_bytecode=True",
    `sys.path[:0]=${JSON.stringify(modulePaths)}`,
    "from check_connected import run_connectivity_check",
    "issues=run_connectivity_check(sys.argv[1],json.loads(sys.argv[2]),0.02,True,False,None,False)",
    `print(${JSON.stringify(marker)}+json.dumps(sorted(set(str(item.get('net_name','')) for item in issues if item.get('net_name')))))`,
  ].join(";")
  const captured = await runCaptured(
    pythonCommand(spec.pythonPath),
    ["-c", bootstrap, resolve(boardPath), JSON.stringify(unique(netNames))],
    resolve(spec.krtDirectory),
    spec.timeoutMs,
    {
      ...(spec.pythonPathEntries?.length
        ? { PYTHONPATH: [...spec.pythonPathEntries, ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])].join(delimiter) }
        : {}),
      // Candidate grading must stay cheap and deterministic. Native refill is
      // still the final board authority after routing.
      KICAD_NO_GRADE_RECONCILE: "1",
    },
    spec.signal,
  )
  const line = captured.stdout.split(/\r?\n/).findLast((item) => item.startsWith(marker))
  let openNets: string[] = []
  let parsed = false
  if (line) {
    try {
      const value: unknown = JSON.parse(line.slice(marker.length))
      if (Array.isArray(value)) {
        openNets = unique(value.map(String))
        parsed = true
      }
    } catch {
      // The failed flag below retains the full stdout/stderr artifact.
    }
  }
  await mkdir(resolve(artifactsDir), { recursive: true }).catch(() => undefined)
  await writeFile(
    join(resolve(artifactsDir), "krt-special-connectivity.log"),
    `${captured.stdout}${captured.stderr ? `\n[stderr]\n${captured.stderr}` : ""}`,
    "utf8",
  ).catch(() => undefined)
  return {
    openNets,
    elapsedMs: captured.elapsedMs,
    stdout: captured.stdout,
    stderr: captured.stderr,
    failed: Boolean(captured.error || captured.timedOut || spec.signal?.aborted || !parsed),
  }
}

async function auditKrtDrc(
  boardPath: string,
  netNames: readonly string[],
  spec: KrtStageSpec,
  artifactsDir: string,
  artifactName: string,
): Promise<KrtDrcAudit> {
  const scriptPath = join(resolve(spec.krtDirectory), "py_router", "check_drc.py")
  const args = [resolve(boardPath), "--quiet", "--nets", ...unique(netNames)]
  const captured = await runCaptured(
    pythonCommand(spec.pythonPath),
    pythonScriptArgs(scriptPath, args, spec.pythonPathEntries),
    resolve(spec.krtDirectory),
    spec.timeoutMs,
    {
      ...(spec.pythonPathEntries?.length
        ? { PYTHONPATH: [...spec.pythonPathEntries, ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])].join(delimiter) }
        : {}),
    },
    spec.signal,
  )
  const violationCount = parseKrtDrcViolationCount(captured.stdout)
  const parsed = violationCount !== undefined
  await mkdir(resolve(artifactsDir), { recursive: true }).catch(() => undefined)
  await writeFile(
    join(resolve(artifactsDir), artifactName),
    `${captured.stdout}${captured.stderr ? `\n[stderr]\n${captured.stderr}` : ""}`,
    "utf8",
  ).catch(() => undefined)
  return {
    violationCount: violationCount ?? 0,
    elapsedMs: captured.elapsedMs,
    stdout: captured.stdout,
    stderr: captured.stderr,
    // check_drc exits 1 when it successfully found violations.
    failed: Boolean(captured.error || captured.timedOut || spec.signal?.aborted
      || !parsed || (captured.exitCode !== 0 && captured.exitCode !== 1)),
  }
}

function specialSemanticOpenNets(
  summary: Record<string, unknown> | undefined,
  pairs: readonly NormalizedPair[],
  completedFollowups: readonly string[],
) {
  if (!pairs.length) return []
  if (!summary) return unique(pairs.flatMap((pair) => [pair.positive, pair.negative]))
  const followups = new Set(completedFollowups)
  const routedPairNames = new Set(stringArray(summary.routed_diff_pairs))
  const reports = recordArray(summary.pair_reports)
  const open: string[] = []
  for (const pair of pairs) {
    const report = reports.find((item) => (
      item.p_net === pair.positive && item.n_net === pair.negative
    ) || (
        item.p_net === pair.negative && item.n_net === pair.positive
      ))
    const incomplete = report ? stringArray(report.incomplete_members) : []
    const pairName = typeof report?.pair === "string" ? report.pair : ""
    const coupled = report?.outcome === "coupled"
      && report.member_audit_mismatch !== true
      && incomplete.length === 0
    // Multipoint pairs may have a coupled trunk plus short duplicate-pad
    // branches. Accept that shape only when KRT recorded the pair as routed,
    // the pair has no failure reason, and every incomplete member was closed
    // by the explicit follow-up pass. A deferred/failed whole pair never
    // becomes a valid differential route merely because route.py connected it.
    const coupledWithFollowup = report?.outcome === "partial"
      && report.failure_reason == null
      && report.member_audit_mismatch !== true
      && Boolean(pairName && routedPairNames.has(pairName))
      && incomplete.length > 0
      && incomplete.every((net) => followups.has(net))
    if (!coupled && !coupledWithFollowup) open.push(pair.positive, pair.negative)
  }
  return unique(open)
}

const RESOLVED_FOLLOWUP_DIAGNOSTICS = new Set([
  "KRT_DIFF_PARTIAL",
  "KRT_DIFF_NOT_FULLY_COUPLED",
  "KRT_DIFF_PAIR_AUDIT_FAILED",
])

async function boardCopperCounts(boardPath: string) {
  const root = parsePcbSource(await readFile(boardPath, "utf8"))
  return {
    vias: listChildren(root, "via").length,
    routes: listChildren(root, "segment").length + listChildren(root, "arc").length,
  }
}

/** Run KRT's own geometry-aware QFN/QFP surface fanout for one compatible pad subset. */
export async function runKrtQfnFanout(
  inputBoard: string,
  outputBoard: string,
  spec: KrtQfnFanoutSpec,
  artifactsDir: string,
): Promise<KrtProcessResult> {
  const allowlist = JSON.stringify({ [spec.component]: unique(spec.padNumbers) })
  const result = await executeStage(
    "fanout",
    inputBoard,
    outputBoard,
    spec,
    artifactsDir,
    "qfn_fanout.py",
    (diagnostics) => qfnFanoutArgs(inputBoard, outputBoard, spec, diagnostics),
    "fanout",
    { COPILOT_ROUTER_QFN_PAD_ALLOWLIST: allowlist },
  )
  const grazeCount = fanoutDrcGrazeCount(result.jsonSummary)
  const drcCheckFailed = typeof jsonObject(result.jsonSummary?.drc_grazes)?.error === "string"
  if (result.status === "completed" && (drcCheckFailed || (grazeCount ?? 0) > 0)) {
    result.status = "process_failed"
    result.diagnostics.push(diagnostic(
      "KRT_FANOUT_DRC_REJECTED",
      "warning",
      drcCheckFailed
        ? "KRT's built-in post-fanout DRC check failed; the optional fanout board was rejected."
        : `KRT's built-in post-fanout DRC check reported ${grazeCount} copper graze(s); the optional fanout board was rejected.`,
      result.jsonSummary?.drc_grazes,
    ))
    await persistResultArtifacts(result, resolve(artifactsDir)).catch(() => undefined)
    return result
  }
  if (result.status === "completed" && await exists(result.outputBoard)) {
    try {
      const locked = await lockAddedCopper(result.inputBoard, result.outputBoard)
      result.diagnostics.push(diagnostic(
        "KRT_FANOUT_COPPER_LOCKED",
        "info",
        `Locked ${locked} fanout copper item(s) so later KRT routing cannot rip the accepted escape geometry.`,
        { component: spec.component, pads: unique(spec.padNumbers), locked },
      ))
      await saveOutputArtifact(result, resolve(artifactsDir))
      await persistResultArtifacts(result, resolve(artifactsDir))
    } catch (error) {
      result.status = "process_failed"
      result.diagnostics.push(diagnostic(
        "KRT_FANOUT_LOCK_FAILED",
        "error",
        `Could not lock generated fanout copper: ${errorText(error)}`,
        { component: spec.component },
      ))
      await persistResultArtifacts(result, resolve(artifactsDir)).catch(() => undefined)
    }
  }
  return result
}

async function runKrtSpecialPipeline(
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
      { ...spec, protectSpecialOutput: false },
      artifactsDir,
      scriptName,
      (diagnostics) => {
        specialPreflight(spec, diagnostics)
        return undefined
      },
      scriptName === "route.py" ? "remaining" : "special",
    )
  }

  const subcalls: KrtProcessResult[] = []
  const diffNets = unique(normalized.pairs.flatMap((pair) => [pair.positive, pair.negative]))
  let currentBoard = resolve(inputBoard)
  let diff: KrtProcessResult | undefined
  let completedFollowups: string[] = []

  if (normalized.pairs.length) {
    const diffOutput = join(resolve(artifactsDir), "special-diff-board.kicad_pcb")
    const diffSpec: KrtStageSpec = {
      ...spec,
      matchedGroups: normalized.coupledGroups.map((group) => group.nets),
      protectSpecialOutput: false,
    }
    diff = await executeStage(
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
      "special",
      explicitDiffPairEnvironment(normalized.pairs),
    )
    subcalls.push(diff)
    if (diff.attempted && await exists(diffOutput)) {
      currentBoard = diffOutput
    }

    const followupNets = unique(stringArray(diff.jsonSummary?.single_ended_followup_nets))
      .filter((net) => diffNets.includes(net))
    if (followupNets.length && currentBoard === diffOutput) {
      const followupOutput = join(resolve(artifactsDir), "special-followup-board.kicad_pcb")
      const followupSpec: KrtStageSpec = {
        ...spec,
        diffPairs: [],
        matchedGroups: [],
        remainingNets: followupNets,
        powerNets: [],
        ordering: "mps",
        mpsReverseRounds: false,
        maxRipup: 0,
        specialMaxCandidates: 1,
        protectSpecialOutput: false,
      }
      const followup = await executeStage(
        "remaining",
        currentBoard,
        followupOutput,
        followupSpec,
        join(artifactsDir, "special-followup"),
        "route.py",
        (diagnostics) => {
          const nets = remainingPreflight(followupSpec, diagnostics)
          if (diagnostics.some((item) => item.severity === "error")) return undefined
          return remainingArgs(currentBoard, followupOutput, followupSpec, nets)
        },
        "remaining",
      )
      subcalls.push(followup)
      let removed: string[] = []
      if (followup.attempted && await exists(followupOutput)) {
        try {
          removed = await removedCopperGeometryNets(currentBoard, followupOutput, diffNets)
          if (removed.length) followup.diagnostics.push(diagnostic(
            "KRT_SPECIAL_COUPLED_COPPER_REMOVED",
            "error",
            "The single-ended follow-up removed or rewrote coupled differential copper.",
            removed,
          ))
        } catch (error) {
          followup.diagnostics.push(diagnostic(
            "KRT_SPECIAL_PROTECTION_GUARD_FAILED",
            "error",
            `Could not verify coupled-copper custody after the follow-up: ${errorText(error)}`,
          ))
        }
      }
      const followupSucceeded = followup.status === "completed"
        && await exists(followupOutput)
        && !followup.diagnostics.some((item) => item.severity === "error")
        && removed.length === 0
      if (followupSucceeded) {
        completedFollowups = followupNets
        currentBoard = followupOutput
      }
    }
  }

  let ordinary: KrtProcessResult | undefined
  const beforeOrdinary = currentBoard
  if (normalized.ordinaryGroups.length) {
    const ordinarySpec: KrtStageSpec = {
      ...spec,
      rules: spec.ordinaryMatchedRules ?? spec.rules,
      fabOverridesPath: spec.ordinaryMatchedFabOverridesPath ?? spec.fabOverridesPath,
      diffPairs: [],
      matchedGroups: normalized.ordinaryGroups.map((group) => group.nets),
      protectSpecialOutput: false,
    }
    ordinary = await executeStage(
      "special",
      currentBoard,
      outputBoard,
      ordinarySpec,
      join(artifactsDir, "special-ordinary"),
      "route.py",
      (diagnostics) => {
        const current = specialPreflight(ordinarySpec, diagnostics)
        if (diagnostics.some((item) => item.severity === "error")) return undefined
        return matchedOrdinaryArgs(
          beforeOrdinary,
          outputBoard,
          ordinarySpec,
          current.ordinaryGroups,
        )
      },
      "remaining",
    )
    subcalls.push(ordinary)
    if (ordinary.attempted && await exists(resolve(outputBoard))) currentBoard = resolve(outputBoard)
  } else {
    const copyDiagnostics: KrtDiagnostic[] = []
    await removeBoardAndSidecars(resolve(outputBoard))
    await copyBoardAndSidecars(currentBoard, resolve(outputBoard), copyDiagnostics)
    if (copyDiagnostics.length) {
      subcalls.push({
        stage: "special", backend: "krt", status: copyDiagnostics.some((item) => item.severity === "error") ? "process_failed" : "completed",
        attempted: false, inputBoard: currentBoard, outputBoard: resolve(outputBoard), command: [], exitCode: 0,
        signal: null, timedOut: false, elapsedMs: 0, stdout: "", stderr: "", jsonSummaries: [], diagnostics: copyDiagnostics,
      })
    }
    currentBoard = resolve(outputBoard)
  }

  const diagnostics = subcalls.flatMap((item) => item.diagnostics)
  const diffSucceeded = !normalized.pairs.length || currentBoard !== resolve(inputBoard)
  if (ordinary && diffNets.length && diffSucceeded && await exists(beforeOrdinary) && await exists(resolve(outputBoard))) {
    try {
      const changed = await changedCopperGeometryNets(beforeOrdinary, resolve(outputBoard), diffNets)
      if (changed.length) diagnostics.push(diagnostic(
        "KRT_SPECIAL_PROTECTED_COPPER_CHANGED",
        "error",
        "The ordinary matched-group subcall changed differential copper from the preceding special subcall.",
        changed,
      ))
    } catch (error) {
      diagnostics.push(diagnostic(
        "KRT_SPECIAL_PROTECTION_GUARD_FAILED",
        "error",
        `Could not compare protected special copper: ${errorText(error)}`,
      ))
    }
  }
  if (ordinary && /\bWARNING:.*(?:NOT fully matched|SHORT of the group target)/i.test(ordinary.stdout)) {
    diagnostics.push(diagnostic(
      "KRT_LENGTH_MATCH_INCOMPLETE",
      "error",
      "KRT reported that an ordinary equal-length group did not meet its requested tolerance.",
    ))
  }

  const summary = {
    ...(diff?.jsonSummary ?? ordinary?.jsonSummary ?? {}),
    copilot_router_completed_followups: completedFollowups,
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
      ?? subcalls.findLast((item) => item.exitCode !== null)?.exitCode ?? null,
    signal: subcalls.find((item) => item.signal)?.signal ?? null,
    timedOut: subcalls.some((item) => item.timedOut),
    elapsedMs: subcalls.reduce((sum, item) => sum + item.elapsedMs, 0),
    stdout: subcalls.map((item) => item.stdout).filter(Boolean).join("\n"),
    stderr: subcalls.map((item) => item.stderr).filter(Boolean).join("\n"),
    jsonSummary: summary,
    jsonSummaries: subcalls.flatMap((item) => item.jsonSummaries),
    diagnostics,
    subcalls,
  }
  await mkdir(resolve(artifactsDir), { recursive: true }).catch(() => undefined)
  await saveOutputArtifact(aggregate, resolve(artifactsDir))
  await persistResultArtifacts(aggregate, resolve(artifactsDir)).catch(() => undefined)
  return aggregate
}

export async function runKrtSpecial(
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  artifactsDir: string,
): Promise<KrtProcessResult> {
  const normalized = specialPreflight(spec, [])
  const configured: KrtSpecialCandidate = {
    id: "configured",
    ordering: spec.ordering ?? "mps",
    mpsReverseRounds: Boolean(spec.ordering === "mps" && spec.mpsReverseRounds),
    maxRipup: Math.max(0, Math.trunc(spec.maxRipup ?? 0)),
  }
  const variants = spec.specialMaxCandidates === undefined || !normalized.pairs.length
    ? [configured]
    : buildKrtSpecialCandidates(spec.specialMaxCandidates, spec.maxRipup)
  const specialNets = unique([
    ...normalized.pairs.flatMap((pair) => [pair.positive, pair.negative]),
    ...normalized.coupledGroups.flatMap((group) => group.nets),
    ...normalized.ordinaryGroups.flatMap((group) => group.nets),
  ])
  const attempts: Array<{
    variant: KrtSpecialCandidate
    result: KrtProcessResult
    audit: KrtConnectivityAudit
    drc: KrtDrcAudit
    openNets: string[]
    addedDrcViolations: number
    hardErrors: number
    vias: number
    routes: number
    complete: boolean
  }> = []
  const baselineDrc = await auditKrtDrc(
    inputBoard,
    specialNets,
    spec,
    resolve(artifactsDir),
    "krt-special-baseline-drc.log",
  )

  for (const [index, variant] of variants.entries()) {
    const candidateDir = join(resolve(artifactsDir), `candidate-${String(index + 1).padStart(2, "0")}-${variant.id}`)
    const candidateOutput = join(candidateDir, "special-candidate.kicad_pcb")
    const candidateSpec: KrtStageSpec = {
      ...spec,
      ordering: variant.ordering,
      mpsReverseRounds: variant.mpsReverseRounds,
      maxRipup: variant.maxRipup,
      specialMaxCandidates: 1,
      // Return-via generation is deliberately outside differential search.
      // It created real pair-via DRC errors on PowerBank; core-owned return
      // stitching or plane stitching has exact final board-level context.
      suppressGroundReturnVias: normalized.pairs.length ? true : spec.suppressGroundReturnVias,
      protectSpecialOutput: false,
    }
    const result = await runKrtSpecialPipeline(
      inputBoard,
      candidateOutput,
      candidateSpec,
      candidateDir,
    )
    const completedFollowups = stringArray(result.jsonSummary?.copilot_router_completed_followups)
    const audit = await exists(candidateOutput)
      ? await auditKrtConnectivity(candidateOutput, specialNets, candidateSpec, candidateDir)
      : { openNets: [...specialNets], elapsedMs: 0, stdout: "", stderr: "", failed: true }
    const drc = await exists(candidateOutput)
      ? await auditKrtDrc(candidateOutput, specialNets, candidateSpec, candidateDir, "krt-special-drc.log")
      : { violationCount: Number.MAX_SAFE_INTEGER, elapsedMs: 0, stdout: "", stderr: "", failed: true }
    const addedDrcViolations = baselineDrc.failed || drc.failed
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, drc.violationCount - baselineDrc.violationCount)
    const semanticOpen = specialSemanticOpenNets(result.jsonSummary, normalized.pairs, completedFollowups)
    const openNets = unique([
      ...semanticOpen,
      ...(audit.failed ? specialNets : audit.openNets),
    ])
    const resolvedFollowup = openNets.length === 0 && completedFollowups.length > 0
    const hardErrors = result.diagnostics.filter((item) => (
      item.severity === "error"
      && !(resolvedFollowup && RESOLVED_FOLLOWUP_DIAGNOSTICS.has(item.code))
    )).length
    const counts = await exists(candidateOutput)
      ? await boardCopperCounts(candidateOutput).catch(() => ({ vias: Number.MAX_SAFE_INTEGER, routes: Number.MAX_SAFE_INTEGER }))
      : { vias: Number.MAX_SAFE_INTEGER, routes: Number.MAX_SAFE_INTEGER }
    const complete = result.status === "completed"
      && !audit.failed
      && !drc.failed
      && openNets.length === 0
      && addedDrcViolations === 0
      && hardErrors === 0
    attempts.push({ variant, result, audit, drc, openNets, addedDrcViolations, hardErrors, ...counts, complete })
    if (complete) break
    if (spec.signal?.aborted) break
  }

  const selected = [...attempts].sort((left, right) => {
    const a = [left.complete ? 0 : 1, left.openNets.length, left.addedDrcViolations, left.hardErrors, left.vias, left.routes]
    const b = [right.complete ? 0 : 1, right.openNets.length, right.addedDrcViolations, right.hardErrors, right.vias, right.routes]
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] - b[index]
    return attempts.indexOf(left) - attempts.indexOf(right)
  })[0]
  if (!selected) return runKrtSpecialPipeline(inputBoard, outputBoard, spec, artifactsDir)

  const diagnostics = selected.result.diagnostics
    .filter((item) => !(selected.complete && RESOLVED_FOLLOWUP_DIAGNOSTICS.has(item.code)))
  const completedFollowups = stringArray(selected.result.jsonSummary?.copilot_router_completed_followups)
  if (selected.complete && completedFollowups.length) diagnostics.push(diagnostic(
    "KRT_DIFF_FOLLOWUP_COMPLETED",
    "info",
    "KRT completed short multipoint differential branches without removing the coupled trunk.",
    { nets: completedFollowups },
  ))
  diagnostics.push(diagnostic(
    "KRT_SPECIAL_CANDIDATE_SELECTED",
    "info",
    `Selected special candidate ${selected.variant.id} after ${attempts.length} attempt(s).`,
    {
      selected: selected.variant,
      candidates: attempts.map((attempt) => ({
        id: attempt.variant.id,
        ordering: attempt.variant.ordering,
        mpsReverseRounds: attempt.variant.mpsReverseRounds,
        maxRipup: attempt.variant.maxRipup,
        complete: attempt.complete,
        openNets: attempt.openNets,
        drcViolations: attempt.drc.violationCount,
        addedDrcViolations: attempt.addedDrcViolations,
        hardErrors: attempt.hardErrors,
        vias: attempt.vias,
        routes: attempt.routes,
        elapsedMs: attempt.result.elapsedMs + attempt.audit.elapsedMs + attempt.drc.elapsedMs,
      })),
    },
  ))
  if (selected.audit.failed) diagnostics.push(diagnostic(
    "KRT_SPECIAL_CONNECTIVITY_AUDIT_FAILED",
    "error",
    "KRT could not grade the selected special candidate's electrical connectivity.",
    { stdout: selected.audit.stdout, stderr: selected.audit.stderr },
  ))
  if (baselineDrc.failed || selected.drc.failed) diagnostics.push(diagnostic(
    "KRT_SPECIAL_DRC_AUDIT_FAILED",
    "error",
    "KRT could not compare the selected special candidate against the input DRC baseline.",
    {
      baseline: { stdout: baselineDrc.stdout, stderr: baselineDrc.stderr },
      candidate: { stdout: selected.drc.stdout, stderr: selected.drc.stderr },
    },
  ))
  if (!baselineDrc.failed && !selected.drc.failed && selected.addedDrcViolations > 0) diagnostics.push(diagnostic(
    "KRT_SPECIAL_DRC_REGRESSION",
    "error",
    `The selected special candidate adds ${selected.addedDrcViolations} KRT DRC violation(s) over its input baseline.`,
    { baseline: baselineDrc.violationCount, candidate: selected.drc.violationCount },
  ))
  if (!selected.complete) diagnostics.push(diagnostic(
    "KRT_SPECIAL_PORTFOLIO_INCOMPLETE",
    "error",
    `No special candidate passed every connectivity and DRC gate; ${selected.openNets.length} net(s) remain unresolved in the selected candidate.`,
    { openNets: selected.openNets, addedDrcViolations: selected.addedDrcViolations },
  ))

  await removeBoardAndSidecars(resolve(outputBoard))
  await copyBoardAndSidecars(selected.result.outputBoard, resolve(outputBoard), diagnostics)
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
        `Could not protect selected special-net copper for later stages: ${errorText(error)}`,
      ))
    }
  }

  const aggregate: KrtProcessResult = {
    ...selected.result,
    status: selected.result.status,
    inputBoard: resolve(inputBoard),
    outputBoard: resolve(outputBoard),
    elapsedMs: baselineDrc.elapsedMs + attempts.reduce(
      (sum, attempt) => sum + attempt.result.elapsedMs + attempt.audit.elapsedMs + attempt.drc.elapsedMs,
      0,
    ),
    diagnostics,
    jsonSummary: {
      ...(selected.result.jsonSummary ?? {}),
      single_ended_followup_nets: selected.complete ? [] : stringArray(selected.result.jsonSummary?.single_ended_followup_nets),
      resolved_single_ended_followup_nets: selected.complete ? completedFollowups : [],
      special_open_nets: selected.openNets,
      special_candidate: selected.variant,
      special_candidate_count: attempts.length,
    },
    subcalls: attempts.map((attempt) => attempt.result),
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
