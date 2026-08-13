import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { atom, findChild, type SExpression } from "../../kicad-copilot/src/kicad/sexpr/ast"
import { listChildren, pcbNetNames, readPcb } from "../../kicad-copilot/src/kicad/pcb-reader"
import { parsePcbSource, serializePcb } from "../../kicad-copilot/src/kicad/pcb-writer"
import {
  runKrtRemaining,
  runKrtSpecial,
  type KrtProcessResult,
  type KrtStageSpec,
} from "./backends/krt-adapter"
import { clearRouting } from "../../kicad-copilot/src/pcb/router-adapter"
import {
  appendFilledCopperProxy,
  removeFilledCopperProxy,
} from "./filled-copper-proxy"
import { QUALITY_PRESETS } from "./portfolio-routing"
import {
  boardCopperMetrics,
  boardStem,
  changedCopperGeometryNets,
  copyBoardSidecars,
  placementChanged,
  zonesChanged,
} from "./workflow-board"
import { summarizeFinalDrc, type FinalDrcSummary } from "./workflow-validation"

export type CompletionProfile = {
  name: string
  scheduling: "global" | "singleton"
  ordering: "inside_out" | "mps" | "original"
  preserveNetOrder: boolean
  enableNetRescue: boolean
  viaCost: number
  viaProximityCost: number
  turnCost: number
  directionPreferenceCost: number
  maxRipup: number
  heuristicWeight: number
  maxIterations: number
  maxProbeIterations: number
}

export type BlockerRepairProfile = {
  name: string
  scheduling: "blocker-repair" | "blocker-probe"
  targetNets: string[]
  blockers: string[]
  hardBlockers: string[]
  movedSpecialGroups: Array<{
    kind: "diff-pair" | "matched-group"
    nets: string[]
  }>
}

export type BlockerRepairPlan = {
  targetNet: string
  blockers: string[]
  hardBlockers: string[]
  blockerScores: Record<string, number>
}

export type CompletionDiagnostic = {
  code: string
  severity: "info" | "warning" | "error"
  message: string
  details?: unknown
}

export type CompletionMetrics = {
  missingNonGroundNets: string[]
  missingNonGroundItems: number
  newDrcErrors: number
  viaCount: number
  segmentCount: number
  arcCount: number
  wireLengthMm: number
  elapsedMs: number
}

export type CompletionCandidate = {
  index: number
  profile: CompletionProfile | BlockerRepairProfile | { name: "incumbent" }
  status: "completed" | "error"
  eligible: boolean
  boardPath: string
  metrics: CompletionMetrics
  diagnostics: CompletionDiagnostic[]
  router?: KrtProcessResult
  routerSubcalls?: KrtProcessResult[]
  score: number[]
}

export type CompletionPortfolioResult = {
  version: 1
  inputBoard: string
  outputBoard: string
  attemptedNets: string[]
  plannedRuns: number
  completedRuns: number
  stoppedEarly: boolean
  selectedCandidateIndex: number
  candidates: CompletionCandidate[]
  diagnostics: CompletionDiagnostic[]
  elapsedMs: number
}

export type NativeCompletionValidation = {
  completed: boolean
  report?: Record<string, unknown>
  elapsedMs: number
  diagnostics?: CompletionDiagnostic[]
}

export type CompletionPortfolioRequest = {
  inputBoard: string
  outputBoard: string
  resultDirectory: string
  residualNets: readonly string[]
  baselineDrc: unknown
  inputDrc: unknown
  sourcePlacementBoard: string
  krtSpec: KrtStageSpec
  maximumRuns: number
  /** First authoritative KRT JSON_SUMMARY from the immediately preceding remaining pass. */
  blockerSummary?: Record<string, unknown>
  /** Hard upper bound for explicitly movable pre-existing blocker nets. */
  maximumBlockers?: number
  profiles?: readonly CompletionProfile[]
  proxyWidthMm: number
  proxyPitchMm: number
  runNativeValidation: (boardPath: string, reportPath: string) => Promise<NativeCompletionValidation>
}

function recordArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item)
      && typeof item === "object" && !Array.isArray(item))
    : []
}

function finiteNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function blockerWeight(item: Record<string, unknown>) {
  if (item.preexisting === true) return 1
  return 1_000
    + 100_000 * finiteNumber(item.near_target_cells)
    + 10_000 * finiteNumber(item.near_source_cells)
    + 100 * finiteNumber(item.blocked_count)
    + finiteNumber(item.unique_cells)
}

/**
 * Converts KRT's structured blocker telemetry into exact, bounded rip-up scopes.
 * Hard nets stay visible in the report but can never enter --rip-existing-nets.
 */
export function buildBlockerRepairPlans(
  summaries: readonly (Record<string, unknown> | undefined)[],
  targets: readonly string[],
  allNets: readonly string[],
  hardNets: readonly string[],
  maximumBlockers = 8,
): BlockerRepairPlan[] {
  const targetSet = new Set(targets)
  const boardNets = new Set(allNets)
  const hard = new Set(hardNets)
  const scoresByTarget = new Map<string, Map<string, number>>()
  for (const summary of summaries) {
    if (!summary) continue
    for (const item of recordArray(summary.blockers)) {
      const target = String(item.net ?? "")
      if (!targetSet.has(target)) continue
      const scores = scoresByTarget.get(target) ?? new Map<string, number>()
      for (const blocker of recordArray(item.blocked_by)) {
        const net = String(blocker.net ?? "")
        if (!net || net === target || !boardNets.has(net)) continue
        scores.set(net, (scores.get(net) ?? 0) + blockerWeight(blocker))
      }
      scoresByTarget.set(target, scores)
    }
  }
  const limit = Math.max(0, Math.min(8, Math.trunc(maximumBlockers)))
  return targets.map((targetNet) => {
    const ranked = [...(scoresByTarget.get(targetNet) ?? new Map()).entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    return {
      targetNet,
      blockers: ranked.filter(([net]) => !hard.has(net)).slice(0, limit).map(([net]) => net),
      hardBlockers: ranked.filter(([net]) => hard.has(net)).map(([net]) => net),
      blockerScores: Object.fromEntries(ranked),
    }
  })
}

function nodeNetName(root: SExpression[], node: SExpression[]) {
  const net = findChild(node, "net")
  if (!net) return ""
  if (net.length >= 3) return atom(net[2]) ?? ""
  const number = atom(net[1]) ?? ""
  if (!/^\d+$/.test(number)) return number
  return atom(listChildren(root, "net").find((entry) => atom(entry[1]) === number)?.[2]) ?? ""
}

function nativeImmutableBlockerNets(root: SExpression[]) {
  const output = new Set(["GND"])
  for (const zone of listChildren(root, "zone")) {
    const net = nodeNetName(root, zone)
    if (net) output.add(net)
  }
  for (const head of ["segment", "arc", "via"] as const) {
    for (const item of listChildren(root, head)) {
      if ((atom(findChild(item, "locked")?.[1]) ?? "").toLowerCase() !== "yes") continue
      const net = nodeNetName(root, item)
      if (net) output.add(net)
    }
  }
  return [...output]
}

function nativeHardBlockerNets(root: SExpression[], specialNets: readonly string[]) {
  return [...new Set([...nativeImmutableBlockerNets(root), ...specialNets])]
}

function specialGroups(spec: KrtStageSpec) {
  return [
    ...spec.diffPairs.map((pair) => ({
      kind: "diff-pair" as const,
      nets: Array.isArray(pair)
        ? [...pair]
        : [pair.positive, pair.negative],
    })),
    ...spec.matchedGroups.map((group) => ({
      kind: "matched-group" as const,
      nets: Array.isArray(group) ? [...group] : [...group.nets],
    })),
  ]
}

export function atomicSpecialGroupsForBlockers(
  blockers: readonly string[],
  spec: KrtStageSpec,
) {
  const blockerSet = new Set(blockers)
  return specialGroups(spec).filter((group) => (
    group.nets.some((net) => blockerSet.has(net))
  ))
}

function diagnostic(
  code: string,
  severity: CompletionDiagnostic["severity"],
  message: string,
  details?: unknown,
): CompletionDiagnostic {
  return { code, severity, message, ...(details === undefined ? {} : { details }) }
}

async function exists(path: string) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function profileFromQuality(
  name: string,
  quality: (typeof QUALITY_PRESETS)[number],
  ordering: CompletionProfile["ordering"],
  enableNetRescue: boolean,
  scheduling: CompletionProfile["scheduling"] = "global",
): CompletionProfile {
  return {
    name,
    scheduling,
    ordering,
    preserveNetOrder: ordering === "original",
    enableNetRescue,
    viaCost: quality.viaCost,
    viaProximityCost: quality.viaProximityCost,
    turnCost: quality.turnCost,
    directionPreferenceCost: quality.directionPreferenceCost,
    maxRipup: quality.maxRipup,
    heuristicWeight: quality.heuristicWeight,
    maxIterations: quality.maxIterations,
    maxProbeIterations: quality.maxProbeIterations,
  }
}

/** High quality first; later attempts spend aesthetics on completion, never DRC geometry. */
export function buildCompletionProfiles(requestedRuns: number): CompletionProfile[] {
  const count = Math.max(0, Math.min(5, Math.trunc(requestedRuns)))
  const [max, high, medium, low] = QUALITY_PRESETS
  return [
    profileFromQuality("max-global-mps", max, "mps", false),
    profileFromQuality("high-escape-order", high, "original", false),
    profileFromQuality("medium-global-mps-rescue", medium, "mps", true),
    profileFromQuality("low-singleton-inside-out-rescue", low, "inside_out", true, "singleton"),
    profileFromQuality("low-singleton-escape-rescue", low, "original", true, "singleton"),
  ].slice(0, count)
}

function scoreCandidate(candidate: Pick<CompletionCandidate, "eligible" | "metrics" | "index">) {
  return [
    candidate.eligible ? 0 : 1,
    candidate.metrics.missingNonGroundNets.length,
    candidate.metrics.missingNonGroundItems,
    candidate.metrics.newDrcErrors,
    candidate.metrics.viaCount,
    candidate.metrics.wireLengthMm,
    candidate.index,
  ]
}

export function compareCompletionCandidates(left: CompletionCandidate, right: CompletionCandidate) {
  const a = scoreCandidate(left)
  const b = scoreCandidate(right)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function metricsFrom(
  root: ReturnType<typeof parsePcbSource>,
  summary: FinalDrcSummary,
  elapsedMs: number,
): CompletionMetrics {
  return {
    missingNonGroundNets: summary.missingNonGroundNets,
    missingNonGroundItems: summary.missingNonGroundItems,
    newDrcErrors: summary.newErrorViolations.length,
    ...boardCopperMetrics(root),
    elapsedMs,
  }
}

function failedMetrics(elapsedMs: number): CompletionMetrics {
  return {
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

async function copyBoardAndSidecars(source: string, target: string) {
  await copyFile(source, target)
  await copyBoardSidecars(source, target, exists)
}

async function setCompletionProtectedNets(boardPath: string, protectedNets: readonly string[]) {
  const projectPath = `${boardStem(boardPath)}.kicad_pro`
  const root = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>
  const tools = root.kicad_routing_tools && typeof root.kicad_routing_tools === "object"
    ? root.kicad_routing_tools as Record<string, unknown>
    : {}
  const existing = tools.protected_nets && typeof tools.protected_nets === "object"
    ? tools.protected_nets as Record<string, unknown>
    : {}
  for (const [net, owner] of Object.entries(existing)) {
    if (String(owner).startsWith("workflow-")) delete existing[net]
  }
  for (const net of protectedNets) existing[net] = "workflow-completion-fixed"
  tools.protected_nets = existing
  root.kicad_routing_tools = tools
  await writeFile(projectPath, `${JSON.stringify(root, null, 2)}\n`)
}

export async function runKrtCompletionPortfolio(
  request: CompletionPortfolioRequest,
): Promise<CompletionPortfolioResult> {
  const started = performance.now()
  const inputBoard = resolve(request.inputBoard)
  const outputBoard = resolve(request.outputBoard)
  const resultDirectory = resolve(request.resultDirectory)
  await mkdir(resultDirectory, { recursive: true })
  const inputRoot = parsePcbSource((await readPcb(inputBoard)).source)
  const sourcePlacementRoot = parsePcbSource((await readPcb(resolve(request.sourcePlacementBoard))).source)
  const allNets = [...pcbNetNames(inputRoot)]
  const attemptedNets = [...new Set(request.residualNets)]
    .filter((net) => net && net.toUpperCase() !== "GND" && allNets.includes(net))
  const protectedNets = allNets.filter((net) => !attemptedNets.includes(net))
  const candidates: CompletionCandidate[] = []
  const portfolioDiagnostics: CompletionDiagnostic[] = []

  const incumbentSummary = summarizeFinalDrc(request.baselineDrc, request.inputDrc)
  const incumbentDiagnostics: CompletionDiagnostic[] = []
  if (placementChanged(sourcePlacementRoot, inputRoot)) incumbentDiagnostics.push(diagnostic(
    "COMPLETION_INPUT_PLACEMENT_CHANGED",
    "error",
    "The completion input no longer has the source footprint placement.",
  ))
  const incumbent: CompletionCandidate = {
    index: 0,
    profile: { name: "incumbent" },
    status: "completed",
    eligible: incumbentDiagnostics.length === 0,
    boardPath: inputBoard,
    metrics: metricsFrom(inputRoot, incumbentSummary, 0),
    diagnostics: incumbentDiagnostics,
    score: [],
  }
  incumbent.score = scoreCandidate(incumbent)
  candidates.push(incumbent)

  let stoppedEarly = attemptedNets.length === 0
  const profiles = request.profiles
    ? [...request.profiles].slice(0, 5)
    : buildCompletionProfiles(request.maximumRuns)
  const specialNets = [
    ...request.krtSpec.diffPairs.flatMap((pair) => Array.isArray(pair)
      ? [...pair]
      : [pair.positive, pair.negative]),
    ...request.krtSpec.matchedGroups.flatMap((group) => Array.isArray(group)
      ? [...group]
      : [...group.nets]),
  ]
  const hardBlockerNets = nativeHardBlockerNets(inputRoot, specialNets)
  const immutableBlockerNets = new Set(nativeImmutableBlockerNets(inputRoot))
  const blockerPlans = buildBlockerRepairPlans(
    [request.blockerSummary],
    attemptedNets,
    allNets,
    hardBlockerNets,
    request.maximumBlockers ?? 8,
  )
  const blockerProfiles: BlockerRepairProfile[] = blockerPlans.map((plan) => {
    const movedSpecialGroups = atomicSpecialGroupsForBlockers(plan.hardBlockers, request.krtSpec)
      .filter((group) => group.nets.every((net) => !immutableBlockerNets.has(net)))
    const movableSpecialNets = new Set(movedSpecialGroups.flatMap((group) => group.nets))
    const maximumBlockers = Math.max(0, Math.min(8, Math.trunc(request.maximumBlockers ?? 8)))
    const ordinaryBudget = Math.max(0, maximumBlockers - movableSpecialNets.size)
    return {
      name: `repair-${plan.targetNet.replace(/[^A-Za-z0-9_-]+/g, "-")}`,
      scheduling: plan.blockers.length || movedSpecialGroups.length
        ? "blocker-repair"
        : "blocker-probe",
      targetNets: [plan.targetNet],
      blockers: plan.blockers.slice(0, ordinaryBudget),
      hardBlockers: plan.hardBlockers.filter((net) => !movableSpecialNets.has(net)),
      movedSpecialGroups,
    }
  })
  const selectedProfiles = request.blockerSummary
    ? blockerProfiles.slice(0, Math.max(0, Math.min(8, Math.trunc(request.maximumRuns))))
    : profiles
  let blockerIncumbentBoard = inputBoard
  let blockerIncumbentRoot = inputRoot
  let blockerIncumbentSummary = incumbentSummary
  for (const [profileIndex, profile] of selectedProfiles.entries()) {
    if (stoppedEarly) break
    const index = profileIndex + 1
    const candidateStarted = performance.now()
    const blockerProfile = profile.scheduling === "blocker-repair"
      || profile.scheduling === "blocker-probe"
      ? profile
      : undefined
    const movedSpecialNets = blockerProfile
      ? [...new Set(blockerProfile.movedSpecialGroups.flatMap((group) => group.nets))]
      : []
    const candidateInputBoard = blockerProfile ? blockerIncumbentBoard : inputBoard
    const candidateInputRoot = blockerProfile ? blockerIncumbentRoot : inputRoot
    const directory = resolve(resultDirectory, `${String(index).padStart(2, "0")}-${profile.name}`)
    const proxyInput = resolve(directory, "completion-proxy-input.kicad_pcb")
    const proxyOutput = resolve(directory, "completion-proxy-output.kicad_pcb")
    const candidateBoard = resolve(directory, "completion-candidate.kicad_pcb")
    await mkdir(directory, { recursive: true })
    const diagnostics: CompletionDiagnostic[] = []
    let router: KrtProcessResult | undefined
    let candidate: CompletionCandidate
    try {
      const proxyRoot = structuredClone(candidateInputRoot)
      if (movedSpecialNets.length) clearRouting(proxyRoot, { onlyNets: movedSpecialNets })
      const manifest = appendFilledCopperProxy(proxyRoot, {
        widthMm: request.proxyWidthMm,
        pitchMm: request.proxyPitchMm,
      })
      await writeFile(proxyInput, serializePcb(proxyRoot))
      await copyBoardSidecars(candidateInputBoard, proxyInput, exists)
      await writeFile(resolve(directory, "filled-copper-proxy.json"), `${JSON.stringify(manifest, null, 2)}\n`)

      const candidateTargets = blockerProfile?.targetNets ?? attemptedNets
      let candidateBlockers = blockerProfile?.blockers ?? []
      const mutableNets = new Set([
        ...candidateTargets,
        ...candidateBlockers,
        ...movedSpecialNets,
      ])
      let candidateProtectedNets = allNets.filter((net) => !mutableNets.has(net))
      await setCompletionProtectedNets(proxyInput, candidateProtectedNets)
      if (blockerProfile?.hardBlockers.length) diagnostics.push(diagnostic(
        "COMPLETION_HARD_BLOCKERS",
        "info",
        "Some reported blockers are immutable zones, locked copper, or GND.",
        blockerProfile.hardBlockers,
      ))
      if (blockerProfile?.movedSpecialGroups.length) diagnostics.push(diagnostic(
        "COMPLETION_ATOMIC_SPECIAL_MOVE",
        "info",
        "Whole special groups will be removed temporarily and rerouted atomically after the target net.",
        blockerProfile.movedSpecialGroups,
      ))
      const quality = QUALITY_PRESETS[0]
      const profileSpec = {
        ...request.krtSpec,
        remainingNets: candidateTargets,
        ripExistingNets: candidateBlockers,
        powerNets: request.krtSpec.powerNets?.filter((item) => candidateTargets.includes(item.net)),
        ordering: blockerProfile ? "original" : profile.ordering,
        preserveNetOrder: blockerProfile ? true : profile.preserveNetOrder,
        enableNetRescue: blockerProfile ? false : profile.enableNetRescue,
        enableTerminalEscalation: false,
        viaCost: blockerProfile ? quality.viaCost : profile.viaCost,
        viaProximityCost: blockerProfile ? quality.viaProximityCost : profile.viaProximityCost,
        turnCost: blockerProfile ? quality.turnCost : profile.turnCost,
        directionPreferenceCost: blockerProfile ? quality.directionPreferenceCost : profile.directionPreferenceCost,
        maxRipup: blockerProfile ? 8 : profile.maxRipup,
        heuristicWeight: blockerProfile ? quality.heuristicWeight : profile.heuristicWeight,
        maxIterations: blockerProfile ? quality.maxIterations : profile.maxIterations,
        maxProbeIterations: blockerProfile ? quality.maxProbeIterations : profile.maxProbeIterations,
        filledCopperProxy: true,
      } satisfies KrtStageSpec
      const routerSubcalls: KrtProcessResult[] = []
      let backendBoard = proxyInput
      if (profile.scheduling === "singleton") {
        for (const [netIndex, net] of attemptedNets.entries()) {
          const singletonOutput = resolve(directory, `singleton-${String(netIndex + 1).padStart(2, "0")}.kicad_pcb`)
          await setCompletionProtectedNets(backendBoard, allNets.filter((name) => name !== net))
          const subcall = await runKrtRemaining(backendBoard, singletonOutput, {
            ...profileSpec,
            remainingNets: [net],
            powerNets: profileSpec.powerNets?.filter((item) => item.net === net),
          }, resolve(directory, `krt-singleton-${String(netIndex + 1).padStart(2, "0")}`))
          routerSubcalls.push(subcall)
          diagnostics.push(...subcall.diagnostics.map((item) => ({ ...item })))
          if (await exists(singletonOutput)) backendBoard = singletonOutput
        }
        router = routerSubcalls.at(-1)
        if (backendBoard !== proxyOutput) await copyBoardAndSidecars(backendBoard, proxyOutput)
        backendBoard = proxyOutput
      } else {
        const firstOutput = blockerProfile
          ? resolve(directory, "blocker-attempt-01.kicad_pcb")
          : proxyOutput
        router = await runKrtRemaining(proxyInput, firstOutput, profileSpec, resolve(directory, "krt"))
        routerSubcalls.push(router)
        diagnostics.push(...router.diagnostics.map((item) => ({ ...item })))
        backendBoard = await exists(firstOutput) ? firstOutput : proxyInput
        if (blockerProfile) {
          const expanded = buildBlockerRepairPlans(
            [request.blockerSummary, router.jsonSummary],
            candidateTargets,
            allNets,
            hardBlockerNets,
            Math.max(0, (request.maximumBlockers ?? 8) - movedSpecialNets.length),
          )[0]
          const merged = expanded?.blockers ?? candidateBlockers
          const movedSpecialSet = new Set(movedSpecialNets)
          blockerProfile.hardBlockers = (expanded?.hardBlockers ?? blockerProfile.hardBlockers)
            .filter((net) => !movedSpecialSet.has(net))
          if (merged.some((net) => !candidateBlockers.includes(net))) {
            candidateBlockers = merged
            blockerProfile.blockers = merged
            blockerProfile.scheduling = "blocker-repair"
            const expandedMutable = new Set([
              ...candidateTargets,
              ...candidateBlockers,
              ...movedSpecialNets,
            ])
            candidateProtectedNets = allNets.filter((net) => !expandedMutable.has(net))
            await setCompletionProtectedNets(proxyInput, candidateProtectedNets)
            const expandedRouter = await runKrtRemaining(proxyInput, proxyOutput, {
              ...profileSpec,
              ripExistingNets: candidateBlockers,
            }, resolve(directory, "krt-expanded"))
            routerSubcalls.push(expandedRouter)
            diagnostics.push(...expandedRouter.diagnostics.map((item) => ({ ...item })))
            router = expandedRouter
            backendBoard = await exists(proxyOutput) ? proxyOutput : proxyInput
          } else if (backendBoard !== proxyOutput) {
            await copyBoardAndSidecars(backendBoard, proxyOutput)
            backendBoard = proxyOutput
          }
        }
      }
      if (movedSpecialNets.length) {
        const specialOutput = resolve(directory, "atomic-special-output.kicad_pcb")
        await setCompletionProtectedNets(
          backendBoard,
          allNets.filter((net) => !movedSpecialNets.includes(net)),
        )
        const movedSet = new Set(movedSpecialNets)
        const specialSpec: KrtStageSpec = {
          ...request.krtSpec,
          diffPairs: request.krtSpec.diffPairs.filter((pair) => {
            const nets = Array.isArray(pair) ? [...pair] : [pair.positive, pair.negative]
            return nets.every((net) => movedSet.has(net))
          }),
          matchedGroups: request.krtSpec.matchedGroups.filter((group) => {
            const nets = Array.isArray(group) ? [...group] : [...group.nets]
            return nets.every((net) => movedSet.has(net))
          }),
          remainingNets: [],
          ripExistingNets: [],
          powerNets: [],
          filledCopperProxy: true,
        }
        const specialRouter = await runKrtSpecial(
          backendBoard,
          specialOutput,
          specialSpec,
          resolve(directory, "krt-atomic-special"),
        )
        routerSubcalls.push(specialRouter)
        diagnostics.push(...specialRouter.diagnostics.map((item) => ({ ...item })))
        backendBoard = await exists(specialOutput) ? specialOutput : backendBoard
      }
      const candidateRoot = parsePcbSource((await readPcb(backendBoard)).source)
      const proxyRemoval = removeFilledCopperProxy(candidateRoot, manifest)
      if (proxyRemoval.missingUuids.length) diagnostics.push(diagnostic(
        "COMPLETION_PROXY_CUSTODY_LOST",
        "error",
        "KRT changed or removed temporary filled-copper geometry.",
        proxyRemoval,
      ))
      await writeFile(candidateBoard, serializePcb(candidateRoot))
      await copyBoardSidecars(backendBoard, candidateBoard, exists)

      const validation = await request.runNativeValidation(
        candidateBoard,
        resolve(directory, "native-drc.json"),
      )
      diagnostics.push(...(validation.diagnostics ?? []))
      const validatedRoot = parsePcbSource((await readPcb(candidateBoard)).source)
      const changedProtected = changedCopperGeometryNets(
        candidateInputRoot,
        validatedRoot,
        blockerProfile ? candidateProtectedNets : protectedNets,
      )
      if (changedProtected.length) diagnostics.push(diagnostic(
        "COMPLETION_PROTECTED_COPPER_CHANGED",
        "error",
        "A completion candidate changed copper outside its residual-net scope.",
        changedProtected,
      ))
      if (zonesChanged(inputRoot, validatedRoot)) diagnostics.push(diagnostic(
        "COMPLETION_ZONE_OUTLINES_CHANGED",
        "error",
        "A completion candidate changed a polygon/plane outline.",
      ))
      if (placementChanged(sourcePlacementRoot, validatedRoot)) diagnostics.push(diagnostic(
        "COMPLETION_PLACEMENT_CHANGED",
        "error",
        "A completion candidate changed footprint placement.",
      ))
      const summary = validation.report
        ? summarizeFinalDrc(request.baselineDrc, validation.report)
        : undefined
      let eligible = validation.completed
        && Boolean(summary)
        && !diagnostics.some((item) => item.severity === "error"
          && item.code.startsWith("COMPLETION_"))
      if (blockerProfile && summary) {
        const targetClosed = candidateTargets.every((net) => !summary.missingNonGroundNets.includes(net))
        const specialGroupsClosed = movedSpecialNets.every((net) => (
          !summary.missingNonGroundNets.includes(net)
        ))
        const specialRouterSucceeded = !movedSpecialNets.length
          || !routerSubcalls.at(-1)?.diagnostics.some((item) => item.severity === "error")
        const improvesConnectivity = summary.missingNonGroundNets.length
            < blockerIncumbentSummary.missingNonGroundNets.length
          || summary.missingNonGroundNets.length === blockerIncumbentSummary.missingNonGroundNets.length
            && summary.missingNonGroundItems < blockerIncumbentSummary.missingNonGroundItems
        const preservesDrc = summary.newErrorViolations.length
          <= blockerIncumbentSummary.newErrorViolations.length
        const previouslyOpen = new Set(blockerIncumbentSummary.missingNonGroundNets)
        const newlyOpened = summary.missingNonGroundNets.filter((net) => !previouslyOpen.has(net))
        const preservesVictims = newlyOpened.length === 0
          && !diagnostics.some((item) => item.severity === "error"
            && item.code === "KRT_RIP_VICTIM_INCOMPLETE")
        if (!targetClosed || !specialGroupsClosed || !specialRouterSucceeded
          || !improvesConnectivity || !preservesDrc || !preservesVictims) {
          diagnostics.push(diagnostic(
            "COMPLETION_REPAIR_NO_IMPROVEMENT",
            "error",
            "Blocker repair was rolled back because it did not close its target with a strict native-connectivity improvement and no DRC regression.",
            {
              targetClosed,
              specialGroupsClosed,
              specialRouterSucceeded,
              improvesConnectivity,
              preservesDrc,
              preservesVictims,
              newlyOpened,
              blockers: candidateBlockers,
              movedSpecialGroups: blockerProfile.movedSpecialGroups,
            },
          ))
          eligible = false
        }
      }
      candidate = {
        index,
        profile,
        status: validation.completed && router?.status === "completed" ? "completed" : "error",
        eligible,
        boardPath: candidateBoard,
        metrics: summary
          ? metricsFrom(validatedRoot, summary, performance.now() - candidateStarted)
          : failedMetrics(performance.now() - candidateStarted),
        diagnostics,
        ...(router ? { router } : {}),
        routerSubcalls,
        score: [],
      }
      if (blockerProfile && candidate.eligible && summary) {
        blockerIncumbentBoard = candidateBoard
        blockerIncumbentRoot = validatedRoot
        blockerIncumbentSummary = summary
      }
    } catch (error) {
      diagnostics.push(diagnostic(
        "COMPLETION_CANDIDATE_FAILED",
        "error",
        error instanceof Error ? error.message : String(error),
      ))
      candidate = {
        index,
        profile,
        status: "error",
        eligible: false,
        boardPath: inputBoard,
        metrics: failedMetrics(performance.now() - candidateStarted),
        diagnostics,
        ...(router ? { router } : {}),
        score: [],
      }
    }
    candidate.score = scoreCandidate(candidate)
    candidates.push(candidate)
    await writeFile(resolve(directory, "completion-result.json"), `${JSON.stringify(candidate, null, 2)}\n`)
    if (candidate.eligible && candidate.metrics.missingNonGroundNets.length === 0) stoppedEarly = true
  }

  const selected = [...candidates].sort(compareCompletionCandidates)[0]
  await copyBoardAndSidecars(selected.boardPath, outputBoard)
  if (!selected.eligible) portfolioDiagnostics.push(diagnostic(
    "COMPLETION_NO_ELIGIBLE_CANDIDATE",
    "error",
    "No completion candidate preserved the fixed board state and completed native validation.",
  ))
  const result: CompletionPortfolioResult = {
    version: 1,
    inputBoard,
    outputBoard,
    attemptedNets,
    plannedRuns: selectedProfiles.length,
    completedRuns: candidates.length - 1,
    stoppedEarly,
    selectedCandidateIndex: selected.index,
    candidates,
    diagnostics: portfolioDiagnostics,
    elapsedMs: performance.now() - started,
  }
  await writeFile(resolve(resultDirectory, "completion-report.json"), `${JSON.stringify(result, null, 2)}\n`)
  return result
}
