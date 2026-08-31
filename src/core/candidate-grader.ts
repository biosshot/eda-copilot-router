import type { BackendRouteResult } from "../adapters/contracts.js"
import type { RoutingProgram } from "../intent/types.js"
import type {
  RoutingBoard,
  RoutingCopper,
  RoutingDiagnostic,
  RoutingRules,
} from "./contracts.js"
import { resolveRoutePlan } from "./route-plan.js"
import { netTerminalSpansMm } from "./net-geometry.js"
import { validateRoutingCopper } from "./validation.js"

/** A physically short net pays a stronger penalty for avoidable layer changes. */
export const SHORT_AVOID_VIA_NET_LENGTH_MM = 10

const CRITICAL_DIAGNOSTICS = new Set([
  "KRT_COVERAGE_GATE_FAILED",
  "KRT_PREEXISTING_COPPER_RIPPED",
  "KRT_PROTECTED_COPPER_RIPPED",
  "KRT_RIP_VICTIM_INCOMPLETE",
  "KRT_SPECIAL_PROTECTED_COPPER_CHANGED",
  "KRT_SPECIAL_PROTECTION_GUARD_FAILED",
])

const DIFFERENTIAL_DIAGNOSTICS = new Set([
  "KRT_DIFF_UNROUTED",
  "KRT_DIFF_PARTIAL",
  "KRT_DIFF_NOT_FULLY_COUPLED",
  "KRT_DIFF_SKIPPED",
  "KRT_DIFF_PAIR_AUDIT_FAILED",
  "KRT_UNREQUESTED_POLARITY_SWAP",
])

const MATCHED_DIAGNOSTICS = new Set([
  "KRT_LENGTH_MATCH_INCOMPLETE",
])

const IMPEDANCE_DIAGNOSTICS = new Set([
  "KRT_IMPEDANCE_GEOMETRY_UNVERIFIED",
  "IMPEDANCE_STACK_INCOMPLETE",
  "IMPEDANCE_REFERENCE_AMBIGUOUS",
  "IMPEDANCE_TOLERANCE_UNREACHABLE",
  "HYBRID_HARD_CONSTRAINTS_UNVERIFIED_FALLBACK",
])

// These diagnostics describe the same unresolved connectivity already carried
// by openNetCount/openNets. Counting them again as generic engine damage makes
// every useful partial KRT checkpoint lose to a synthetic diagnostic-free
// baseline, even after it removes vias or improves other routed nets.
const CONNECTIVITY_PARTIAL_DIAGNOSTICS = new Set([
  "KRT_NETS_UNROUTED",
  "KRT_NETS_OPEN",
  "KRT_MULTIPOINT_INCOMPLETE",
  "KRT_CLEANUP_DISCONNECTED",
  "KRT_PAD_PAIRS_OPEN",
])

// Process/protocol failure remains visible to the caller, but it is not board
// quality damage once the returned copper has finite geometry-aware
// connectivity evidence. Semantic DRC/connectivity/protection diagnostics are
// deliberately absent from this set and continue to rank before via quality.
const KRT_TRANSPORT_DIAGNOSTICS = new Set([
  "KRT_PROCESS_START_FAILED",
  "KRT_TIMEOUT",
  "KRT_ABORTED",
  "KRT_NONZERO_EXIT",
  "KRT_SUMMARY_MISSING",
  "KRT_SUMMARY_MIN_MISSING",
  "KRT_BACKEND_FAILED_AFTER_CHECKPOINT",
])

type JsonRecord = Readonly<Record<string, unknown>>

// KRT exposes these raw stage summaries for provenance. They are not snapshots
// of the promoted board and can include failures from candidates that a stage
// gate rolled back. `special` is intentionally retained because it is the
// canonical semantic report for differential pairs and matched groups;
// `specialBatches` is only its duplicate expanded representation.
const KRT_NATIVE_AUTO_HISTORY_ROOT_KEYS = new Set([
  "specialBatches",
  "critical",
  "early",
  "main",
])

export type RoutingCandidateGrade = Readonly<{
  structurallyUsable: boolean
  structuralDiagnostics: readonly RoutingDiagnostic[]
  criticalRegressionCount: number
  priorityOpenPenalty: number
  openNetCount: number
  connectivityComponentCount: number
  differentialViolationCount: number
  matchedViolationCount: number
  impedanceViolationCount: number
  drcViolationCount: number
  errorCount: number
  forbiddenViaCount: number
  shortAvoidViaPenalty: number
  avoidViaPenalty: number
  viaCount: number
  trackLengthMm: number
  /** Stable lexicographic ordering. Lower is better. */
  score: readonly number[]
}>

