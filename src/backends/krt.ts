import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type {
  BackendRouteRequest,
  BackendRouteResult,
  RouterBackendAdapter,
} from "../adapters/contracts.js"
import type {
  RoutingCopper,
  RoutingDiagnostic,
  RoutingRuleValues,
} from "../core/contracts.js"
import {
  runKrtRemaining,
  runKrtSpecial,
  type KrtDiagnostic,
  type KrtNumericRules,
  type KrtProcessResult,
  type KrtStageSpec,
} from "./krt-adapter.js"
import { RouterAssetError, type RouterAssetPolicy } from "./assets.js"
import {
  prepareKrtRuntime,
  type PreparedKrtRuntime,
} from "./krt-runtime.js"

export { KRT_REQUIRED_NECKDOWN_ENVIRONMENT } from "./krt-adapter.js"

export {
  KRT_MANAGED_VERSION,
  krtManagedRelease,
  prepareKrtRuntime,
  readKrtLicense,
  type KrtRuntimeOptions,
  type PreparedKrtRuntime,
} from "./krt-runtime.js"

export type KrtBoardTransportResult = Readonly<{
  inputBoard: string
  diagnostics?: readonly RoutingDiagnostic[]
}>

export type KrtBoardReadResult = Readonly<{
  copper: RoutingCopper
  diagnostics?: readonly RoutingDiagnostic[]
}>

/**
 * KRT itself consumes KiCad files. The EDA host owns this narrow transport,
 * while KRT stage selection, rule compilation and process custody stay here.
 */
export interface KrtBoardTransport {
  prepare(request: BackendRouteRequest, directory: string): Promise<KrtBoardTransportResult>
  read(
    request: BackendRouteRequest,
    preparedBoard: string,
    routedBoard: string,
  ): Promise<KrtBoardReadResult>
}

export type KrtBackendOptions = Readonly<{
  transport: KrtBoardTransport
  /** Optional development override. Normal package use lazily prepares KRT. */
  krtDirectory?: string
  pythonPath?: string
  assets?: RouterAssetPolicy
  artifactsDirectory?: string
  keepArtifacts?: boolean
  /** @deprecated Ignored. Cancel routing through BackendRouteRequest.signal. */
  timeoutMs?: number
}>

const EMPTY_COPPER: RoutingCopper = { tracks: [], vias: [], zones: [] }
const HARD_MIN_TRACK_WIDTH_MM = 0.127

function diagnostic(code: string, severity: RoutingDiagnostic["severity"], message: string, details?: unknown): RoutingDiagnostic {
  return { code, severity, message, ...(details === undefined ? {} : { details }) }
}

function convertDiagnostics(source: readonly KrtDiagnostic[]): RoutingDiagnostic[] {
  return source.map((item) => ({
    code: item.code,
    severity: item.severity,
    message: item.message,
    ...(item.details === undefined ? {} : { details: item.details }),
  }))
}

/**
 * Resolve KRT for support tooling. With no local override this performs the
 * same verified lazy preparation used by createKrtBackend().
 */
export async function discoverKrtDirectory(explicit?: string, assets?: RouterAssetPolicy) {
  return (await prepareKrtRuntime({ krtDirectory: explicit, assets })).directory
}

function ruleFor(request: BackendRouteRequest, net: string) {
  return request.rules.nets.find((item) => item.net === net)?.values ?? request.rules.default
}

function orderedScopeNets(request: BackendRouteRequest) {
  const boardNets = request.board.nets.map((item) => item.name)
  if (!request.program.onlyNets) return boardNets
  const known = new Set(boardNets)
  return request.program.onlyNets.filter((net) => known.has(net))
}

function routeLayersFor(request: BackendRouteRequest, nets: readonly string[]) {
  const constrained = nets
    .map((net) => ruleFor(request, net).allowedLayers)
    .filter((layers): layers is readonly string[] => Boolean(layers?.length))
  if (constrained.length !== nets.length) return request.board.layers.map((item) => item.name)
  const allowed = new Set(constrained.flat())
  return request.board.layers.map((item) => item.name).filter((layer) => allowed.has(layer))
}

function sameNumber(values: readonly number[], epsilon = 1e-9) {
  return !values.length || values.every((value) => Math.abs(value - values[0]) <= epsilon)
}

