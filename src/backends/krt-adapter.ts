import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { constants, createWriteStream } from "node:fs"
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
  /** Undefined keeps the upstream script default. */
  maxRipup?: number
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

/**
 * Keep the configured/measured candidate first, then add bounded alternatives
 * without silently replacing KRT's native rip-up default with zero.
 */
export function buildKrtSpecialCandidatePortfolio(
  configured: KrtSpecialCandidate,
  maxCandidates = 1,
): KrtSpecialCandidate[] {
  const limit = Number.isFinite(maxCandidates)
    ? Math.max(1, Math.min(16, Math.trunc(maxCandidates)))
    : 1
  const candidateKey = (candidate: KrtSpecialCandidate) => (
    `${candidate.ordering}:${candidate.mpsReverseRounds ? 1 : 0}:${candidate.maxRipup ?? "native"}`
  )
  const alternatives = buildKrtSpecialCandidates(16, configured.maxRipup)
    .map<KrtSpecialCandidate>((candidate) => configured.maxRipup === undefined
      ? {
          id: candidate.id.replace(/-rip0$/, "-native-ripup"),
          ordering: candidate.ordering,
          mpsReverseRounds: candidate.mpsReverseRounds,
        }
      : candidate)
  return [
    configured,
    ...alternatives.filter((candidate) => candidateKey(candidate) !== candidateKey(configured)),
  ].slice(0, limit)
}

export type KrtNumericRules = {
  /** Nominal CLI width. KRT may neck down only to hardTrackWidth. */
  trackWidth: number
  hardTrackWidth?: number
  clearance: number
  /** Nominal CLI via geometry. The hard fabrication floor is independent. */
  viaSize: number
  viaDrill: number
  hardViaSize?: number
  hardViaDrill?: number
  hardViaAnnular?: number
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
  /**
   * Immutable project rules used to re-materialize the .kicad_pro sidecar
   * before every native invocation. When omitted, the input board's sibling
   * project is authoritative. KRT-written project files are never promoted to
   * the next stage's rule source.
   */
  authoritativeProjectPath?: string
  /** Geometry/fabrication floor for the route.py equal-length subcall. */
  ordinaryMatchedRules?: KrtNumericRules
  /** Bounded fine-grid/tolerance rules used only by an alternative ordinary matched candidate. */
  ordinaryMatchedFallbackRules?: KrtNumericRules
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
  /** Re-route the explicitly scoped nets even when their current copper is connected. */
  forceReroute?: boolean
  powerNets?: readonly { net: string; width: number }[]
  /**
   * Native, stackup-aware impedance solve for this isolated invocation.
   * This is an internal execution policy; the public board/DSL contracts stay
   * unchanged and remain authoritative for the requested values.
   */
  impedance?: Readonly<{
    targetOhm: number
    coplanarGapMm?: number
  }>
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
  /** Restore upstream custody-backed pre-existing-copper recovery. */
  ripPreexisting?: boolean
  /** Core owns plane generation; opt in only when native plane finalization is desired. */
  planeFinalize?: boolean
  /** Allow blocker rip-up in native plane finalization when that stage is enabled. */
  finalizeRip?: boolean
  /** Nets whose verified copper must remain protected during later native recovery. */
  protectedNets?: readonly string[]
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
  /** Hash manifest for the exact board/rule bundle consumed by this invocation. */
  manifestPath?: string
  resultPath?: string
  inputArtifactPath?: string
  outputArtifactPath?: string
  protectedNetsPath?: string
  protectedNets?: string[]
  /** Independent board-semantic length audit for the selected matched groups. */
  matchedGroupsAuditPath?: string
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

type KrtMatchedGroupAuditReason =
  | "capability-mismatch"
  | "connectivity-audit-failed"
  | "open-members"
  | "drc-audit-failed"
  | "drc-regression"
  | "invalid-tolerance"
  | "measurement-failed"
  | "outside-tolerance"

type KrtMatchedGroupAudit = Readonly<{
  index: number
  nets: readonly string[]
  coupled: boolean
  protectionGate: "differential" | "matched-group"
  toleranceMm: number
  lengthsMm: Readonly<Record<string, number>>
  measurementErrors: Readonly<Record<string, readonly string[]>>
  minLengthMm?: number
  maxLengthMm?: number
  spreadMm?: number
  excessMm?: number
  openNets: readonly string[]
  drcRegressedNets: readonly string[]
  reasons: readonly KrtMatchedGroupAuditReason[]
  verified: boolean
}>

type CapturedProcess = {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  elapsedMs: number
  stdout: string
  stderr: string
  error?: string
  logError?: string
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
  toolArgsPath?: string,
) {
  if (!pythonPathEntries?.length && !toolArgsPath) return [scriptPath, ...args]
  // KiCad's bundled Python uses a ._pth file on Windows and intentionally
  // ignores PYTHONPATH. Insert managed packages in-process, then execute the
  // real KRT CLI as __main__ without modifying the host interpreter.
  const bootstrap = [
    "import importlib,importlib.util,json,os,runpy,sys",
    "sys.dont_write_bytecode=True",
    "script=sys.argv[1]",
    `sys.path[:0]=[os.path.dirname(script),*${JSON.stringify([...(pythonPathEntries ?? [])])}]`,
    "importlib.import_module('copilot_router_krt_patch') if importlib.util.find_spec('copilot_router_krt_patch') else None",
    ...(toolArgsPath
      ? [
          "tool_args=json.load(open(sys.argv[2],encoding='utf-8'))",
          "isinstance(tool_args,list) or (_ for _ in ()).throw(RuntimeError('KRT args sidecar must contain a JSON array'))",
          "sys.argv=[script,*[str(value) for value in tool_args]]",
        ]
      : ["sys.argv=sys.argv[1:]"]),
    "runpy.run_path(script,run_name='__main__')",
  ].join(";")
  return ["-c", bootstrap, scriptPath, ...(toolArgsPath ? [resolve(toolArgsPath)] : args)]
}

export const KRT_EXACT_NET_SENTINEL = "__COPILOT_ROUTER_EXACT_NET_SCOPE_V1__"
export const KRT_EXACT_RIP_SENTINEL = "__COPILOT_ROUTER_EXACT_RIP_SCOPE_V1__"
export const KRT_DRC_SCOPE_SENTINEL = "__COPILOT_ROUTER_EXACT_DRC_SCOPE_V1__"

export type KrtExactSelectorSidecar = Readonly<{
  schemaVersion: 1
  netSelection: readonly string[]
  ripSelection: readonly string[]
  ripAuthorization: readonly string[]
  diffPairs: readonly (readonly [string, string])[]
  selectorTokens: readonly (readonly [string, string])[]
  netSentinel: string
  ripSentinel: string
}>

/**
 * @internal Keep Windows CreateProcess argv/environment size independent of
 * the number and spelling length of exact host-owned net selectors.
 */
export function compactKrtExactSelectorArgs(
  sourceArgs: readonly string[],
  scope: Readonly<{
    netSelection: readonly string[]
    ripSelection?: readonly string[]
    ripAuthorization?: readonly string[]
    diffPairs?: readonly (readonly [string, string])[]
  }>,
) {
  const args = [...sourceArgs]
  const selectorNames = unique([
    ...scope.netSelection,
    ...(scope.ripSelection ?? []),
  ])
  const occupiedNames = new Set(selectorNames)
  const uniqueScopeSentinel = (base: string, additionallyOccupied: ReadonlySet<string> = new Set()) => {
    let candidate = base
    let suffix = 0
    while (occupiedNames.has(candidate) || additionallyOccupied.has(candidate)) {
      suffix += 1
      candidate = `${base}_${suffix}`
    }
    return candidate
  }
  const netSentinel = uniqueScopeSentinel(KRT_EXACT_NET_SENTINEL)
  const ripSentinel = uniqueScopeSentinel(KRT_EXACT_RIP_SENTINEL, new Set([netSentinel]))
  let tokenNamespace = 0
  let selectorTokens: Array<readonly [string, string]>
  do {
    selectorTokens = selectorNames.map((name, index) => [
      `__COPILOT_ROUTER_EXACT_NAME_V1_${tokenNamespace}_${index}__`,
      name,
    ] as const)
    tokenNamespace += 1
  } while (selectorTokens.some(([token]) => occupiedNames.has(token)))
  const opaqueTokenByName = new Map(selectorTokens.map(([token, name]) => [name, token]))
  const selectorTokenMap = (
    candidates: readonly string[],
    encode: (name: string) => string,
  ) => {
    const byToken = new Map<string, string>()
    for (const name of unique(candidates)) {
      const token = encode(name)
      const previous = byToken.get(token)
      if (previous !== undefined && previous !== name) {
        throw new Error(`Exact KRT selector encoding collision between ${JSON.stringify(previous)} and ${JSON.stringify(name)}.`)
      }
      byToken.set(token, name)
    }
    return byToken
  }
  const compactFlag = (
    flag: "--nets" | "--rip-existing-nets",
    candidates: readonly string[],
    sentinel: string,
  ) => {
    const byToken = selectorTokenMap(candidates, krtLiteralNetFilterPattern)
    const selected: string[] = []
    let searchFrom = 0
    while (true) {
      const flagIndex = args.indexOf(flag, searchFrom)
      if (flagIndex < 0) break
      let end = flagIndex + 1
      const current: string[] = []
      while (end < args.length && !args[end].startsWith("--")) {
        const name = byToken.get(args[end])
        if (name === undefined) {
          throw new Error(`KRT ${flag} contains a selector not owned by the exact host scope: ${JSON.stringify(args[end])}.`)
        }
        current.push(name)
        end += 1
      }
      if (!current.length) throw new Error(`KRT ${flag} requires at least one exact host selector.`)
      selected.push(...current)
      args.splice(flagIndex + 1, end - flagIndex - 1, sentinel)
      searchFrom = flagIndex + 2
    }
    return unique(selected)
  }

  const netSelection = compactFlag("--nets", scope.netSelection, netSentinel)
  const ripSelection = compactFlag(
    "--rip-existing-nets",
    scope.ripSelection ?? [],
    ripSentinel,
  )
  const globTokens = selectorTokenMap(selectorNames, krtLiteralGlobPattern)
  const compactExactListFlag = (flag: "--length-match-group" | "--power-nets") => {
    let searchFrom = 0
    while (true) {
      const flagIndex = args.indexOf(flag, searchFrom)
      if (flagIndex < 0) break
      let end = flagIndex + 1
      while (end < args.length && !args[end].startsWith("--")) {
        const name = globTokens.get(args[end])
        const token = name === undefined ? undefined : opaqueTokenByName.get(name)
        if (name === undefined || token === undefined) {
          throw new Error(`KRT ${flag} contains a selector not owned by the exact host scope: ${JSON.stringify(args[end])}.`)
        }
        args[end] = token
        end += 1
      }
      if (end === flagIndex + 1) throw new Error(`KRT ${flag} requires at least one exact host selector.`)
      searchFrom = end
    }
  }
  compactExactListFlag("--length-match-group")
  compactExactListFlag("--power-nets")
  const sidecar: KrtExactSelectorSidecar = {
    schemaVersion: 1,
    netSelection,
    ripSelection,
    ripAuthorization: unique(scope.ripAuthorization ?? []),
    diffPairs: (scope.diffPairs ?? []).map(([positive, negative]) => [positive, negative] as const),
    selectorTokens,
    netSentinel,
    ripSentinel,
  }
  return { args, sidecar }
}

type KrtAuditScopeSidecar = Readonly<{
  schemaVersion: 1
  scopeId: string
  expected: readonly string[]
  patterns: readonly string[]
  resultPath: string
}>

/** @internal Exact audit data lives on disk; process argv stays constant-size. */
export function buildKrtAuditScopeTransport(
  netNames: readonly string[],
  scopePath: string,
  resultPath: string,
) {
  const expected = unique(netNames)
  const patterns = expected.map(krtLiteralGlobPattern)
  const scopeId = createHash("sha256")
    .update(JSON.stringify({ expected, patterns }))
    .digest("hex")
  const sidecar: KrtAuditScopeSidecar = {
    schemaVersion: 1,
    scopeId,
    expected,
    patterns,
    resultPath: resolve(resultPath),
  }
  return {
    sidecar,
    connectivityBootstrapArgs: [resolve(scopePath)],
    drcBootstrapArgs: [resolve(scopePath)],
    drcNetArgs: ["--nets", KRT_DRC_SCOPE_SENTINEL],
  }
}

function pythonScopedDrcArgs(
  scriptPath: string,
  args: readonly string[],
  pythonPathEntries: readonly string[] | undefined,
  scopePath: string,
) {
  // check_drc.py reports an empty fnmatch scope as a clean board. Resolve the
  // scope with the same parser/fnmatch implementation in the same process and
  // stop before grading unless it selects exactly the host-owned raw names.
  const bootstrap = [
    "import fnmatch,importlib,importlib.util,json,os,runpy,sys",
    "sys.dont_write_bytecode=True",
    "script=sys.argv[1]",
    "scope=json.load(open(sys.argv[2],encoding='utf-8'))",
    "expected=scope['expected']",
    "expected_set=set(expected)",
    "sentinel=" + JSON.stringify(KRT_DRC_SCOPE_SENTINEL),
    "tool_args=sys.argv[3:]",
    `sys.path[:0]=[os.path.dirname(script),*${JSON.stringify([...(pythonPathEntries ?? [])])}]`,
    "importlib.import_module('copilot_router_krt_patch') if importlib.util.find_spec('copilot_router_krt_patch') else None",
    "from kicad_parser import parse_kicad_pcb",
    "pcb=parse_kicad_pcb(tool_args[0])",
    "names=sorted(set(str(net.name) for net in pcb.nets.values() if getattr(net,'name',None)))",
    "selected=sorted(name for name in names if name in expected_set)",
    "scope_ok=set(selected)==set(expected)",
    "scope_result={'scopeId':scope.get('scopeId'),'scopeOk':scope_ok,'expectedCount':len(expected_set),'selectedCount':len(selected)}",
    "json.dump(scope_result,open(scope['resultPath'],'w',encoding='utf-8'),sort_keys=True)",
    "scope_ok or sys.exit(3)",
    "original_fnmatch=fnmatch.fnmatch",
    "fnmatch.fnmatch=lambda name,pattern: (name in expected_set) if pattern==sentinel else original_fnmatch(name,pattern)",
    "sys.argv=[script,*tool_args]",
    "runpy.run_path(script,run_name='__main__')",
  ].join(";")
  return [
    "-c",
    bootstrap,
    scriptPath,
    resolve(scopePath),
    ...args,
  ]
}

function unique(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

/** Escape one exact KiCad net name for a plain Python fnmatch consumer. */
export function krtLiteralGlobPattern(net: string) {
  const pattern = net
    .replaceAll("[", "[[]")
    .replaceAll("*", "[*]")
    .replaceAll("?", "[?]")
  // argparse treats a value beginning with "--" as another option even when
  // it follows a nargs selector. A one-character class is the exact fnmatch
  // spelling of a leading dash and keeps every legal KiCad name data-like.
  return pattern.startsWith("-") ? `[-]${pattern.slice(1)}` : pattern
}

/** Escape one exact name for KRT filters, which additionally use leading ! as exclusion. */
export function krtLiteralNetFilterPattern(net: string) {
  const pattern = krtLiteralGlobPattern(net)
  return net.startsWith("!") ? `\\${pattern}` : pattern
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

type KrtCopperLengthMeasurement = Readonly<{
  lengthsMm: Readonly<Record<string, number>>
  planarLengthsMm: Readonly<Record<string, number>>
  viaBarrelLengthsMm: Readonly<Record<string, number>>
  measurementErrorsByNet: Readonly<Record<string, readonly string[]>>
  vias: number
  routes: number
}>

function numericAtom(value: SExpression | undefined) {
  const parsed = Number(atom(value))
  return Number.isFinite(parsed) ? parsed : undefined
}

function nodePoint(node: SExpression[], head: string): readonly [number, number] | undefined {
  const point = findChild(node, head)
  if (!point) return undefined
  const x = numericAtom(point[1])
  const y = numericAtom(point[2])
  return x === undefined || y === undefined ? undefined : [x, y]
}

function pointDistance(left: readonly [number, number], right: readonly [number, number]) {
  return Math.hypot(right[0] - left[0], right[1] - left[1])
}

/**
 * Match KRT 0.21.3's `_arc_to_segments(..., chord_eps=0.005)` measurement.
 * Native output is linear, but inherited KiCad arcs must contribute exactly as
 * they do to KRT's own `net_copper_length()` semantic.
 */
function krtArcPolylineLength(
  start: readonly [number, number],
  mid: readonly [number, number],
  end: readonly [number, number],
) {
  const [ax, ay] = start
  const [bx, by] = mid
  const [cx, cy] = end
  const denominator = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(denominator) < 1e-10) return pointDistance(start, end)
  const ux = ((ax * ax + ay * ay) * (by - cy)
    + (bx * bx + by * by) * (cy - ay)
    + (cx * cx + cy * cy) * (ay - by)) / denominator
  const uy = ((ax * ax + ay * ay) * (cx - bx)
    + (bx * bx + by * by) * (ax - cx)
    + (cx * cx + cy * cy) * (bx - ax)) / denominator
  const radius = Math.hypot(ax - ux, ay - uy)
  if (!(radius > 0)) return pointDistance(start, end)
  const startAngle = Math.atan2(ay - uy, ax - ux)
  const normalize = (angle: number) => {
    const circle = 2 * Math.PI
    return ((angle - startAngle) % circle + circle) % circle
  }
  const midCcw = normalize(Math.atan2(by - uy, bx - ux))
  const endCcw = normalize(Math.atan2(cy - uy, cx - ux))
  const sweep = midCcw <= endCcw ? endCcw : endCcw - 2 * Math.PI
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - 0.005 / radius)))
  const segments = maxStep > 0
    ? Math.max(16, Math.min(512, Math.ceil(Math.abs(sweep) / maxStep)))
    : 16
  return segments * 2 * radius * Math.sin(Math.abs(sweep) / (2 * segments))
}

