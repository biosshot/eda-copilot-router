import { performance } from "node:perf_hooks"
import {
  optimizeCompactBoundaries,
  type CompactBoundaryOptimization,
} from "./boundary-optimizer"
import type {
  CopperTarget as PolygonTarget,
  LayerSelector as PolygonLayerSelector,
  PolygonIntent,
} from "../intent/types.js"
import type {
  PcbLayerName,
  PcbPoint,
  PolygonScene,
  PolygonScenePad,
  PolygonScenePolygon,
} from "./scene.js"

export const MAX_COMPACT_BOARD_AREA_RATIO = 0.10

export type PolygonProgramInput = Readonly<{
  polygons: readonly PolygonIntent[]
}>

export type ResolvedPolygonPad = Pick<PolygonScenePad,
  "id" | "component" | "padNumber" | "net" | "x" | "y" | "layer">

export type ZoneOptimizationMetrics = {
  strategy: "mst_corridor" | "octilinear_envelope"
  clusterIndex: number
  clusterCount: number
  mstLengthMm: number
  routedLengthMm: number
  routeDetourMm: number
  avoidedObstacleCount: number
  corridorWidthMinMm: number
  corridorBodyWidthMaxMm: number
  maxPadFreeGapMm: number
  maxPadFreeGapWidths: number
  targetPadAreaMm2: number
  copperEfficiency: number
  angleMode: "octilinear"
  boundaryVertexCount: number
  removedVertexCount: number
  minimumFeatureMm: number
  pocketClosingRadiusMm: number
  filledPocketAreaMm2: number
}

export type ZonePlan = {
  intent: PolygonIntent
  net: string
  layer: PcbLayerName
  status: "ready" | "skipped" | "error"
  reason?: string
  targetPads: ResolvedPolygonPad[]
  /** Rough zone outline only. The target EDA performs the actual copper fill. */
  boundary?: PcbPoint[]
  boardAreaMm2: number
  boundaryAreaMm2: number
  boardAreaRatio: number
  optimization?: ZoneOptimizationMetrics
  warnings: string[]
}

export type PolygonPlannerResult = {
  program: PolygonProgramInput
  plans: ZonePlan[]
  metrics: {
    elapsedMs: number
    heapDeltaBytes: number
    ready: number
    skipped: number
    errors: number
    candidateAreaMm2: number
  }
}

export type FilledPolygonValidationDiagnostic = {
  planIndex: number
  net: string
  layer: PcbLayerName
  status: "ready" | "error"
  reason?: string
  targetCopperGroups?: Array<{
    component?: string
    padNumber: string
    group: number | null
  }>
}

export type FilledPolygonValidationResult = {
  plans: ZonePlan[]
  diagnostics: FilledPolygonValidationDiagnostic[]
  errors: number
}

export type PolygonGeometryRules = {
  /** Minimum useful copper width after the EDA refills the zone. */
  minimumCorridorWidthMm?: number
  /** Clearance around foreign copper used while choosing a corridor path. */
  obstacleClearanceMm?: number
  /** Deterministic cap on geometric search work for one polygon intent. */
  maxSearchWorkUnits?: number
  /** Cooperative wall-clock cap for one polygon intent; never exceeds 10 seconds. */
  maxSearchElapsedMs?: number
}

export type PolygonPlannerOptions = {
  rulesForNet?: (net: string) => PolygonGeometryRules | undefined
}

type LayerName = PcbLayerName

const rawLayer = (value: string): LayerName => value as LayerName

function resolveLayers(scene: PolygonScene, selector: PolygonLayerSelector) {
  const top = rawLayer(scene.layers?.top ?? "TOP")
  const bottom = rawLayer(scene.layers?.bottom ?? "BOTTOM")
  if (selector.kind === "outer") return [top, bottom]
  if (selector.kind === "top") return [top]
  if (selector.kind === "bottom") return [bottom]
  return selector.names.map(rawLayer)
}

