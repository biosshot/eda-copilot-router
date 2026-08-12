import { readFile, writeFile } from "node:fs/promises"
import { extname } from "node:path"
import {
  atom,
  findChild,
  type SExpression,
} from "../../kicad-copilot/src/kicad/sexpr/ast"
import { childText, listChildren } from "../../kicad-copilot/src/kicad/pcb-reader"
import {
  netClassFor,
  type PcbNetClassRule,
  type PcbRoutingRules,
} from "../../kicad-copilot/src/pcb/router-rules"

export type PowerNetIntent = {
  net: string
  maxCurrentA?: number
  minTrackWidthMm?: number
  maxTempRiseC?: number
}

export type PowerManufacturingIntent = {
  defaultCopperThicknessOz?: number
  viaPlatingThicknessUm?: number
  maxTrackWidthMm?: number
}

export type PowerIntentInput = {
  powerNets?: PowerNetIntent[]
  manufacturing?: PowerManufacturingIntent
}

export type PowerIntentDiagnostic = {
  code: string
  severity: "info" | "warning" | "error"
  message: string
  net?: string
  details?: unknown
}

export type CopperLayerRule = {
  layer: string
  external: boolean
  thicknessMm: number
  thicknessOz: number
  source: "stackup" | "default_1oz" | "configured_default"
}

export type CompiledPowerNet = {
  net: string
  source: "max_current" | "minimum_width"
  maxCurrentA?: number
  maxTempRiseC: number
  requiredTrackWidthMm: number
  layerWidthsMm: Record<string, number>
  viaDiameterMm: number
  viaDrillMm: number
  requiredParallelVias: number
  requiredCopperAreaMm2: number
  obstacleClearanceMm: number
  status: "ready" | "error"
  diagnostics: PowerIntentDiagnostic[]
}

export type CompiledPowerIntent = {
  version: 1
  calculationModel: "IPC-2221-chart-fallback"
  defaultCopperThicknessOz: number
  viaPlatingThicknessUm: number
  maxTrackWidthMm: number
  layers: CopperLayerRule[]
  nets: CompiledPowerNet[]
  diagnostics: PowerIntentDiagnostic[]
  errors: number
}

export type PowerRoutingViolation = {
  code: "POWER_INTENT_ERROR" | "POWER_TRACK_WIDTH" | "POWER_VIA_GEOMETRY" | "POWER_VIA_PARALLEL_COUNT"
  net: string
  message: string
  details?: unknown
}

export type PowerRoutingValidation = {
  completed: true
  valid: boolean
  checkedNets: number
  violations: PowerRoutingViolation[]
  reinforcedTrackItems: number
}

type Point = { x: number; y: number }
type FilledRing = { net: string; layer: string; points: Point[] }

const DEFAULT_COPPER_OZ = 1
const DEFAULT_TEMP_RISE_C = 16
const DEFAULT_VIA_PLATING_UM = 20
const ABSOLUTE_MAX_TRACK_WIDTH_MM = 10
const COPPER_MM_PER_OZ = 0.03479
const WIDTH_GRID_MM = 0.05
const EPSILON = 1e-6