function requiredNodePoint(node: SExpression[], head: string, net: string) {
  const point = nodePoint(node, head)
  if (!point) throw new Error(`Malformed ${atom(node[0]) ?? "copper"} ${head} point on net ${net}`)
  return point
}

function lineNodeLength(node: SExpression[], net: string) {
  return pointDistance(requiredNodePoint(node, "start", net), requiredNodePoint(node, "end", net))
}

function arcNodeLength(node: SExpression[], net: string) {
  return krtArcPolylineLength(
    requiredNodePoint(node, "start", net),
    requiredNodePoint(node, "mid", net),
    requiredNodePoint(node, "end", net),
  )
}

function graphicStrokeWidth(node: SExpression[]) {
  const stroke = findChild(node, "stroke")
  return numericAtom(findChild(node, "width")?.[1])
    ?? numericAtom(stroke && findChild(stroke, "width")?.[1])
    ?? 0
}

function stackupLayers(root: SExpression[]) {
  const setup = findChild(root, "setup")
  const stackup = setup && findChild(setup, "stackup")
  if (!stackup) return []
  return listChildren(stackup, "layer").flatMap((layer) => {
    const name = atom(layer[1]) ?? ""
    const type = atom(findChild(layer, "type")?.[1]) ?? ""
    const thickness = numericAtom(findChild(layer, "thickness")?.[1]) ?? 0
    return name && ["copper", "core", "prepreg"].includes(type)
      ? [{ name, thickness }]
      : []
  })
}

function viaBarrelLength(node: SExpression[], layers: readonly { name: string; thickness: number }[]) {
  const endpoints = findChild(node, "layers")
  const first = atom(endpoints?.[1])
  const second = atom(endpoints?.[2])
  if (!first || !second || !layers.length) return 0
  const firstIndex = layers.findIndex((layer) => layer.name === first)
  const secondIndex = layers.findIndex((layer) => layer.name === second)
  if (firstIndex < 0 || secondIndex < 0) return 0
  const start = Math.min(firstIndex, secondIndex)
  const end = Math.max(firstIndex, secondIndex)
  return layers.slice(start, end + 1).reduce((sum, layer) => sum + layer.thickness, 0)
}

/**
 * Independently measure the intended KRT length metric (planar copper plus
 * via barrels) from the final board. The S-expression stackup reader is
 * deliberately stricter than KRT 0.21.3's line-oriented parser, so compact
 * host-generated stackups still receive their physically real barrel length.
 */
async function measureKrtNetCopperLengths(
  boardPath: string,
  netNames: readonly string[],
): Promise<KrtCopperLengthMeasurement> {
  const root = parsePcbSource(await readFile(boardPath, "utf8"))
  const wanted = new Set(unique(netNames))
  const planar = Object.fromEntries([...wanted].map((net) => [net, 0])) as Record<string, number>
  const barrels = Object.fromEntries([...wanted].map((net) => [net, 0])) as Record<string, number>
  const measurementErrorsByNet: Record<string, string[]> = {}
  const addPlanar = (net: string, length: number) => {
    if (wanted.has(net)) planar[net] += length
  }
  const measurePlanar = (node: SExpression[], measure: (net: string) => number) => {
    const net = nodeNetName(root, node)
    if (!wanted.has(net)) return
    try {
      addPlanar(net, measure(net))
    } catch (error) {
      const errors = measurementErrorsByNet[net] ?? []
      errors.push(errorText(error))
      measurementErrorsByNet[net] = errors
    }
  }
  for (const node of listChildren(root, "segment")) {
    measurePlanar(node, (net) => lineNodeLength(node, net))
  }
  for (const node of listChildren(root, "arc")) {
    measurePlanar(node, (net) => arcNodeLength(node, net))
  }

  // KRT treats net-tagged copper graphics as routed copper too (#337).
  for (const node of listChildren(root, "gr_line")) {
    const net = nodeNetName(root, node)
    const layer = atom(findChild(node, "layer")?.[1]) ?? ""
    const width = graphicStrokeWidth(node)
    if (wanted.has(net) && layer.endsWith(".Cu") && width > 0) {
      measurePlanar(node, (name) => lineNodeLength(node, name))
    }
  }
  for (const node of listChildren(root, "gr_arc")) {
    const net = nodeNetName(root, node)
    const layer = atom(findChild(node, "layer")?.[1]) ?? ""
    const width = graphicStrokeWidth(node)
    if (wanted.has(net) && layer.endsWith(".Cu") && width > 0) {
      measurePlanar(node, (name) => arcNodeLength(node, name))
    }
  }
  for (const node of listChildren(root, "gr_poly")) {
    const net = nodeNetName(root, node)
    const layer = atom(findChild(node, "layer")?.[1]) ?? ""
    if (!wanted.has(net) || !layer.endsWith(".Cu")) continue
    const points = listChildren(findChild(node, "pts") ?? [], "xy")
      .map((point) => nodePoint([token("point"), point], "xy"))
      .filter((point): point is readonly [number, number] => Boolean(point))
    if (points.length >= 2) addPlanar(net, points.reduce((sum, point, index) => (
      sum + pointDistance(point, points[(index + 1) % points.length])
    ), 0))
  }
  for (const node of listChildren(root, "gr_rect")) {
    const net = nodeNetName(root, node)
    const layer = atom(findChild(node, "layer")?.[1]) ?? ""
    if (!wanted.has(net) || !layer.endsWith(".Cu")) continue
    measurePlanar(node, (name) => {
      const start = requiredNodePoint(node, "start", name)
      const end = requiredNodePoint(node, "end", name)
      return 2 * (Math.abs(end[0] - start[0]) + Math.abs(end[1] - start[1]))
    })
  }
  for (const node of listChildren(root, "gr_circle")) {
    const net = nodeNetName(root, node)
    const layer = atom(findChild(node, "layer")?.[1]) ?? ""
    if (!wanted.has(net) || !layer.endsWith(".Cu")) continue
    measurePlanar(node, (name) => {
      const center = requiredNodePoint(node, "center", name)
      const end = requiredNodePoint(node, "end", name)
      return 32 * pointDistance(center, end) * Math.sin(Math.PI / 16)
    })
  }

  const layers = stackupLayers(root)
  for (const node of listChildren(root, "via")) {
    const net = nodeNetName(root, node)
    if (wanted.has(net)) barrels[net] += viaBarrelLength(node, layers)
  }
  return {
    planarLengthsMm: planar,
    viaBarrelLengthsMm: barrels,
    measurementErrorsByNet,
    lengthsMm: Object.fromEntries([...wanted].map((net) => [net, planar[net] + barrels[net]])),
    vias: listChildren(root, "via").length,
    routes: listChildren(root, "segment").length + listChildren(root, "arc").length,
  }
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

  if (!(await exists(projectPath))) {
    throw new Error(`Authoritative KRT project sidecar is missing: ${projectPath}`)
  }
  const parsed = JSON.parse(await readFile(projectPath, "utf8"))
  const object = jsonObject(parsed)
  if (!object) throw new Error(`${projectPath} does not contain a JSON object`)
  const project = object

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
  const sourceProject = `${sourceStem}.kicad_pro`
  if (!(await exists(sourceProject))) {
    diagnostics.push(diagnostic(
      "KRT_PROJECT_SIDECAR_REQUIRED",
      "error",
      `KRT cannot route without an authoritative .kicad_pro sidecar: ${sourceProject}`,
      { sourceBoard, sourceProject },
    ))
    return false
  }
  for (const suffix of SIDECAR_SUFFIXES) {
    const source = `${sourceStem}${suffix}`
    if (!(await exists(source))) continue
    try {
      await copyIfDifferent(source, `${targetStem}${suffix}`)
    } catch (error) {
      diagnostics.push(diagnostic(
        "KRT_SIDECAR_COPY_FAILED",
        "error",
        `Could not copy ${suffix} sidecar: ${errorText(error)}`,
        { source, target: `${targetStem}${suffix}` },
      ))
    }
  }
  return !diagnostics.some((item) => item.severity === "error")
}

