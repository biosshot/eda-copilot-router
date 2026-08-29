import assert from "node:assert/strict"
import * as krt from "../package-dist/backends/krt.js"
import * as krtCodec from "../package-dist/backends/krt-codec.js"

const emptyCopper = { tracks: [], vias: [], zones: [] }
const rule = {
  preferredTrackWidthMm: 0.2,
  minTrackWidthMm: 0.127,
  clearanceMm: 0.2,
  edgeClearanceMm: 0.2,
  via: {
    preferredDiameterMm: 0.5,
    preferredDrillMm: 0.25,
    minDiameterMm: 0.45,
    minDrillMm: 0.2,
  },
}

assert.deepEqual(krt.KRT_NATIVE_AUTO_POLICY, {
  gridStep: 0.1,
  ordering: "mps",
  enableNetRescue: true,
  enableTerminalEscalation: true,
  ripPreexisting: true,
  dynamicIterations: true,
  planeFinalize: false,
  finalizeRip: true,
  specialMaxCandidates: 1,
})
assert.equal(krt.KRT_MAX_POST_MAIN_REPAIRS, 8)
assert.equal(krt.KRT_ORDINARY_MATCHED_MAX_CANDIDATES, 2)
assert.equal(krt.KRT_MATCHED_FINE_GRID_STEP_MM, 0.05)
assert.equal(krt.KRT_MATCHED_FINE_GRID_MAX_CELLS_PER_LAYER, 4_000_000)
assert.equal(krt.krtMatchedFallbackTolerance(8), 6)
assert.ok(Math.abs(krt.krtMatchedFallbackTolerance(0.2) - 0.15) < 1e-12)
assert.equal(krt.krtMatchedFallbackGridStep([
  { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 },
], 0.1), 0.05, "a bounded small-board matched retry may use the local fine grid")
assert.equal(krt.krtMatchedFallbackGridStep([
  { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 },
], 0.1), 0.1, "a huge board must keep the coarse grid above the cell cap")
const nativeRipupPortfolio = krt.buildKrtSpecialCandidatePortfolio({
  id: "configured",
  ordering: "mps",
  mpsReverseRounds: false,
}, 2)
assert.deepEqual(nativeRipupPortfolio.map(({ ordering }) => ordering), ["mps", "original"],
  "the measured configured ordering must remain the first candidate")
assert.ok(nativeRipupPortfolio.every((candidate) => candidate.maxRipup === undefined),
  "an ordering alternative must preserve KRT's native rip-up default")
const explicitZeroPortfolio = krt.buildKrtSpecialCandidatePortfolio({
  id: "configured-zero",
  ordering: "mps",
  mpsReverseRounds: false,
  maxRipup: 0,
}, 2)
assert.ok(explicitZeroPortfolio.every((candidate) => candidate.maxRipup === 0),
  "an explicitly configured zero rip-up limit must remain explicit")
assert.equal(krt.KRT_MAX_OPEN_REPAIR_BLOCKER_VICTIMS, 3)
assert.equal(krt.KRT_POST_MAIN_REPAIR_BUDGET_RATIO, 0.3)
assert.equal(krt.KRT_MIN_POST_MAIN_REPAIR_BUDGET_MS, 5_000)
assert.equal(krt.KRT_MAX_ORDINARY_ROUTE_BATCHES, 32)
assert.equal(krt.KRT_ORDINARY_TRACK_WIDTH_BUCKET_MM, 0.05)
assert.equal(krt.KRT_CAPTURED_LOG_TAIL_CHARS, 512 * 1024)
assert.deepEqual(krt.krtBoundedLogTail("abcdef", 4), { text: "cdef", omitted: 2 })
assert.equal(krt.KRT_SHORT_VIA_REPAIR_MAX_LENGTH_MM, 10)
assert.equal(krt.KRT_SHORT_VIA_REPAIR_MAX_DETOUR_RATIO, 2)
assert.equal(krt.KRT_SHORT_VIA_REPAIR_LENGTH_SLACK_MM, 2)
assert.deepEqual(krt.KRT_VIA_PREFERENCE_COSTS, { avoid: 300, forbid: 1_000_000 })
assert.equal(krt.krtLiteralGlobPattern("DATA[0]"), "DATA[[]0]")
assert.equal(krt.krtLiteralGlobPattern("CLK*?"), "CLK[*][?]")
assert.equal(krt.krtLiteralGlobPattern("!RESET"), "!RESET")
assert.equal(krt.krtLiteralGlobPattern("--CLK"), "[-]-CLK")
assert.equal(krt.krtLiteralNetFilterPattern("!RESET[0]"), "\\!RESET[[]0]")
for (const code of ["KRT_PROCESS_START_FAILED", "KRT_TIMEOUT", "KRT_ABORTED", "KRT_NONZERO_EXIT", "KRT_SUMMARY_MISSING"]) {
  assert.equal(krt.krtTransportDiagnostic(code), true, `${code} is process state, not physical board damage`)
}
assert.equal(krt.krtTransportDiagnostic("KRT_SPECIAL_DRC_REGRESSION"), false)

const longExactNets = Array.from({ length: 1_000 }, (_, index) => (
  `LONG_EXACT_NET_${String(index).padStart(4, "0")}_${"X".repeat(64)}[${index}]`
))
const longRipNets = longExactNets.slice(0, 500)
const longDiffPairs = Array.from({ length: 500 }, (_, index) => ([
  longExactNets[index * 2],
  longExactNets[index * 2 + 1],
]))
const compactSelectors = krt.compactKrtExactSelectorArgs([
  "in.kicad_pcb", "out.kicad_pcb",
  "--nets", ...longExactNets.map(krt.krtLiteralNetFilterPattern),
  "--rip-existing-nets", ...longRipNets.map(krt.krtLiteralNetFilterPattern),
  "--force-reroute",
], {
  netSelection: longExactNets,
  ripSelection: longRipNets,
  ripAuthorization: longExactNets,
  diffPairs: longDiffPairs,
})
assert.deepEqual(
  compactSelectors.args.slice(compactSelectors.args.indexOf("--nets"), compactSelectors.args.indexOf("--nets") + 2),
  ["--nets", krt.KRT_EXACT_NET_SENTINEL],
)
assert.deepEqual(
  compactSelectors.args.slice(compactSelectors.args.indexOf("--rip-existing-nets"), compactSelectors.args.indexOf("--rip-existing-nets") + 2),
  ["--rip-existing-nets", krt.KRT_EXACT_RIP_SENTINEL],
)
assert.ok(JSON.stringify(compactSelectors.args).length < 512,
  "1,000 long exact names must live only in the selector sidecar, not process argv")
