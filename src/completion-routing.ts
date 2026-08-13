import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { pcbNetNames, readPcb } from "../../kicad-copilot/src/kicad/pcb-reader"
import { parsePcbSource, serializePcb } from "../../kicad-copilot/src/kicad/pcb-writer"
import {
  runKrtRemaining,
  type KrtProcessResult,
  type KrtStageSpec,
} from "./backends/krt-adapter"
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
  profile: CompletionProfile | { name: "incumbent" }
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
  profiles?: readonly CompletionProfile[]
  proxyWidthMm: number
  proxyPitchMm: number
  runNativeValidation: (boardPath: string, reportPath: string) => Promise<NativeCompletionValidation>
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
  for (const [profileIndex, profile] of profiles.entries()) {
    if (stoppedEarly) break
    const index = profileIndex + 1
    const candidateStarted = performance.now()
    const directory = resolve(resultDirectory, `${String(index).padStart(2, "0")}-${profile.name}`)
    const proxyInput = resolve(directory, "completion-proxy-input.kicad_pcb")
    const proxyOutput = resolve(directory, "completion-proxy-output.kicad_pcb")
    const candidateBoard = resolve(directory, "completion-candidate.kicad_pcb")
    await mkdir(directory, { recursive: true })
    const diagnostics: CompletionDiagnostic[] = []
    let router: KrtProcessResult | undefined
    let candidate: CompletionCandidate
    try {
      const proxyRoot = structuredClone(inputRoot)
      const manifest = appendFilledCopperProxy(proxyRoot, {
        widthMm: request.proxyWidthMm,
        pitchMm: request.proxyPitchMm,
      })
      await writeFile(proxyInput, serializePcb(proxyRoot))
      await copyBoardSidecars(inputBoard, proxyInput, exists)
      await setCompletionProtectedNets(proxyInput, protectedNets)
      await writeFile(resolve(directory, "filled-copper-proxy.json"), `${JSON.stringify(manifest, null, 2)}\n`)

      const profileSpec = {
        ...request.krtSpec,
        remainingNets: attemptedNets,
        powerNets: request.krtSpec.powerNets?.filter((item) => attemptedNets.includes(item.net)),
        ordering: profile.ordering,
        preserveNetOrder: profile.preserveNetOrder,
        enableNetRescue: profile.enableNetRescue,
        enableTerminalEscalation: false,
        viaCost: profile.viaCost,
        viaProximityCost: profile.viaProximityCost,
        turnCost: profile.turnCost,
        directionPreferenceCost: profile.directionPreferenceCost,
        maxRipup: profile.maxRipup,
        heuristicWeight: profile.heuristicWeight,
        maxIterations: profile.maxIterations,
        maxProbeIterations: profile.maxProbeIterations,
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
        router = await runKrtRemaining(proxyInput, proxyOutput, profileSpec, resolve(directory, "krt"))
        routerSubcalls.push(router)
        diagnostics.push(...router.diagnostics.map((item) => ({ ...item })))
        backendBoard = await exists(proxyOutput) ? proxyOutput : proxyInput
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
      const changedProtected = changedCopperGeometryNets(inputRoot, validatedRoot, protectedNets)
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
      const eligible = validation.completed
        && Boolean(summary)
        && !diagnostics.some((item) => item.severity === "error"
          && item.code.startsWith("COMPLETION_"))
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
    plannedRuns: profiles.length,
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