function projectSidecarPath(boardPath: string) {
  return `${boardStem(resolve(boardPath))}.kicad_pro`
}

async function readProjectObject(path: string) {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  const project = jsonObject(parsed)
  if (!project) throw new Error(`${path} does not contain a JSON object`)
  return project
}

function projectProtectedNets(project: Record<string, unknown>) {
  const namespace = jsonObject(project.kicad_routing_tools)
  return { ...(jsonObject(namespace?.protected_nets) ?? {}) }
}

/**
 * Restore the immutable rule sidecar before every subprocess while carrying
 * forward only the verified protected-net ledger. This deliberately discards
 * any netclass rewrite performed by an earlier KRT output stage.
 */
async function materializeAuthoritativeSidecars(
  inputBoard: string,
  spec: KrtStageSpec,
  diagnostics: KrtDiagnostic[],
) {
  const targetProject = projectSidecarPath(inputBoard)
  const authoritativeProject = resolve(spec.authoritativeProjectPath ?? targetProject)
  if (!(await exists(authoritativeProject))) {
    diagnostics.push(diagnostic(
      "KRT_PROJECT_SIDECAR_REQUIRED",
      "error",
      `The authoritative KRT project sidecar does not exist: ${authoritativeProject}`,
      { inputBoard, authoritativeProject },
    ))
    return false
  }

  try {
    const project = await readProjectObject(authoritativeProject)
    const namespace = jsonObject(project.kicad_routing_tools) ?? {}
    const authoritativeProtection = projectProtectedNets(project)
    const protectedNets = {
      ...authoritativeProtection,
      ...Object.fromEntries(unique(spec.protectedNets ?? []).map((net) => [net, "workflow-verified"])),
    }
    if (Object.keys(protectedNets).length) namespace.protected_nets = protectedNets
    else delete namespace.protected_nets
    if (Object.keys(namespace).length) project.kicad_routing_tools = namespace
    else delete project.kicad_routing_tools
    await writeFile(targetProject, `${JSON.stringify(project, null, 2)}\n`, "utf8")

    const authoritativeStem = boardStem(authoritativeProject)
    const targetStem = boardStem(targetProject)
    for (const suffix of [".kicad_dru", ".kicad_prl"] as const) {
      const source = `${authoritativeStem}${suffix}`
      if (!(await exists(source))) continue
      await copyIfDifferent(source, `${targetStem}${suffix}`)
    }
    return true
  } catch (error) {
    diagnostics.push(diagnostic(
      "KRT_PROJECT_MATERIALIZATION_FAILED",
      "error",
      `Could not materialize the authoritative KRT sidecars: ${errorText(error)}`,
      { inputBoard, authoritativeProject, targetProject },
    ))
    return false
  }
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

async function sha256File(path: string) {
  const content = await readFile(path)
  return {
    path: resolve(path),
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  }
}

async function writeStageManifest(
  result: KrtProcessResult,
  spec: KrtStageSpec,
  artifactsDir: string,
  scriptName: "qfn_fanout.py" | "route_diff.py" | "route.py",
) {
  const inputProject = projectSidecarPath(result.inputBoard)
  const authoritativeProject = resolve(spec.authoritativeProjectPath ?? inputProject)
  const inputStem = boardStem(result.inputBoard)
  const materializedProtectedNets = Object.keys(projectProtectedNets(
    await readProjectObject(inputProject),
  ))
  const candidates = unique([
    result.inputBoard,
    inputProject,
    authoritativeProject,
    resolve(spec.fabOverridesPath),
    ...[".kicad_dru", ".kicad_prl"].map((suffix) => `${inputStem}${suffix}`),
  ])
  const files = []
  for (const path of candidates) if (await exists(path)) files.push(await sha256File(path))
  result.manifestPath = join(artifactsDir, `krt-${result.stage}-manifest.json`)
  await writeFile(result.manifestPath, `${JSON.stringify({
    schema: "copilot-router-krt-stage-manifest",
    version: 1,
    stage: result.stage,
    script: scriptName,
    inputBoard: result.inputBoard,
    outputBoard: result.outputBoard,
    authoritativeProject,
    layers: unique(spec.layers),
    rules: spec.rules,
    protectedNets: unique([...(spec.protectedNets ?? []), ...materializedProtectedNets]),
    recovery: {
      ripPreexisting: spec.ripPreexisting !== false,
      netRescue: spec.enableNetRescue !== false,
      terminalEscalation: spec.enableTerminalEscalation !== false,
      dynamicIterations: spec.dynamicIterations !== false,
      planeFinalize: Boolean(spec.planeFinalize),
      finalizeRip: spec.finalizeRip !== false,
      forceReroute: Boolean(spec.forceReroute),
    },
    files,
  }, null, 2)}\n`, "utf8")
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
  protectedNetNames: readonly string[] = [],
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
    const protectedNets = new Set(protectedNetNames)
    const protectedRips = Object.fromEntries(Object.entries(outcomes)
      .filter(([net]) => protectedNets.has(net)))
    const casualties = Object.fromEntries(Object.entries(outcomes)
      .filter(([, outcome]) => /NOT RECOVERED|PARTIAL|still open/i.test(String(outcome))))
    if (Object.keys(protectedRips).length) diagnostics.push(diagnostic(
      "KRT_PROTECTED_COPPER_RIPPED",
      "error",
      "KRT reported rip-up activity on verified protected copper.",
      protectedRips,
    ))
    if (Object.keys(casualties).length) diagnostics.push(diagnostic(
      "KRT_RIP_VICTIM_INCOMPLETE",
      "error",
      "KRT did not fully recover every pre-existing blocker net taken into native custody.",
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
    const automatic = Object.fromEntries(Object.entries(outcomes)
      .filter(([net]) => !authorized.has(net) && !protectedNets.has(net) && !(net in casualties)))
    if (Object.keys(automatic).length) diagnostics.push(diagnostic(
      "KRT_NATIVE_BLOCKER_RECOVERY",
      "info",
      "KRT used custody-backed native blocker recovery and restored the affected pre-existing nets.",
      automatic,
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

/** Bound resident process logs; full stage streams are spooled to artifacts. */
export const KRT_CAPTURED_LOG_TAIL_CHARS = 512 * 1024

/** @internal Pure tail limiter used by the streaming process capture. */
export function krtBoundedLogTail(value: string, limit = KRT_CAPTURED_LOG_TAIL_CHARS) {
  const safeLimit = Math.max(0, Math.trunc(limit))
  return value.length <= safeLimit
    ? { text: value, omitted: 0 }
    : { text: value.slice(value.length - safeLimit), omitted: value.length - safeLimit }
}

async function runCaptured(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number | undefined,
  environment: Record<string, string> = {},
  abortSignal?: AbortSignal,
  logPaths?: Readonly<{ stdout: string; stderr: string }>,
): Promise<CapturedProcess> {
  const started = performance.now()
  return await new Promise((resolvePromise) => {
    let stdout = ""
    let stderr = ""
    let stdoutOmitted = 0
    let stderrOmitted = 0
    let timedOut = false
    let spawnError: string | undefined
    let logError: string | undefined
    let settled = false
    const stdoutLog = logPaths?.stdout ? createWriteStream(logPaths.stdout, { encoding: "utf8" }) : undefined
    const stderrLog = logPaths?.stderr ? createWriteStream(logPaths.stderr, { encoding: "utf8" }) : undefined
    stdoutLog?.on("error", (error) => { logError ??= errorText(error) })
    stderrLog?.on("error", (error) => { logError ??= errorText(error) })

    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        // Plane creation remains a core-owned post-route operation unless an
        // actual routing stage explicitly opts into native finalization.
        KICAD_PLANE_FINALIZE: "0",
        ...KRT_REQUIRED_NECKDOWN_ENVIRONMENT,
        PYTHONDONTWRITEBYTECODE: "1",
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdoutLog?.write(chunk)
      const bounded = krtBoundedLogTail(stdout + chunk)
      stdout = bounded.text
      stdoutOmitted += bounded.omitted
    })
    child.stderr?.on("data", (chunk: string) => {
      stderrLog?.write(chunk)
      const bounded = krtBoundedLogTail(stderr + chunk)
      stderr = bounded.text
      stderrOmitted += bounded.omitted
    })
    child.on("error", (error) => { spawnError = errorText(error) })

    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => child.kill("SIGKILL")
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      abortSignal?.removeEventListener("abort", abort)
      const closeLog = (stream: typeof stdoutLog) => new Promise<void>((resolveClose) => {
        if (!stream) return resolveClose()
        if (stream.destroyed || stream.closed) return resolveClose()
        let closed = false
        const done = () => {
          if (closed) return
          closed = true
          resolveClose()
        }
        stream.once("finish", done)
        stream.once("error", done)
        stream.end()
      })
      void Promise.all([closeLog(stdoutLog), closeLog(stderrLog)]).then(() => {
        const residentStdout = stdoutOmitted
          ? `[${stdoutOmitted} earlier character(s) spooled only to ${logPaths?.stdout}]\n${stdout}`
          : stdout
        const residentStderr = stderrOmitted
          ? `[${stderrOmitted} earlier character(s) spooled only to ${logPaths?.stderr}]\n${stderr}`
          : stderr
        resolvePromise({
          exitCode,
          signal,
          timedOut,
          elapsedMs: performance.now() - started,
          stdout: residentStdout,
          stderr: residentStderr,
          ...(spawnError ? { error: spawnError } : {}),
          ...(logError ? { logError } : {}),
        })
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
  const authoritativeProject = resolve(spec.authoritativeProjectPath ?? projectSidecarPath(inputBoard))
  if (!(await exists(authoritativeProject))) diagnostics.push(diagnostic(
    "KRT_PROJECT_SIDECAR_REQUIRED",
    "error",
    `KRT requires an authoritative .kicad_pro sidecar: ${authoritativeProject}`,
    { inputBoard, authoritativeProject },
  ))
  else {
    try {
      const project = await readProjectObject(authoritativeProject)
      const netSettings = jsonObject(project.net_settings)
      if (!netSettings || !Array.isArray(netSettings.classes) || !netSettings.classes.length
        || !jsonObject(netSettings.netclass_assignments)) diagnostics.push(diagnostic(
        "KRT_PROJECT_RULES_INVALID",
        "error",
        "The authoritative .kicad_pro must contain net classes and netclass assignments; native fallback rules are not allowed.",
        { authoritativeProject },
      ))
    } catch (error) {
      diagnostics.push(diagnostic(
        "KRT_PROJECT_RULES_INVALID",
        "error",
        `Could not parse the authoritative .kicad_pro: ${errorText(error)}`,
        { authoritativeProject },
      ))
    }
  }
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
  validatePositiveNumber(spec.rules.hardViaSize, "rules.hardViaSize", diagnostics)
  validatePositiveNumber(spec.rules.hardViaDrill, "rules.hardViaDrill", diagnostics)
  validatePositiveNumber(spec.rules.hardViaAnnular, "rules.hardViaAnnular", diagnostics)
  validatePositiveNumber(spec.rules.diffPairGap, "rules.diffPairGap", diagnostics)
  validatePositiveNumber(spec.rules.gridStep, "rules.gridStep", diagnostics)
  validatePositiveNumber(spec.rules.holeToHoleClearance, "rules.holeToHoleClearance", diagnostics)
  validatePositiveNumber(spec.rules.boardEdgeClearance, "rules.boardEdgeClearance", diagnostics)
  validatePositiveNumber(spec.rules.sameNetPadClearance, "rules.sameNetPadClearance", diagnostics)
  validatePositiveNumber(spec.rules.routingClearanceMargin, "rules.routingClearanceMargin", diagnostics)
  validatePositiveNumber(spec.rules.lengthMatchTolerance, "rules.lengthMatchTolerance", diagnostics)
  validatePositiveNumber(spec.rules.meanderAmplitude, "rules.meanderAmplitude", diagnostics)
  validatePositiveNumber(spec.rules.meanderSpacing, "rules.meanderSpacing", diagnostics)
  validatePositiveNumber(spec.impedance?.targetOhm, "impedance.targetOhm", diagnostics)
  validateNonNegativeNumber(spec.impedance?.coplanarGapMm, "impedance.coplanarGapMm", diagnostics)
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
  if (spec.forceReroute !== undefined && typeof spec.forceReroute !== "boolean") diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC", "error", "forceReroute must be a boolean.",
    { field: "forceReroute", value: spec.forceReroute },
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

  const hardViaSize = spec.rules.hardViaSize ?? spec.rules.viaSize
  const hardViaDrill = spec.rules.hardViaDrill ?? spec.rules.viaDrill
  const hardViaAnnular = spec.rules.hardViaAnnular ?? Math.max((hardViaSize - hardViaDrill) / 2, 0.001)
  if (hardViaSize > spec.rules.viaSize + EPSILON || hardViaDrill > spec.rules.viaDrill + EPSILON) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC",
    "error",
    "Hard via fabrication minima must not exceed the nominal CLI via geometry.",
    {
      hardViaSize,
      hardViaDrill,
      nominalViaSize: spec.rules.viaSize,
      nominalViaDrill: spec.rules.viaDrill,
    },
  ))
  if (hardViaDrill >= hardViaSize) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC",
    "error",
    "rules.hardViaDrill must be smaller than rules.hardViaSize.",
    { hardViaSize, hardViaDrill },
  ))
  if ((spec.rules.viaSize - spec.rules.viaDrill) / 2 + EPSILON < hardViaAnnular) diagnostics.push(diagnostic(
    "KRT_INVALID_SPEC",
    "error",
    "Nominal CLI via geometry must preserve the compiled hard annular-ring floor.",
    {
      nominalAnnular: (spec.rules.viaSize - spec.rules.viaDrill) / 2,
      hardViaAnnular,
    },
  ))

  if (!(await exists(spec.fabOverridesPath))) {
    diagnostics.push(diagnostic(
      "KRT_HARD_FAB_REQUIRED",
      "error",
      `A readable fabOverridesPath is required to enforce the compiled fabrication floor: ${spec.fabOverridesPath}`,
    ))
  } else {
    try {
      const values = await readFabOverrides(spec.fabOverridesPath)
      const holeToHoleClearance = spec.rules.holeToHoleClearance ?? spec.rules.clearance
      const required: Array<[string, number]> = [
        ["track_width", hardTrackWidth],
        ["clearance", spec.rules.clearance],
        ["via_diameter", hardViaSize],
        ["via_drill", hardViaDrill],
        ["annular", hardViaAnnular],
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
  // route_diff.py treats an explicit width as the impedance-width floor.  A
  // compiled preferred width would therefore defeat the native stackup solve
  // whenever the two calculators differ slightly.  Impedance calls pass only
  // the real fabrication floor; ordinary special calls keep their exact width.
  args.push("--track-width", numberArg(
    spec.impedance ? spec.rules.hardTrackWidth ?? spec.rules.trackWidth : spec.rules.trackWidth,
  ))
  const nets = unique(pairs.flatMap((pair) => [pair.positive, pair.negative]))
  args.push("--nets", ...nets.map(krtLiteralNetFilterPattern))
  args.push("--diff-pair-gap", numberArg(spec.rules.diffPairGap!))
  if (spec.matchDifferentialPairLengths) args.push("--diff-pair-intra-match")
  if (spec.suppressGroundReturnVias) args.push("--no-gnd-vias")
  appendImpedanceArgs(args, spec)
  for (const group of groups) args.push("--length-match-group", ...group.nets.map(krtLiteralGlobPattern))
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
  args.push("--nets", ...nets.map(krtLiteralNetFilterPattern))
  // route.py performs matching only over results produced by this invocation,
  // so every ordinary member is deliberately submitted together.
  for (const group of groups) args.push("--length-match-group", ...group.nets.map(krtLiteralGlobPattern))
  pushNumericArg(args, "--length-match-tolerance", spec.rules.lengthMatchTolerance)
  pushNumericArg(args, "--meander-amplitude", spec.rules.meanderAmplitude)
  pushNumericArg(args, "--meander-spacing", spec.rules.meanderSpacing)
  appendRoutePyQualityArgs(args, spec)
  appendImpedanceArgs(args, spec)
  return args
}

function appendImpedanceArgs(args: string[], spec: KrtStageSpec) {
  if (!spec.impedance) return
  args.push("--impedance", numberArg(spec.impedance.targetOhm))
  if (spec.impedance.coplanarGapMm !== undefined) {
    args.push("--coplanar-gap", numberArg(spec.impedance.coplanarGapMm))
  }
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
  args.push("--nets", ...unique(nets).map(krtLiteralNetFilterPattern))
  if (spec.busDetect) {
    args.push("--bus")
    if (spec.busDetect !== true) {
      pushNumericArg(args, "--bus-detection-radius", spec.busDetect.detectionRadiusMm)
      pushNumericArg(args, "--bus-min-nets", spec.busDetect.minNets)
      pushNumericArg(args, "--bus-attraction-radius", spec.busDetect.attractionRadiusMm)
    }
  }
  const ripExistingNets = unique(spec.ripExistingNets ?? [])
  if (ripExistingNets.length) args.push("--rip-existing-nets", ...ripExistingNets.map(krtLiteralNetFilterPattern))
  if (spec.forceReroute) args.push("--force-reroute")
  if (spec.collectStats) args.push("--stats")
  appendRoutePyQualityArgs(args, spec)
  appendImpedanceArgs(args, spec)
  if (spec.powerNets?.length) {
    args.push("--power-nets", ...spec.powerNets.map((item) => krtLiteralGlobPattern(item.net)))
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
  args.push("--nets", ...nets.map(krtLiteralNetFilterPattern))
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

/** Exact default-on recovery environment passed to native KRT subprocesses. */
export function buildKrtNativeRecoveryEnvironment(spec: KrtStageSpec): Record<string, string> {
  return {
    // These are upstream default-on capabilities. Emit the values explicitly
    // so a stale parent-process A/B environment cannot silently suppress them.
    KICAD_RIP_PREEXISTING: spec.ripPreexisting === false ? "0" : "1",
    KICAD_NET_RESCUE: spec.enableNetRescue === false ? "0" : "1",
    KICAD_TERMINAL_ESCALATION: spec.enableTerminalEscalation === false ? "0" : "1",
    KICAD_DYNAMIC_ITERATIONS: spec.dynamicIterations === false ? "0" : "1",
    KICAD_DYNAMIC_ITERATIONS_CLAMP: "200000",
    // Hybrid/KRT recovery must not silently turn into an implicit BGA
    // fanout stage. Besides duplicating the explicit DSL fanout workflow,
    // upstream's bare-pad rung can run the full BGA escape ladder several
    // times per open net. On dense boards this dominated the entire repair
    // while repeatedly producing no connectivity progress.
    KICAD_BARE_PAD_ESCAPE: "0",
    KICAD_RESCUE_CAP_MOVE: "0",
    // The bundled patch applies these only to the one explicitly enabled
    // final rescue.  They bound search work by cells/iterations/attempts, not
    // by an unrealistically small wall-clock timeout.
    COPILOT_ROUTER_RESCUE_GRID_STEP: "0.1",
    COPILOT_ROUTER_RESCUE_CLEARANCE_STEPS: "1",
    COPILOT_ROUTER_RESCUE_MAX_WINDOW_CELLS: "500000",
    COPILOT_ROUTER_RESCUE_MAX_EDGES_PER_NET: "1",
    COPILOT_ROUTER_RESCUE_MAX_ITERATIONS: "100000",
    KICAD_PLANE_FINALIZE: spec.planeFinalize ? "1" : "0",
    KICAD_FINALIZE_RIP: spec.finalizeRip === false ? "0" : "1",
  }
}

function exactNetSelectionNets(spec: KrtStageSpec): string[] {
  const fanoutNets = "nets" in spec && Array.isArray(spec.nets)
    ? spec.nets.map(String)
    : []
  return unique([
    ...spec.remainingNets,
    ...spec.diffPairs.flatMap((pair) => {
      const normalized = normalizePair(pair)
      return [normalized.positive, normalized.negative]
    }),
    ...spec.matchedGroups.flatMap((group) => normalizeGroup(group).nets),
    ...fanoutNets,
  ])
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
    await materializeAuthoritativeSidecars(normalizedInput, spec, diagnostics)
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

    const builtArgs = buildArgs(diagnostics)
    if (!builtArgs || diagnostics.some((item) => item.severity === "error")) {
      await saveOutputArtifact(result, normalizedArtifacts)
      await persistResultArtifacts(result, normalizedArtifacts)
      return result
    }
    if (!builtArgs.length) {
      result.status = "skipped"
      diagnostics.push(diagnostic(
        "KRT_STAGE_EMPTY", "info", `The ${stage} stage has no nets to route.`,
      ))
      await saveOutputArtifact(result, normalizedArtifacts)
      await persistResultArtifacts(result, normalizedArtifacts)
      return result
    }

    const netSelectionCandidates = exactNetSelectionNets(spec)
    const ripSelectionCandidates = unique(spec.ripExistingNets ?? [])
    const compact = compactKrtExactSelectorArgs(builtArgs, {
      netSelection: netSelectionCandidates,
      ripSelection: ripSelectionCandidates,
      ripAuthorization: unique([
        ...ripSelectionCandidates,
        ...(spec.forceReroute ? netSelectionCandidates : []),
      ]),
      diffPairs: spec.diffPairs.map((pair) => {
        const normalized = normalizePair(pair)
        return [normalized.positive, normalized.negative] as const
      }),
    })
    const args = compact.args
    const hasExactSelectorScope = compact.sidecar.netSelection.length > 0
      || compact.sidecar.ripSelection.length > 0
      || compact.sidecar.ripAuthorization.length > 0
      || compact.sidecar.diffPairs.length > 0
    const selectorEnvironment: Record<string, string> = {}
    if (hasExactSelectorScope) {
      const selectorPath = join(normalizedArtifacts, `krt-${stage}-exact-selectors.json`)
      await writeFile(selectorPath, `${JSON.stringify(compact.sidecar, null, 2)}\n`, "utf8")
      selectorEnvironment.COPILOT_ROUTER_EXACT_SELECTORS_FILE = selectorPath
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

    // Keep the complete native argv on disk. Only the fixed bootstrap, script
    // path and args-file path cross Windows CreateProcess; large matched groups
    // and power-net lists therefore cannot overflow its command-line limit.
    const toolArgsPath = join(normalizedArtifacts, `krt-${stage}-args.json`)
    await writeFile(toolArgsPath, `${JSON.stringify(args, null, 2)}\n`, "utf8")
    const scriptPath = join(normalizedKrt, "py_router", scriptName)
    const processArgs = pythonScriptArgs(scriptPath, args, spec.pythonPathEntries, toolArgsPath)
    result.command = [executable, ...processArgs]
    try {
      await writeStageManifest(result, spec, normalizedArtifacts, scriptName)
    } catch (error) {
      diagnostics.push(diagnostic(
        "KRT_MANIFEST_WRITE_FAILED",
        "error",
        `Could not persist the authoritative KRT stage manifest: ${errorText(error)}`,
        { artifactsDir: normalizedArtifacts },
      ))
      await saveOutputArtifact(result, normalizedArtifacts)
      await persistResultArtifacts(result, normalizedArtifacts)
      return result
    }
    result.invocationPath = join(normalizedArtifacts, `krt-${stage}-invocation.json`)
    // console.log(result.command)
    await writeArtifact(result.invocationPath, `${JSON.stringify({
      stage,
      executable,
       args: processArgs,
       toolArgs: args,
       toolArgsPath,
      cwd: normalizedKrt,
      timeoutMs: spec.timeoutMs,
      environment: {
        ...(spec.pythonPathEntries?.length
          ? { PYTHONPATH: [...spec.pythonPathEntries, ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])].join(delimiter) }
          : {}),
        ...buildKrtNativeRecoveryEnvironment(spec),
        PYTHONDONTWRITEBYTECODE: "1",
        ...KRT_REQUIRED_NECKDOWN_ENVIRONMENT,
        ...selectorEnvironment,
        ...extraEnvironment,
      },
    }, null, 2)}\n`, diagnostics)

    result.attempted = true
    result.stdoutPath = join(normalizedArtifacts, `krt-${stage}.stdout.log`)
    result.stderrPath = join(normalizedArtifacts, `krt-${stage}.stderr.log`)
    const captured = await runCaptured(
      executable,
      processArgs,
      normalizedKrt,
      spec.timeoutMs,
      {
        ...(spec.pythonPathEntries?.length
          ? { PYTHONPATH: [...spec.pythonPathEntries, ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])].join(delimiter) }
          : {}),
        ...buildKrtNativeRecoveryEnvironment(spec),
        ...selectorEnvironment,
        ...extraEnvironment,
      },
      spec.signal,
      { stdout: result.stdoutPath, stderr: result.stderrPath },
    )
    result.exitCode = captured.exitCode
    result.signal = captured.signal
    result.timedOut = captured.timedOut
    result.elapsedMs = captured.elapsedMs
    result.stdout = captured.stdout
    result.stderr = captured.stderr

    if (captured.logError) diagnostics.push(diagnostic(
      "KRT_LOG_SPOOL_FAILED",
      "warning",
      `Could not persist the complete KRT process stream: ${captured.logError}`,
      { stdoutPath: result.stdoutPath, stderrPath: result.stderrPath },
    ))

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
      spec.protectedNets,
      spec.enableTerminalEscalation !== false,
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
    if (stage === "special"
      && spec.protectSpecialOutput !== false
      && !diagnostics.some((item) => item.severity === "error")
      && await exists(normalizedOutput)) {
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
  issueFingerprints: readonly string[]
  issueFingerprintsByNet: Readonly<Record<string, readonly string[]>>
  componentCountByNet: Readonly<Record<string, number>>
  elapsedMs: number
  stdout: string
  stderr: string
  failed: boolean
}>

type KrtDrcAudit = Readonly<{
  violationCount: number
  fingerprints: readonly string[]
  shortFingerprints: readonly string[]
  fingerprintsByNet: Readonly<Record<string, readonly string[]>>
  shortFingerprintsByNet: Readonly<Record<string, readonly string[]>>
  unattributedFingerprints: readonly string[]
  unattributedShortFingerprints: readonly string[]
  fingerprintsAvailable: boolean
  byType: Readonly<Record<string, number>>
  contactsByType: Readonly<Record<string, number>>
  elapsedMs: number
  stdout: string
  stderr: string
  failed: boolean
}>

function unavailableKrtConnectivityAudit(openNets: readonly string[]): KrtConnectivityAudit {
  return {
    openNets: unique(openNets),
    issueFingerprints: [],
    issueFingerprintsByNet: {},
    componentCountByNet: {},
    elapsedMs: 0,
    stdout: "",
    stderr: "",
    failed: true,
  }
}

function canonicalDrcFingerprint(item: Record<string, unknown>) {
  const keys = [
    "type", "short", "net", "net_name", "layer", "hole_ref", "edge",
    "via_loc", "seg_loc", "cross_point",
    "width", "size", "drill", "min_width", "min_size", "min_drill",
  ]
  const normalize = (value: unknown, directionless = false): unknown => {
    if (typeof value === "number") return Number(value.toFixed(4))
    if (Array.isArray(value)) {
      const normalized = value.map((entry) => normalize(entry))
      // A point is [x,y] and remains ordered. A segment/path endpoint pair is
      // either [[x1,y1],[x2,y2]] or KRT's flat [x1,y1,x2,y2], and has no
      // direction in a physical DRC identity.
      if (directionless && normalized.length === 4
        && normalized.every((entry) => typeof entry === "number")) {
        const reversed = [normalized[2], normalized[3], normalized[0], normalized[1]]
        return JSON.stringify(normalized).localeCompare(JSON.stringify(reversed)) <= 0
          ? normalized
          : reversed
      }
      return directionless && normalized.length === 2
        && normalized.every((entry) => Array.isArray(entry) || (entry !== null && typeof entry === "object"))
        ? normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
        : normalized
    }
    if (value !== null && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    )
    return value
  }
  const directionlessKeys = new Set(["edge", "seg_loc"])
  const fingerprint: Record<string, unknown> = Object.fromEntries(keys.flatMap((key) => (
    item[key] === undefined ? [] : [[key, normalize(item[key], directionlessKeys.has(key))]]
  )))
  const participantKeys = [
    ["net1", "pad_ref", "loc1", "pad_loc"],
    ["net2", "pad_ref2", "loc2", "pad_loc2"],
  ] as const
  const participants = participantKeys.map((participant) => Object.fromEntries(
    participant.flatMap((key) => (
      item[key] === undefined ? [] : [[key.replace(/2$/, "").replace(/1$/, ""), normalize(
        item[key],
        key === "loc1" || key === "loc2",
      )]]
    )),
  )).filter((participant) => Object.keys(participant).length)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  if (participants.length) fingerprint.participants = participants
  return JSON.stringify(fingerprint)
}

/** @internal Accepted KRT contacts are audit evidence, not DRC violations. */
export function krtDrcViolationItem(value: unknown) {
  const item = jsonObject(value)
  return item && !item.accepted ? item : undefined
}

export type KrtDrcFingerprintIndex = Readonly<{
  fingerprints: readonly string[]
  shortFingerprints: readonly string[]
  fingerprintsByNet: Readonly<Record<string, readonly string[]>>
  shortFingerprintsByNet: Readonly<Record<string, readonly string[]>>
  unattributedFingerprints: readonly string[]
  unattributedShortFingerprints: readonly string[]
}>

/**
 * Attribute native DRC identities to every named participant. This lets a
 * partially successful critical batch protect clean connected members instead
 * of making one bad member veto the entire group. Items without any net name
 * stay global and therefore conservatively gate every member.
 */
export function indexKrtDrcFingerprints(values: readonly unknown[]): KrtDrcFingerprintIndex {
  const fingerprints: string[] = []
  const shortFingerprints: string[] = []
  const fingerprintsByNet: Record<string, string[]> = {}
  const shortFingerprintsByNet: Record<string, string[]> = {}
  const unattributedFingerprints: string[] = []
  const unattributedShortFingerprints: string[] = []
  for (const value of values) {
    const item = krtDrcViolationItem(value)
    if (!item) continue
    const fingerprint = canonicalDrcFingerprint(item)
    const isShort = item.short === true
    fingerprints.push(fingerprint)
    if (isShort) shortFingerprints.push(fingerprint)
    const nets = unique(["net", "net_name", "net1", "net2"].flatMap((key) => {
      const net = item[key]
      return typeof net === "string" && net.trim() ? [net] : []
    }))
    if (!nets.length) {
      unattributedFingerprints.push(fingerprint)
      if (isShort) unattributedShortFingerprints.push(fingerprint)
      continue
    }
    for (const net of nets) {
      const netFingerprints = fingerprintsByNet[net] ?? []
      netFingerprints.push(fingerprint)
      fingerprintsByNet[net] = netFingerprints
      if (isShort) {
        const netShortFingerprints = shortFingerprintsByNet[net] ?? []
        netShortFingerprints.push(fingerprint)
        shortFingerprintsByNet[net] = netShortFingerprints
      }
    }
  }
  fingerprints.sort()
  shortFingerprints.sort()
  unattributedFingerprints.sort()
  unattributedShortFingerprints.sort()
  for (const values of Object.values(fingerprintsByNet)) values.sort()
  for (const values of Object.values(shortFingerprintsByNet)) values.sort()
  return {
    fingerprints,
    shortFingerprints,
    fingerprintsByNet,
    shortFingerprintsByNet,
    unattributedFingerprints,
    unattributedShortFingerprints,
  }
}

function fingerprintMultisetIsSubset(candidate: readonly string[], baseline: readonly string[]) {
  const remaining = new Map<string, number>()
  for (const fingerprint of baseline) remaining.set(fingerprint, (remaining.get(fingerprint) ?? 0) + 1)
  for (const fingerprint of candidate) {
    const count = remaining.get(fingerprint) ?? 0
    if (!count) return false
    remaining.set(fingerprint, count - 1)
  }
  return true
}

export function krtCriticalNetDrcNonRegressing(
  net: string,
  baseline: Pick<KrtDrcAudit,
    "fingerprintsAvailable" | "fingerprintsByNet" | "shortFingerprintsByNet"
    | "unattributedFingerprints" | "unattributedShortFingerprints">,
  candidate: Pick<KrtDrcAudit,
    "fingerprintsAvailable" | "fingerprintsByNet" | "shortFingerprintsByNet"
    | "unattributedFingerprints" | "unattributedShortFingerprints">,
) {
  return baseline.fingerprintsAvailable
    && candidate.fingerprintsAvailable
    && fingerprintMultisetIsSubset(
      candidate.fingerprintsByNet[net] ?? [],
      baseline.fingerprintsByNet[net] ?? [],
    )
    && fingerprintMultisetIsSubset(
      candidate.shortFingerprintsByNet[net] ?? [],
      baseline.shortFingerprintsByNet[net] ?? [],
    )
    && fingerprintMultisetIsSubset(
      candidate.unattributedFingerprints,
      baseline.unattributedFingerprints,
    )
    && fingerprintMultisetIsSubset(
      candidate.unattributedShortFingerprints,
      baseline.unattributedShortFingerprints,
    )
}

function addedDrcFingerprints(baseline: KrtDrcAudit, candidate: KrtDrcAudit) {
  if (!baseline.fingerprintsAvailable || !candidate.fingerprintsAvailable) return []
  const remaining = new Map<string, number>()
  for (const fingerprint of baseline.fingerprints) remaining.set(fingerprint, (remaining.get(fingerprint) ?? 0) + 1)
  return candidate.fingerprints.filter((fingerprint) => {
    const count = remaining.get(fingerprint) ?? 0
    if (!count) return true
    remaining.set(fingerprint, count - 1)
    return false
  })
}

async function auditKrtMatchedGroups(
  boardPath: string,
  groups: readonly NormalizedGroup[],
  diffNets: readonly string[],
  toleranceMm: number,
  connectivity: KrtConnectivityAudit,
  baselineDrc: KrtDrcAudit,
  candidateDrc: KrtDrcAudit,
  artifactsDir: string,
) {
  const diagnostics: KrtDiagnostic[] = []
  const coupled = new Set(diffNets)
  let measurement: KrtCopperLengthMeasurement | undefined
  let measurementError: string | undefined
  try {
    measurement = await measureKrtNetCopperLengths(boardPath, groups.flatMap((group) => group.nets))
  } catch (error) {
    measurementError = errorText(error)
  }
  const open = new Set(connectivity.openNets)
  const audits: KrtMatchedGroupAudit[] = groups.map((group, index) => {
    const lengthsMm = Object.fromEntries(group.nets.flatMap((net) => (
      measurement ? [[net, measurement.lengthsMm[net] ?? 0]] : []
    )))
    const measurementErrors = Object.fromEntries(group.nets.flatMap((net) => {
      const errors = measurement?.measurementErrorsByNet[net] ?? []
      return errors.length ? [[net, errors]] : []
    }))
    const values = Object.values(lengthsMm)
    const minLengthMm = values.length === group.nets.length ? Math.min(...values) : undefined
    const maxLengthMm = values.length === group.nets.length ? Math.max(...values) : undefined
    const spreadMm = minLengthMm === undefined || maxLengthMm === undefined
      ? undefined
      : maxLengthMm - minLengthMm
    const diffMembers = group.nets.filter((net) => coupled.has(net))
    // Stock KRT has no one-shot primitive for a group that is partly coupled
    // differential copper and partly ordinary single-ended copper. Keep this
    // explicit in the semantic verdict even if a future pipeline happens to
    // leave equal-length geometry behind: that geometry was never routed or
    // audited under one representable matched-group constraint.
    const capabilityMismatch = diffMembers.length > 0 && diffMembers.length < group.nets.length
    const openNets = connectivity.failed ? [...group.nets] : group.nets.filter((net) => open.has(net))
    const drcRegressedNets = baselineDrc.failed || candidateDrc.failed
      ? [...group.nets]
      : group.nets.filter((net) => !krtCriticalNetDrcNonRegressing(net, baselineDrc, candidateDrc))
    const reasons: KrtMatchedGroupAuditReason[] = []
    if (capabilityMismatch) reasons.push("capability-mismatch")
    if (connectivity.failed) reasons.push("connectivity-audit-failed")
    else if (openNets.length) reasons.push("open-members")
    if (baselineDrc.failed || candidateDrc.failed) reasons.push("drc-audit-failed")
    else if (drcRegressedNets.length) reasons.push("drc-regression")
    if (!Number.isFinite(toleranceMm) || toleranceMm < 0) reasons.push("invalid-tolerance")
    if (!measurement || Object.keys(measurementErrors).length) reasons.push("measurement-failed")
    else if (spreadMm !== undefined && spreadMm > toleranceMm + EPSILON) reasons.push("outside-tolerance")
    const isCoupled = group.nets.every((net) => coupled.has(net))
    return {
      index,
      nets: [...group.nets],
      coupled: isCoupled,
      protectionGate: isCoupled ? "differential" : "matched-group",
      toleranceMm,
      lengthsMm,
      measurementErrors,
      ...(minLengthMm === undefined ? {} : { minLengthMm }),
      ...(maxLengthMm === undefined ? {} : { maxLengthMm }),
      ...(spreadMm === undefined ? {} : {
        spreadMm,
        excessMm: Math.max(0, spreadMm - toleranceMm),
      }),
      openNets,
      drcRegressedNets,
      reasons,
      verified: reasons.length === 0,
    }
  })
  const normalizedArtifacts = resolve(artifactsDir)
  const auditPath = join(normalizedArtifacts, "krt-special-matched-groups.json")
  let auditPersisted = false
  try {
    await mkdir(normalizedArtifacts, { recursive: true })
    await writeFile(auditPath, `${JSON.stringify({
      schemaVersion: 1,
      boardPath: resolve(boardPath),
      toleranceMm,
      ...(measurementError ? { measurementError } : {}),
      ...(measurement ? {
        planarLengthsMm: measurement.planarLengthsMm,
        viaBarrelLengthsMm: measurement.viaBarrelLengthsMm,
        measurementErrorsByNet: measurement.measurementErrorsByNet,
        copperCounts: { vias: measurement.vias, routes: measurement.routes },
      } : {}),
      groups: audits,
    }, null, 2)}\n`, "utf8")
    auditPersisted = true
  } catch (error) {
    diagnostics.push(diagnostic(
      "KRT_MATCHED_GROUP_AUDIT_ARTIFACT_FAILED",
      "warning",
      `Could not persist the matched-group semantic audit: ${errorText(error)}`,
      { path: auditPath },
    ))
  }
  for (const audit of audits) {
    const number = audit.index + 1
    const details = { ...audit, auditPath, ...(measurementError ? { measurementError } : {}) }
    if (audit.verified) diagnostics.push(diagnostic(
      "KRT_MATCHED_GROUP_VERIFIED",
      "info",
      `Matched group ${number} is connected and within ${audit.toleranceMm} mm `
        + `(measured spread ${(audit.spreadMm ?? 0).toFixed(6)} mm).`
        + (audit.coupled ? " Its protection remains governed by the differential-pair gate." : ""),
      details,
    ))
    else if (audit.reasons.includes("capability-mismatch")) diagnostics.push(diagnostic(
      "CAPABILITY_MISMATCH",
      "error",
      `Matched group ${number} mixes differential-pair and ordinary members; its copper remains unprotected.`,
      details,
    ))
    else if (audit.reasons.includes("measurement-failed") || audit.reasons.includes("invalid-tolerance")) diagnostics.push(diagnostic(
      "KRT_MATCHED_GROUP_AUDIT_FAILED",
      "error",
      `Could not measure final copper lengths for matched group ${number}; its nets remain unprotected.`,
      details,
    ))
    else if (audit.reasons.includes("outside-tolerance")) diagnostics.push(diagnostic(
      "KRT_LENGTH_MATCH_INCOMPLETE",
      "error",
      `Matched group ${number} has ${(audit.spreadMm ?? 0).toFixed(6)} mm final copper spread, `
        + `exceeding its ${audit.toleranceMm} mm tolerance; useful connected copper is retained but remains editable.`,
      details,
    ))
    else diagnostics.push(diagnostic(
      "KRT_MATCHED_GROUP_NOT_VERIFIED",
      "warning",
      `Matched group ${number} could not be protected after its independent semantic audit.`,
      details,
    ))
  }
  return {
    audits,
    diagnostics,
    auditPath: auditPersisted ? auditPath : undefined,
    copperCounts: measurement ? { vias: measurement.vias, routes: measurement.routes } : undefined,
  }
}

function unavailableKrtDrcAudit(violationCount = Number.MAX_SAFE_INTEGER): KrtDrcAudit {
  return {
    violationCount,
    fingerprints: [],
    shortFingerprints: [],
    fingerprintsByNet: {},
    shortFingerprintsByNet: {},
    unattributedFingerprints: [],
    unattributedShortFingerprints: [],
    fingerprintsAvailable: false,
    byType: {},
    contactsByType: {},
    elapsedMs: 0,
    stdout: "",
    stderr: "",
    failed: true,
  }
}

async function auditKrtConnectivity(
  boardPath: string,
  netNames: readonly string[],
  spec: KrtStageSpec,
  artifactsDir: string,
): Promise<KrtConnectivityAudit> {
  const normalizedArtifacts = resolve(artifactsDir)
  const scopePath = join(normalizedArtifacts, "krt-special-connectivity-scope.json")
  const resultPath = join(normalizedArtifacts, "krt-special-connectivity-result.json")
  const transport = buildKrtAuditScopeTransport(netNames, scopePath, resultPath)
  try {
    await mkdir(normalizedArtifacts, { recursive: true })
    await rm(resultPath, { force: true })
    await writeFile(scopePath, `${JSON.stringify(transport.sidecar, null, 2)}\n`, "utf8")
  } catch (error) {
    return {
      ...unavailableKrtConnectivityAudit(netNames),
      stderr: `Could not persist the exact connectivity-audit scope: ${errorText(error)}`,
    }
  }
  const modulePaths = [
    join(resolve(spec.krtDirectory), "py_router"),
    ...unique(spec.pythonPathEntries ?? []),
  ]
  const bootstrap = [
    "import fnmatch,json,sys",
    "sys.dont_write_bytecode=True",
    `sys.path[:0]=${JSON.stringify(modulePaths)}`,
    "from check_connected import run_connectivity_check",
    "from kicad_parser import parse_kicad_pcb",
    "scope=json.load(open(sys.argv[2],encoding='utf-8'))",
    "expected=scope['expected']",
    "patterns=scope['patterns']",
    "pcb=parse_kicad_pcb(sys.argv[1])",
    "names=sorted(set(str(net.name) for net in pcb.nets.values() if getattr(net,'name',None)))",
    "selected=sorted(name for name in names if any(fnmatch.fnmatch(name,pattern) for pattern in patterns))",
    "scope_error=set(selected)!=set(expected)",
    "issues=[] if scope_error else run_connectivity_check(sys.argv[1],patterns,0.02,True,False,None,False)",
    "scope_error=scope_error or any(bool(item.get('scope_error')) for item in issues)",
    "payload={'scopeId':scope.get('scopeId'),'scopeError':scope_error,'expectedCount':len(set(expected)),'selectedCount':len(selected),'openNets':sorted(set(str(item.get('net_name','')) for item in issues if item.get('net_name') and not item.get('scope_error'))),'issues':[{'net':str(item.get('net_name','')),'num_components':int(item.get('num_components') or 0),'num_pads':int(item.get('num_pads') or 0),'disconnected_pads':item.get('disconnected_pads') or [],'unrouted':bool(item.get('unrouted')),'kicad_only':bool(item.get('kicad_only'))} for item in issues if not item.get('scope_error')]}",
    "json.dump(payload,open(scope['resultPath'],'w',encoding='utf-8'),sort_keys=True)",
  ].join(";")
  const captured = await runCaptured(
    pythonCommand(spec.pythonPath),
    [
      "-c",
      bootstrap,
      resolve(boardPath),
      ...transport.connectivityBootstrapArgs,
    ],
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
  let openNets: string[] = []
  let issueFingerprints: string[] = []
  let issueFingerprintsByNet: Record<string, string[]> = {}
  let componentCountByNet: Record<string, number> = {}
  let scopeError = false
  let parsed = false
  try {
    const value: unknown = JSON.parse(await readFile(resultPath, "utf8"))
    const object = jsonObject(value)
    if (object && object.scopeId === transport.sidecar.scopeId
      && typeof object.scopeError === "boolean"
      && typeof object.expectedCount === "number" && typeof object.selectedCount === "number"
      && Array.isArray(object.openNets) && Array.isArray(object.issues)) {
      scopeError = object.scopeError
        || object.expectedCount !== transport.sidecar.expected.length
        || object.selectedCount !== transport.sidecar.expected.length
      openNets = unique(object.openNets.map(String))
      issueFingerprints = object.issues.map((item) => JSON.stringify(item)).sort()
      for (const raw of object.issues) {
        const issue = jsonObject(raw)
        const net = typeof issue?.net === "string" ? issue.net : ""
        const count = Number(issue?.num_components)
        if (net) {
          const fingerprint = JSON.stringify(raw)
          const fingerprints = issueFingerprintsByNet[net] ?? []
          fingerprints.push(fingerprint)
          issueFingerprintsByNet[net] = fingerprints
        }
        if (net && Number.isFinite(count)) componentCountByNet[net] = Math.max(componentCountByNet[net] ?? 0, count)
      }
      for (const fingerprints of Object.values(issueFingerprintsByNet)) fingerprints.sort()
      parsed = true
    }
  } catch {
    // The failed flag below retains the full stdout/stderr artifact.
  }
  await writeFile(
    join(normalizedArtifacts, "krt-special-connectivity.log"),
    `${captured.stdout}${captured.stderr ? `\n[stderr]\n${captured.stderr}` : ""}`,
    "utf8",
  ).catch(() => undefined)
  return {
    openNets,
    issueFingerprints,
    issueFingerprintsByNet,
    componentCountByNet,
    elapsedMs: captured.elapsedMs,
    stdout: captured.stdout,
    stderr: captured.stderr,
    failed: Boolean(captured.error || captured.timedOut || spec.signal?.aborted || !parsed || scopeError),
  }
}

/** Full-board geometry-aware connectivity audit used instead of stage counters. */
export async function auditKrtBoardConnectivity(
  boardPath: string,
  netNames: readonly string[],
  spec: KrtStageSpec,
  artifactsDir: string,
) {
  const audit = await auditKrtConnectivity(boardPath, netNames, spec, artifactsDir)
  const diagnostics: KrtDiagnostic[] = audit.failed
    ? [diagnostic(
        "KRT_FINAL_CONNECTIVITY_AUDIT_FAILED",
        "error",
        "KRT could not determine final geometry-aware connectivity; stage counters are not used as a fallback.",
        { stdout: audit.stdout, stderr: audit.stderr },
      )]
    : []
  return {
    openNets: audit.failed ? unique(netNames) : audit.openNets,
    issueFingerprints: audit.issueFingerprints,
    issueFingerprintsByNet: audit.issueFingerprintsByNet,
    componentCountByNet: audit.componentCountByNet,
    elapsedMs: audit.elapsedMs,
    diagnostics,
  }
}

async function auditKrtDrc(
  boardPath: string,
  netNames: readonly string[],
  spec: KrtStageSpec,
  artifactsDir: string,
  artifactName: string,
): Promise<KrtDrcAudit> {
  const materializationDiagnostics: KrtDiagnostic[] = []
  const authoritativeReady = await materializeAuthoritativeSidecars(
    resolve(boardPath),
    spec,
    materializationDiagnostics,
  )
  if (!authoritativeReady) return {
    violationCount: 0,
    fingerprints: [],
    shortFingerprints: [],
    fingerprintsByNet: {},
    shortFingerprintsByNet: {},
    unattributedFingerprints: [],
    unattributedShortFingerprints: [],
    fingerprintsAvailable: false,
    byType: {},
    contactsByType: {},
    elapsedMs: 0,
    stdout: "",
    stderr: materializationDiagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"),
    failed: true,
  }
  const scriptPath = join(resolve(spec.krtDirectory), "py_router", "check_drc.py")
  const normalizedArtifacts = resolve(artifactsDir)
  const artifactStem = artifactName.replace(/\.log$/i, "")
  const jsonPath = join(normalizedArtifacts, `${artifactStem}.json`)
  const scopePath = join(normalizedArtifacts, `${artifactStem}-scope.json`)
  const scopeResultPath = join(normalizedArtifacts, `${artifactStem}-scope-result.json`)
  const transport = buildKrtAuditScopeTransport(netNames, scopePath, scopeResultPath)
  try {
    await mkdir(normalizedArtifacts, { recursive: true })
    await Promise.all([
      rm(jsonPath, { force: true }),
      rm(scopeResultPath, { force: true }),
    ])
    await writeFile(scopePath, `${JSON.stringify(transport.sidecar, null, 2)}\n`, "utf8")
  } catch (error) {
    return {
      ...unavailableKrtDrcAudit(0),
      stderr: `Could not persist the exact DRC-audit scope: ${errorText(error)}`,
    }
  }
  // check_drc.py treats --clearance as a global ceiling, just like route.py.
  // Omitting it is required for the authoritative project netclasses and
  // netclass_patterns to remain effective during a mixed-class board audit.
  const args = [resolve(boardPath), "--quiet", "--json", jsonPath]
  pushNumericArg(args, "--hole-to-hole-clearance", spec.rules.holeToHoleClearance)
  pushNumericArg(args, "--board-edge-clearance", spec.rules.boardEdgeClearance)
  // Keep the native audit on the exact same fabrication contract as route.py.
  // Without this, check_drc.py activates its default fab tier (including the
  // 0.2 mm board-edge floor) and can reject copper the router legally created
  // under a tighter explicit DSL/project rule. The explicit CLI values above
  // remain authoritative inputs; check_drc applies the shared fab minima too.
  args.push("--fab-overrides", resolve(spec.fabOverridesPath))
  const expectedNets = unique(netNames)
  args.push(...transport.drcNetArgs)
  const captured = await runCaptured(
    pythonCommand(spec.pythonPath),
    pythonScopedDrcArgs(
      scriptPath,
      args,
      spec.pythonPathEntries,
      transport.drcBootstrapArgs[0],
    ),
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
  let jsonResult: Record<string, unknown> | undefined
  try {
    jsonResult = jsonObject(JSON.parse(await readFile(jsonPath, "utf8")))
  } catch {
    jsonResult = undefined
  }
  const fingerprintIndex = indexKrtDrcFingerprints(
    Array.isArray(jsonResult?.items) ? jsonResult.items : [],
  )
  let scopeVerified = false
  try {
    const payload = jsonObject(JSON.parse(await readFile(scopeResultPath, "utf8")))
    scopeVerified = payload?.scopeId === transport.sidecar.scopeId
      && payload.scopeOk === true
      && payload.expectedCount === expectedNets.length
      && payload.selectedCount === expectedNets.length
  } catch {
    scopeVerified = false
  }
  const numericRecord = (value: unknown) => Object.fromEntries(Object.entries(jsonObject(value) ?? {}).flatMap(([key, item]) => (
    typeof item === "number" && Number.isFinite(item) ? [[key, item]] : []
  )))
  await writeFile(
    join(normalizedArtifacts, artifactName),
    `${captured.stdout}${captured.stderr ? `\n[stderr]\n${captured.stderr}` : ""}`,
    "utf8",
  ).catch(() => undefined)
  return {
    violationCount: violationCount ?? 0,
    ...fingerprintIndex,
    fingerprintsAvailable: Boolean(jsonResult && Array.isArray(jsonResult.items)),
    byType: numericRecord(jsonResult?.by_type),
    contactsByType: numericRecord(jsonResult?.contacts_by_type),
    elapsedMs: captured.elapsedMs,
    stdout: captured.stdout,
    stderr: captured.stderr,
    // check_drc exits 1 when it successfully found violations.
    failed: Boolean(captured.error || captured.timedOut || spec.signal?.aborted
      || !scopeVerified || !parsed || !jsonResult || !Array.isArray(jsonResult.items)
      || (captured.exitCode !== 0 && captured.exitCode !== 1)),
  }
}

/** Scoped native DRC audit used to gate post-main repair candidates. */
export async function auditKrtBoardDrc(
  boardPath: string,
  netNames: readonly string[],
  spec: KrtStageSpec,
  artifactsDir: string,
) {
  const audit = await auditKrtDrc(
    boardPath,
    netNames,
    spec,
    artifactsDir,
    "krt-board-drc.log",
  )
  const diagnostics: KrtDiagnostic[] = audit.failed
    ? [diagnostic(
        "KRT_BOARD_DRC_AUDIT_FAILED",
        "error",
        "KRT could not determine the scoped native DRC count.",
        { stdout: audit.stdout, stderr: audit.stderr },
      )]
    : []
  return {
    violationCount: audit.violationCount,
    fingerprints: audit.fingerprints,
    shortFingerprints: audit.shortFingerprints,
    fingerprintsByNet: audit.fingerprintsByNet,
    shortFingerprintsByNet: audit.shortFingerprintsByNet,
    unattributedFingerprints: audit.unattributedFingerprints,
    unattributedShortFingerprints: audit.unattributedShortFingerprints,
    fingerprintsAvailable: audit.fingerprintsAvailable,
    byType: audit.byType,
    contactsByType: audit.contactsByType,
    elapsedMs: audit.elapsedMs,
    failed: audit.failed,
    diagnostics,
  }
}

function diffPairSemanticallyCoupled(
  summary: Record<string, unknown> | undefined,
  pair: NormalizedPair,
  completedFollowups: readonly string[],
) {
  if (!summary) return false
  const followups = new Set(completedFollowups)
  const routedPairNames = new Set(stringArray(summary.routed_diff_pairs))
  const reports = recordArray(summary.pair_reports)
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
  return coupled || coupledWithFollowup
}

function specialSemanticOpenNets(
  summary: Record<string, unknown> | undefined,
  pairs: readonly NormalizedPair[],
  completedFollowups: readonly string[],
) {
  return unique(pairs.flatMap((pair) => diffPairSemanticallyCoupled(summary, pair, completedFollowups)
    ? []
    : [pair.positive, pair.negative]))
}

type KrtDiffPairDrcEvidence = Readonly<{
  failed: boolean
  fingerprintsAvailable: boolean
  fingerprintsByNet: Readonly<Record<string, readonly string[]>>
  shortFingerprintsByNet: Readonly<Record<string, readonly string[]>>
  unattributedFingerprints: readonly string[]
  unattributedShortFingerprints: readonly string[]
}>

export type KrtDiffPairCustodyEvidence = Readonly<{
  pairs: readonly KrtDiffPair[]
  summary?: Record<string, unknown>
  completedFollowups?: readonly string[]
  connectivity: Readonly<{ failed: boolean; openNets: readonly string[] }>
  baselineDrc: KrtDiffPairDrcEvidence
  candidateDrc: KrtDiffPairDrcEvidence
  matchedGroups?: readonly KrtMatchedGroup[]
  matchedGroupAudits?: readonly Readonly<{ nets: readonly string[]; verified: boolean }>[]
}>

function sameNetMembership(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((net) => rightSet.has(net))
}

/**
 * Return only independently verified differential members. A failed sibling
 * pair does not revoke good copper, while connectivity, per-net DRC, and every
 * declared matched-group constraint remain fail-closed custody gates.
 */
export function krtVerifiedDiffPairNets(evidence: KrtDiffPairCustodyEvidence) {
  if (evidence.connectivity.failed || evidence.baselineDrc.failed || evidence.candidateDrc.failed) return []
  const completedFollowups = evidence.completedFollowups ?? []
  const open = new Set(evidence.connectivity.openNets)
  const groups = (evidence.matchedGroups ?? []).map(normalizeGroup)
  const groupAudits = evidence.matchedGroupAudits ?? []
  const verified: string[] = []
  for (const pair of evidence.pairs.map(normalizePair)) {
    const members = [pair.positive, pair.negative]
    if (!pair.positive || !pair.negative || pair.positive === pair.negative) continue
    if (!diffPairSemanticallyCoupled(evidence.summary, pair, completedFollowups)) continue
    if (members.some((net) => open.has(net))) continue
    if (members.some((net) => !krtCriticalNetDrcNonRegressing(
      net,
      evidence.baselineDrc,
      evidence.candidateDrc,
    ))) continue
    const memberGroups = groups.filter((group) => group.nets.some((net) => members.includes(net)))
    if (memberGroups.some((group) => !groupAudits.some((audit) => (
      audit.verified && sameNetMembership(group.nets, audit.nets)
    )))) continue
    verified.push(...members)
  }
  return unique(verified)
}

const KRT_MATCHED_RETRY_INFRASTRUCTURE_REASONS = new Set([
  "capability-mismatch",
  "connectivity-audit-failed",
  "drc-audit-failed",
  "invalid-tolerance",
  "measurement-failed",
])

const KRT_MATCHED_RETRY_ROUTE_REASONS = new Set([
  "open-members",
  "drc-regression",
  "outside-tolerance",
])

export type KrtOrdinaryMatchedRetryEvidence = Readonly<{
  aborted: boolean
  attempted: boolean
  preflightFailed: boolean
  connectivityAuditFailed: boolean
  drcAuditFailed: boolean
  openNets: readonly string[]
  matchedGroupReasons: readonly (readonly string[])[]
}>

/** A second ordinary matched candidate is useful only for route/order failures. */
export function krtOrdinaryMatchedCandidateRetryable(evidence: KrtOrdinaryMatchedRetryEvidence) {
  if (evidence.aborted
    || !evidence.attempted
    || evidence.preflightFailed
    || evidence.connectivityAuditFailed
    || evidence.drcAuditFailed) return false
  const reasons = evidence.matchedGroupReasons.flat()
  if (reasons.some((reason) => KRT_MATCHED_RETRY_INFRASTRUCTURE_REASONS.has(reason))) return false
  return evidence.openNets.length > 0
    || reasons.some((reason) => KRT_MATCHED_RETRY_ROUTE_REASONS.has(reason))
}

const RESOLVED_FOLLOWUP_DIAGNOSTICS = new Set([
  "KRT_DIFF_PARTIAL",
  "KRT_DIFF_NOT_FULLY_COUPLED",
  "KRT_DIFF_PAIR_AUDIT_FAILED",
])

// Process/protocol state remains visible in status and diagnostics, but it is
// not board-semantic damage once independent output connectivity and DRC
// audits prove the checkpoint. Keep this aligned with candidate grading.
const KRT_TRANSPORT_DIAGNOSTICS = new Set([
  "KRT_PROCESS_START_FAILED",
  "KRT_TIMEOUT",
  "KRT_ABORTED",
  "KRT_NONZERO_EXIT",
  "KRT_SUMMARY_MISSING",
  "KRT_SUMMARY_MIN_MISSING",
  "KRT_INVALID_JSON_SUMMARY",
  "KRT_MERGED_SUMMARY_INVALID",
])

/** @internal Transport diagnostics do not describe physical board damage. */
export function krtTransportDiagnostic(code: string) {
  return KRT_TRANSPORT_DIAGNOSTICS.has(code)
}

const KRT_SPECIAL_TRANSPORT_DIAGNOSTICS = new Set([
  "KRT_PROCESS_START_FAILED",
  "KRT_TIMEOUT",
  "KRT_ABORTED",
  "KRT_NONZERO_EXIT",
  "KRT_SUMMARY_MIN_MISSING",
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
        maxRipup: spec.maxRipup,
        specialMaxCandidates: 1,
        protectSpecialOutput: false,
        protectedNets: unique([...(spec.protectedNets ?? []), ...diffNets]),
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
      "KRT_LENGTH_MATCH_NATIVE_WARNING",
      "warning",
      "KRT reported a possibly incomplete equal-length group; the final output copper audit is authoritative.",
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
    ...(spec.maxRipup === undefined
      ? {}
      : { maxRipup: Math.max(0, Math.trunc(spec.maxRipup)) }),
  }
  const variants = spec.specialMaxCandidates === undefined
    || spec.specialMaxCandidates <= 1
    || (!normalized.pairs.length && !normalized.ordinaryGroups.length)
    ? [configured]
    : buildKrtSpecialCandidatePortfolio(configured, spec.specialMaxCandidates)
  const matchedGroups = spec.matchedGroups.map(normalizeGroup)
  const specialNets = unique([
    ...normalized.pairs.flatMap((pair) => [pair.positive, pair.negative]),
    // Audit the exact requested groups, including a mixed diff/ordinary group
    // rejected by native preflight. An omitted member must never look closed
    // merely because it was absent from the connectivity/DRC audit scope.
    ...matchedGroups.flatMap((group) => group.nets),
  ])
  const diffNets = unique(normalized.pairs.flatMap((pair) => [pair.positive, pair.negative]))
  const attempts: Array<{
    variant: KrtSpecialCandidate
    result: KrtProcessResult
    audit: KrtConnectivityAudit
    drc: KrtDrcAudit
    matchedGroupAudits: KrtMatchedGroupAudit[]
    verifiedDiffNets: string[]
    verifiedMatchedNets: string[]
    matchedViolationCount: number
    matchedExcessMm: number
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
    const matchedFallbackRules = index > 0 && !normalized.pairs.length
      ? spec.ordinaryMatchedFallbackRules
      : undefined
    const candidateSpec: KrtStageSpec = {
      ...spec,
      rules: matchedFallbackRules ?? spec.rules,
      ordinaryMatchedRules: matchedFallbackRules ?? spec.ordinaryMatchedRules,
      ordering: variant.ordering,
      mpsReverseRounds: variant.mpsReverseRounds,
      ...(variant.maxRipup === undefined ? {} : { maxRipup: variant.maxRipup }),
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
      : unavailableKrtConnectivityAudit(specialNets)
    const drc = await exists(candidateOutput)
      ? await auditKrtDrc(candidateOutput, specialNets, candidateSpec, candidateDir, "krt-special-drc.log")
      : unavailableKrtDrcAudit()
    const addedFingerprints = addedDrcFingerprints(baselineDrc, drc)
    const addedDrcViolations = baselineDrc.failed || drc.failed
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, drc.violationCount - baselineDrc.violationCount, addedFingerprints.length)
    const matchedAudit = matchedGroups.length
      ? await auditKrtMatchedGroups(
          candidateOutput,
          matchedGroups,
          diffNets,
          spec.rules.lengthMatchTolerance ?? Number.NaN,
          audit,
          baselineDrc,
          drc,
          candidateDir,
        )
      : {
          audits: [] as KrtMatchedGroupAudit[],
          diagnostics: [] as KrtDiagnostic[],
          auditPath: undefined,
          copperCounts: undefined,
        }
    result.diagnostics.push(...matchedAudit.diagnostics)
    const matchedGroupAudits = [...matchedAudit.audits]
    const verifiedDiffNets = krtVerifiedDiffPairNets({
      pairs: normalized.pairs,
      summary: result.jsonSummary,
      completedFollowups,
      connectivity: audit,
      baselineDrc,
      candidateDrc: drc,
      matchedGroups,
      matchedGroupAudits,
    })
    const verifiedMatchedNets = unique(matchedGroupAudits
      // A group made exclusively from pair members remains under the existing
      // differential semantic/protection gate. Ordinary matched groups are
      // independently protectable, so one bad sibling group cannot veto them.
      .filter((group) => group.verified && !group.coupled)
      .flatMap((group) => group.nets))
    const unmatchedGroups = matchedGroupAudits.filter((group) => !group.verified)
    const matchedViolationCount = unmatchedGroups.length
    const matchedExcessMm = unmatchedGroups.reduce((sum, group) => sum + (group.excessMm ?? 0), 0)
    result.jsonSummary = {
      ...(result.jsonSummary ?? {}),
      matched_group_audits: matchedGroupAudits,
      diff_verified_nets: verifiedDiffNets,
      diff_unverified_nets: diffNets.filter((net) => !verifiedDiffNets.includes(net)),
      matched_verified_nets: verifiedMatchedNets,
      unmatched_groups: unmatchedGroups,
    }
    if (matchedAudit.auditPath) result.matchedGroupsAuditPath = matchedAudit.auditPath
    await persistResultArtifacts(result, candidateDir).catch(() => undefined)
    const semanticOpen = specialSemanticOpenNets(result.jsonSummary, normalized.pairs, completedFollowups)
    const openNets = unique([
      ...semanticOpen,
      ...(audit.failed ? specialNets : audit.openNets),
    ])
    const resolvedFollowup = openNets.length === 0 && completedFollowups.length > 0
    const hardErrors = result.diagnostics.filter((item) => (
      item.severity === "error"
      // A matched/differential stage still needs a parseable semantic summary;
      // independent connectivity+DRC can neutralize process termination, not
      // prove coupling or length tolerance on its own.
      && !KRT_SPECIAL_TRANSPORT_DIAGNOSTICS.has(item.code)
      && !(resolvedFollowup && RESOLVED_FOLLOWUP_DIAGNOSTICS.has(item.code))
    )).length
    const counts = matchedAudit.copperCounts ?? (await exists(candidateOutput)
      ? await boardCopperCounts(candidateOutput).catch(() => ({ vias: Number.MAX_SAFE_INTEGER, routes: Number.MAX_SAFE_INTEGER }))
      : { vias: Number.MAX_SAFE_INTEGER, routes: Number.MAX_SAFE_INTEGER })
    const complete = !audit.failed
      && !drc.failed
      && openNets.length === 0
      && addedDrcViolations === 0
      && matchedViolationCount === 0
      && hardErrors === 0
    attempts.push({
      variant,
      result,
      audit,
      drc,
      matchedGroupAudits,
      verifiedDiffNets,
      verifiedMatchedNets,
      matchedViolationCount,
      matchedExcessMm,
      openNets,
      addedDrcViolations,
      hardErrors,
      ...counts,
      complete,
    })
    if (complete) break
    if (spec.signal?.aborted) break
    if (!normalized.pairs.length && normalized.ordinaryGroups.length
      && !krtOrdinaryMatchedCandidateRetryable({
        aborted: Boolean(spec.signal?.aborted),
        attempted: result.attempted,
        preflightFailed: result.status === "preflight_failed",
        connectivityAuditFailed: audit.failed,
        drcAuditFailed: baselineDrc.failed || drc.failed,
        openNets,
        matchedGroupReasons: matchedGroupAudits.map((group) => group.reasons),
      })) break
  }

  const selected = [...attempts].sort((left, right) => {
    const a = [
      left.complete ? 0 : 1,
      left.openNets.length,
      left.addedDrcViolations,
      left.hardErrors,
      left.matchedViolationCount,
      left.matchedExcessMm,
      left.vias,
      left.routes,
    ]
    const b = [
      right.complete ? 0 : 1,
      right.openNets.length,
      right.addedDrcViolations,
      right.hardErrors,
      right.matchedViolationCount,
      right.matchedExcessMm,
      right.vias,
      right.routes,
    ]
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
        gridStep: attempt.result.subcalls?.find((subcall) => subcall.attempted)
          ? (attempt.variant.id === configured.id
              ? spec.rules.gridStep
              : spec.ordinaryMatchedFallbackRules?.gridStep ?? spec.rules.gridStep)
          : undefined,
        nativeLengthMatchTolerance: attempt.variant.id === configured.id
          ? spec.rules.lengthMatchTolerance
          : spec.ordinaryMatchedFallbackRules?.lengthMatchTolerance ?? spec.rules.lengthMatchTolerance,
        complete: attempt.complete,
        openNets: attempt.openNets,
        drcViolations: attempt.drc.violationCount,
        addedDrcViolations: attempt.addedDrcViolations,
        hardErrors: attempt.hardErrors,
        matchedViolationCount: attempt.matchedViolationCount,
        matchedExcessMm: attempt.matchedExcessMm,
        matchedGroups: attempt.matchedGroupAudits,
        verifiedDiffNets: attempt.verifiedDiffNets,
        verifiedMatchedNets: attempt.verifiedMatchedNets,
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
    `No special candidate passed every semantic, connectivity, and DRC gate; `
      + `${selected.openNets.length} net(s) and ${selected.matchedViolationCount} matched group(s) remain unresolved.`,
    {
      openNets: selected.openNets,
      addedDrcViolations: selected.addedDrcViolations,
      unmatchedGroups: selected.matchedGroupAudits.filter((group) => !group.verified),
    },
  ))

  await removeBoardAndSidecars(resolve(outputBoard))
  await copyBoardAndSidecars(selected.result.outputBoard, resolve(outputBoard), diagnostics)
  const sidecarsMaterialized = await materializeAuthoritativeSidecars(
    resolve(outputBoard),
    spec,
    diagnostics,
  )
  let protectedNetsPath: string | undefined
  let protectedNets: string[] | undefined
  const verifiedSpecialNets = unique([
    ...selected.verifiedDiffNets,
    ...selected.verifiedMatchedNets,
  ])
  if (verifiedSpecialNets.length
    && spec.protectSpecialOutput !== false
    && await exists(resolve(outputBoard))) {
    // Keep the verified set in memory even when sibling-project persistence
    // fails. The caller rematerializes this set before every later KRT stage,
    // preventing ordinary routing from silently rewriting verified copper.
    protectedNets = [...verifiedSpecialNets]
    try {
      if (!sidecarsMaterialized) throw new Error("authoritative sidecar materialization failed")
      const persisted = await persistKrtProtectedNets(resolve(outputBoard), verifiedSpecialNets)
      protectedNetsPath = persisted.path
      protectedNets = persisted.nets
      diagnostics.push(diagnostic(
        "KRT_SPECIAL_NETS_PROTECTED",
        "info",
        `Protected ${protectedNets.length} independently verified special net(s) for later native stages.`,
        {
          nets: protectedNets,
          differentialNets: selected.verifiedDiffNets,
          matchedNets: selected.verifiedMatchedNets,
        },
      ))
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
      matched_group_audits: selected.matchedGroupAudits,
      diff_verified_nets: selected.verifiedDiffNets,
      diff_unverified_nets: diffNets.filter((net) => !selected.verifiedDiffNets.includes(net)),
      matched_verified_nets: selected.verifiedMatchedNets,
      matched_unverified_nets: unique(selected.matchedGroupAudits
        .filter((group) => !group.verified)
        .flatMap((group) => group.nets)),
      special_verified_nets: verifiedSpecialNets,
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
    "remaining",
  )
}

/**
 * Route a critical ordinary-net group and protect only the members that the
 * native geometry audit proves connected without adding a scoped DRC
 * regression. A partial group remains useful: completed members are protected
 * while open members stay available to the later full-board pass.
 */
export async function runKrtVerifiedCritical(
  inputBoard: string,
  outputBoard: string,
  spec: KrtStageSpec,
  artifactsDir: string,
): Promise<KrtProcessResult> {
  const nets = unique(spec.remainingNets)
  const normalizedArtifacts = resolve(artifactsDir)
  const baselineDrc = await auditKrtDrc(
    inputBoard,
    nets,
    spec,
    normalizedArtifacts,
    "krt-critical-baseline-drc.log",
  )
  const result = await runKrtRemaining(inputBoard, outputBoard, spec, normalizedArtifacts)
  const outputExists = await exists(resolve(outputBoard))
  const connectivity = outputExists
    ? await auditKrtConnectivity(outputBoard, nets, spec, normalizedArtifacts)
    : unavailableKrtConnectivityAudit(nets)
  const candidateDrc = outputExists
    ? await auditKrtDrc(
        outputBoard,
        nets,
        spec,
        normalizedArtifacts,
        "krt-critical-candidate-drc.log",
      )
    : unavailableKrtDrcAudit()
  const addedFingerprints = addedDrcFingerprints(baselineDrc, candidateDrc)
  const addedDrcViolations = baselineDrc.failed || candidateDrc.failed
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, candidateDrc.violationCount - baselineDrc.violationCount, addedFingerprints.length)
  const perNetIncompleteDiagnostics = new Set([
    "KRT_NETS_UNROUTED",
    "KRT_NETS_OPEN",
    "KRT_MULTIPOINT_INCOMPLETE",
    "KRT_CLEANUP_DISCONNECTED",
    "KRT_PAD_PAIRS_OPEN",
  ])
  const blockingResultError = result.diagnostics.some((item) => (
    item.severity === "error"
    && !perNetIncompleteDiagnostics.has(item.code)
    && !krtTransportDiagnostic(item.code)
  ))
  const connectedNets = outputExists
    && !connectivity.failed
    && !baselineDrc.failed
    && !candidateDrc.failed
    // Incomplete members are intentionally not a batch-wide veto: geometry
    // connectivity below verifies and protects each completed critical net.
    && !blockingResultError
    ? nets.filter((net) => !connectivity.openNets.includes(net))
    : []
  const verifiedNets = connectedNets.filter((net) => (
    krtCriticalNetDrcNonRegressing(net, baselineDrc, candidateDrc)
  ))
  const drcRegressedNets = connectedNets.filter((net) => !verifiedNets.includes(net))

  if (connectivity.failed) result.diagnostics.push(diagnostic(
    "KRT_CRITICAL_CONNECTIVITY_AUDIT_FAILED",
    "error",
    "KRT could not verify critical-net connectivity; no new protection was granted.",
    { stdout: connectivity.stdout, stderr: connectivity.stderr },
  ))
  if (baselineDrc.failed || candidateDrc.failed) result.diagnostics.push(diagnostic(
    "KRT_CRITICAL_DRC_AUDIT_FAILED",
    "error",
    "KRT could not compare the critical candidate against its input DRC baseline; no new protection was granted.",
    {
      baseline: { stdout: baselineDrc.stdout, stderr: baselineDrc.stderr },
      candidate: { stdout: candidateDrc.stdout, stderr: candidateDrc.stderr },
    },
  ))
  if (addedDrcViolations > 0 && addedDrcViolations !== Number.MAX_SAFE_INTEGER) result.diagnostics.push(diagnostic(
    "KRT_CRITICAL_DRC_REGRESSION",
    "warning",
    `The critical candidate adds ${addedDrcViolations} scoped KRT DRC violation(s); only clean connected members can be protected.`,
    {
      baseline: baselineDrc.violationCount,
      candidate: candidateDrc.violationCount,
      addedFingerprints: addedFingerprints.slice(0, 16),
      regressedNets: drcRegressedNets,
      verifiedNets,
    },
  ))

  let protectedNetsPath: string | undefined
  if (verifiedNets.length) {
    // executeStage already produced a sidecar from the authoritative rule
    // source. Re-materialize it here so only the explicit verified ledger is
    // carried into protection, never a KRT-written project mutation.
    const materialized = await materializeAuthoritativeSidecars(
      resolve(outputBoard),
      spec,
      result.diagnostics,
    )
    try {
      if (!materialized) throw new Error("authoritative sidecar materialization failed")
      const persisted = await persistKrtProtectedNets(
        resolve(outputBoard),
        verifiedNets,
        "workflow-critical",
      )
      protectedNetsPath = persisted.path
      result.diagnostics.push(diagnostic(
        "KRT_CRITICAL_NETS_PROTECTED",
        "info",
        `Protected ${verifiedNets.length} geometry-verified critical net(s) for later native recovery.`,
        { nets: verifiedNets },
      ))
    } catch (error) {
      result.diagnostics.push(diagnostic(
        "KRT_CRITICAL_PROTECTION_FAILED",
        "error",
        `Could not protect verified critical-net copper: ${errorText(error)}`,
        { board: resolve(outputBoard), nets: verifiedNets },
      ))
    }
  }

  result.elapsedMs += baselineDrc.elapsedMs + connectivity.elapsedMs + candidateDrc.elapsedMs
  result.jsonSummary = {
    ...(result.jsonSummary ?? {}),
    // "open" here means unresolved for protection/retry, not merely the
    // electrical connectivity subset. A connected candidate with a DRC or
    // semantic error must still flow into the later editable main pass.
    critical_open_nets: nets.filter((net) => !verifiedNets.includes(net)),
    critical_connectivity_open_nets: connectivity.failed ? nets : connectivity.openNets,
    critical_verified_nets: verifiedNets,
    critical_drc_regressed_nets: drcRegressedNets,
    critical_added_drc_violations: addedDrcViolations,
    critical_blocking_result_error: blockingResultError,
  }
  result.protectedNets = unique([...(spec.protectedNets ?? []), ...verifiedNets])
  if (protectedNetsPath) result.protectedNetsPath = protectedNetsPath
  await saveOutputArtifact(result, normalizedArtifacts)
  await persistResultArtifacts(result, normalizedArtifacts).catch(() => undefined)
  return result
}