export type RoutingCandidate = Readonly<{
  index: number
  label: string
  result: BackendRouteResult
  grade: RoutingCandidateGrade
}>

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function finite(value: unknown, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function itemCount(value: unknown) {
  if (Array.isArray(value)) return value.length
  const object = record(value)
  if (object) return Object.keys(object).length
  if (value === true) return 1
  return finite(value)
}

function trackLengths(copper: RoutingCopper) {
  const byNet = new Map<string, number>()
  let total = 0
  for (const track of copper.tracks) {
    let length = 0
    for (let index = 1; index < track.points.length; index += 1) {
      const previous = track.points[index - 1]
      const point = track.points[index]
      length += Math.hypot(point.x - previous.x, point.y - previous.y)
    }
    total += length
    byNet.set(track.net, (byNet.get(track.net) ?? 0) + length)
  }
  return { byNet, total }
}

function detailRecords(details: unknown) {
  const output: JsonRecord[] = []
  const seen = new Set<unknown>()
  const excluded = new Set(["attempts", "candidates", "fanout", "runtime", "subcalls"])
  const nativeAuto = record(details)?.policy === "native-auto"
  const visit = (value: unknown, depth: number, path: readonly string[]) => {
    if (depth > 4 || seen.has(value)) return
    const object = record(value)
    if (object) {
      seen.add(value)
      // Orchestrators retain rejected attempts in metrics.details for
      // diagnostics and reproducibility. Their nested summaries describe a
      // board that was explicitly rolled back, so they are not evidence about
      // the copper in this candidate. The original details remain available to
      // callers; only the final-state grade ignores this rejected subtree.
      if (nativeAuto && path.length === 1 && path[0] === "repairs" && object.accepted === false) return
      output.push(object)
      for (const [key, child] of Object.entries(object)) {
        if (excluded.has(key)) continue
        if (nativeAuto && depth === 0 && KRT_NATIVE_AUTO_HISTORY_ROOT_KEYS.has(key)) continue
        visit(child, depth + 1, [...path, key])
      }
      return
    }
    if (Array.isArray(value)) {
      seen.add(value)
      for (const child of value.slice(0, 128)) visit(child, depth + 1, path)
    }
  }
  visit(details, 0, [])
  return output
}

function detailCount(records: readonly JsonRecord[], keys: readonly string[]) {
  let count = 0
  for (const item of records) for (const key of keys) if (item[key] !== undefined) count += itemCount(item[key])
  return count
}

function badPairReportCount(records: readonly JsonRecord[]) {
  let count = 0
  for (const item of records) for (const report of Array.isArray(item.pair_reports) ? item.pair_reports : []) {
    const pair = record(report)
    if (pair && (pair.outcome !== "coupled"
      || pair.member_audit_mismatch === true
      || stringArray(pair.incomplete_members).length > 0)) count += 1
  }
  return count
}

function unrecoveredRipCount(records: readonly JsonRecord[]) {
  let count = 0
  for (const item of records) {
    const outcomes = record(item.preexisting_rips)
    if (!outcomes) continue
    count += Object.values(outcomes).filter((outcome) => (
      /NOT RECOVERED|PARTIAL|still open/i.test(String(outcome))
    )).length
  }
  return count
}

function ruleFor(rules: RoutingRules, net: string) {
  return rules.nets.find((item) => item.net === net)?.values ?? rules.default
}

function diagnosticsMatching(diagnostics: readonly RoutingDiagnostic[], codes: ReadonlySet<string>) {
  return diagnostics.filter((item) => item.severity === "error" && codes.has(item.code)).length
}

function drcDiagnosticCount(diagnostics: readonly RoutingDiagnostic[]) {
  return diagnostics.filter((item) => item.severity === "error" && /(?:^|_)DRC(?:_|$)/i.test(item.code)).length
}

function openNets(result: BackendRouteResult) {
  return new Set(result.metrics?.openNets ?? [])
}

function effectiveOpenCount(result: BackendRouteResult, names: ReadonlySet<string>) {
  if (result.metrics?.openNetCount !== undefined) {
    return Math.max(names.size, finite(result.metrics.openNetCount, Number.MAX_SAFE_INTEGER))
  }
  if (result.metrics?.openNets) return names.size
  // Transport status is not connectivity evidence. In particular, a custom
  // backend must not be able to erase routed copper with complete+empty while
  // omitting the board-level audit metrics.
  return Number.MAX_SAFE_INTEGER
}

function effectiveConnectivityComponentCount(result: BackendRouteResult) {
  return result.metrics?.connectivityComponentCount === undefined
    ? Number.MAX_SAFE_INTEGER
    : finite(result.metrics.connectivityComponentCount, Number.MAX_SAFE_INTEGER)
}

/**
 * Grade one applicable backend snapshot. Transport status deliberately is not
 * a structural gate: a parseable partial/error board is still a valid recovery
 * candidate and is ranked by its semantic damage.
 */
export function gradeRoutingCandidate(
  board: RoutingBoard,
  program: RoutingProgram,
  rules: RoutingRules,
  result: BackendRouteResult,
  index = 0,
): RoutingCandidateGrade {
  const validation = validateRoutingCopper(result.copper, board)
  if (!validation.ok) {
    const unusable = Number.MAX_SAFE_INTEGER
    return {
      structurallyUsable: false,
      structuralDiagnostics: validation.diagnostics,
      criticalRegressionCount: unusable,
      priorityOpenPenalty: unusable,
      openNetCount: unusable,
      connectivityComponentCount: unusable,
      differentialViolationCount: unusable,
      matchedViolationCount: unusable,
      impedanceViolationCount: unusable,
      drcViolationCount: unusable,
      errorCount: unusable,
      forbiddenViaCount: unusable,
      shortAvoidViaPenalty: unusable,
      avoidViaPenalty: unusable,
      viaCount: unusable,
      trackLengthMm: unusable,
      score: [1, ...Array(14).fill(unusable), index],
    }
  }
  const diagnostics = result.diagnostics ?? []
  const details = detailRecords(result.metrics?.details)
  const open = openNets(result)
  const openNetCount = effectiveOpenCount(result, open)
  const connectivityComponentCount = effectiveConnectivityComponentCount(result)
  const routePlan = resolveRoutePlan(board, program, rules)
  const preferences = new Map(routePlan.netPolicies.map((item) => [item.net, item]))
  const terminalSpans = netTerminalSpansMm(board)

  let priorityOpenPenalty = 0
  for (const net of open) {
    const policy = preferences.get(net)
    priorityOpenPenalty += policy?.priorityWeight ?? 4
    // Critical opens are a priority/completion penalty, not evidence that
    // previously good copper regressed.
  }
  const unnamedOpen = Math.max(0, openNetCount - open.size)
  if (openNetCount === Number.MAX_SAFE_INTEGER || !Number.isFinite(unnamedOpen)) {
    priorityOpenPenalty = Number.MAX_SAFE_INTEGER
  } else {
    priorityOpenPenalty = Math.min(Number.MAX_SAFE_INTEGER, priorityOpenPenalty + unnamedOpen * 4)
  }

  const { byNet: lengths, total: trackLengthMm } = trackLengths(result.copper)
  const fixedLengths = trackLengths(board.copper.fixed).byNet
  const electricalLength = (net: string) => {
    const editable = lengths.get(net)
    const fixed = fixedLengths.get(net)
    return editable === undefined && fixed === undefined ? undefined : (editable ?? 0) + (fixed ?? 0)
  }
  const viaCounts = new Map<string, number>()
  for (const via of result.copper.vias) viaCounts.set(via.net, (viaCounts.get(via.net) ?? 0) + 1)

  let forbiddenViaCount = 0
  let shortAvoidViaPenalty = 0
  let avoidViaPenalty = 0
  for (const [net, preference] of preferences) {
    const vias = viaCounts.get(net) ?? 0
    if (!vias) continue
    const penalty = preference.priorityWeight * preference.viaPenalty
    if (preference.viaPreference === "forbid") forbiddenViaCount += vias
    if (preference.viaPreference === "avoid" || preference.viaPreference === "forbid") {
      avoidViaPenalty += vias * penalty
      const terminalSpan = terminalSpans.get(net)
      if (terminalSpan !== undefined && terminalSpan <= SHORT_AVOID_VIA_NET_LENGTH_MM) {
        shortAvoidViaPenalty += vias * penalty
      }
    }
  }

  let differentialViolationCount = program.differentialPairs.filter((pair) => (
    open.has(pair.positive) || open.has(pair.negative)
  )).length
  for (const pair of program.differentialPairs) {
    if (open.has(pair.positive) || open.has(pair.negative)) continue
    const positiveLength = electricalLength(pair.positive)
    const negativeLength = electricalLength(pair.negative)
    const maxSkew = pair.maxSkewMm
      ?? ruleFor(rules, pair.positive).differential?.maxSkewMm
      ?? ruleFor(rules, pair.negative).differential?.maxSkewMm
    if (maxSkew !== undefined && positiveLength !== undefined && negativeLength !== undefined
      && Math.abs(positiveLength - negativeLength) > maxSkew + 1e-9) differentialViolationCount += 1
  }
  const reportedDifferential = detailCount(details, [
    "failed_diff_pairs", "partial_diff_pairs", "single_ended_diff_pairs", "polarity_swapped_pairs",
  ]) + badPairReportCount(details)
  differentialViolationCount = Math.max(
    differentialViolationCount,
    reportedDifferential,
    diagnosticsMatching(diagnostics, DIFFERENTIAL_DIAGNOSTICS),
  )

  let matchedViolationCount = program.matchedGroups.filter((group) => group.nets.some((net) => open.has(net))).length
  for (const group of program.matchedGroups) {
    if (group.nets.some((net) => open.has(net))) continue
    const tolerance = group.toleranceMm
      ?? rules.matchedGroups?.find((item) => item.id === group.id)?.toleranceMm
    const groupLengths = group.nets.map(electricalLength)
    if (tolerance !== undefined && groupLengths.every((length): length is number => length !== undefined)
      && Math.max(...groupLengths) - Math.min(...groupLengths) > tolerance + 1e-9) matchedViolationCount += 1
  }
  matchedViolationCount = Math.max(
    matchedViolationCount,
    detailCount(details, ["matched_group_violations", "length_match_violations", "unmatched_groups"]),
    diagnosticsMatching(diagnostics, MATCHED_DIAGNOSTICS),
  )

  const impedanceNets = rules.nets
    .filter((item) => item.values.impedanceOhm !== undefined)
    .map((item) => item.net)
  const reportedImpedanceFailures = details.filter((item) => (
    typeof item.targetOhm === "number" && item.verified === false
  )).length
  const impedanceViolationCount = Math.max(
    impedanceNets.filter((net) => open.has(net)).length,
    reportedImpedanceFailures,
    diagnosticsMatching(diagnostics, IMPEDANCE_DIAGNOSTICS),
  )

  const criticalRegressionCount = diagnosticsMatching(diagnostics, CRITICAL_DIAGNOSTICS)
    + detailCount(details, [
      "criticalRegressions", "critical_regressions", "protectedCasualties", "protected_casualties",
      "coverage_gate_nets",
    ])
    + unrecoveredRipCount(details)
  const drcViolationCount = Math.max(
    drcDiagnosticCount(diagnostics),
    detailCount(details, [
      "addedDrcViolations", "added_drc_violations", "drcViolationCount", "drc_violation_count",
    ]),
  )
  // Transport status is deliberately not a quality penalty. If copper is
  // parseable, the semantic diagnostics and audits decide whether it wins.
  const connectivityPartialIsAudited = openNetCount > 0 && openNetCount < Number.MAX_SAFE_INTEGER
  const connectivityIsAudited = openNetCount < Number.MAX_SAFE_INTEGER
    && connectivityComponentCount < Number.MAX_SAFE_INTEGER
  const errorCount = diagnostics.filter((item) => (
    item.severity === "error"
    && !(connectivityPartialIsAudited && CONNECTIVITY_PARTIAL_DIAGNOSTICS.has(item.code))
    && !(connectivityIsAudited && KRT_TRANSPORT_DIAGNOSTICS.has(item.code))
  )).length
  const viaCount = result.copper.vias.length
  const score = [
    validation.ok ? 0 : 1,
    criticalRegressionCount,
    priorityOpenPenalty,
    openNetCount,
    connectivityComponentCount,
    differentialViolationCount,
    matchedViolationCount,
    impedanceViolationCount,
    drcViolationCount,
    errorCount,
    forbiddenViaCount,
    shortAvoidViaPenalty,
    avoidViaPenalty,
    viaCount,
    trackLengthMm,
    index,
  ]
  return {
    structurallyUsable: validation.ok,
    structuralDiagnostics: validation.diagnostics,
    criticalRegressionCount,
    priorityOpenPenalty,
    openNetCount,
    connectivityComponentCount,
    differentialViolationCount,
    matchedViolationCount,
    impedanceViolationCount,
    drcViolationCount,
    errorCount,
    forbiddenViaCount,
    shortAvoidViaPenalty,
    avoidViaPenalty,
    viaCount,
    trackLengthMm,
    score,
  }
}

export function compareRoutingCandidateGrades(left: RoutingCandidateGrade, right: RoutingCandidateGrade) {
  for (let index = 0; index < left.score.length; index += 1) {
    if (left.score[index] !== right.score[index]) return left.score[index] - right.score[index]
  }
  return 0
}

/** Keep the previous champion unless a later candidate is strictly better. */
export function retainRoutingChampion(
  champion: RoutingCandidate | undefined,
  candidate: RoutingCandidate,
) {
  if (!candidate.grade.structurallyUsable) return champion
  if (!champion || compareRoutingCandidateGrades(candidate.grade, champion.grade) < 0) return candidate
  return champion
}
