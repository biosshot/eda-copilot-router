import type {
  RoutingCopper,
  RoutingDiagnostic,
  RoutingMetrics,
} from "../core/contracts.js"
import { resolveRoutePlan } from "../core/route-plan.js"
import type { CompiledRoutingProgram, FanoutIntent, ViaStitchIntent } from "../intent/types.js"
import type {
  BackendRouteRequest,
  BackendRouteResult,
  RouterBackendAdapter,
} from "../adapters/contracts.js"
import {
  gradeRoutingCandidate,
  retainRoutingChampion,
  type RoutingCandidate,
} from "../core/candidate-grader.js"
import {
  createBundledEasyEdaWasmBackend,
  type BundledEasyEdaWasmBackendOptions,
} from "./easyeda-wasm.js"
import { createKrtBackend, type KrtBackendOptions } from "./krt.js"

export type HybridBackendOptions = Readonly<{
  krt?: KrtBackendOptions
  easyeda?: BundledEasyEdaWasmBackendOptions
}>

export type HybridBackendDependencies = Readonly<{
  krt: RouterBackendAdapter
  easyeda: RouterBackendAdapter
}>

export type HybridRoutePartition = Readonly<{
  routableNets: readonly string[]
  krtNets: readonly string[]
  easyedaNets: readonly string[]
  reasons: Readonly<Record<string, readonly string[]>>
}>

type CheckedBackend = Readonly<{
  backend: RouterBackendAdapter
  request: BackendRouteRequest
  diagnostics: readonly RoutingDiagnostic[]
  ready: boolean
  stage: string
}>

type HybridExecutionMode =
  | "noop"
  | "hybrid"
  | "krt-full"
  | "krt-scoped"
  | "easyeda-only"
  | "easyeda-full"
  | "none"

type HybridExecutionPlan = Readonly<{
  mode: HybridExecutionMode
  partition: HybridRoutePartition
  diagnostics: readonly RoutingDiagnostic[]
  krtRequest?: BackendRouteRequest
  easyedaRequest?: BackendRouteRequest
  fallback: boolean
  reason?: string
}>

const GROUND_NETS = new Set(["GND", "/GND"])

function diagnostic(
  code: string,
  severity: RoutingDiagnostic["severity"],
  message: string,
  details?: unknown,
): RoutingDiagnostic {
  return { code, severity, message, ...(details === undefined ? {} : { details }) }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {}
}

function isGroundNet(net: string) {
  return GROUND_NETS.has(net.trim().toUpperCase())
}