assert.deepEqual(compactSelectors.sidecar.netSelection, longExactNets)
assert.deepEqual(compactSelectors.sidecar.ripSelection, longRipNets)
assert.deepEqual(compactSelectors.sidecar.ripAuthorization, longExactNets)
assert.deepEqual(compactSelectors.sidecar.diffPairs, longDiffPairs)
assert.equal(compactSelectors.sidecar.selectorTokens.length, longExactNets.length)
assert.equal(new Set(compactSelectors.sidecar.selectorTokens.map(([token]) => token)).size, longExactNets.length)
assert.ok(compactSelectors.sidecar.selectorTokens.every(([token, name]) => token !== name))
const adversarialNames = ["--CLK", "DATA[0]", "DATA[[]0]"]
const adversarialSelectors = krt.compactKrtExactSelectorArgs([
  "in.kicad_pcb", "out.kicad_pcb",
  "--nets", ...adversarialNames.map(krt.krtLiteralNetFilterPattern),
  "--length-match-group", ...adversarialNames.map(krt.krtLiteralGlobPattern),
], {
  netSelection: adversarialNames,
})
assert.deepEqual(
  adversarialSelectors.args.slice(adversarialSelectors.args.indexOf("--nets"), adversarialSelectors.args.indexOf("--nets") + 2),
  ["--nets", krt.KRT_EXACT_NET_SENTINEL],
  "a legal net beginning with -- must remain selector data, not become an argparse option",
)
const adversarialGroupIndex = adversarialSelectors.args.indexOf("--length-match-group")
const adversarialGroupTokens = adversarialSelectors.args.slice(adversarialGroupIndex + 1)
assert.equal(adversarialGroupTokens.length, adversarialNames.length)
assert.equal(new Set(adversarialGroupTokens).size, adversarialNames.length,
  "raw and escaped-lookalike KiCad names must receive distinct opaque selector tokens")
assert.ok(adversarialGroupTokens.every((token) => token.startsWith("__COPILOT_ROUTER_EXACT_NAME_V1_")))
const reservedNameSelectors = krt.compactKrtExactSelectorArgs([
  "--nets", krt.krtLiteralNetFilterPattern(krt.KRT_EXACT_NET_SENTINEL),
  "--rip-existing-nets", krt.krtLiteralNetFilterPattern(krt.KRT_EXACT_RIP_SENTINEL),
], {
  netSelection: [krt.KRT_EXACT_NET_SENTINEL],
  ripSelection: [krt.KRT_EXACT_RIP_SENTINEL],
})
assert.notEqual(reservedNameSelectors.sidecar.netSentinel, krt.KRT_EXACT_NET_SENTINEL)
assert.notEqual(reservedNameSelectors.sidecar.ripSentinel, krt.KRT_EXACT_RIP_SENTINEL)
assert.ok(reservedNameSelectors.args.includes(reservedNameSelectors.sidecar.netSentinel))
assert.ok(reservedNameSelectors.args.includes(reservedNameSelectors.sidecar.ripSentinel))
const auditTransport = krt.buildKrtAuditScopeTransport(
  longExactNets,
  "audit-scope.json",
  "audit-result.json",
)
assert.equal(auditTransport.sidecar.expected.length, 1_000)
assert.equal(auditTransport.connectivityBootstrapArgs.length, 1)
assert.equal(auditTransport.drcBootstrapArgs.length, 1)
assert.deepEqual(auditTransport.drcNetArgs, ["--nets", krt.KRT_DRC_SCOPE_SENTINEL])
assert.ok(JSON.stringify([
  ...auditTransport.connectivityBootstrapArgs,
  ...auditTransport.drcBootstrapArgs,
  ...auditTransport.drcNetArgs,
]).length < 512, "audit argv must remain bounded independently of exact scope size")
assert.equal(krt.krtStageDrcGatePasses("strict", {
  drcNonRegressing: false, shortsNonRegressing: true, connectivityImproved: true,
}), false, "strict special/critical stages must reject any new DRC identity")
assert.equal(krt.krtStageDrcGatePasses("ordinary", {
  drcNonRegressing: false, shortsNonRegressing: true, connectivityImproved: true,
}), true, "useful ordinary partial copper may retain a new non-short clearance diagnostic")
assert.equal(krt.krtStageDrcGatePasses("ordinary", {
  drcNonRegressing: false, shortsNonRegressing: false, connectivityImproved: true,
}), false, "a new physical short is catastrophic even when connectivity improved")
assert.equal(krt.krtStageConnectivityGatePasses({
  connectivityNonRegressing: true,
  connectivityImproved: false,
  requireConnectivityImprovement: true,
}), false, "a monolithic fallback must not replace its checkpoint without strict connectivity improvement")
assert.equal(krt.krtStageConnectivityGatePasses({
  connectivityNonRegressing: true,
  connectivityImproved: true,
  requireConnectivityImprovement: true,
}), true, "a strictly improving monolithic fallback may proceed to the remaining safety gates")
assert.equal(krt.krtStageConnectivityGatePasses({
  connectivityNonRegressing: false,
  connectivityImproved: true,
  allowWeightedTradeoff: true,
  hardConnectivityNonRegressing: true,
  weightedConnectivityImproved: true,
  requireConnectivityImprovement: true,
}), true, "ordinary routing may trade unprotected nets when weighted connectivity strictly improves")
assert.equal(krt.krtStageConnectivityGatePasses({
  connectivityNonRegressing: false,
  connectivityImproved: true,
  allowWeightedTradeoff: true,
  hardConnectivityNonRegressing: false,
  weightedConnectivityImproved: true,
  requireConnectivityImprovement: true,
}), false, "a weighted trade must never open or fragment a critical/protected net")
assert.equal(krt.krtStageConnectivityGatePasses({
  connectivityNonRegressing: false,
  connectivityImproved: true,
  allowWeightedTradeoff: false,
  hardConnectivityNonRegressing: true,
  weightedConnectivityImproved: true,
}), false, "strict stages must retain monotonic full-board connectivity")

const connectivity = (components, fingerprints = []) => ({
  componentCountByNet: { N1: components },
  issueFingerprintsByNet: { N1: fingerprints },
})
assert.equal(krt.connectivityComponentsNonRegressing(connectivity(2), connectivity(5)), true)
assert.equal(krt.connectivityComponentsImproved(connectivity(2), connectivity(5)), true,
  "a multipoint net that improves from five components to two is useful while still open")
assert.equal(krt.connectivityComponentsNonRegressing(connectivity(5), connectivity(2)), false)
assert.equal(krt.connectivityComponentsNonRegressing(
  connectivity(2, ["different-pad-partition"]),
  connectivity(2, ["original-pad-partition"]),
), false, "same component count must not hide a disconnected-pad partition regression")