function specialRules(request: BackendRouteRequest): { rules?: KrtNumericRules; diagnostics: RoutingDiagnostic[] } {
  const specialNets = new Set([
    ...request.program.differentialPairs.flatMap((pair) => [pair.positive, pair.negative]),
    ...request.program.matchedGroups.flatMap((group) => group.nets),
  ])
  if (!specialNets.size) return { diagnostics: [] }
  const values = [...specialNets].map((net) => ruleFor(request, net))
  const widths = values.map((item) => item.differential?.trackWidthMm ?? item.preferredTrackWidthMm)
  const clearances = values.map((item) => item.clearanceMm)
  const viaSizes = values.map((item) => item.via.preferredDiameterMm)
  const viaDrills = values.map((item) => item.via.preferredDrillMm)
  const gaps = request.program.differentialPairs.map((pair) => (
    ruleFor(request, pair.positive).differential?.gapMm
      ?? ruleFor(request, pair.negative).differential?.gapMm
      ?? Math.max(ruleFor(request, pair.positive).clearanceMm, ruleFor(request, pair.negative).clearanceMm)
  ))
  if (![widths, clearances, viaSizes, viaDrills, gaps].every(sameNumber)) return {
    diagnostics: [diagnostic(
      "KRT_SPECIAL_RULE_CONFLICT",
      "error",
      "One atomic KRT special stage requires one compatible width, clearance, via geometry and differential gap.",
      { widths, clearances, viaSizes, viaDrills, gaps },
    )],
  }
  const tolerance = request.program.matchedGroups.length
    ? Math.min(...request.program.matchedGroups.map((group) => (
      request.rules.matchedGroups?.find((item) => item.id === group.id)?.toleranceMm ?? 0.1
    )))
    : Math.min(...values.map((item) => item.differential?.maxSkewMm ?? 0.1))
  return {
    diagnostics: [],
    rules: {
      trackWidth: Math.max(HARD_MIN_TRACK_WIDTH_MM, widths[0]),
      clearance: clearances[0],
      viaSize: viaSizes[0],
      viaDrill: viaDrills[0],
      diffPairGap: gaps[0] ?? clearances[0],
      gridStep: 0.05,
      lengthMatchTolerance: tolerance,
      meanderAmplitude: request.policy?.meander?.amplitudeMm ?? 0.2,
      meanderSpacing: request.policy?.meander?.spacingMm ?? Math.max(widths[0] * 2, 0.2),
    },
  }
}

function minimumRules(values: readonly RoutingRuleValues[]): KrtNumericRules {
  const source = values.length ? values : []
  const first = source[0]
  return {
    trackWidth: Math.max(HARD_MIN_TRACK_WIDTH_MM, Math.min(...source.map((item) => item.minTrackWidthMm))),
    clearance: Math.min(...source.map((item) => item.clearanceMm)),
    viaSize: Math.min(...source.map((item) => item.via.minDiameterMm)),
    viaDrill: Math.min(...source.map((item) => item.via.minDrillMm)),
    gridStep: 0.05,
    boardEdgeClearance: first?.edgeClearanceMm,
  }
}

function routedCopperRuleDiagnostics(request: BackendRouteRequest, copper: RoutingCopper) {
  const narrowTracks = copper.tracks.flatMap((track) => {
    const minimum = Math.max(HARD_MIN_TRACK_WIDTH_MM, ruleFor(request, track.net).minTrackWidthMm)
    return track.widthMm + 1e-9 < minimum
      ? [{ net: track.net, layer: track.layer, actualMm: track.widthMm, minimumMm: minimum }]
      : []
  })
  const undersizedVias = copper.vias.flatMap((via) => {
    const rules = ruleFor(request, via.net).via
    return via.diameterMm + 1e-9 < rules.minDiameterMm || via.drillMm + 1e-9 < rules.minDrillMm
      ? [{
        net: via.net,
        actualDiameterMm: via.diameterMm,
        actualDrillMm: via.drillMm,
        minimumDiameterMm: rules.minDiameterMm,
        minimumDrillMm: rules.minDrillMm,
      }]
      : []
  })
  const diagnostics: RoutingDiagnostic[] = []
  if (narrowTracks.length) diagnostics.push(diagnostic(
    "KRT_TRACK_WIDTH_BELOW_HARD_MINIMUM",
    "error",
    `KRT produced ${narrowTracks.length} track segment(s) below the compiled hard minimum; the routed delta was rejected.`,
    { hardMinimumMm: HARD_MIN_TRACK_WIDTH_MM, samples: narrowTracks.slice(0, 16) },
  ))
  if (undersizedVias.length) diagnostics.push(diagnostic(
    "KRT_VIA_BELOW_HARD_MINIMUM",
    "error",
    `KRT produced ${undersizedVias.length} via(s) below the compiled hard minimum; the routed delta was rejected.`,
    { samples: undersizedVias.slice(0, 16) },
  ))
  return diagnostics
}