function padOnLayer(pad: PolygonScenePad, layer: LayerName) {
  return pad.layer === "MULTI" || pad.layer === layer
}

function rotateDegrees(point: PcbPoint, center: PcbPoint, degrees: number): PcbPoint {
  const radians = degrees * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const dx = point.x - center.x
  const dy = point.y - center.y
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  }
}

function ellipse(center: PcbPoint, width: number, height: number, rotation: number) {
  return Array.from({ length: 24 }, (_, index) => {
    const angle = Math.PI * 2 * index / 24
    return rotateDegrees({
      x: center.x + Math.cos(angle) * width / 2,
      y: center.y + Math.sin(angle) * height / 2,
    }, center, rotation)
  })
}

function sourceRings(source: unknown): PcbPoint[][] {
  if (!Array.isArray(source)) return []
  const rings: PcbPoint[][] = []
  let ring: PcbPoint[] = []
  let index = 0
  const flush = () => {
    if (ring.length >= 3) rings.push(ring)
    ring = []
  }
  if (typeof source[0] === "number" && typeof source[1] === "number") {
    ring.push({ x: source[0], y: source[1] })
    index = 2
  }
  while (index < source.length) {
    const command = source[index++]
    if (command === "M") {
      flush()
      if (typeof source[index] === "number" && typeof source[index + 1] === "number") {
        ring.push({ x: source[index] as number, y: source[index + 1] as number })
        index += 2
      }
    } else if (command === "L") {
      while (typeof source[index] === "number" && typeof source[index + 1] === "number") {
        ring.push({ x: source[index] as number, y: source[index + 1] as number })
        index += 2
      }
    } else if (command === "Z") {
      flush()
    } else if (command === "CIRCLE") {
      const x = source[index]
      const y = source[index + 1]
      const radius = source[index + 2]
      if (typeof x === "number" && typeof y === "number" && typeof radius === "number") {
        rings.push(ellipse({ x, y }, radius * 2, radius * 2, 0))
      }
      index += 3
    } else {
      while (typeof source[index] === "number") index += 1
    }
  }
  flush()
  return rings
}

export function ringsFromScenePolygon(polygon: PolygonScenePolygon) {
  return polygon.sources.flatMap((source) => sourceRings(source))
}

/** @deprecated Use ringsFromScenePolygon in new code. */
export const ringsFromRawPolygon = ringsFromScenePolygon

export function ringsFromScenePad(pad: PolygonScenePad): PcbPoint[][] {
  if (pad.rings?.length) return structuredClone(pad.rings)
  const shape = pad.shape as unknown[] | undefined
  if (!shape?.length) return []
  const type = String(shape[0]).toUpperCase()
  if (type === "POLYGON") {
    const complex = shape[1]
    if (!Array.isArray(complex)) return []
    const sources = Array.isArray(complex[0]) ? complex : [complex]
    return sources.flatMap((source) => sourceRings(source))
  }
  const width = Number(shape[1])
  const height = Number(shape[2] ?? shape[1])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return []
  if (type === "ELLIPSE" || type === "CIRCLE" || type === "OVAL") {
    return [ellipse(pad, width, height, pad.rotation || 0)]
  }
  const points = [
    { x: pad.x - width / 2, y: pad.y - height / 2 },
    { x: pad.x + width / 2, y: pad.y - height / 2 },
    { x: pad.x + width / 2, y: pad.y + height / 2 },
    { x: pad.x - width / 2, y: pad.y + height / 2 },
  ].map((point) => rotateDegrees(point, pad, pad.rotation || 0))
  return [points]
}

/** @deprecated Use ringsFromScenePad in new code. */
export const ringsFromRawPad = ringsFromScenePad

function polygonArea(points: PcbPoint[]) {
  if (points.length < 3) return 0
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return Math.abs(area) / 2
}