const stageAudit = (openNets) => ({
  openNets,
  componentCountByNet: Object.fromEntries(openNets.map((net) => [net, 2])),
  issueFingerprintsByNet: Object.fromEntries(openNets.map((net) => [net, [`open:${net}`]])),
})
const h743ClosedOrdinary = Array.from({ length: 73 }, (_, index) => `N${index + 1}`)
const h743RetainedOrdinary = Array.from({ length: 11 }, (_, index) => `R${index + 1}`)
const h743ReopenedHigh = ["GYRO1_SCK", "GYRO2_SCK", "VBAT_IN"]
const h743Policies = [
  ...h743ClosedOrdinary,
  ...h743RetainedOrdinary,
].map((net) => ({ net, priorityWeight: 4, protectOnSuccess: false })).concat(
  h743ReopenedHigh.map((net) => ({ net, priorityWeight: 16, protectOnSuccess: false })),
  [{ net: "CRITICAL", priorityWeight: 64, protectOnSuccess: true }],
)
const h743Tradeoff = krt.krtStageConnectivityTradeoff(
  stageAudit([...h743ClosedOrdinary, ...h743RetainedOrdinary]),
  stageAudit([...h743RetainedOrdinary, ...h743ReopenedHigh]),
  h743Policies,
  [],
)
assert.equal(h743Tradeoff.baselineOpenNetCount, 84)
assert.equal(h743Tradeoff.candidateOpenNetCount, 14)
assert.equal(h743Tradeoff.baselinePriorityOpenPenalty, 336)
assert.equal(h743Tradeoff.candidatePriorityOpenPenalty, 92)
assert.deepEqual(h743Tradeoff.newlyOpenedNets, h743ReopenedHigh)
assert.equal(h743Tradeoff.newlyClosedNets.length, 73)
assert.equal(h743Tradeoff.hardConnectivityNonRegressing, true)
assert.equal(h743Tradeoff.weightedConnectivityImproved, true,
  "the measured H743 84-to-14 fallback must survive three newly-open high nets")

const criticalRegressionTradeoff = krt.krtStageConnectivityTradeoff(
  stageAudit([...h743ClosedOrdinary, ...h743RetainedOrdinary]),
  stageAudit([...h743RetainedOrdinary, "CRITICAL"]),
  h743Policies,
  [],
)
assert.equal(criticalRegressionTradeoff.weightedConnectivityImproved, true)
assert.equal(criticalRegressionTradeoff.hardConnectivityNonRegressing, false,
  "even a large aggregate gain must not reopen a critical net")

const protectedRegressionTradeoff = krt.krtStageConnectivityTradeoff(
  stageAudit([...h743ClosedOrdinary, ...h743RetainedOrdinary]),
  stageAudit([...h743RetainedOrdinary, "GYRO1_SCK"]),
  h743Policies,
  ["GYRO1_SCK"],
)
assert.equal(protectedRegressionTradeoff.hardConnectivityNonRegressing, false,
  "the dynamic protected ledger must remain a hard gate independently of DSL priority")
assert.ok(krt.krtDrcViolationItem({ type: "clearance", accepted: false }))
assert.equal(krt.krtDrcViolationItem({ type: "clearance", accepted: true }), undefined)
assert.equal(krt.krtDrcViolationItem({ type: "clearance", accepted: "quantization-margin" }), undefined,
  "truthy KRT acceptance reasons must not become false DRC regressions")
const emptyDrcIndex = {
  ...krt.indexKrtDrcFingerprints([]),
  fingerprintsAvailable: true,
}
const oneBadCriticalMember = {
  ...krt.indexKrtDrcFingerprints([
    { type: "pad-track", net1: "CRIT_B", net2: "OTHER", loc1: [1, 2] },
    { type: "segment-board-edge", net1: "CRIT_B", accepted: "quantization-margin" },
  ]),
  fingerprintsAvailable: true,
}
assert.equal(krt.krtCriticalNetDrcNonRegressing("CRIT_A", emptyDrcIndex, oneBadCriticalMember), true,
  "a DRC regression on one critical batch member must not revoke a clean connected neighbor")
assert.equal(krt.krtCriticalNetDrcNonRegressing("CRIT_B", emptyDrcIndex, oneBadCriticalMember), false,
  "the critical member that owns a new DRC identity must remain editable and unprotected")
const sharedCriticalCollision = {
  ...krt.indexKrtDrcFingerprints([
    { type: "segment-segment", net1: "CRIT_A", net2: "CRIT_B", short: true, loc1: [2, 3] },
  ]),
  fingerprintsAvailable: true,
}
assert.equal(krt.krtCriticalNetDrcNonRegressing("CRIT_A", emptyDrcIndex, sharedCriticalCollision), false)
assert.equal(krt.krtCriticalNetDrcNonRegressing("CRIT_B", emptyDrcIndex, sharedCriticalCollision), false,
  "a collision between two critical members must be attributed to both")
const symmetricBaseline = {
  ...krt.indexKrtDrcFingerprints([{
    type: "segment-segment", net1: "CRIT_A", net2: "CRIT_B",
    loc1: [1, 2, 3, 4], loc2: [7, 8, 5, 6], short: true,
  }]),
  fingerprintsAvailable: true,
}
const symmetricRewrite = {
  ...krt.indexKrtDrcFingerprints([{
    type: "segment-segment", net1: "CRIT_B", net2: "CRIT_A",
    loc1: [5, 6, 7, 8], loc2: [3, 4, 1, 2], short: true,
  }]),
  fingerprintsAvailable: true,
}
assert.equal(krt.krtCriticalNetDrcNonRegressing("CRIT_A", symmetricBaseline, symmetricRewrite), true,
  "swapping symmetric DRC participants and segment direction must retain one physical identity")
const movedSymmetricCollision = {
  ...krt.indexKrtDrcFingerprints([{
    type: "segment-segment", net1: "CRIT_B", net2: "CRIT_A",
    loc1: [5, 6, 7, 8], loc2: [3, 4, 1.1, 2], short: true,
  }]),
  fingerprintsAvailable: true,
}
assert.equal(krt.krtCriticalNetDrcNonRegressing("CRIT_A", symmetricBaseline, movedSymmetricCollision), false,
  "a genuinely moved collision must remain a new DRC identity")
const globalCriticalRegression = {
  ...krt.indexKrtDrcFingerprints([{ type: "unknown-global-rule" }]),
  fingerprintsAvailable: true,
}
assert.equal(krt.krtCriticalNetDrcNonRegressing("CRIT_A", emptyDrcIndex, globalCriticalRegression), false,
  "unattributed native DRC evidence must conservatively gate every critical member")