async function writeFabOverrides(path: string, values: KrtNumericRules) {
  const annular = Math.max((values.viaSize - values.viaDrill) / 2, 0.001)
  const hole = Math.max(values.clearance, 0.001)
  await writeFile(path, [
    `track_width = ${values.trackWidth}`,
    `clearance = ${values.clearance}`,
    `via_diameter = ${values.viaSize}`,
    `via_drill = ${values.viaDrill}`,
    `hole_to_hole = ${hole}`,
    `pad_hole_to_hole = ${hole}`,
    `annular = ${annular}`,
    `board_edge = ${Math.max(values.boardEdgeClearance ?? values.clearance, 0.001)}`,
    "",
  ].join("\n"))
}

function fullyPreconnectedNets(request: BackendRouteRequest) {
  const padCounts = new Map<string, number>()
  for (const pad of request.board.pads) if (pad.net) padCounts.set(pad.net, (padCounts.get(pad.net) ?? 0) + 1)
  const groups = request.connectivity?.preconnectedPadGroups ?? []
  return new Set(groups.filter((group) => {
    const uniquePads = new Set(group.pads.map((pad) => `${pad.component}\u0000${pad.pad}`))
    return uniquePads.size >= 2 && uniquePads.size === padCounts.get(group.net)
  }).map((group) => group.net))
}

export const KRT_QUALITY_PROFILES = Object.freeze({
  fast: Object.freeze({
    maxIterations: 120_000,
    maxProbeIterations: 8_000,
    maxRipup: 2,
    heuristicWeight: 1.8,
  }),
  balanced: Object.freeze({
    maxIterations: 350_000,
    maxProbeIterations: 20_000,
    maxRipup: 5,
    heuristicWeight: 1.6,
  }),
  "quality-first": Object.freeze({
    maxIterations: 1_000_000,
    maxProbeIterations: 50_000,
    maxRipup: 5,
    heuristicWeight: 1.2,
  }),
  "completion-first": Object.freeze({
    maxIterations: 1_500_000,
    maxProbeIterations: 100_000,
    maxRipup: 12,
    heuristicWeight: 1.5,
  }),
} as const)

function routeQuality(request: BackendRouteRequest) {
  switch (request.policy?.profile) {
    case "fast": return KRT_QUALITY_PROFILES.fast
    case "quality-first": return KRT_QUALITY_PROFILES["quality-first"]
    case "completion-first": return KRT_QUALITY_PROFILES["completion-first"]
    default: return KRT_QUALITY_PROFILES.balanced
  }
}

function recordArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : []
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function summaryOpenNets(summary: Record<string, unknown> | undefined) {
  const output = new Set<string>()
  if (!summary) return output
  for (const key of ["failed_single", "open_single", "single_ended_followup_nets"]) {
    for (const net of stringArray(summary[key])) output.add(net)
  }
  for (const key of ["failed_multipoint", "pad_pairs_open", "pair_reports"]) {
    for (const item of recordArray(summary[key])) {
      const incomplete = stringArray(item.incomplete_members)
      if (incomplete.length) for (const net of incomplete) output.add(net)
      else if (key !== "pair_reports" || item.outcome !== "coupled") for (const field of ["net", "p_net", "n_net"]) {
        if (typeof item[field] === "string") output.add(item[field] as string)
      }
    }
  }
  return output
}

function trackLengthMm(copper: RoutingCopper) {
  return copper.tracks.reduce((total, track) => total + track.points.slice(1).reduce((length, point, index) => {
    const previous = track.points[index]
    return length + Math.hypot(point.x - previous.x, point.y - previous.y)
  }, 0), 0)
}

function processFailed(result: KrtProcessResult) {
  return result.status !== "completed" || result.diagnostics.some((item) => item.severity === "error")
}