function finitePositive(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function diagnostic(
  code: string,
  severity: PowerIntentDiagnostic["severity"],
  message: string,
  net?: string,
  details?: unknown,
): PowerIntentDiagnostic {
  return {
    code,
    severity,
    message,
    ...(net ? { net } : {}),
    ...(details === undefined ? {} : { details }),
  }
}

function numberAt(node: SExpression[] | undefined, index: number, fallback = 0) {
  const value = Number(atom(node?.[index]))
  return Number.isFinite(value) ? value : fallback
}

function boardStem(path: string) {
  const extension = extname(path)
  return extension ? path.slice(0, -extension.length) : path
}

function ruleForNet(rules: PcbRoutingRules, net: string) {
  const name = netClassFor(rules, net)
  return rules.classes.find((rule) => rule.name === name)
    ?? rules.classes.find((rule) => rule.name === "Default")!
}

function roundUp(value: number, step: number) {
  return Number((Math.ceil((value - EPSILON) / step) * step).toFixed(6))
}

/** IPC-2221 external/internal empirical chart equation, used as a conservative fallback. */
export function calculateTrackWidthMm(
  currentA: number,
  maxTempRiseC: number,
  copperThicknessMm: number,
  external: boolean,
) {
  const coefficient = external ? 0.048 : 0.024
  const crossSectionMil2 = (currentA / (coefficient * maxTempRiseC ** 0.44)) ** (1 / 0.725)
  const thicknessMil = copperThicknessMm / 0.0254
  return crossSectionMil2 / thicknessMil * 0.0254
}

export function parsePowerIntent(value: unknown): PowerIntentInput {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const manufacturingRaw = root.manufacturing && typeof root.manufacturing === "object"
    ? root.manufacturing as Record<string, unknown>
    : {}
  return {
    powerNets: Array.isArray(root.powerNets) ? root.powerNets.map((entry) => {
      const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {}
      return {
        net: String(item.net ?? ""),
        ...(item.maxCurrentA === undefined ? {} : { maxCurrentA: Number(item.maxCurrentA) }),
        ...(item.minTrackWidthMm === undefined ? {} : { minTrackWidthMm: Number(item.minTrackWidthMm) }),
        ...(item.maxTempRiseC === undefined ? {} : { maxTempRiseC: Number(item.maxTempRiseC) }),
      }
    }) : [],
    manufacturing: {
      ...(manufacturingRaw.defaultCopperThicknessOz === undefined
        ? {} : { defaultCopperThicknessOz: Number(manufacturingRaw.defaultCopperThicknessOz) }),
      ...(manufacturingRaw.viaPlatingThicknessUm === undefined
        ? {} : { viaPlatingThicknessUm: Number(manufacturingRaw.viaPlatingThicknessUm) }),
      ...(manufacturingRaw.maxTrackWidthMm === undefined
        ? {} : { maxTrackWidthMm: Number(manufacturingRaw.maxTrackWidthMm) }),
    },
  }
}

function copperLayers(root: SExpression[], defaultCopperOz: number): CopperLayerRule[] {
  const setup = findChild(root, "setup")
  const stackup = setup ? findChild(setup, "stackup") : undefined
  const explicit = (stackup ? listChildren(stackup, "layer") : []).flatMap((layer) => {
    const name = atom(layer[1]) ?? ""
    const type = childText(layer, "type")?.toLowerCase()
    if (!name.endsWith(".Cu") || type !== "copper") return []
    const thicknessMm = finitePositive(numberAt(findChild(layer, "thickness"), 1))
      ?? defaultCopperOz * COPPER_MM_PER_OZ
    return [{
      layer: name,
      external: name === "F.Cu" || name === "B.Cu",
      thicknessMm,
      thicknessOz: thicknessMm / COPPER_MM_PER_OZ,
      source: findChild(layer, "thickness")
        ? "stackup" as const
        : defaultCopperOz === DEFAULT_COPPER_OZ ? "default_1oz" as const : "configured_default" as const,
    }]
  })
  if (explicit.length) return explicit
  const thicknessMm = defaultCopperOz * COPPER_MM_PER_OZ
  return ["F.Cu", "B.Cu"].map((layer) => ({
    layer,
    external: true,
    thicknessMm,
    thicknessOz: defaultCopperOz,
    source: defaultCopperOz === DEFAULT_COPPER_OZ ? "default_1oz" : "configured_default",
  }))
}

export function compilePowerIntent(
  input: PowerIntentInput,
  boardRoot: SExpression[],
  rules: PcbRoutingRules,
  knownNets: readonly string[],
): CompiledPowerIntent {
  const diagnostics: PowerIntentDiagnostic[] = []
  const defaultCopperThicknessOz = finitePositive(input.manufacturing?.defaultCopperThicknessOz)
    ?? DEFAULT_COPPER_OZ
  const viaPlatingThicknessUm = finitePositive(input.manufacturing?.viaPlatingThicknessUm)
    ?? DEFAULT_VIA_PLATING_UM
  const requestedMaxWidth = finitePositive(input.manufacturing?.maxTrackWidthMm)
    ?? ABSOLUTE_MAX_TRACK_WIDTH_MM
  const maxTrackWidthMm = Math.min(requestedMaxWidth, ABSOLUTE_MAX_TRACK_WIDTH_MM)
  if (!finitePositive(input.manufacturing?.defaultCopperThicknessOz)
    && input.manufacturing?.defaultCopperThicknessOz !== undefined) diagnostics.push(diagnostic(
    "POWER_DEFAULT_COPPER_INVALID", "error", "defaultCopperThicknessOz must be positive.",
  ))
  if (!finitePositive(input.manufacturing?.viaPlatingThicknessUm)
    && input.manufacturing?.viaPlatingThicknessUm !== undefined) diagnostics.push(diagnostic(
    "POWER_VIA_PLATING_INVALID", "error", "viaPlatingThicknessUm must be positive.",
  ))
  if (requestedMaxWidth > ABSOLUTE_MAX_TRACK_WIDTH_MM) diagnostics.push(diagnostic(
    "POWER_MAX_WIDTH_EXCEEDS_ABSOLUTE_LIMIT",
    "error",
    `maxTrackWidthMm may not exceed ${ABSOLUTE_MAX_TRACK_WIDTH_MM} mm.`,
    undefined,
    { requestedMaxWidthMm: requestedMaxWidth },
  ))
  if (input.manufacturing?.maxTrackWidthMm !== undefined && !finitePositive(input.manufacturing.maxTrackWidthMm)) {
    diagnostics.push(diagnostic("POWER_MAX_WIDTH_INVALID", "error", "maxTrackWidthMm must be positive."))
  }

  const layers = copperLayers(boardRoot, defaultCopperThicknessOz)
  const known = new Set(knownNets)
  const seen = new Set<string>()
  const nets = (input.powerNets ?? []).map((intent): CompiledPowerNet => {
    const local: PowerIntentDiagnostic[] = []
    const net = intent.net.trim()
    const current = finitePositive(intent.maxCurrentA)
    const manualWidth = finitePositive(intent.minTrackWidthMm)
    const hasCurrent = intent.maxCurrentA !== undefined
    const hasManual = intent.minTrackWidthMm !== undefined
    if (!net) local.push(diagnostic("POWER_NET_NAME_MISSING", "error", "A power intent needs an exact net name."))
    else if (!known.has(net)) local.push(diagnostic("POWER_NET_UNKNOWN", "error", `${net} does not exist on the board.`, net))
    if (seen.has(net)) local.push(diagnostic("POWER_NET_DUPLICATE", "error", `${net} has more than one power intent.`, net))
    seen.add(net)
    if (hasCurrent === hasManual) local.push(diagnostic(
      "POWER_SOURCE_CONFLICT",
      "error",
      `${net || "Power net"} must define exactly one of maxCurrentA or minTrackWidthMm.`,
      net,
    ))
    if (hasCurrent && !current) local.push(diagnostic("POWER_CURRENT_INVALID", "error", "maxCurrentA must be positive.", net))
    if (hasManual && !manualWidth) local.push(diagnostic("POWER_WIDTH_INVALID", "error", "minTrackWidthMm must be positive.", net))
    const maxTempRiseC = intent.maxTempRiseC === undefined
      ? DEFAULT_TEMP_RISE_C
      : finitePositive(intent.maxTempRiseC) ?? DEFAULT_TEMP_RISE_C
    if (intent.maxTempRiseC !== undefined && !finitePositive(intent.maxTempRiseC)) local.push(diagnostic(
      "POWER_TEMP_RISE_INVALID", "error", "maxTempRiseC must be positive.", net,
    ))
    const nativeMinimum = net && known.has(net)
      ? Math.max(rules.minimumTrackWidth, ruleForNet(rules, net).trackWidth)
      : Math.max(rules.minimumTrackWidth, 0)
    const layerWidthsMm = Object.fromEntries(layers.map((layer) => [
      layer.layer,
      current ? calculateTrackWidthMm(current, maxTempRiseC, layer.thicknessMm, layer.external) : (manualWidth ?? 0),
    ]))
    const rawRequired = Math.max(nativeMinimum, manualWidth ?? 0, ...Object.values(layerWidthsMm))
    const requiredTrackWidthMm = roundUp(rawRequired, WIDTH_GRID_MM)
    if (requiredTrackWidthMm > maxTrackWidthMm + EPSILON) local.push(diagnostic(
      "POWER_WIDTH_EXCEEDS_LIMIT",
      "error",
      `${net || "Power net"} needs ${requiredTrackWidthMm.toFixed(2)} mm, above maxTrackWidthMm=${maxTrackWidthMm.toFixed(2)} mm.`,
      net,
      { requiredTrackWidthMm, maxTrackWidthMm },
    ))
    const native = net && known.has(net) ? ruleForNet(rules, net) : ruleForNet(rules, "")
    const obstacleClearanceMm = Math.max(rules.minimumClearance, native.clearance)
    const viaDrillMm = Math.max(
      finitePositive(rules.minimumViaDrill) ?? finitePositive(native.viaDrill) ?? 0.3,
      0.001,
    )
    const viaDiameterMm = Math.max(
      finitePositive(rules.minimumViaDiameter) ?? finitePositive(native.viaDiameter) ?? viaDrillMm,
      viaDrillMm + 2 * Math.max(rules.minimumViaAnnularWidth, 0),
    )
    const requiredCopperAreaMm2 = Math.max(...layers.map((layer) => (
      requiredTrackWidthMm * layer.thicknessMm
    )))
    const barrelCopperAreaMm2 = Math.PI * viaDrillMm * viaPlatingThicknessUm / 1_000
    const requiredParallelVias = Math.max(1, Math.ceil(requiredCopperAreaMm2 / barrelCopperAreaMm2 - EPSILON))
    diagnostics.push(...local)
    return {
      net,
      source: hasCurrent ? "max_current" : "minimum_width",
      ...(current ? { maxCurrentA: current } : {}),
      maxTempRiseC,
      requiredTrackWidthMm,
      layerWidthsMm,
      viaDiameterMm,
      viaDrillMm,
      requiredParallelVias,
      requiredCopperAreaMm2,
      obstacleClearanceMm,
      status: local.some((item) => item.severity === "error") ? "error" : "ready",
      diagnostics: local,
    }
  })
  return {
    version: 1,
    calculationModel: "IPC-2221-chart-fallback",
    defaultCopperThicknessOz,
    viaPlatingThicknessUm,
    maxTrackWidthMm,
    layers,
    nets,
    diagnostics,
    errors: diagnostics.filter((item) => item.severity === "error").length,
  }
}

function generatedClassName(index: number) {
  return `WorkflowPower_${index + 1}`
}

export function withCompiledPowerRules(
  rules: PcbRoutingRules,
  compiled: CompiledPowerIntent,
): PcbRoutingRules {
  const output = structuredClone(rules)
  for (const [index, power] of compiled.nets.filter((item) => item.status === "ready").entries()) {
    const native = ruleForNet(rules, power.net)
    const name = generatedClassName(index)
    const generated: PcbNetClassRule = {
      ...native,
      name,
      trackWidth: power.requiredTrackWidthMm,
      viaDiameter: power.viaDiameterMm,
      viaDrill: power.viaDrillMm,
    }
    output.classes = output.classes.filter((item) => item.name !== name)
    output.classes.push(generated)
    output.assignments[power.net] = name
  }
  return output
}

export async function persistCompiledPowerRules(
  boardPath: string,
  rules: PcbRoutingRules,
  compiled: CompiledPowerIntent,
) {
  const projectPath = `${boardStem(boardPath)}.kicad_pro`
  let root: Record<string, unknown> = {}
  try { root = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown> } catch {}
  const netSettings = root.net_settings && typeof root.net_settings === "object"
    ? root.net_settings as Record<string, unknown>
    : {}
  const existingClasses = Array.isArray(netSettings.classes)
    ? netSettings.classes.filter((value) => {
      const item = value && typeof value === "object" ? value as Record<string, unknown> : {}
      return !String(item.name ?? "").startsWith("WorkflowPower_")
    })
    : []
  const assignmentsRaw = netSettings.netclass_assignments
    && typeof netSettings.netclass_assignments === "object"
    && !Array.isArray(netSettings.netclass_assignments)
    ? netSettings.netclass_assignments as Record<string, unknown>
    : {}
  const assignments = { ...assignmentsRaw }
  const generated = compiled.nets.filter((item) => item.status === "ready").map((power, index) => {
    const native = ruleForNet(rules, power.net)
    const name = generatedClassName(index)
    assignments[power.net] = [name]
    return {
      name,
      clearance: native.clearance,
      track_width: power.requiredTrackWidthMm,
      via_diameter: power.viaDiameterMm,
      via_drill: power.viaDrillMm,
      diff_pair_width: native.diffPairWidth,
      diff_pair_gap: native.diffPairGap,
      diff_pair_via_gap: native.diffPairGap,
      microvia_diameter: power.viaDiameterMm,
      microvia_drill: power.viaDrillMm,
      bus_width: 12,
      wire_width: 6,
      line_style: 0,
      priority: index,
      pcb_color: "rgba(0, 0, 0, 0.000)",
      schematic_color: "rgba(0, 0, 0, 0.000)",
      tuning_profile: "",
    }
  })
  root.net_settings = {
    ...netSettings,
    classes: [...existingClasses, ...generated],
    netclass_assignments: assignments,
  }
  await writeFile(projectPath, `${JSON.stringify(root, null, 2)}\n`, "utf8")
  return { projectPath, generatedClasses: generated.length }
}

function nodeNetName(root: SExpression[], node: SExpression[]) {
  const net = findChild(node, "net")
  if (!net) return ""
  if (net.length >= 3) return atom(net[2]) ?? ""
  const id = atom(net[1]) ?? ""
  return atom(listChildren(root, "net").find((item) => atom(item[1]) === id)?.[2]) ?? id
}

function filledRings(root: SExpression[]): FilledRing[] {
  return listChildren(root, "zone").flatMap((zone) => {
    const net = nodeNetName(root, zone)
    const defaultLayer = childText(zone, "layer") ?? "F.Cu"
    return listChildren(zone, "filled_polygon").flatMap((polygon) => {
      const points = listChildren(findChild(polygon, "pts") ?? [], "xy")
        .map((point) => ({ x: numberAt(point, 1), y: numberAt(point, 2) }))
      return points.length >= 3 ? [{ net, layer: childText(polygon, "layer") ?? defaultLayer, points }] : []
    })
  })
}

function pointInRing(point: Point, ring: Point[]) {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index]
    const b = ring[previous]
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function pointSegmentDistance(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const denominator = dx * dx + dy * dy
  const ratio = denominator <= EPSILON
    ? 0
    : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator))
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy))
}