const cleanDiffCustodyDrc = { ...emptyDrcIndex, failed: false }
const mixedPairSummary = {
  routed_diff_pairs: ["GOOD"],
  pair_reports: [
    {
      pair: "GOOD", p_net: "GOOD_P", n_net: "GOOD_N", outcome: "coupled",
      member_audit_mismatch: false, incomplete_members: [],
    },
    {
      pair: "FAILED", p_net: "FAILED_P", n_net: "FAILED_N", outcome: "failed",
      failure_reason: "no-path", incomplete_members: ["FAILED_P", "FAILED_N"],
    },
  ],
}
const mixedPairCustody = {
  pairs: [["GOOD_P", "GOOD_N"], ["FAILED_P", "FAILED_N"]],
  summary: mixedPairSummary,
  connectivity: { failed: false, openNets: ["FAILED_P", "FAILED_N"] },
  baselineDrc: cleanDiffCustodyDrc,
  candidateDrc: cleanDiffCustodyDrc,
}
assert.deepEqual(krt.krtVerifiedDiffPairNets(mixedPairCustody), ["GOOD_P", "GOOD_N"],
  "one failed compatible pair must not revoke independently coupled sibling copper")
assert.deepEqual(krt.krtVerifiedDiffPairNets({
  ...mixedPairCustody,
  matchedGroups: [["GOOD_P", "GOOD_N"]],
  matchedGroupAudits: [],
}), [], "a declared matched group without a verified audit must fail closed")
assert.deepEqual(krt.krtVerifiedDiffPairNets({
  ...mixedPairCustody,
  matchedGroups: [["GOOD_P", "GOOD_N"]],
  matchedGroupAudits: [{ nets: ["GOOD_N", "GOOD_P"], verified: false }],
}), [], "a coupled pair in a failed matched group must remain editable")
assert.deepEqual(krt.krtVerifiedDiffPairNets({
  ...mixedPairCustody,
  matchedGroups: [["GOOD_P", "GOOD_N"]],
  matchedGroupAudits: [{ nets: ["GOOD_N", "GOOD_P"], verified: true }],
}), ["GOOD_P", "GOOD_N"], "matched-group membership may protect a pair only after verified audit")
const goodPairDrcRegression = {
  ...krt.indexKrtDrcFingerprints([
    { type: "pad-track", net1: "GOOD_N", net2: "OTHER", loc1: [4, 5] },
  ]),
  fingerprintsAvailable: true,
  failed: false,
}
assert.deepEqual(krt.krtVerifiedDiffPairNets({
  ...mixedPairCustody,
  candidateDrc: goodPairDrcRegression,
}), [], "a per-net DRC regression must revoke only that differential pair's custody")

const routeDependentMatchedRetry = {
  aborted: false,
  attempted: true,
  preflightFailed: false,
  connectivityAuditFailed: false,
  drcAuditFailed: false,
  openNets: [],
  matchedGroupReasons: [["outside-tolerance"]],
}
assert.equal(krt.krtOrdinaryMatchedCandidateRetryable(routeDependentMatchedRetry), true,
  "an order-dependent length miss may use the second ordinary matched candidate")
assert.equal(krt.krtOrdinaryMatchedCandidateRetryable({
  ...routeDependentMatchedRetry,
  matchedGroupReasons: [["drc-regression"]],
}), true, "a physically different route may repair a candidate DRC regression")
for (const blockedRetry of [
  { ...routeDependentMatchedRetry, aborted: true },
  { ...routeDependentMatchedRetry, attempted: false },
  { ...routeDependentMatchedRetry, preflightFailed: true },
  { ...routeDependentMatchedRetry, connectivityAuditFailed: true },
  { ...routeDependentMatchedRetry, drcAuditFailed: true },
  { ...routeDependentMatchedRetry, matchedGroupReasons: [["measurement-failed", "outside-tolerance"]] },
  { ...routeDependentMatchedRetry, matchedGroupReasons: [["invalid-tolerance"]] },
]) assert.equal(krt.krtOrdinaryMatchedCandidateRetryable(blockedRetry), false,
  "infrastructure/configuration failures must not spend the second matched candidate")
for (const forbidden of [
  "maxIterations", "maxProbeIterations", "maxRipup", "heuristicWeight",
  "viaCost", "viaProximityCost", "turnCost", "directionPreferenceCost",
  "ripupBlockerSelect", "ripupAbandonMetric",
]) assert.ok(!(forbidden in krt.KRT_NATIVE_AUTO_POLICY), `${forbidden} must remain a native KRT default`)
assert.equal(krt.KRT_QUALITY_PROFILES, undefined)
assert.deepEqual(krt.buildKrtNativeRecoveryEnvironment({}), {
  KICAD_RIP_PREEXISTING: "1",
  KICAD_NET_RESCUE: "1",
  KICAD_TERMINAL_ESCALATION: "1",
  KICAD_DYNAMIC_ITERATIONS: "1",
  KICAD_PLANE_FINALIZE: "0",
  KICAD_FINALIZE_RIP: "1",
})

const baseRequest = {
  board: {
    outline: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
    cutouts: [],
    layers: [{ name: "TOP", index: 0, side: "top" }, { name: "BOTTOM", index: 31, side: "bottom" }],
    nets: [{ name: "N1" }],
    components: [{ designator: "U1", at: { x: 5, y: 5 }, rotationDeg: 0, side: "top" }],
    pads: [
      { component: "U1", number: "1", net: "N1", at: { x: 5, y: 5 }, rotationDeg: 0, layers: ["TOP"], shape: { kind: "rect", widthMm: 0.25, heightMm: 0.5 } },
      { component: "J1", number: "1", net: "N1", at: { x: 15, y: 5 }, rotationDeg: 0, layers: ["TOP"], shape: { kind: "circle", diameterMm: 1 } },
    ],
    keepouts: [],
    rules: { default: rule, nets: [] },
    copper: { fixed: emptyCopper, editable: emptyCopper },
  },
  rules: { default: rule, nets: [] },
  program: { fanouts: [], fanoutExclusions: [], ignoreNets: [] },
}

assert.deepEqual(krt.planKrtQfnFanout(baseRequest, ["N1"], 0.1), [],
  "physical QFN-like geometry must not activate fanout")