function padKey(pad: PolygonScenePad) {
  return pad.id || `${pad.component ?? ""}:${pad.padNumber}:${pad.x}:${pad.y}:${pad.layer}`
}

function resolveTarget(pcb: PolygonScene, intent: PolygonIntent, target: PolygonTarget) {
  if (target.kind === "net") {
    const pads = pcb.pads.filter((pad) => pad.net === target.net)
    return pads.length ? { pads } : { pads, error: `net(${target.net}) has no pads` }
  }
  const pads = pcb.pads.filter((pad) => pad.component === target.component && pad.padNumber === target.pad)
  if (!pads.length) return { pads, error: `pad(${target.component}, ${target.pad}) was not found` }
  const mismatch = pads.find((pad) => pad.net !== intent.net)
  if (mismatch) {
    return { pads: [], error: `pad(${target.component}, ${target.pad}) belongs to ${mismatch.net || "no net"}, not ${intent.net}` }
  }
  return { pads }
}

function resolvedPad(pad: PolygonScenePad): ResolvedPolygonPad {
  const { id, component, padNumber, net, x, y, layer } = pad
  return { id, component, padNumber, net, x, y, layer }
}

function skipped(
  intent: PolygonIntent,
  layer: LayerName,
  boardAreaMm2: number,
  reason: string,
  targetPads: PolygonScenePad[] = [],
  boundary?: PcbPoint[],
): ZonePlan {
  const boundaryAreaMm2 = boundary ? polygonArea(boundary) : 0
  return {
    intent,
    net: intent.net,
    layer,
    status: "skipped",
    reason,
    targetPads: targetPads.map(resolvedPad),
    boundary,
    boardAreaMm2,
    boundaryAreaMm2,
    boardAreaRatio: boardAreaMm2 > 0 ? boundaryAreaMm2 / boardAreaMm2 : 0,
    warnings: [],
  }
}

function failed(
  intent: PolygonIntent,
  layer: LayerName,
  boardAreaMm2: number,
  reason: string,
  targetPads: PolygonScenePad[] = [],
  boundary?: PcbPoint[],
): ZonePlan {
  return {
    ...skipped(intent, layer, boardAreaMm2, reason, targetPads, boundary),
    status: "error",
  }
}

function optimizationMetrics(
  optimized: CompactBoundaryOptimization,
  clusterIndex: number,
  clusterCount: number,
): ZoneOptimizationMetrics {
  return {
    strategy: optimized.strategy,
    clusterIndex,
    clusterCount,
    mstLengthMm: optimized.mstLengthMm,
    routedLengthMm: optimized.routedLengthMm,
    routeDetourMm: optimized.routeDetourMm,
    avoidedObstacleCount: optimized.avoidedObstacleCount,
    corridorWidthMinMm: optimized.corridorWidthMinMm,
    corridorBodyWidthMaxMm: optimized.corridorBodyWidthMaxMm,
    maxPadFreeGapMm: optimized.maxPadFreeGapMm,
    maxPadFreeGapWidths: optimized.maxPadFreeGapWidths,
    targetPadAreaMm2: optimized.targetPadAreaMm2,
    copperEfficiency: optimized.copperEfficiency,
    angleMode: optimized.angleMode,
    boundaryVertexCount: optimized.boundaryVertexCount,
    removedVertexCount: optimized.removedVertexCount,
    minimumFeatureMm: optimized.minimumFeatureMm,
    pocketClosingRadiusMm: optimized.pocketClosingRadiusMm,
    filledPocketAreaMm2: optimized.filledPocketAreaMm2,
  }
}