function reinforcedByFill(start: Point, end: Point, requiredWidth: number, rings: FilledRing[]) {
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  const samples = Math.max(2, Math.ceil(length / Math.max(0.05, requiredWidth / 3)))
  return rings.some((ring) => Array.from({ length: samples + 1 }, (_, index) => {
    const ratio = index / samples
    const point = { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio }
    if (!pointInRing(point, ring.points)) return false
    const boundaryDistance = Math.min(...ring.points.map((vertex, vertexIndex) => (
      pointSegmentDistance(point, vertex, ring.points[(vertexIndex + 1) % ring.points.length])
    )))
    return boundaryDistance + EPSILON >= requiredWidth / 2
  }).every(Boolean))
}

export function validatePowerRouting(
  root: SExpression[],
  compiled: CompiledPowerIntent,
): PowerRoutingValidation {
  const violations: PowerRoutingViolation[] = []
  const rings = filledRings(root)
  let reinforcedTrackItems = 0
  for (const power of compiled.nets) {
    if (power.status === "error") {
      violations.push({
        code: "POWER_INTENT_ERROR",
        net: power.net,
        message: `${power.net || "Power intent"} could not be compiled.`,
        details: power.diagnostics,
      })
      continue
    }
    for (const head of ["segment", "arc"] as const) {
      for (const item of listChildren(root, head).filter((node) => nodeNetName(root, node) === power.net)) {
        const actualWidth = numberAt(findChild(item, "width"), 1)
        if (actualWidth + EPSILON >= power.requiredTrackWidthMm) continue
        const start = { x: numberAt(findChild(item, "start"), 1), y: numberAt(findChild(item, "start"), 2) }
        const end = { x: numberAt(findChild(item, "end"), 1), y: numberAt(findChild(item, "end"), 2) }
        const layer = childText(item, "layer") ?? "F.Cu"
        const sameNetRings = rings.filter((ring) => ring.net === power.net && ring.layer === layer)
        if (head === "segment" && reinforcedByFill(start, end, power.requiredTrackWidthMm, sameNetRings)) {
          reinforcedTrackItems += 1
          continue
        }
        violations.push({
          code: "POWER_TRACK_WIDTH",
          net: power.net,
          message: `${power.net} has exposed ${actualWidth.toFixed(3)} mm copper below ${power.requiredTrackWidthMm.toFixed(3)} mm.`,
          details: { type: head, layer, actualWidthMm: actualWidth, requiredWidthMm: power.requiredTrackWidthMm, start, end },
        })
      }
    }
    const vias = listChildren(root, "via").filter((via) => nodeNetName(root, via) === power.net).map((via) => ({
      x: numberAt(findChild(via, "at"), 1),
      y: numberAt(findChild(via, "at"), 2),
      diameter: numberAt(findChild(via, "size"), 1),
      drill: numberAt(findChild(via, "drill"), 1),
    }))
    for (const via of vias) if (via.diameter + EPSILON < power.viaDiameterMm || via.drill + EPSILON < power.viaDrillMm) {
      violations.push({
        code: "POWER_VIA_GEOMETRY",
        net: power.net,
        message: `${power.net} via ${via.diameter.toFixed(3)}/${via.drill.toFixed(3)} mm is below the calculated minimum.`,
        details: { ...via, requiredDiameterMm: power.viaDiameterMm, requiredDrillMm: power.viaDrillMm },
      })
    }
    if (power.requiredParallelVias > 1 && vias.length) {
      const unvisited = new Set(vias.map((_, index) => index))
      const clusterRadius = power.viaDiameterMm + power.obstacleClearanceMm
      while (unvisited.size) {
        const seed = unvisited.values().next().value as number
        const cluster = [seed]
        unvisited.delete(seed)
        for (let cursor = 0; cursor < cluster.length; cursor += 1) {
          const a = vias[cluster[cursor]]
          for (const index of [...unvisited]) {
            const b = vias[index]
            if (Math.hypot(a.x - b.x, a.y - b.y) <= clusterRadius + EPSILON) {
              unvisited.delete(index)
              cluster.push(index)
            }
          }
        }
        const barrelAreaMm2 = cluster.reduce((sum, index) => (
          sum + Math.PI * vias[index].drill * compiled.viaPlatingThicknessUm / 1_000
        ), 0)
        if (barrelAreaMm2 + EPSILON < power.requiredCopperAreaMm2) violations.push({
          code: "POWER_VIA_PARALLEL_COUNT",
          net: power.net,
          message: `${power.net} via transition has insufficient barrel copper; it needs ${power.requiredParallelVias} minimum-size vias or an equivalent larger via.`,
          details: {
            requiredParallelVias: power.requiredParallelVias,
            requiredCopperAreaMm2: power.requiredCopperAreaMm2,
            actualBarrelAreaMm2: barrelAreaMm2,
            vias: cluster.map((index) => vias[index]),
          },
        })
      }
    }
  }
  return {
    completed: true,
    valid: violations.length === 0,
    checkedNets: compiled.nets.length,
    violations,
    reinforcedTrackItems,
  }
}