const explicit = krt.planKrtQfnFanout({
  ...baseRequest,
  program: {
    ...baseRequest.program,
    fanouts: [{ target: { kind: "component", component: "U1" }, method: "stub", extensionMm: 0.1 }],
  },
}, ["N1"], 0.1)
assert.equal(explicit.length, 1)
assert.equal(explicit[0].component, "U1")
assert.equal(explicit[0].layer, "F.Cu", "KRT boundary must translate canonical TOP to F.Cu")

assert.equal(krt.selectKrtGridStep(baseRequest, 0.1, ["N1"]), 0.1,
  "fine-pitch geometry must stay on the full-board grid and rely on local rescue")

const conflictingSpecialRequest = {
  ...baseRequest,
  board: {
    ...baseRequest.board,
    nets: [{ name: "DP_P" }, { name: "DP_N" }],
    rules: {
      default: rule,
      nets: [
        { net: "DP_P", values: { ...rule, preferredTrackWidthMm: 0.18 } },
        { net: "DP_N", values: { ...rule, preferredTrackWidthMm: 0.28 } },
      ],
    },
  },
  rules: {
    default: rule,
    nets: [
      { net: "DP_P", values: { ...rule, preferredTrackWidthMm: 0.18 } },
      { net: "DP_N", values: { ...rule, preferredTrackWidthMm: 0.28 } },
    ],
  },
  program: {
    ...baseRequest.program,
    differentialPairs: [{ kind: "differential-pair", id: "DP", positive: "DP_P", negative: "DP_N" }],
    matchedGroups: [],
  },
  plan: {
    netPolicies: [
      { net: "DP_P", priorityWeight: 32, viaPreference: "avoid" },
      { net: "DP_N", priorityWeight: 32, viaPreference: "avoid" },
    ],
  },
}
const conflictingSpecialPlan = krt.planKrtSpecialBatches(
  conflictingSpecialRequest,
  ["DP_P", "DP_N"],
  0.1,
)
assert.equal(conflictingSpecialPlan.batches.length, 0,
  "an unrepresentable special group must not be sent with flattened rules")
assert.ok(conflictingSpecialPlan.diagnostics.some((item) => (
  item.code === "KRT_SPECIAL_GROUP_DEFERRED" && item.severity === "warning"
)), "an incompatible special group must be deferred locally instead of aborting full-board routing")
assert.ok(conflictingSpecialPlan.diagnostics.every((item) => item.severity !== "error"),
  "deferred special incompatibility must preserve partial-result execution")

const prioritySpecialNets = ["DP_P", "DP_N", "CRIT_A", "CRIT_B", "HDR_A", "HDR_B"]
const prioritySpecialRequest = {
  ...baseRequest,
  board: {
    ...baseRequest.board,
    nets: prioritySpecialNets.map((name) => ({ name })),
    rules: {
      default: rule,
      nets: prioritySpecialNets.map((net) => ({ net, values: rule })),
      matchedGroups: [
        { id: "CRIT_MATCH", nets: ["CRIT_A", "CRIT_B"], toleranceMm: 0.2 },
        { id: "HEADER", nets: ["HDR_A", "HDR_B"], toleranceMm: 0.2 },
      ],
    },
  },
  rules: {
    default: rule,
    nets: prioritySpecialNets.map((net) => ({ net, values: rule })),
    matchedGroups: [
      { id: "CRIT_MATCH", nets: ["CRIT_A", "CRIT_B"], toleranceMm: 0.2 },
      { id: "HEADER", nets: ["HDR_A", "HDR_B"], toleranceMm: 0.2 },
    ],
  },
  program: {
    ...baseRequest.program,
    differentialPairs: [{ kind: "differential-pair", id: "DP", positive: "DP_P", negative: "DP_N" }],
    matchedGroups: [
      { kind: "matched-group", id: "CRIT_MATCH", nets: ["CRIT_A", "CRIT_B"], toleranceMm: 0.2 },
      { kind: "matched-group", id: "HEADER", nets: ["HDR_A", "HDR_B"], toleranceMm: 0.2 },
    ],
  },
  plan: {
    netPolicies: prioritySpecialNets.map((net) => ({
      net,
      priorityWeight: net.startsWith("CRIT_") ? 64 : 4,
      viaPreference: "auto",
    })),
  },
}
const prioritySpecialPlan = krt.planKrtSpecialBatches(
  prioritySpecialRequest,
  prioritySpecialNets,
  0.1,
)
assert.equal(prioritySpecialPlan.batches.length, 3,
  "different priority/differential custody classes must not collapse into one special process")
const diffSpecial = prioritySpecialPlan.batches.find((batch) => batch.nets.includes("DP_P"))
const criticalSpecial = prioritySpecialPlan.batches.find((batch) => batch.nets.includes("CRIT_A"))
const normalHeader = prioritySpecialPlan.batches.find((batch) => batch.nets.includes("HDR_A"))
assert.equal(diffSpecial.containsDifferential, true)
assert.equal(krt.krtSpecialBatchRunsBeforeCritical(diffSpecial), true,
  "differential routing must preserve its special-before-ordinary custody boundary")
assert.equal(criticalSpecial.priorityWeight, 64)
assert.equal(krt.krtSpecialBatchRunsBeforeCritical(criticalSpecial), true)
assert.equal(krt.krtSpecialBatchRunsBeforeCritical(normalHeader), false,
  "normal matched headers must wait until critical ordinary nets have routed")

const rejectedSpecialDisposition = krt.krtSpecialBatchRecoveryDisposition(
  ["HDR_A", "HDR_B"],
  false,
  // A rejected artifact may report locally verified nets, but none of its
  // copper reached the promoted board and therefore none earns custody.
  ["HDR_A"],
)
assert.deepEqual(rejectedSpecialDisposition, {
  verifiedNets: [],
  ordinaryFallbackNets: ["HDR_A", "HDR_B"],
}, "a rejected planned-special batch must return every net to ordinary routing")
const partialSpecialDisposition = krt.krtSpecialBatchRecoveryDisposition(
  ["HDR_A", "HDR_B"],
  true,
  ["HDR_A"],
)
assert.deepEqual(partialSpecialDisposition, {
  verifiedNets: ["HDR_A"],
  ordinaryFallbackNets: ["HDR_B"],
}, "a safely promoted but semantically unverified special net must remain editable")
assert.deepEqual(krt.krtOrdinaryRecoveryScope(
  ["HDR_A", "HDR_B"],
  partialSpecialDisposition.verifiedNets,
), ["HDR_B"], "an unverified special net that is open later must enter ordinary recovery")