function planIntent(
  pcb: PolygonScene,
  intent: PolygonIntent,
  layer: LayerName,
  boardAreaMm2: number,
  options: PolygonPlannerOptions,
): ZonePlan[] {
  const resolved = intent.targets.map((target) => ({ target, ...resolveTarget(pcb, intent, target) }))
  const error = resolved.find((item) => item.error)?.error
  if (error) return [failed(intent, layer, boardAreaMm2, error)]

  const unique = new Map<string, PolygonScenePad>()
  for (const pad of resolved.flatMap((item) => item.pads)) unique.set(padKey(pad), pad)
  const targetPads = [...unique.values()].filter((pad) => padOnLayer(pad, layer))
  const explicitPads = resolved
    .filter((item) => item.target.kind === "pad")
    .flatMap((item) => item.pads)
    .filter((pad) => padOnLayer(pad, layer))
  const explicitPadKeys = new Set(explicitPads.map(padKey))
  if (!targetPads.length) return [failed(intent, layer, boardAreaMm2, `no target pads are present on ${layer}`)]

  if (targetPads.length < 2) {
    const createDiagnostic = explicitPads.length ? failed : skipped
    return [createDiagnostic(intent, layer, boardAreaMm2, "compact polygon needs at least two target pads", targetPads)]
  }

  const usablePads = targetPads.filter((pad) => ringsFromScenePad(pad).some((ring) => ring.length >= 3))
  const unusablePads = targetPads.filter((pad) => !usablePads.includes(pad))
  const unusableExplicitPads = unusablePads.filter((pad) => explicitPadKeys.has(padKey(pad)))
  if (unusableExplicitPads.length) {
    return [failed(intent, layer, boardAreaMm2, "an explicit target pad has no usable geometry", unusableExplicitPads)]
  }
  const optimized = optimizeCompactBoundaries(
    usablePads,
    ringsFromScenePad,
    pcb.pads.filter((pad) => padOnLayer(pad, layer)),
    {
      maxPadFreeGapWidths: intent.maxPadFreeGapWidths,
      ...options.rulesForNet?.(intent.net),
    },
  )
  if (optimized.failure) {
    return [failed(intent, layer, boardAreaMm2, optimized.failure.message, targetPads)]
  }
  const clusterCount = optimized.boundaries.length + optimized.isolatedPads.length + unusablePads.length
  const plans: ZonePlan[] = optimized.boundaries.map((cluster, index) => {
    const boundaryAreaMm2 = polygonArea(cluster.boundary)
    const boardAreaRatio = boardAreaMm2 > 0 ? boundaryAreaMm2 / boardAreaMm2 : Infinity
    const optimization = optimizationMetrics(cluster, index + 1, clusterCount)
    const splitWarning = clusterCount > 1
      ? [explicitPads.length
        ? `compact target was decomposed into ${clusterCount} overlapping local boundaries`
        : `compact target was split into ${clusterCount} local clusters; long pad-free spans stay available to the router`]
      : []
    if (!Number.isFinite(boardAreaRatio) || boardAreaRatio > MAX_COMPACT_BOARD_AREA_RATIO) {
      const containsAllExplicit = explicitPads.length > 0
        && explicitPads.every((pad) => cluster.pads.some((candidate) => padKey(candidate) === padKey(pad)))
      const createDiagnostic = containsAllExplicit ? failed : skipped
      const plan = createDiagnostic(
        intent,
        layer,
        boardAreaMm2,
        `compact boundary uses ${(boardAreaRatio * 100).toFixed(2)}% of board; limit is ${MAX_COMPACT_BOARD_AREA_RATIO * 100}%`,
        cluster.pads,
        cluster.boundary,
      )
      plan.optimization = optimization
      plan.warnings = splitWarning
      return plan
    }
    return {
      intent,
      net: intent.net,
      layer,
      status: "ready",
      targetPads: cluster.pads.map(resolvedPad),
      boundary: cluster.boundary,
      boardAreaMm2,
      boundaryAreaMm2,
      boardAreaRatio,
      optimization,
      warnings: splitWarning,
    }
  })
  const explicitIsolated: typeof optimized.isolatedPads = []
  for (const isolated of optimized.isolatedPads) {
    const normalizedGap = Number.isFinite(isolated.nearestPadFreeGapWidths)
      ? isolated.nearestPadFreeGapWidths.toFixed(2)
      : "infinite"
    const explicit = explicitPadKeys.has(padKey(isolated.pad))
    if (explicit) {
      explicitIsolated.push(isolated)
      continue
    }
    plans.push(skipped(
      intent,
      layer,
      boardAreaMm2,
      isolated.reason
        ?? `local cluster has one pad; nearest pad-free gap is ${normalizedGap} pad widths (limit ${intent.maxPadFreeGapWidths})`,
      [isolated.pad],
    ))
  }
  if (explicitIsolated.length) plans.push(failed(
    intent,
    layer,
    boardAreaMm2,
    explicitIsolated.find((item) => item.reason)?.reason
      ?? (optimized.maxPadFreeGapWidths > intent.maxPadFreeGapWidths
        ? `explicit targets require a ${optimized.maxPadFreeGapWidths.toFixed(2)} pad-width pad-free gap; configured maxPadFreeGap is ${intent.maxPadFreeGapWidths}`
        : "explicit targets have no collision-free 0/45/90 corridor at the configured useful width"),
    explicitIsolated.map((item) => item.pad),
  ))
  for (const pad of unusablePads) {
    plans.push(skipped(intent, layer, boardAreaMm2, "target pad has no usable geometry", [pad]))
  }
  return plans.length ? plans : [skipped(intent, layer, boardAreaMm2, "compact target produced no usable local clusters", targetPads)]
}