function normalized(values: readonly string[]) {
  return [...new Set(values)].sort()
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const a = normalized(left)
  const b = normalized(right)
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function ruleFor(request: BackendRouteRequest, net: string) {
  return request.rules.nets.find((item) => item.net === net)?.values ?? request.rules.default
}

function fanoutTargetNets(request: BackendRouteRequest, fanout: FanoutIntent) {
  return request.board.pads.flatMap((pad) => {
    if (!pad.net || pad.component !== fanout.target.component) return []
    if (fanout.target.kind === "pad" && pad.number !== fanout.target.pad) return []
    return [pad.net]
  })
}

function fanoutTouchesScope(request: BackendRouteRequest, fanout: FanoutIntent, scope: ReadonlySet<string>) {
  return fanoutTargetNets(request, fanout).some((net) => scope.has(net))
}

function scopedViaStitches(stitches: readonly ViaStitchIntent[], scope: ReadonlySet<string>) {
  return stitches.filter((item) => {
    if (item.mode === "along") return item.routes.every((net) => scope.has(net))
    if (item.mode === "return") return !item.forNets || item.forNets.every((net) => scope.has(net))
    return scope.has(item.net)
  })
}

/**
 * Build a backend-internal scoped request without changing the DSL or public
 * contracts. The whole board remains visible as routing context and obstacles;
 * only electrical intent and request.plan are narrowed.
 */
export function scopeBackendRequest(
  request: BackendRouteRequest,
  nets: readonly string[],
): BackendRouteRequest {
  const selected = new Set(nets)
  const scopeNets = request.plan.scopeNets.filter((net) => selected.has(net))
  const scope = new Set(scopeNets)
  const program: CompiledRoutingProgram = {
    ...request.program,
    signalNets: request.program.signalNets.filter((item) => scope.has(item.net)),
    powerNets: request.program.powerNets.filter((item) => scope.has(item.net)),
    differentialPairs: request.program.differentialPairs.filter((item) => (
      scope.has(item.positive) && scope.has(item.negative)
    )),
    matchedGroups: request.program.matchedGroups.filter((item) => (
      item.nets.every((net) => scope.has(net))
    )),
    fanouts: request.program.fanouts.filter((item) => fanoutTouchesScope(request, item, scope)),
    viaStitches: scopedViaStitches(request.program.viaStitches, scope),
    onlyNets: scopeNets,
    ignoreNets: [],
  }
  return {
    ...request,
    program,
    plan: resolveRoutePlan(request.board, program, request.rules),
    ...(request.connectivity
      ? {
          connectivity: {
            preconnectedPadGroups: request.connectivity.preconnectedPadGroups.filter((group) => scope.has(group.net)),
          },
        }
      : {}),
  }
}

function withEditableCopper(request: BackendRouteRequest, copper: RoutingCopper): BackendRouteRequest {
  const board = {
    ...request.board,
    copper: { ...request.board.copper, editable: copper },
  }
  return {
    ...request,
    board,
    plan: resolveRoutePlan(board, request.program, request.rules),
  }
}

/** Select only routing policy. KRT remains the sole owner of all KRT stages. */
export function partitionHybridRoute(request: BackendRouteRequest): HybridRoutePartition {
  const padCounts = new Map<string, number>()
  for (const pad of request.board.pads) if (pad.net) {
    padCounts.set(pad.net, (padCounts.get(pad.net) ?? 0) + 1)
  }
  const routableNets = request.plan.scopeNets.filter((net) => (
    !isGroundNet(net) && (padCounts.get(net) ?? 0) >= 2
  ))
  const routable = new Set(routableNets)
  const krt = new Set<string>()
  const reasons = new Map<string, Set<string>>()
  const claim = (net: string, reason: string) => {
    if (!routable.has(net)) return
    krt.add(net)
    const current = reasons.get(net) ?? new Set<string>()
    current.add(reason)
    reasons.set(net, current)
  }

  for (const group of request.plan.groups) for (const net of group.nets) claim(net, group.kind)
  for (const pair of request.rules.differentialPairs ?? []) {
    claim(pair.positive, "effective-differential-relation")
    claim(pair.negative, "effective-differential-relation")
  }
  for (const group of request.rules.matchedGroups ?? []) {
    for (const net of group.nets) claim(net, "effective-matched-relation")
  }
  for (const intent of request.program.powerNets) claim(intent.net, "power")
  for (const intent of request.program.signalNets) if (intent.impedance) claim(intent.net, "impedance")
  for (const policy of request.plan.netPolicies) {
    if (policy.priority === "high") claim(policy.net, "high-priority")
    if (policy.priority === "critical") claim(policy.net, "critical")
    if (policy.viaPreference !== "auto") claim(policy.net, `via-${policy.viaPreference}`)
  }
  if (request.program.busDetect) for (const net of routableNets) claim(net, "bus-detect")
  for (const fanout of request.program.fanouts) {
    for (const net of fanoutTargetNets(request, fanout)) claim(net, "fanout")
  }

  const allLayers = request.board.layers.map((layer) => layer.name)
  for (const net of routableNets) {
    const rule = ruleFor(request, net)
    if (rule.impedanceOhm !== undefined || rule.differential) claim(net, "compiled-special-rule")
    if (rule.allowedLayers && !sameStrings(rule.allowedLayers, allLayers)) claim(net, "per-net-layers")
  }

  return {
    routableNets,
    krtNets: routableNets.filter((net) => krt.has(net)),
    easyedaNets: routableNets.filter((net) => !krt.has(net)),
    reasons: Object.fromEntries([...reasons].map(([net, values]) => [net, [...values]])),
  }
}

function scopedDiagnostic(item: RoutingDiagnostic, backend: string, stage: string): RoutingDiagnostic {
  return {
    ...item,
    details: {
      hybridBackend: backend,
      hybridStage: stage,
      ...(item.details === undefined ? {} : { originalDetails: item.details }),
    },
  }
}

async function checkBackend(
  backend: RouterBackendAdapter,
  request: BackendRouteRequest,
  stage: string,
): Promise<CheckedBackend> {
  try {
    const diagnostics = (await backend.preflight?.(request) ?? [])
      .map((item) => scopedDiagnostic(item, backend.id, stage))
    return {
      backend,
      request,
      diagnostics,
      ready: !diagnostics.some((item) => item.severity === "error"),
      stage,
    }
  } catch (error) {
    return {
      backend,
      request,
      diagnostics: [diagnostic(
        "HYBRID_BACKEND_PREFLIGHT_EXCEPTION",
        "error",
        `${backend.id} preflight threw during ${stage}.`,
        { backend: backend.id, stage, error: errorMessage(error) },
      )],
      ready: false,
      stage,
    }
  }
}

function publicPreflightDiagnostics(plan: HybridExecutionPlan) {
  const output = plan.diagnostics.map((item) => item.severity !== "error"
    ? item
    : diagnostic(
        "HYBRID_BACKEND_PREFLIGHT_DEFERRED",
        "warning",
        `${item.code}: ${item.message}`,
        { original: item },
      ))
  output.push(diagnostic(
    "HYBRID_ROUTE_MODE_SELECTED",
    "info",
    `Hybrid routing selected ${plan.mode}.`,
    {
      mode: plan.mode,
      fallback: plan.fallback,
      reason: plan.reason,
      krtNets: plan.partition.krtNets,
      easyedaNets: plan.partition.easyedaNets,
    },
  ))
  return output
}

async function prepareExecution(
  request: BackendRouteRequest,
  dependencies: HybridBackendDependencies,
): Promise<HybridExecutionPlan> {
  const partition = partitionHybridRoute(request)
  if (!partition.routableNets.length) return {
    mode: "noop",
    partition,
    diagnostics: [],
    fallback: false,
  }

  const easyFullRequest = scopeBackendRequest(request, partition.routableNets)
  if (request.board.layers.length > 2) {
    const krt = await checkBackend(dependencies.krt, request, "krt-full")
    if (krt.ready) return {
      mode: "krt-full", partition, diagnostics: krt.diagnostics,
      krtRequest: request, fallback: false,
    }
    const easyeda = await checkBackend(dependencies.easyeda, easyFullRequest, "easyeda-full-fallback")
    return easyeda.ready
      ? {
          mode: "easyeda-full", partition,
          diagnostics: [...krt.diagnostics, ...easyeda.diagnostics],
          easyedaRequest: easyFullRequest,
          fallback: true,
          reason: "KRT preflight failed for a multilayer board.",
        }
      : {
          mode: "none", partition,
          diagnostics: [...krt.diagnostics, ...easyeda.diagnostics],
          fallback: true,
          reason: "Neither backend passed preflight.",
        }
  }

  const krtScopedRequest = partition.krtNets.length
    ? scopeBackendRequest(request, partition.krtNets)
    : undefined
  const easyScopedRequest = partition.easyedaNets.length
    ? scopeBackendRequest(request, partition.easyedaNets)
    : undefined
  const [krtScoped, easyScoped] = await Promise.all([
    krtScopedRequest
      ? checkBackend(dependencies.krt, krtScopedRequest, "krt-constrained")
      : Promise.resolve(undefined),
    easyScopedRequest
      ? checkBackend(dependencies.easyeda, easyScopedRequest, "easyeda-remaining")
      : Promise.resolve(undefined),
  ])
  const scopedDiagnostics = [
    ...(krtScoped?.diagnostics ?? []),
    ...(easyScoped?.diagnostics ?? []),
  ]

  if (krtScoped?.ready && easyScoped?.ready) return {
    mode: "hybrid", partition, diagnostics: scopedDiagnostics,
    krtRequest: krtScopedRequest,
    easyedaRequest: easyScopedRequest,
    fallback: false,
  }
  if (!krtScopedRequest && easyScoped?.ready) return {
    mode: "easyeda-only", partition, diagnostics: scopedDiagnostics,
    easyedaRequest: easyScopedRequest,
    fallback: false,
  }
  if (!easyScopedRequest && krtScoped?.ready) return {
    mode: "krt-scoped", partition, diagnostics: scopedDiagnostics,
    krtRequest: krtScopedRequest,
    fallback: false,
  }

  let easyedaFull: CheckedBackend | undefined
  if (krtScopedRequest && !krtScoped?.ready) {
    easyedaFull = await checkBackend(dependencies.easyeda, easyFullRequest, "easyeda-full-fallback")
    if (easyedaFull.ready) return {
      mode: "easyeda-full", partition,
      diagnostics: [...scopedDiagnostics, ...easyedaFull.diagnostics],
      easyedaRequest: easyFullRequest,
      fallback: true,
      reason: "KRT constrained preflight failed.",
    }
  }

  const krtFull = await checkBackend(dependencies.krt, request, "krt-full-fallback")
  if (krtFull.ready) return {
    mode: "krt-full", partition,
    diagnostics: [...scopedDiagnostics, ...krtFull.diagnostics],
    krtRequest: request,
    fallback: true,
    reason: "EasyEDA WASM remaining preflight failed.",
  }

  easyedaFull ??= easyScoped && sameStrings(
    easyScoped.request.plan.scopeNets,
    easyFullRequest.plan.scopeNets,
  )
    ? easyScoped
    : await checkBackend(dependencies.easyeda, easyFullRequest, "easyeda-full-last-resort")
  const easyedaFullDiagnostics = easyedaFull === easyScoped ? [] : easyedaFull.diagnostics
  if (easyedaFull.ready) return {
    mode: "easyeda-full", partition,
    diagnostics: [...scopedDiagnostics, ...krtFull.diagnostics, ...easyedaFullDiagnostics],
    easyedaRequest: easyFullRequest,
    fallback: true,
    reason: "KRT full preflight failed; EasyEDA WASM is the last available backend.",
  }

  return {
    mode: "none", partition,
    diagnostics: [...scopedDiagnostics, ...krtFull.diagnostics, ...easyedaFullDiagnostics],
    fallback: true,
    reason: "Neither backend passed preflight.",
  }
}

function copperPrimitiveCount(copper: RoutingCopper) {
  return copper.tracks.length + copper.vias.length + copper.zones.length
}

function trackLengthMm(copper: RoutingCopper) {
  return copper.tracks.reduce((sum, track) => sum + track.points.slice(1).reduce((subtotal, point, index) => {
    const previous = track.points[index]
    return subtotal + Math.hypot(point.x - previous.x, point.y - previous.y)
  }, 0), 0)
}

function baselineMetrics(request: BackendRouteRequest): Partial<RoutingMetrics> {
  return {
    openNetCount: request.plan.scopeNets.length,
    openNets: request.plan.scopeNets,
    connectivityComponentCount: request.plan.scopeNets.reduce((sum, net) => (
      sum + Math.max(1, request.board.pads.filter((pad) => pad.net === net).length)
    ), 0),
    viaCount: request.board.copper.editable.vias.length,
    trackLengthMm: trackLengthMm(request.board.copper.editable),
  }
}

async function safeRoute(
  backend: RouterBackendAdapter,
  request: BackendRouteRequest,
  stage: string,
): Promise<BackendRouteResult> {
  const startedAt = performance.now()
  try {
    const result = await backend.route(request)
    const validShape = result.copper
      && Array.isArray(result.copper.tracks)
      && Array.isArray(result.copper.vias)
      && Array.isArray(result.copper.zones)
    if (!validShape) return {
      status: "error",
      copper: request.board.copper.editable,
      diagnostics: [
        ...(result.diagnostics ?? []),
        diagnostic(
          "HYBRID_STAGE_COPPER_INVALID",
          "error",
          `${backend.id} returned an invalid copper replacement during ${stage}; the stage checkpoint was retained.`,
          { backend: backend.id, stage },
        ),
      ],
      metrics: { ...baselineMetrics(request), elapsedMs: performance.now() - startedAt },
    }
    if (result.status === "error"
      && copperPrimitiveCount(result.copper) === 0
      && copperPrimitiveCount(request.board.copper.editable) > 0) {
      return {
        ...result,
        copper: request.board.copper.editable,
        diagnostics: [
          ...(result.diagnostics ?? []),
          diagnostic(
            "HYBRID_STAGE_CHECKPOINT_RETAINED",
            "warning",
            `${backend.id} failed during ${stage}; the incoming editable checkpoint was retained.`,
            { backend: backend.id, stage },
          ),
        ],
      }
    }
    return result
  } catch (error) {
    return {
      status: "error",
      copper: request.board.copper.editable,
      diagnostics: [diagnostic(
        "HYBRID_STAGE_ROUTE_EXCEPTION",
        "error",
        `${backend.id} threw during ${stage}; the stage checkpoint was retained.`,
        { backend: backend.id, stage, error: errorMessage(error) },
      )],
      metrics: { ...baselineMetrics(request), elapsedMs: performance.now() - startedAt },
    }
  }
}

function hasDiagnostic(result: BackendRouteResult, code: string) {
  return (result.diagnostics ?? []).some((item) => item.code === code)
}

function stageFailed(result: BackendRouteResult, backend: "krt" | "easyeda") {
  if (result.status === "error") return true
  if (backend === "easyeda") return hasDiagnostic(result, "EASYEDA_WASM_ROUTE_FAILED")
  return hasDiagnostic(result, "KRT_BACKEND_FAILED_AFTER_CHECKPOINT")
}

function enrichResult(
  result: BackendRouteResult,
  diagnostics: readonly RoutingDiagnostic[],
  mode: HybridExecutionMode,
  partition: HybridRoutePartition,
  forcePartial: boolean,
  details: Readonly<Record<string, unknown>> = {},
): BackendRouteResult {
  const mergedDiagnostics = [...diagnostics, ...(result.diagnostics ?? [])]
  const partial = forcePartial
    || result.status !== "complete"
    || mergedDiagnostics.some((item) => item.severity === "error")
  return {
    ...result,
    status: partial ? "partial" : "complete",
    diagnostics: mergedDiagnostics,
    metrics: {
      ...(result.metrics ?? {}),
      backend: "hybrid",
      details: {
        ...(result.metrics?.details ?? {}),
        hybrid: {
          ...record(result.metrics?.details?.hybrid),
          mode,
          krtNets: partition.krtNets,
          easyedaNets: partition.easyedaNets,
          reasons: partition.reasons,
          ...details,
        },
      },
    },
  }
}

function aggregateHybridResult(
  request: BackendRouteRequest,
  partition: HybridRoutePartition,
  krtResult: BackendRouteResult,
  easyedaResult: BackendRouteResult,
  diagnostics: readonly RoutingDiagnostic[],
): BackendRouteResult {
  const krtOpen = krtResult.metrics?.openNetCount ?? partition.krtNets.length
  const easyedaOpen = easyedaResult.metrics?.openNetCount ?? partition.easyedaNets.length
  const exactOpenNets = [
    ...(krtResult.metrics?.openNets ?? []),
    ...(easyedaResult.metrics?.openNets ?? []),
  ]
  const copper = easyedaResult.copper
  const mergedDiagnostics = [
    ...diagnostics,
    ...(krtResult.diagnostics ?? []),
    ...(easyedaResult.diagnostics ?? []),
  ]
  const partial = krtResult.status !== "complete"
    || easyedaResult.status !== "complete"
    || krtOpen + easyedaOpen > 0
    || mergedDiagnostics.some((item) => item.severity === "error")
  return {
    status: partial ? "partial" : "complete",
    copper,
    diagnostics: mergedDiagnostics,
    metrics: {
      elapsedMs: (krtResult.metrics?.elapsedMs ?? 0) + (easyedaResult.metrics?.elapsedMs ?? 0),
      routedNetCount: Math.max(0, partition.routableNets.length - krtOpen - easyedaOpen),
      openNetCount: krtOpen + easyedaOpen,
      ...(exactOpenNets.length || krtOpen + easyedaOpen === 0
        ? { openNets: [...new Set(exactOpenNets)] }
        : {}),
      connectivityComponentCount:
        (krtResult.metrics?.connectivityComponentCount ?? partition.krtNets.length + krtOpen)
        + (easyedaResult.metrics?.connectivityComponentCount ?? partition.easyedaNets.length + easyedaOpen),
      trackLengthMm: trackLengthMm(copper),
      viaCount: copper.vias.length,
      backend: "hybrid",
      details: {
        hybrid: {
          mode: "hybrid",
          krtNets: partition.krtNets,
          easyedaNets: partition.easyedaNets,
          reasons: partition.reasons,
          stages: {
            krt: { status: krtResult.status, metrics: krtResult.metrics },
            easyeda: { status: easyedaResult.status, metrics: easyedaResult.metrics },
          },
        },
        initialConnectivity: {
          openNets: request.plan.scopeNets,
          connectivityComponentCount: baselineMetrics(request).connectivityComponentCount,
        },
      },
    },
  }
}

function retainedScopeCheckpoint(
  request: BackendRouteRequest,
  copper: RoutingCopper,
): BackendRouteResult {
  return {
    status: "partial",
    copper,
    metrics: {
      ...baselineMetrics(request),
      elapsedMs: 0,
      trackLengthMm: trackLengthMm(copper),
      viaCount: copper.vias.length,
    },
  }
}

function richerResult(
  request: BackendRouteRequest,
  candidates: readonly BackendRouteResult[],
): BackendRouteResult {
  const baseline: BackendRouteResult = {
    status: "partial",
    copper: request.board.copper.editable,
    metrics: baselineMetrics(request),
  }
  let champion: RoutingCandidate | undefined
  for (const [index, result] of [baseline, ...candidates].entries()) {
    const candidate: RoutingCandidate = {
      index: index - 1,
      label: index === 0 ? "hybrid-pre-route-checkpoint" : `hybrid-recovery-${index}`,
      result,
      grade: gradeRoutingCandidate(
        request.board,
        request.program,
        request.rules,
        result,
        index - 1,
      ),
    }
    champion = retainRoutingChampion(champion, candidate)
  }
  return champion?.result ?? baseline
}

function unselectedDiagnostics(
  selected: BackendRouteResult,
  candidates: readonly BackendRouteResult[],
) {
  return candidates.flatMap((candidate) => (
    candidate === selected ? [] : candidate.diagnostics ?? []
  ))
}

async function recoverFromKrtFailure(
  request: BackendRouteRequest,
  partition: HybridRoutePartition,
  krtRecovery: BackendRouteResult,
  krtRecoveryMode: HybridExecutionMode,
  dependencies: HybridBackendDependencies,
  diagnostics: readonly RoutingDiagnostic[],
): Promise<BackendRouteResult> {
  const easyFullRequest = scopeBackendRequest(request, partition.routableNets)
  const easyFullCheck = await checkBackend(
    dependencies.easyeda,
    easyFullRequest,
    "easyeda-full-runtime-fallback",
  )
  if (!easyFullCheck.ready) return enrichResult(krtRecovery, [
    ...diagnostics,
    ...easyFullCheck.diagnostics,
    diagnostic(
      "HYBRID_KRT_RUNTIME_FALLBACK_UNAVAILABLE",
      "warning",
      "KRT failed during routing, and EasyEDA WASM did not pass full-scope fallback preflight.",
    ),
  ], krtRecoveryMode, partition, true, {
    recoverySelected: krtRecoveryMode,
  })

  const easyFull = await safeRoute(
    dependencies.easyeda,
    easyFullRequest,
    "easyeda-full-runtime-fallback",
  )
  const recoveryCandidates = [krtRecovery, easyFull]
  const selected = richerResult(request, recoveryCandidates)
  const recoveryMode = selected === easyFull
    ? "easyeda-full"
    : selected === krtRecovery ? krtRecoveryMode : "none"
  return enrichResult(selected, [
    ...diagnostics,
    ...easyFullCheck.diagnostics,
    ...unselectedDiagnostics(selected, recoveryCandidates),
    diagnostic(
      "HYBRID_KRT_RUNTIME_FALLBACK",
      "warning",
      "KRT failed during routing; EasyEDA WASM was retried on the full routable scope.",
    ),
  ], recoveryMode, partition, true, {
    recoverySelected: recoveryMode,
  })
}

async function recoverFromEasyEdaFailure(
  request: BackendRouteRequest,
  partition: HybridRoutePartition,
  easyedaRecovery: BackendRouteResult,
  easyedaRecoveryMode: HybridExecutionMode,
  dependencies: HybridBackendDependencies,
  diagnostics: readonly RoutingDiagnostic[],
): Promise<BackendRouteResult> {
  const krtFullCheck = await checkBackend(
    dependencies.krt,
    request,
    "krt-full-runtime-fallback",
  )
  if (!krtFullCheck.ready) return enrichResult(easyedaRecovery, [
    ...diagnostics,
    ...krtFullCheck.diagnostics,
    diagnostic(
      "HYBRID_EASYEDA_RUNTIME_FALLBACK_UNAVAILABLE",
      "warning",
      "EasyEDA WASM failed during routing, and KRT did not pass full-scope fallback preflight.",
    ),
  ], easyedaRecoveryMode, partition, true, {
    recoverySelected: easyedaRecoveryMode,
  })

  // The original request is intentional: KRT owns its complete native-auto
  // workflow and must not receive a reimplemented or widened Hybrid variant.
  const krtFull = await safeRoute(dependencies.krt, request, "krt-full-runtime-fallback")
  const recoveryCandidates = [easyedaRecovery, krtFull]
  const selected = richerResult(request, recoveryCandidates)
  const recoveryMode = selected === krtFull
    ? "krt-full"
    : selected === easyedaRecovery ? easyedaRecoveryMode : "none"
  return enrichResult(selected, [
    ...diagnostics,
    ...krtFullCheck.diagnostics,
    ...unselectedDiagnostics(selected, recoveryCandidates),
    diagnostic(
      "HYBRID_EASYEDA_RUNTIME_FALLBACK",
      "warning",
      "EasyEDA WASM failed during routing; KRT was retried on the original full request.",
    ),
  ], recoveryMode, partition, true, {
    recoverySelected: recoveryMode,
  })
}

async function executePlan(
  request: BackendRouteRequest,
  plan: HybridExecutionPlan,
  dependencies: HybridBackendDependencies,
): Promise<BackendRouteResult> {
  const selectedDiagnostic = diagnostic(
    "HYBRID_ROUTE_MODE_SELECTED",
    "info",
    `Hybrid routing selected ${plan.mode}.`,
    { mode: plan.mode, fallback: plan.fallback, reason: plan.reason },
  )
  const planDiagnostics = [...plan.diagnostics, selectedDiagnostic]

  if (plan.mode === "noop") return {
    status: "complete",
    copper: request.board.copper.editable,
    diagnostics: planDiagnostics,
    metrics: {
      elapsedMs: 0,
      routedNetCount: 0,
      openNetCount: 0,
      openNets: [],
      connectivityComponentCount: request.plan.scopeNets.length,
      viaCount: request.board.copper.editable.vias.length,
      trackLengthMm: trackLengthMm(request.board.copper.editable),
      backend: "hybrid",
      details: { hybrid: { mode: "noop" } },
    },
  }

  if (plan.mode === "none") return {
    status: "partial",
    copper: request.board.copper.editable,
    diagnostics: [
      ...planDiagnostics,
      diagnostic(
        "HYBRID_NO_BACKEND_AVAILABLE",
        "error",
        "Neither KRT nor EasyEDA WASM could be started; the incoming editable checkpoint was retained.",
      ),
    ],
    metrics: {
      ...baselineMetrics(request),
      elapsedMs: 0,
      backend: "hybrid",
      details: { hybrid: { mode: "none", reason: plan.reason } },
    },
  }

  if (plan.mode === "krt-full" || plan.mode === "krt-scoped") {
    const result = await safeRoute(dependencies.krt, plan.krtRequest!, plan.mode)
    if (!plan.fallback && stageFailed(result, "krt")) return recoverFromKrtFailure(
      request,
      plan.partition,
      result,
      plan.mode,
      dependencies,
      planDiagnostics,
    )
    return enrichResult(result, planDiagnostics, plan.mode, plan.partition, plan.fallback, {
      fallbackReason: plan.reason,
    })
  }

  if (plan.mode === "easyeda-only" || plan.mode === "easyeda-full") {
    const result = await safeRoute(dependencies.easyeda, plan.easyedaRequest!, plan.mode)
    if (!plan.fallback && stageFailed(result, "easyeda")) return recoverFromEasyEdaFailure(
      request,
      plan.partition,
      result,
      plan.mode,
      dependencies,
      planDiagnostics,
    )
    return enrichResult(result, planDiagnostics, plan.mode, plan.partition, plan.fallback, {
      fallbackReason: plan.reason,
    })
  }

  const krtResult = await safeRoute(dependencies.krt, plan.krtRequest!, "krt-constrained")
  if (stageFailed(krtResult, "krt")) {
    const untouchedEasyScope = scopeBackendRequest(
      withEditableCopper(request, krtResult.copper),
      plan.partition.easyedaNets,
    )
    const krtRecovery = aggregateHybridResult(
      request,
      plan.partition,
      krtResult,
      retainedScopeCheckpoint(untouchedEasyScope, krtResult.copper),
      [],
    )
    return recoverFromKrtFailure(
      request,
      plan.partition,
      krtRecovery,
      "hybrid",
      dependencies,
      planDiagnostics,
    )
  }

  const stagedRequest = scopeBackendRequest(
    withEditableCopper(request, krtResult.copper),
    plan.partition.easyedaNets,
  )
  const easyedaResult = await safeRoute(dependencies.easyeda, stagedRequest, "easyeda-remaining")
  if (stageFailed(easyedaResult, "easyeda")) {
    const stagedRecovery = aggregateHybridResult(
      request,
      plan.partition,
      krtResult,
      easyedaResult,
      [],
    )
    return recoverFromEasyEdaFailure(
      request,
      plan.partition,
      stagedRecovery,
      "hybrid",
      dependencies,
      planDiagnostics,
    )
  }

  return aggregateHybridResult(request, plan.partition, krtResult, easyedaResult, planDiagnostics)
}

/**
 * Production routing strategy. KRT and EasyEDA remain independent leaf
 * backends; this adapter owns only scope partitioning and bounded fallback.
 */
export function createHybridBackend(
  options: HybridBackendOptions = {},
  injected?: HybridBackendDependencies,
): RouterBackendAdapter {
  const dependencies: HybridBackendDependencies = injected ?? {
    krt: createKrtBackend(options.krt),
    easyeda: createBundledEasyEdaWasmBackend(options.easyeda),
  }
  const prepared = new WeakMap<BackendRouteRequest, Promise<HybridExecutionPlan>>()
  const execution = (request: BackendRouteRequest) => {
    let current = prepared.get(request)
    if (!current) {
      current = prepareExecution(request, dependencies).catch((error): HybridExecutionPlan => ({
        mode: "none",
        partition: {
          routableNets: [],
          krtNets: [],
          easyedaNets: [],
          reasons: {},
        },
        diagnostics: [diagnostic(
          "HYBRID_PREPARE_EXCEPTION",
          "error",
          "Hybrid routing could not prepare its internal scope plan; the incoming editable checkpoint will be retained.",
          { error: errorMessage(error) },
        )],
        fallback: true,
        reason: "Hybrid scope preparation failed.",
      }))
      prepared.set(request, current)
    }
    return current
  }

  return {
    id: "hybrid",
    // The production strategy satisfies the same semantic surface as KRT when
    // KRT is available. Runtime degradation is explicit and always partial.
    capabilities: dependencies.krt.capabilities,
    async preflight(request) {
      return publicPreflightDiagnostics(await execution(request))
    },
    async route(request) {
      const plan = await execution(request)
      try {
        return await executePlan(request, plan, dependencies)
      } catch (error) {
        return {
          status: "partial",
          copper: request.board.copper.editable,
          diagnostics: [
            ...plan.diagnostics,
            diagnostic(
              "HYBRID_ROUTE_EXCEPTION",
              "error",
              "Hybrid routing failed unexpectedly; the incoming editable checkpoint was retained.",
              { error: errorMessage(error) },
            ),
          ],
          metrics: {
            ...baselineMetrics(request),
            elapsedMs: 0,
            backend: "hybrid",
            details: { hybrid: { mode: "unexpected-exception" } },
          },
        }
      }
    },
  }
}