const monolithicSoftPolicyRequest = {
  ...prioritySpecialRequest,
  plan: {
    netPolicies: prioritySpecialRequest.plan.netPolicies.map((policy) => ({
      ...policy,
      viaPreference: policy.net === "HDR_A" ? "avoid" : "auto",
    })),
  },
}
assert.deepEqual(
  krt.krtMonolithicFallbackBatch(monolithicSoftPolicyRequest, ["HDR_A", "HDR_B"])?.nets,
  ["HDR_A", "HDR_B"],
  "the bounded completion fallback may combine compatible nets across soft via preferences",
)
const hardSplitRules = prioritySpecialRequest.rules.nets.map((item) => ({
  ...item,
  values: item.net === "HDR_A"
    ? { ...item.values, allowedLayers: ["TOP"] }
    : item.net === "HDR_B"
      ? { ...item.values, allowedLayers: ["BOTTOM"] }
      : item.values,
}))
const monolithicHardSplitRequest = {
  ...monolithicSoftPolicyRequest,
  board: {
    ...monolithicSoftPolicyRequest.board,
    rules: { ...monolithicSoftPolicyRequest.board.rules, nets: hardSplitRules },
  },
  rules: { ...monolithicSoftPolicyRequest.rules, nets: hardSplitRules },
}
assert.equal(
  krt.krtMonolithicFallbackBatch(monolithicHardSplitRequest, ["HDR_A", "HDR_B"]),
  undefined,
  "the monolithic fallback must fail closed across incompatible hard layer policies",
)

const fallbackSignalRule = { ...rule, preferredTrackWidthMm: 0.18 }
const fallbackPowerRule = { ...rule, preferredTrackWidthMm: 0.4 }
const originalOrderRequest = {
  ...baseRequest,
  board: {
    ...baseRequest.board,
    // The portable board order is canonical/lexicographic and intentionally
    // puts power before the later ordinary signal.
    nets: ["$BOOT", "+1V1", "GND", "SIG", "IGNORED"].map((name) => ({ name })),
  },
  rules: {
    default: rule,
    nets: [
      { net: "GND", values: rule },
      { net: "$BOOT", values: fallbackSignalRule },
      { net: "+1V1", values: fallbackPowerRule },
      { net: "SIG", values: fallbackSignalRule },
      { net: "IGNORED", values: fallbackSignalRule },
    ],
  },
  program: { ...baseRequest.program, ignoreNets: ["IGNORED"] },
}
const originalOrderSelectors = krt.krtMonolithicFallbackSelectors(originalOrderRequest)
assert.deepEqual(originalOrderSelectors, ["$BOOT", "SIG", "+1V1"],
  "original-order fallback selectors must preserve project/netclass grouping and filtering")
assert.deepEqual(krt.compactKrtExactSelectorArgs([
  "in.kicad_pcb", "out.kicad_pcb",
  "--nets", ...originalOrderSelectors.map(krt.krtLiteralNetFilterPattern),
], { netSelection: originalOrderSelectors }).sidecar.netSelection, originalOrderSelectors,
"the exact-selector sidecar must retain the proven project order end to end")

const partiallyRoutableSpecial = krt.planKrtSpecialBatches(
  prioritySpecialRequest,
  ["HDR_A"],
  0.1,
)
assert.equal(partiallyRoutableSpecial.batches.length, 0)
assert.ok(partiallyRoutableSpecial.diagnostics.some((item) => (
  item.code === "KRT_SPECIAL_GROUP_DEFERRED"
  && item.details?.id === "HEADER"
  && item.details?.routableNets?.includes("HDR_A")
)), "a partially routable atomic group must be explicitly deferred, never silently filtered")

const blockerPolicies = [
  { net: "XIN", priorityWeight: 64 },
  { net: "HEADER", priorityWeight: 4 },
  { net: "LOW_A", priorityWeight: 1 },
  { net: "LOW_B", priorityWeight: 1 },
  { net: "DP_P", priorityWeight: 4 },
  { net: "PEER", priorityWeight: 64 },
]
const blockerVictims = krt.krtOpenRepairBlockerVictims([{
  blockers: [{
    net: "XIN",
    blocked_by: [
      { net: "HEADER", preexisting: true },
      { net: "LOW_A", preexisting: true },
      { net: "LOW_B", preexisting: true },
      { net: "DP_P", preexisting: true },
      { net: "PEER", preexisting: true },
    ],
  }],
}], ["XIN"], blockerPolicies, {
  excludedNets: ["DP_P"],
  copperNets: ["HEADER", "LOW_A", "LOW_B", "DP_P", "PEER"],
})
assert.equal(blockerVictims.length, krt.KRT_MAX_OPEN_REPAIR_BLOCKER_VICTIMS)
assert.ok(blockerVictims.includes("HEADER"))
assert.ok(!blockerVictims.includes("DP_P"), "ordinary repair must not dissolve special custody")
assert.ok(!blockerVictims.includes("PEER"), "repair may grant authority only over lower-priority blockers")
assert.ok(krt.compareKrtRepairOrder(
  { kind: "open", priorityWeight: 1, clearanceMm: 0.2, firstNet: "OPEN" },
  { kind: "short-via", priorityWeight: 64, clearanceMm: 0.2, firstNet: "COSMETIC" },
) < 0, "an open repair must consume budget before even a critical cosmetic via repair")
assert.equal(krt.krtNativeAutoResultStatus({
  constraintsDeferred: false,
  processFailed: false,
  diagnosticsHaveErrors: false,
  openNetCount: 1,
  connectivityAudited: true,
}), "partial", "a direct KRT backend result with an audited open net must never claim complete")
assert.equal(krt.krtNativeAutoResultStatus({
  constraintsDeferred: false,
  processFailed: false,
  diagnosticsHaveErrors: false,
  openNetCount: 0,
  connectivityAudited: false,
}), "partial", "missing final connectivity evidence must keep the direct backend result partial")
assert.equal(krt.krtNativeAutoResultStatus({
  constraintsDeferred: false,
  processFailed: false,
  diagnosticsHaveErrors: false,
  openNetCount: 0,
  connectivityAudited: true,
}), "complete")

const manyNets = Array.from({ length: 1_000 }, (_, index) => `N${index}`)
const manyRules = manyNets.map((net, index) => ({
  net,
  values: {
    ...rule,
    clearanceMm: 0.2 + index * 0.0001,
    via: {
      ...rule.via,
      preferredDiameterMm: 0.5 + index * 0.00001,
      preferredDrillMm: 0.25 + index * 0.000005,
    },
  },
}))
const scalableRequest = {
  ...baseRequest,
  board: {
    ...baseRequest.board,
    nets: manyNets.map((name) => ({ name })),
    rules: { default: rule, nets: manyRules },
  },
  rules: { default: rule, nets: manyRules },
  plan: {
    netPolicies: manyNets.map((net) => ({ net, priorityWeight: 4, viaPreference: "auto" })),
  },
}
const scalableBatches = krt.planKrtOrdinaryBatches(scalableRequest, manyNets, true)
assert.ok(scalableBatches.length <= 3,
  `1,000 close rule variants must coalesce into bounded conservative buckets, got ${scalableBatches.length}`)