type LayerIntent = {
  intent: PolygonIntent
  layer: LayerName
  order: number
  sources?: PolygonIntent[]
}

function coalesceSharedPadIntents(items: LayerIntent[]) {
  const buckets = new Map<string, LayerIntent[]>()
  for (const item of items) {
    const { intent, layer } = item
    const key = [
      intent.net,
      layer,
      intent.mode,
      intent.priority,
      intent.maxPadFreeGapWidths,
    ].join("\u0000")
    buckets.set(key, [...(buckets.get(key) ?? []), item])
  }
  const merged: LayerIntent[] = []
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) {
      merged.push(...bucket)
      continue
    }
    const parent = bucket.map((_, index) => index)
    const find = (value: number): number => parent[value] === value
      ? value
      : (parent[value] = find(parent[value]))
    const join = (left: number, right: number) => {
      const a = find(left)
      const b = find(right)
      if (a !== b) parent[b] = a
    }
    const owners = new Map<string, number>()
    bucket.forEach((item, index) => {
      for (const target of item.intent.targets) {
        if (target.kind !== "pad") continue
        const key = `${target.component}\u0000${target.pad}`
        const previous = owners.get(key)
        if (previous === undefined) owners.set(key, index)
        else join(previous, index)
      }
    })
    const components = new Map<number, LayerIntent[]>()
    bucket.forEach((item, index) => {
      const root = find(index)
      components.set(root, [...(components.get(root) ?? []), item])
    })
    for (const component of components.values()) {
      if (component.length === 1) {
        merged.push(component[0])
        continue
      }
      const first = component.reduce((left, right) => left.order < right.order ? left : right)
      const targets = new Map<string, PolygonTarget>()
      for (const item of component.sort((left, right) => left.order - right.order)) {
        for (const target of item.intent.targets) {
          const key = target.kind === "pad"
            ? `pad\u0000${target.component}\u0000${target.pad}`
            : `net\u0000${target.net}`
          if (!targets.has(key)) targets.set(key, target)
        }
      }
      merged.push({
        ...first,
        intent: { ...first.intent, targets: [...targets.values()] },
        sources: component.map((item) => item.intent),
      })
    }
  }
  return merged.sort((left, right) => left.order - right.order)
}