export function createKrtBackend(options: KrtBackendOptions): RouterBackendAdapter {
  let preparedRuntime: Promise<PreparedKrtRuntime> | undefined
  const runtime = (signal?: AbortSignal) => {
    if (!preparedRuntime) preparedRuntime = prepareKrtRuntime({
      krtDirectory: options.krtDirectory,
      pythonPath: options.pythonPath,
      assets: { ...options.assets, ...(signal ? { signal } : {}) },
    }).catch((error) => {
      preparedRuntime = undefined
      throw error
    })
    return preparedRuntime
  }
  const runtimeDiagnostic = (error: unknown) => diagnostic(
    error instanceof RouterAssetError ? error.code : "KRT_RUNTIME_PREPARE_FAILED",
    "error",
    error instanceof Error ? error.message : String(error),
    error instanceof RouterAssetError ? error.details : undefined,
  )
  const adapter: RouterBackendAdapter = {
    id: "krt",
    capabilities: {
      supported: [
        "ordinary-routing", "vias", "differential-pairs", "matched-length",
        "impedance-controlled", "preserve-fixed-copper", "fixed-zone-obstacles",
        "preconnected-pad-groups", "parallel-vias",
      ],
      maxCopperLayers: 32,
    },
    async preflight(request) {
      const diagnostics: RoutingDiagnostic[] = []
      try {
        await runtime(request.signal)
      } catch (error) {
        diagnostics.push(runtimeDiagnostic(error))
      }
      if (request.board.layers.length > 32) diagnostics.push(diagnostic(
        "KRT_LAYER_LIMIT", "error", "KRT supports at most 32 copper layers.",
      ))
      diagnostics.push(...specialRules(request).diagnostics)
      return diagnostics
    },
    async route(request): Promise<BackendRouteResult> {
      const diagnostics: RoutingDiagnostic[] = []
      let managed: PreparedKrtRuntime
      try {
        managed = await runtime(request.signal)
      } catch (error) {
        return { status: "error", copper: EMPTY_COPPER, diagnostics: [runtimeDiagnostic(error)] }
      }
      const krtDirectory = managed.directory
      const specialStage = request.program.differentialPairs.length > 0
        || request.program.matchedGroups.length > 0
        || request.program.viaFences.length > 0
      const root = options.artifactsDirectory
        ? join(resolve(options.artifactsDirectory), request.policy?.profile ?? "default", specialStage ? "special" : "remaining")
        : await mkdtemp(join(tmpdir(), "copilot-router-krt-"))
      const ownedTemporary = !options.artifactsDirectory
      await mkdir(root, { recursive: true })
      const startedAt = performance.now()
      try {
        const prepared = await options.transport.prepare(request, root)
        diagnostics.push(...(prepared.diagnostics ?? []))
        if (diagnostics.some((item) => item.severity === "error")) return {
          status: "error", copper: EMPTY_COPPER, diagnostics,
        }
        const special = specialRules(request)
        diagnostics.push(...special.diagnostics)
        if (special.diagnostics.some((item) => item.severity === "error")) return {
          status: "error", copper: EMPTY_COPPER, diagnostics,
        }
        const allSpecial = new Set([
          ...request.program.differentialPairs.flatMap((pair) => [pair.positive, pair.negative]),
          ...request.program.matchedGroups.flatMap((group) => group.nets),
        ])
        const inScope = (net: string) => (
          (!request.program.onlyNets || request.program.onlyNets.includes(net))
          && !request.program.ignoreNets.includes(net)
        )
        const preconnected = fullyPreconnectedNets(request)
        const remainingNets = orderedScopeNets(request).filter((net) => (
          net.toUpperCase() !== "GND" && inScope(net) && !allSpecial.has(net) && !preconnected.has(net)
          && request.board.pads.filter((pad) => pad.net === net).length >= 2
        ))
        const remainingValues = remainingNets.map((net) => ruleFor(request, net))
        const remainingRules = minimumRules(remainingValues.length ? remainingValues : [request.rules.default])
        const specialFab = join(root, "special-fab.txt")
        const remainingFab = join(root, "remaining-fab.txt")
        if (special.rules) await writeFabOverrides(specialFab, special.rules)
        await writeFabOverrides(remainingFab, remainingRules)
        const routedLayers = routeLayersFor(request, [...allSpecial, ...remainingNets])
        const common: Omit<KrtStageSpec, "rules" | "fabOverridesPath"> = {
          pythonPath: managed.pythonPath,
          pythonPathEntries: managed.pythonPathEntries,
          krtDirectory,
          layers: routedLayers,
          diffPairs: request.program.differentialPairs.map((pair) => [pair.positive, pair.negative] as const),
          matchedGroups: request.program.matchedGroups.map((group) => group.nets),
          remainingNets,
          ordering: request.program.onlyNets ? "original" : "mps",
          preserveNetOrder: Boolean(request.program.onlyNets),
          // A dense pad escape may need the fixed 0.127 mm hard floor even
          // when the ordinary preferred width cannot leave the footprint.
          // This is a completion mechanism, never a reason to weaken via or
          // clearance rules.
          enableTerminalEscalation: true,
          ...routeQuality(request),
          collectStats: true,
          debugMemory: true,
          exactFilledZoneObstacles: true,
          signal: request.signal,
        }
        let current = prepared.inputBoard
        let specialResult: KrtProcessResult | undefined
        if (allSpecial.size && special.rules) {
          const output = join(root, "02-special.kicad_pcb")
          specialResult = await runKrtSpecial(current, output, {
            ...common,
            rules: special.rules,
            fabOverridesPath: specialFab,
            ordinaryMatchedRules: special.rules,
            ordinaryMatchedFabOverridesPath: specialFab,
          }, join(root, "special"))
          diagnostics.push(...convertDiagnostics(specialResult.diagnostics))
          if (specialResult.status === "completed") current = output
        }
        let remainingResult: KrtProcessResult | undefined
        if (remainingNets.length) {
          const output = join(root, "03-remaining.kicad_pcb")
          const preferredWidthNets = new Set([
            ...request.program.powerNets.map((intent) => intent.net),
            ...request.program.signalNets.filter((intent) => intent.impedance).map((intent) => intent.net),
          ])
          remainingResult = await runKrtRemaining(current, output, {
            ...common,
            rules: remainingRules,
            fabOverridesPath: remainingFab,
            powerNets: remainingNets.filter((net) => preferredWidthNets.has(net)).map((net) => ({
              net,
              width: ruleFor(request, net).preferredTrackWidthMm,
            })),
          }, join(root, "remaining"))
          diagnostics.push(...convertDiagnostics(remainingResult.diagnostics))
          if (remainingResult.status === "completed") current = output
        }
        const routed = await options.transport.read(request, prepared.inputBoard, current)
        diagnostics.push(...(routed.diagnostics ?? []))
        const ruleDiagnostics = routedCopperRuleDiagnostics(request, routed.copper)
        diagnostics.push(...ruleDiagnostics)
        if (ruleDiagnostics.length) return {
          status: "error",
          copper: EMPTY_COPPER,
          diagnostics,
          metrics: {
            elapsedMs: performance.now() - startedAt,
            routedNetCount: 0,
            backend: "krt",
            details: { rejectedRoutedDelta: true, artifactsDirectory: root },
          },
        }
        const failed = (specialResult ? processFailed(specialResult) : false)
          || (remainingResult ? processFailed(remainingResult) : false)
        const openNets = new Set([
          ...summaryOpenNets(specialResult?.jsonSummary),
          ...summaryOpenNets(remainingResult?.jsonSummary),
        ])
        if (remainingResult && !remainingResult.jsonSummary) {
          for (const net of remainingNets) openNets.add(net)
        }
        if (specialResult && !specialResult.jsonSummary) {
          for (const net of allSpecial) openNets.add(net)
        }
        const routeScope = new Set([...allSpecial, ...remainingNets])
        return {
          status: failed || diagnostics.some((item) => item.severity === "error") ? "partial" : "complete",
          copper: routed.copper,
          diagnostics,
          metrics: {
            elapsedMs: performance.now() - startedAt,
            routedNetCount: Math.max(0, routeScope.size - openNets.size),
            openNetCount: openNets.size,
            openNets: [...openNets].sort(),
            viaCount: routed.copper.vias.length,
            trackLengthMm: trackLengthMm(routed.copper),
            backend: "krt",
            details: {
              artifactsDirectory: root,
              runtime: {
                version: managed.version,
                source: managed.source,
                cacheDirectory: managed.cacheDirectory,
              },
              special: specialResult?.jsonSummary,
              remaining: remainingResult?.jsonSummary,
            },
          },
        }
      } catch (error) {
        return {
          status: "error", copper: EMPTY_COPPER,
          diagnostics: [...diagnostics, diagnostic(
            "KRT_BACKEND_FAILED", "error",
            error instanceof Error ? error.message : String(error),
          )],
        }
      } finally {
        if (ownedTemporary && !options.keepArtifacts) await rm(root, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
  const specialMembers = (request: BackendRouteRequest) => [...new Set([
    ...request.program.differentialPairs.flatMap((pair) => [pair.positive, pair.negative]),
    ...request.program.matchedGroups.flatMap((group) => group.nets),
    ...request.program.viaFences.flatMap((fence) => fence.along),
  ])]
  return {
    ...adapter,
    routeSpecial(request) {
      const members = specialMembers(request)
      return adapter.route({
        ...request,
        program: {
          ...request.program,
          signalNets: request.program.signalNets.filter((item) => members.includes(item.net)),
          powerNets: request.program.powerNets.filter((item) => members.includes(item.net)),
          onlyNets: members,
          ignoreNets: request.board.nets.map((item) => item.name).filter((net) => !members.includes(net)),
        },
      })
    },
    routeRemaining(request) {
      const members = specialMembers(request)
      return adapter.route({
        ...request,
        program: {
          ...request.program,
          differentialPairs: [], matchedGroups: [], viaFences: [],
          ignoreNets: [...new Set([...request.program.ignoreNets, ...members])],
        },
      })
    },
  }
}