const assertExactBatchNets = (batches, expectedNets, message) => {
  const actual = batches.flatMap((batch) => batch.nets)
  assert.equal(actual.length, expectedNets.length, `${message}: net count`)
  assert.equal(new Set(actual).size, actual.length, `${message}: duplicate net`)
  assert.deepEqual([...actual].sort(), [...expectedNets].sort(), `${message}: exact net set`)
}
assertExactBatchNets(scalableBatches, manyNets,
  "1,000 coalesced rule variants must appear exactly once")

const widthBucketNets = ["W_A", "W_B", "W_C"]
const widthBucketRules = [0.201, 0.22, 0.26].map((minTrackWidthMm, index) => ({
  net: widthBucketNets[index],
  values: { ...rule, minTrackWidthMm },
}))
const widthBucketRequest = {
  ...baseRequest,
  board: {
    ...baseRequest.board,
    nets: widthBucketNets.map((name) => ({ name })),
    rules: { default: rule, nets: widthBucketRules },
  },
  rules: { default: rule, nets: widthBucketRules },
  plan: {
    netPolicies: widthBucketNets.map((net) => ({ net, priorityWeight: 4, viaPreference: "auto" })),
  },
}
const widthBatches = krt.planKrtOrdinaryBatches(widthBucketRequest, widthBucketNets, true)
assert.equal(widthBatches.length, 2,
  "different hard neck-down buckets must not share one permissive native process")
const sharedWidthBatch = widthBatches.find((batch) => batch.nets.includes("W_A"))
assert.deepEqual([...sharedWidthBatch.nets].sort(), ["W_A", "W_B"])
assert.equal(sharedWidthBatch.hardTrackWidthMm, 0.22,
  "a shared width bucket must use its strictest compiled neck-down floor")

const adversarialLayers = Array.from({ length: 10 }, (_, index) => ({
  name: index === 0 ? "TOP" : index === 9 ? "BOTTOM" : `INNER_${index}`,
  index,
  side: index === 0 ? "top" : index === 9 ? "bottom" : "inner",
}))
const adversarialNets = Array.from({ length: 1_000 }, (_, index) => `ADV${index}`)
const adversarialRules = adversarialNets.map((net, index) => ({
  net,
  values: {
    ...rule,
    allowedLayers: adversarialLayers
      .filter((_layer, bit) => ((index + 1) & (1 << bit)) !== 0)
      .map((layer) => layer.name),
    clearanceMm: 0.05 + (index % 20) * 0.05,
  },
}))
const adversarialRequest = {
  ...baseRequest,
  board: {
    ...baseRequest.board,
    layers: adversarialLayers,
    nets: adversarialNets.map((name) => ({ name })),
    rules: { default: rule, nets: adversarialRules },
  },
  rules: { default: rule, nets: adversarialRules },
  plan: {
    netPolicies: adversarialNets.map((net, index) => ({
      net,
      priorityWeight: index < 8 ? 64 : 4,
      viaPreference: "auto",
    })),
  },
}
const adversarialBatches = krt.planKrtOrdinaryBatches(adversarialRequest, adversarialNets, true)
assert.ok(adversarialBatches.length > krt.KRT_MAX_ORDINARY_ROUTE_BATCHES,
  "fixture must exercise more compatibility classes than the execution cap")
assertExactBatchNets(adversarialBatches, adversarialNets,
  "adversarial compatibility partition must preserve every net exactly once")
for (let index = 1; index < adversarialBatches.length; index += 1) {
  assert.ok(adversarialBatches[index - 1].priorityWeight >= adversarialBatches[index].priorityWeight,
    "ordinary compatibility batches must be ordered by descending priority")
}

const priorityNets = adversarialNets.slice(0, 8)
const ordinaryNets = adversarialNets.slice(8)
const priorityBatches = krt.planKrtOrdinaryBatches(adversarialRequest, priorityNets, true)
const ordinaryBatches = krt.planKrtOrdinaryBatches(adversarialRequest, ordinaryNets, true)
const scheduledPriority = krt.limitKrtOrdinaryBatches(priorityBatches)
assert.equal(scheduledPriority.length, priorityBatches.length,
  "bounded scheduling must consume every small priority phase before main routing")
assertExactBatchNets(scheduledPriority, priorityNets,
  "priority phase must schedule every priority net exactly once")
const scheduledOrdinary = krt.limitKrtOrdinaryBatches(ordinaryBatches, scheduledPriority.length)
const scheduledBatches = [...scheduledPriority, ...scheduledOrdinary]
assert.equal(scheduledBatches.length, krt.KRT_MAX_ORDINARY_ROUTE_BATCHES,
  "priority and main phases must share one global process cap")
const deferredOrdinary = ordinaryBatches.slice(scheduledOrdinary.length)
assert.ok(deferredOrdinary.length > 0, "fixture must leave explicit deferred main batches")
const scheduledNets = scheduledBatches.flatMap((batch) => batch.nets)
const deferredNets = deferredOrdinary.flatMap((batch) => batch.nets)
assert.equal(new Set(scheduledNets).size, scheduledNets.length,
  "scheduled phases must not route a net twice")
assert.equal(new Set(deferredNets).size, deferredNets.length,
  "deferred batches must not duplicate nets")
const scheduledNetSet = new Set(scheduledNets)
assert.ok(deferredNets.every((net) => !scheduledNetSet.has(net)),
  "deferred nets must remain outside the bounded native process selection")
assert.deepEqual([...scheduledNets, ...deferredNets].sort(), [...adversarialNets].sort(),
  "scheduled plus deferred nets must remain an exact full-board partition for final audit")
assert.equal(krt.limitKrtOrdinaryBatches(adversarialBatches, krt.KRT_MAX_ORDINARY_ROUTE_BATCHES).length, 0)

const annularRequest = {
  ...baseRequest,
  plan: {
    netPolicies: [{ net: "N1", priorityWeight: 4, viaPreference: "auto" }],
  },
  board: {
    ...baseRequest.board,
    rules: {
      default: {
        ...rule,
        via: {
          preferredDiameterMm: 0.65,
          preferredDrillMm: 0.5,
          minDiameterMm: 0.6,
          minDrillMm: 0.3,
        },
      },
      nets: [],
    },
  },
  rules: {
    default: {
      ...rule,
      via: {
        preferredDiameterMm: 0.65,
        preferredDrillMm: 0.5,
        minDiameterMm: 0.6,
        minDrillMm: 0.3,
      },
    },
    nets: [],
  },
}
const [annularBatch] = krt.planKrtOrdinaryBatches(annularRequest, ["N1"], true)
assert.ok((annularBatch.viaSizeMm - annularBatch.viaDrillMm) / 2 >= 0.15 - 1e-9,
  "nominal CLI via geometry must preserve the hard annular floor")
