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
import {
  createKrtBackend,
  createKrtPostEasyBackend,
  krtPostEasyReservedNets,
  type KrtBackendOptions,
} from "./krt.js"
import { withKrtPreRouteBaseline } from "./krt-baseline.js"

export type HybridBackendOptions = Readonly<{
  krt?: KrtBackendOptions
  easyeda?: BundledEasyEdaWasmBackendOptions
}>

export type HybridBackendDependencies = Readonly<{
  krt: RouterBackendAdapter
  easyeda: RouterBackendAdapter
}>

type HybridRuntimeDependencies = Readonly<{
  krtFull: RouterBackendAdapter
  krtPostEasy: RouterBackendAdapter
  easyeda: RouterBackendAdapter
}>

export type HybridRoutePartition = Readonly<{
  routableNets: readonly string[]
  /** Final hard-semantics custody. This is a subset of easyedaNets on two layers. */
  krtNets: readonly string[]
  /** Provisional EasyEDA planning scope. It intentionally overlaps krtNets. */
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

type ProvisionalCustodyReset = Readonly<{
  copper: RoutingCopper
  removed: Readonly<{ tracks: number; vias: number; zones: number }>
  restored: Readonly<{ tracks: number; vias: number; zones: number }>
  retainedCompliantNets: readonly string[]
}>

const LOCALLY_VERIFIABLE_CUSTODY_REASONS = new Set([
  "via-forbid",
  "per-net-layers",
  // The shared KRT selector adds this umbrella reason to every custody net.
  "krt-dependent",
])

function provisionalCopperSatisfiesLocalCustody(
  request: BackendRouteRequest,
  copper: RoutingCopper,
  net: string,
  reasons: readonly string[],
) {
  const specific = reasons.filter((reason) => reason !== "krt-dependent")
  if (!specific.length || specific.some((reason) => !LOCALLY_VERIFIABLE_CUSTODY_REASONS.has(reason))) {
    return false
  }
  const hasCopper = copper.tracks.some((track) => track.net === net)
    || copper.vias.some((via) => via.net === net)
    || copper.zones.some((zone) => zone.net === net)
  if (!hasCopper) return false
  const viaForbid = specific.includes("via-forbid")
  const layerRestricted = specific.includes("per-net-layers")
  if (viaForbid && copper.vias.some((via) => via.net === net)) return false
  if (!layerRestricted) return true

  const allowed = new Set(ruleFor(request, net).allowedLayers ?? [])
  if (!allowed.size) return false
  if (copper.tracks.some((track) => track.net === net && !allowed.has(track.layer))) return false
  if (copper.vias.some((via) => via.net === net
    && (!allowed.has(via.fromLayer) || !allowed.has(via.toLayer)))) return false
  if (copper.zones.some((zone) => zone.net === net
    && zone.layers.some((layer) => !allowed.has(layer)))) return false
  return true
}

/**
 * Remove EasyEDA copper whose final semantics cannot be verified locally.
 * Via-forbid/layer-only custody survives when every returned primitive already
 * satisfies the restriction; KRT still audits that connected checkpoint.
 * Incoming editable copper for reset nets is restored exactly, while fixed
 * copper is outside this replacement object and remains untouched.
 */
function resetProvisionalKrtCustody(
  request: BackendRouteRequest,
  easyedaCopper: RoutingCopper,
  partition: HybridRoutePartition,
): ProvisionalCustodyReset {
  const retainedCompliantNets = partition.krtNets.filter((net) => (
    provisionalCopperSatisfiesLocalCustody(
      request,
      easyedaCopper,
      net,
      partition.reasons[net] ?? [],
    )
  ))
  const retained = new Set(retainedCompliantNets)
  const custody = new Set(partition.krtNets.filter((net) => !retained.has(net)))
  if (!custody.size) return {
    copper: easyedaCopper,
    removed: { tracks: 0, vias: 0, zones: 0 },
    restored: { tracks: 0, vias: 0, zones: 0 },
    retainedCompliantNets,
  }
  const generatedForCustody = (item: { net?: string }) => Boolean(item.net && custody.has(item.net))
  const incomingForCustody = (item: { net?: string }) => Boolean(item.net && custody.has(item.net))
  const incoming = request.board.copper.editable
  const removed = {
    tracks: easyedaCopper.tracks.filter(generatedForCustody).length,
    vias: easyedaCopper.vias.filter(generatedForCustody).length,
    zones: easyedaCopper.zones.filter(generatedForCustody).length,
  }
  const restored = {
    tracks: incoming.tracks.filter(incomingForCustody).length,
    vias: incoming.vias.filter(incomingForCustody).length,
    zones: incoming.zones.filter(incomingForCustody).length,
  }
  return {
    copper: {
      tracks: [
        ...easyedaCopper.tracks.filter((item) => !generatedForCustody(item)),
        ...incoming.tracks.filter(incomingForCustody),
      ],
      vias: [
        ...easyedaCopper.vias.filter((item) => !generatedForCustody(item)),
        ...incoming.vias.filter(incomingForCustody),
      ],
      zones: [
        ...easyedaCopper.zones.filter((item) => !generatedForCustody(item)),
        ...incoming.zones.filter(incomingForCustody),
      ],
    },
    removed,
    restored,
    retainedCompliantNets,
  }
}

/**
 * Select provisional planning scope and final hard-semantics custody.
 *
 * These are intentionally overlapping sets: EasyEDA sees the complete
 * two-layer routing problem, while KRT later owns the final audit and replaces
 * copper whose semantics cannot be proven by the local via/layer gate.
 */
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

  for (const group of request.program.matchedGroups) for (const net of group.nets) claim(net, "matched")
  for (const group of request.rules.matchedGroups ?? []) {
    for (const net of group.nets) claim(net, "effective-matched-relation")
  }
  for (const intent of request.program.signalNets) if (intent.impedance) claim(intent.net, "impedance")
  for (const policy of request.plan.netPolicies) {
    if (policy.viaPreference === "forbid") claim(policy.net, "via-forbid")
  }
  for (const fanout of request.program.fanouts) {
    for (const net of fanoutTargetNets(request, fanout)) claim(net, "fanout")
  }

  const allLayers = request.board.layers.map((layer) => layer.name)
  for (const net of routableNets) {
    const rule = ruleFor(request, net)
    if (rule.impedanceOhm !== undefined) claim(net, "compiled-impedance-rule")
    if (rule.allowedLayers && !sameStrings(rule.allowedLayers, allLayers)) claim(net, "per-net-layers")
  }

  // Keep the shared KRT policy authoritative if a new internal hard intent is
  // added later; Hybrid only supplies human-readable reasons.
  for (const net of krtPostEasyReservedNets(request)) claim(net, "krt-dependent")

  return {
    routableNets,
    krtNets: routableNets.filter((net) => krt.has(net)),
    // EasyEDA is the global two-layer planner, including provisional routes
    // for KRT-custody nets. The overlap is what preserves useful corridors.
    easyedaNets: routableNets,
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
  dependencies: HybridRuntimeDependencies,
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
    const krt = await checkBackend(dependencies.krtFull, request, "krt-full")
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

  // EasyEDA receives the complete two-layer routing problem as a provisional
  // global plan. Post-Easy KRT receives the whole request so its transaction
  // can replace hard-custody copper and repair exact EasyEDA victims. Its
  // internal mode still routes only reserved constraints plus genuinely open
  // nets.
  // Even a board with no pre-reserved KRT nets may leave ordinary EasyEDA
  // opens.  Keep one post-Easy KRT transaction available so it can route only
  // those exact leftovers and run the shared bounded recovery stage.
  const krtScopedRequest = request
  const easyScopedRequest = partition.easyedaNets.length
    ? scopeBackendRequest(request, partition.easyedaNets)
    : undefined
  const [krtScoped, easyScoped] = await Promise.all([
    krtScopedRequest
      ? checkBackend(dependencies.krtPostEasy, krtScopedRequest, "krt-post-easy")
      : Promise.resolve(undefined),
    easyScopedRequest
      ? checkBackend(dependencies.easyeda, easyScopedRequest, "easyeda-global-provisional")
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
  if (!easyScopedRequest && krtScoped?.ready) return {
    mode: "krt-scoped", partition, diagnostics: scopedDiagnostics,
    krtRequest: krtScopedRequest,
    fallback: false,
  }

  if (!partition.krtNets.length && easyScoped?.ready && !krtScoped?.ready) return {
    mode: "easyeda-only", partition, diagnostics: scopedDiagnostics,
    easyedaRequest: easyScopedRequest,
    fallback: true,
    reason: "KRT post-Easy completion/repair preflight failed.",
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

  const krtFull = await checkBackend(dependencies.krtFull, request, "krt-full-fallback")
  if (krtFull.ready) return {
    mode: "krt-full", partition,
    diagnostics: [...scopedDiagnostics, ...krtFull.diagnostics],
    krtRequest: request,
    fallback: true,
    reason: "EasyEDA WASM global provisional preflight failed.",
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
  custodyReset?: ProvisionalCustodyReset,
): BackendRouteResult {
  // Post-Easy KRT audits the complete request, including ordinary EasyEDA
  // copper and any victims it moved. Its final metrics are therefore the one
  // authoritative connectivity snapshot; summing two scoped counters would
  // double-count or miss cross-stage damage.
  const finalOpen = krtResult.metrics?.openNetCount ?? partition.routableNets.length
  const copper = krtResult.copper
  const mergedDiagnostics = [
    ...diagnostics,
    ...(easyedaResult.diagnostics ?? []),
    ...(krtResult.diagnostics ?? []),
  ]
  const partial = krtResult.status !== "complete"
    || finalOpen > 0
    || mergedDiagnostics.some((item) => item.severity === "error")
  return {
    status: partial ? "partial" : "complete",
    copper,
    diagnostics: mergedDiagnostics,
    metrics: {
      ...(krtResult.metrics ?? {}),
      elapsedMs: (krtResult.metrics?.elapsedMs ?? 0) + (easyedaResult.metrics?.elapsedMs ?? 0),
      routedNetCount: krtResult.metrics?.routedNetCount
        ?? Math.max(0, partition.routableNets.length - finalOpen),
      openNetCount: finalOpen,
      trackLengthMm: trackLengthMm(copper),
      viaCount: copper.vias.length,
      backend: "hybrid",
      details: {
        ...(krtResult.metrics?.details ?? {}),
        hybrid: {
          mode: "hybrid",
          krtNets: partition.krtNets,
          easyedaNets: partition.easyedaNets,
          reasons: partition.reasons,
          stages: {
            easyedaBulk: { status: easyedaResult.status, metrics: easyedaResult.metrics },
            krtPostEasy: { status: krtResult.status, metrics: krtResult.metrics },
          },
          ...(custodyReset ? {
            provisionalKrtCustody: {
              nets: partition.krtNets,
              removed: custodyReset.removed,
              restoredIncoming: custodyReset.restored,
              retainedCompliantNets: custodyReset.retainedCompliantNets,
            },
          } : {}),
        },
        hybridInput: {
          openNets: request.plan.scopeNets,
          connectivityComponentCount: baselineMetrics(request).connectivityComponentCount,
        },
      },
    },
  }
}

function conservativeEasyCheckpoint(
  request: BackendRouteRequest,
  partition: HybridRoutePartition,
  easyCheckpoint: BackendRouteResult,
): BackendRouteResult {
  const reportedEasyOpen = easyCheckpoint.metrics?.openNets
    ?? (easyCheckpoint.status === "complete" ? [] : partition.easyedaNets)
  const openNets = [...new Set([
    ...partition.krtNets,
    ...reportedEasyOpen,
  ])]
  const easyComponents = easyCheckpoint.metrics?.connectivityComponentCount
    ?? partition.easyedaNets.reduce((sum, net) => (
      sum + Math.max(1, request.board.pads.filter((pad) => pad.net === net).length)
    ), 0)
  const reservedComponents = partition.krtNets.reduce((sum, net) => (
    sum + Math.max(1, request.board.pads.filter((pad) => pad.net === net).length)
  ), 0)
  return {
    ...easyCheckpoint,
    status: "partial",
    metrics: {
      ...(easyCheckpoint.metrics ?? {}),
      openNetCount: openNets.length,
      openNets,
      connectivityComponentCount: easyComponents + reservedComponents,
      routedNetCount: Math.max(0, partition.routableNets.length - openNets.length),
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
  dependencies: HybridRuntimeDependencies,
  diagnostics: readonly RoutingDiagnostic[],
  easyCheckpoint?: BackendRouteResult,
): Promise<BackendRouteResult> {
  if (easyCheckpoint) {
    // EasyEDA has already run once. Never start a second WASM route solely for
    // hard-special opens: retain the richer of its checkpoint and KRT's last
    // readable checkpoint, with every failure visible as partial diagnostics.
    const easyFallback = conservativeEasyCheckpoint(request, partition, easyCheckpoint)
    const recoveryCandidates = [easyFallback, krtRecovery]
    const selected = richerResult(request, recoveryCandidates)
    const recoveryMode = selected === krtRecovery ? krtRecoveryMode : "hybrid"
    return enrichResult(selected, [
      ...diagnostics,
      ...unselectedDiagnostics(selected, recoveryCandidates),
      ...(selected !== krtRecovery && partition.krtNets.length ? [diagnostic(
        "HYBRID_HARD_CONSTRAINTS_UNVERIFIED_FALLBACK",
        "warning",
        "Late KRT routing failed; the retained non-KRT checkpoint does not verify matched-length, impedance, fanout, layer, or via-forbid semantics. Any provisional EasyEDA copper for those nets must be treated as unfinished.",
        { nets: partition.krtNets },
      )] : []),
      diagnostic(
        "HYBRID_KRT_CHECKPOINT_FALLBACK",
        "warning",
        "Late KRT routing failed; no second EasyEDA process was started and the best existing partial checkpoint was retained.",
      ),
    ], recoveryMode, partition, true, {
      recoverySelected: recoveryMode,
    })
  }

  // A KRT-only/full plan has not spent its EasyEDA attempt. If KRT passes
  // preflight but then cannot start or fails before a useful checkpoint, keep
  // the original last-resort contract: try EasyEDA exactly once on full
  // routable scope and rank both partial checkpoints.
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
      "KRT failed before an EasyEDA pass, and EasyEDA WASM did not pass full-scope fallback preflight.",
    ),
  ], krtRecoveryMode, partition, true, {
    recoverySelected: krtRecoveryMode,
  })

  const easyFullResult = await safeRoute(
    dependencies.easyeda,
    easyFullRequest,
    "easyeda-full-runtime-fallback",
  )
  const easyFallback = enrichResult(easyFullResult, partition.krtNets.length ? [diagnostic(
    "HYBRID_HARD_CONSTRAINTS_UNVERIFIED_FALLBACK",
    "warning",
    "EasyEDA full runtime fallback copper was retained, but matched-length and impedance/KRT-only semantics remain unverified.",
    { nets: partition.krtNets },
  )] : [], "easyeda-full", partition, true)
  const recoveryCandidates = [krtRecovery, easyFallback]
  const selected = richerResult(request, recoveryCandidates)
  const recoveryMode = selected === krtRecovery
    ? krtRecoveryMode
    : selected === easyFallback ? "easyeda-full" : "none"
  return enrichResult(selected, [
    ...diagnostics,
    ...easyFullCheck.diagnostics,
    ...unselectedDiagnostics(selected, recoveryCandidates),
    diagnostic(
      "HYBRID_KRT_RUNTIME_FALLBACK",
      "warning",
      "KRT failed before an EasyEDA pass; EasyEDA WASM was attempted once on the full routable scope.",
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
  dependencies: HybridRuntimeDependencies,
  diagnostics: readonly RoutingDiagnostic[],
): Promise<BackendRouteResult> {
  const conservativeEasy = conservativeEasyCheckpoint(request, partition, easyedaRecovery)
  const krtFullCheck = await checkBackend(
    dependencies.krtFull,
    request,
    "krt-full-runtime-fallback",
  )
  if (!krtFullCheck.ready) return enrichResult(conservativeEasy, [
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
  const krtInput = withEditableCopper(request, easyedaRecovery.copper)
  const krtFull = await safeRoute(dependencies.krtFull, krtInput, "krt-full-runtime-fallback")
  const recoveryCandidates = [conservativeEasy, krtFull]
  const selected = richerResult(request, recoveryCandidates)
  const recoveryMode = selected === krtFull
    ? "krt-full"
    : selected === conservativeEasy ? easyedaRecoveryMode : "none"
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
  dependencies: HybridRuntimeDependencies,
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
    const backend = plan.mode === "krt-full" ? dependencies.krtFull : dependencies.krtPostEasy
    const result = await safeRoute(backend, plan.krtRequest!, plan.mode)
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
    const fallbackDiagnostics = plan.mode === "easyeda-full" && plan.partition.krtNets.length
      ? [diagnostic(
          "HYBRID_HARD_CONSTRAINTS_UNVERIFIED_FALLBACK",
          "warning",
          "EasyEDA full fallback copper was retained, but matched-length and impedance/KRT-only semantics remain unverified.",
          { nets: plan.partition.krtNets },
        )]
      : []
    return enrichResult(result, [...planDiagnostics, ...fallbackDiagnostics], plan.mode, plan.partition, plan.fallback, {
      fallbackReason: plan.reason,
    })
  }

  const easyedaResult = await safeRoute(dependencies.easyeda, plan.easyedaRequest!, "easyeda-bulk")
  if (stageFailed(easyedaResult, "easyeda")) {
    return recoverFromEasyEdaFailure(
      request,
      plan.partition,
      easyedaResult,
      "hybrid",
      dependencies,
      planDiagnostics,
    )
  }

  const custodyReset = resetProvisionalKrtCustody(
    request,
    easyedaResult.copper,
    plan.partition,
  )
  const stagedRequest = withKrtPreRouteBaseline(
    withEditableCopper(request, custodyReset.copper),
    request,
  )
  const krtResult = await safeRoute(dependencies.krtPostEasy, stagedRequest, "krt-post-easy")
  if (stageFailed(krtResult, "krt")) return recoverFromKrtFailure(
    request,
    plan.partition,
    krtResult,
    "hybrid",
    dependencies,
    planDiagnostics,
    easyedaResult,
  )

  return aggregateHybridResult(
    request,
    plan.partition,
    krtResult,
    easyedaResult,
    planDiagnostics,
    custodyReset,
  )
}

/**
 * Production routing strategy. KRT and EasyEDA remain independent leaf
 * backends; this adapter owns only scope partitioning and bounded fallback.
 */
export function createHybridBackend(
  options: HybridBackendOptions = {},
  injected?: HybridBackendDependencies,
): RouterBackendAdapter {
  const dependencies: HybridRuntimeDependencies = injected
    ? { krtFull: injected.krt, krtPostEasy: injected.krt, easyeda: injected.easyeda }
    : {
        krtFull: createKrtBackend(options.krt),
        krtPostEasy: createKrtPostEasyBackend(options.krt),
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
    capabilities: dependencies.krtFull.capabilities,
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