export function planPolygons(
  pcb: PolygonScene,
  program: PolygonProgramInput,
  options: PolygonPlannerOptions = {},
): PolygonPlannerResult {
  const started = performance.now()
  const beforeHeap = process.memoryUsage().heapUsed
  const boardAreaMm2 = polygonArea(pcb.board?.polygon ?? [])
  const layerIntents = program.polygons.flatMap((intent, order) =>
    resolveLayers(pcb, intent.layers).map((layer) => ({ intent, layer, order, sources: [intent] })))
  const plans = coalesceSharedPadIntents(layerIntents)
    .flatMap(({ intent, layer, sources }) => {
      const planned = planIntent(pcb, intent, layer, boardAreaMm2, options)
      if ((sources?.length ?? 0) <= 1 || !planned.some((plan) => plan.status === "error")) return planned
      // A valid local polygon must not disappear just because another
      // shared-pad branch exceeds maxPadFreeGap. Preserve the original local
      // plans and report only the failing branch, matching non-coalesced DSL
      // semantics while still optimizing successful shared groups jointly.
      return sources!.flatMap((source) =>
        planIntent(pcb, source, layer, boardAreaMm2, options))
    })
  return {
    program,
    plans,
    metrics: {
      elapsedMs: performance.now() - started,
      heapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap,
      ready: plans.filter((plan) => plan.status === "ready").length,
      skipped: plans.filter((plan) => plan.status === "skipped").length,
      errors: plans.filter((plan) => plan.status === "error").length,
      candidateAreaMm2: plans
        .filter((plan) => plan.status === "ready")
        .reduce((sum, plan) => sum + plan.boundaryAreaMm2, 0),
    },
  }
}

type RingBounds = { left: number; right: number; top: number; bottom: number }

function ringBounds(points: PcbPoint[]): RingBounds {
  return {
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    bottom: Math.max(...points.map((point) => point.y)),
  }
}

function ringBoundsTouch(left: RingBounds, right: RingBounds) {
  const epsilon = 1e-7
  return left.left <= right.right + epsilon && left.right + epsilon >= right.left
    && left.top <= right.bottom + epsilon && left.bottom + epsilon >= right.top
}

function pointOnSegment(point: PcbPoint, start: PcbPoint, end: PcbPoint) {
  const epsilon = 1e-7
  const cross = (point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x)
  if (Math.abs(cross) > epsilon * Math.max(1, Math.hypot(end.x - start.x, end.y - start.y))) return false
  return point.x >= Math.min(start.x, end.x) - epsilon && point.x <= Math.max(start.x, end.x) + epsilon
    && point.y >= Math.min(start.y, end.y) - epsilon && point.y <= Math.max(start.y, end.y) + epsilon
}

function pointInRing(point: PcbPoint, ring: PcbPoint[]) {
  let inside = false
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index]
    const end = ring[(index + 1) % ring.length]
    if (pointOnSegment(point, start, end)) return true
    const crosses = (start.y > point.y) !== (end.y > point.y)
      && point.x < (end.x - start.x) * (point.y - start.y) / (end.y - start.y) + start.x
    if (crosses) inside = !inside
  }
  return inside
}