const badAnnularDiagnostics = krt.krtRoutedCopperRuleDiagnostics(annularRequest, {
  tracks: [],
  vias: [{
    net: "N1",
    at: { x: 10, y: 10 },
    diameterMm: 0.65,
    drillMm: 0.5,
    fromLayer: "TOP",
    toLayer: "BOTTOM",
    type: "through",
  }],
  zones: [],
})
const badAnnular = badAnnularDiagnostics.find((item) => item.code === "KRT_VIA_BELOW_HARD_MINIMUM")
assert.ok(badAnnular,
  "routed copper with legal diameter/drill but an undersized annular ring must fail the safety gate")
assert.ok(Math.abs(badAnnular.details.samples[0].actualAnnularMm - 0.075) < 1e-12)
assert.equal(badAnnular.details.samples[0].minimumAnnularMm, 0.15)
const validAnnularDiagnostics = krt.krtRoutedCopperRuleDiagnostics(annularRequest, {
  tracks: [],
  vias: [{
    net: "N1",
    at: { x: 10, y: 10 },
    diameterMm: 0.8,
    drillMm: 0.5,
    fromLayer: "TOP",
    toLayer: "BOTTOM",
    type: "through",
  }],
  zones: [],
})
assert.ok(!validAnnularDiagnostics.some((item) => item.code === "KRT_VIA_BELOW_HARD_MINIMUM"),
  "a routed via exactly meeting the hard annular floor must pass")

const inheritedInvalidTrack = {
  net: "N1", layer: "TOP", widthMm: 0.1,
  points: [{ x: 5, y: 5 }, { x: 7, y: 5 }],
}
const validNewTrack = {
  net: "N1", layer: "TOP", widthMm: 0.2,
  points: [{ x: 7, y: 5 }, { x: 9, y: 5 }],
}
const inheritedDelta = krtCodec.subtractKrtCopper(
  { tracks: [inheritedInvalidTrack], vias: [], zones: [] },
  { tracks: [inheritedInvalidTrack, validNewTrack], vias: [], zones: [] },
)
assert.equal(krt.krtRoutedCopperRuleDiagnostics(baseRequest, inheritedDelta).length, 0,
  "an unchanged inherited hard-rule violation must not deadlock a useful stage checkpoint")
const changedInvalidDelta = krtCodec.subtractKrtCopper(
  { tracks: [inheritedInvalidTrack], vias: [], zones: [] },
  { tracks: [{ ...inheritedInvalidTrack, widthMm: 0.09 }], vias: [], zones: [] },
)
assert.ok(krt.krtRoutedCopperRuleDiagnostics(baseRequest, changedInvalidDelta)
  .some((item) => item.code === "KRT_TRACK_WIDTH_BELOW_HARD_MINIMUM"),
"new or changed invalid geometry must remain a hard stage gate")

const args = krt.buildKrtRemainingArgs("in.kicad_pcb", "out.kicad_pcb", {
  pythonPath: "python",
  krtDirectory: ".",
  layers: ["F.Cu", "B.Cu"],
  rules: { trackWidth: 0.2, hardTrackWidth: 0.127, clearance: 0.2, viaSize: 0.5, viaDrill: 0.25, gridStep: 0.1 },
  fabOverridesPath: "fab.txt",
  diffPairs: [],
  matchedGroups: [],
  remainingNets: ["N1"],
}, ["N1"])
for (const flag of [
  "--max-iterations", "--max-probe-iterations", "--max-ripup", "--heuristic-weight",
  "--via-cost", "--via-proximity-cost", "--turn-cost", "--direction-preference-cost",
  "--ripup-blocker-select", "--ripup-abandon-metric",
]) assert.ok(!args.includes(flag), `${flag} must be owned by native KRT defaults`)

const avoidArgs = krt.buildKrtRemainingArgs("in.kicad_pcb", "out.kicad_pcb", {
  pythonPath: "python",
  krtDirectory: ".",
  layers: ["F.Cu", "B.Cu"],
  rules: { trackWidth: 0.2, hardTrackWidth: 0.127, clearance: 0.2, viaSize: 0.5, viaDrill: 0.25, gridStep: 0.1 },
  fabOverridesPath: "fab.txt",
  diffPairs: [],
  matchedGroups: [],
  remainingNets: ["N1"],
  viaCost: krt.KRT_VIA_PREFERENCE_COSTS.avoid,
  forceReroute: true,
}, ["N1"])
assert.deepEqual(
  avoidArgs.slice(avoidArgs.indexOf("--via-cost"), avoidArgs.indexOf("--via-cost") + 2),
  ["--via-cost", "300"],
  "viaPreference=avoid must affect only its isolated semantic batch",
)
assert.ok(avoidArgs.includes("--force-reroute"), "connected short-net repair must use native force reroute")
assert.ok(!args.includes("--force-reroute"), "ordinary routing must not force already-connected nets")

const literalSelectorArgs = krt.buildKrtRemainingArgs("in.kicad_pcb", "out.kicad_pcb", {
  pythonPath: "python",
  krtDirectory: ".",
  layers: ["F.Cu", "B.Cu"],
  rules: { trackWidth: 0.2, hardTrackWidth: 0.127, clearance: 0.2, viaSize: 0.5, viaDrill: 0.25, gridStep: 0.1 },
  fabOverridesPath: "fab.txt",
  diffPairs: [],
  matchedGroups: [],
  remainingNets: ["DATA[0]"],
  ripExistingNets: ["BLOCK[1]"],
  powerNets: [{ net: "PWR*", width: 0.4 }],
}, ["DATA[0]"])
assert.equal(literalSelectorArgs[literalSelectorArgs.indexOf("--nets") + 1], "DATA[[]0]")
assert.equal(literalSelectorArgs[literalSelectorArgs.indexOf("--rip-existing-nets") + 1], "BLOCK[[]1]")
assert.equal(literalSelectorArgs[literalSelectorArgs.indexOf("--power-nets") + 1], "PWR[*]")
assert.equal(literalSelectorArgs[literalSelectorArgs.indexOf("--power-nets-widths") + 1], "0.4")

console.log("KRT native-auto policy contract passed")