function segmentsTouch(a: PcbPoint, b: PcbPoint, c: PcbPoint, d: PcbPoint) {
  const orientation = (p: PcbPoint, q: PcbPoint, r: PcbPoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  const epsilon = 1e-7
  if (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
    && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) return true
  return (Math.abs(abC) <= epsilon && pointOnSegment(c, a, b))
    || (Math.abs(abD) <= epsilon && pointOnSegment(d, a, b))
    || (Math.abs(cdA) <= epsilon && pointOnSegment(a, c, d))
    || (Math.abs(cdB) <= epsilon && pointOnSegment(b, c, d))
}

function ringsTouch(left: PcbPoint[], right: PcbPoint[]) {
  if (!left.length || !right.length || !ringBoundsTouch(ringBounds(left), ringBounds(right))) return false
  if (left.some((point) => pointInRing(point, right)) || right.some((point) => pointInRing(point, left))) return true
  return left.some((start, leftIndex) => {
    const end = left[(leftIndex + 1) % left.length]
    return right.some((otherStart, rightIndex) =>
      segmentsTouch(start, end, otherStart, right[(rightIndex + 1) % right.length]))
  })
}

function ringSetsTouch(left: PcbPoint[][], right: PcbPoint[][]) {
  return left.some((leftRing) => right.some((rightRing) => ringsTouch(leftRing, rightRing)))
}

function resolvedPadLookupKey(pad: ResolvedPolygonPad | PolygonScenePad) {
  return pad.id || `${pad.component ?? ""}:${pad.padNumber}:${pad.x}:${pad.y}:${pad.layer}`
}

export function validateFilledPolygonPlans(pcb: PolygonScene, plans: ZonePlan[]): FilledPolygonValidationResult {
  const validatedPlans = plans.map((plan) => ({ ...plan, warnings: [...plan.warnings] }))
  const diagnostics: FilledPolygonValidationDiagnostic[] = []
  for (let planIndex = 0; planIndex < validatedPlans.length; planIndex += 1) {
    const plan = validatedPlans[planIndex]
    if (plan.status !== "ready" || plan.targetPads.length < 2) continue
    const pads = pcb.pads.filter((pad) => pad.net === plan.net && padOnLayer(pad, plan.layer))
    const polygons = pcb.polygons.filter((polygon) => polygon.net === plan.net
      && (polygon.layer === plan.layer || polygon.layer === "MULTI"))
    const entities = [
      ...pads.map((pad) => ({ kind: "pad" as const, key: resolvedPadLookupKey(pad), rings: ringsFromScenePad(pad) })),
      ...polygons.map((polygon, index) => ({ kind: "polygon" as const, key: `polygon:${index}`, rings: ringsFromScenePolygon(polygon) })),
    ].filter((entity) => entity.rings.some((ring) => ring.length >= 3))
    const parent = entities.map((_, index) => index)
    const find = (value: number): number => parent[value] === value ? value : (parent[value] = find(parent[value]))
    const join = (left: number, right: number) => {
      const leftRoot = find(left)
      const rightRoot = find(right)
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
    }
    for (let left = 0; left < entities.length; left += 1) {
      for (let right = left + 1; right < entities.length; right += 1) {
        if (entities[left].kind === "pad" && entities[right].kind === "pad"
          && entities[left].key === entities[right].key) {
          join(left, right)
        } else if (ringSetsTouch(entities[left].rings, entities[right].rings)) {
          join(left, right)
        }
      }
    }
    const targetIndices = plan.targetPads.map((target) =>
      entities.findIndex((entity) => entity.kind === "pad"
        && entity.key === resolvedPadLookupKey(target)))
    const targetRoots = new Map<number, number>()
    const targetCopperGroups = plan.targetPads.map((target, targetIndex) => {
      const entityIndex = targetIndices[targetIndex]
      const root = entityIndex >= 0 ? find(entityIndex) : -1
      if (root >= 0 && !targetRoots.has(root)) targetRoots.set(root, targetRoots.size + 1)
      return {
        component: target.component,
        padNumber: target.padNumber,
        group: root >= 0 ? targetRoots.get(root)! : null,
      }
    })
    const connected = targetIndices.length >= plan.targetPads.length
      && targetIndices.every((index) => index >= 0 && find(index) === find(targetIndices[0]))
    if (connected) {
      diagnostics.push({ planIndex, net: plan.net, layer: plan.layer, status: "ready", targetCopperGroups })
      continue
    }
    const reason = "native EDA refill did not connect every target pad through filled copper"
    validatedPlans[planIndex] = { ...plan, status: "error", reason }
    diagnostics.push({ planIndex, net: plan.net, layer: plan.layer, status: "error", reason, targetCopperGroups })
  }
  return {
    plans: validatedPlans,
    diagnostics,
    errors: diagnostics.filter((diagnostic) => diagnostic.status === "error").length,
  }
}
