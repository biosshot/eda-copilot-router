import type {
  RoutingBoard,
  RoutingDiagnostic,
  RoutingRuleOverride,
  RoutingRules,
  RoutingRuleValues,
} from "../core/contracts.js"
import type { RouterBackendCapabilities, RouterCapability } from "../adapters/contracts.js"
import type {
  DifferentialPairIntent,
  LayerSelector,
  RoutingProgram,
} from "./types.js"
import { validateRoutingProgram } from "./validation.js"

const COPPER_MM_PER_OZ = 0.03479
const DEFAULT_TEMP_RISE_C = 16
const DEFAULT_VIA_PLATING_UM = 20
const WIDTH_GRID_MM = 0.05
/**
 * Absolute manufacturing/search floor for a short neck-down. Power-current
 * calculations select the preferred trunk width; they must not make that
 * width mandatory at a fine-pitch pad escape.
 */
export const HARD_MIN_TRACK_WIDTH_MM = 0.127
const EPSILON = 1e-6

export type CompiledRoutingRules = Readonly<{
  effective: RoutingRules
  overriddenFields: readonly RoutingRuleOverride[]
  diagnostics: readonly RoutingDiagnostic[]
  requiredCapabilities: readonly RouterCapability[]
}>

function diagnostic(code: string, message: string, details?: unknown): RoutingDiagnostic {
  return { code, severity: "error", message, ...(details === undefined ? {} : { details }) }
}

function valuesForNet(rules: RoutingRules, net: string) {
  return rules.nets.find((entry) => entry.net === net)?.values ?? rules.default
}

function roundedUp(value: number) {
  return Number((Math.ceil((value - EPSILON) / WIDTH_GRID_MM) * WIDTH_GRID_MM).toFixed(6))
}

/** IPC-2221 chart equation retained as the documented conservative fallback. */
export function calculateTrackWidthMm(
  currentA: number,
  maxTempRiseC: number,
  copperThicknessMm: number,
  external: boolean,
) {
  const coefficient = external ? 0.048 : 0.024
  const crossSectionMil2 = (currentA / (coefficient * maxTempRiseC ** 0.44)) ** (1 / 0.725)
  return crossSectionMil2 / (copperThicknessMm / 0.0254) * 0.0254
}

function selectedLayers(board: RoutingBoard, selector?: LayerSelector) {
  if (!selector) return board.layers.map((layer) => layer.name)
  if (selector.kind === "top") return board.layers.filter((layer) => layer.side === "top").map((layer) => layer.name)
  if (selector.kind === "bottom") return board.layers.filter((layer) => layer.side === "bottom").map((layer) => layer.name)
  if (selector.kind === "outer") return board.layers.filter((layer) => layer.side !== "inner").map((layer) => layer.name)
  return [...selector.names]
}

function copperThicknesses(board: RoutingBoard, selector?: LayerSelector, fallbackOz = 1) {
  const names = selectedLayers(board, selector)
  const stackup = board.stackup?.layers ?? []
  return names.map((name) => {
    const explicit = stackup.find((layer) => layer.kind === "copper" && layer.layer === name)
    return {
      layer: name,
      external: board.layers.find((layer) => layer.name === name)?.side !== "inner",
      thicknessMm: explicit?.kind === "copper" ? explicit.thicknessMm : fallbackOz * COPPER_MM_PER_OZ,
    }
  })
}

function changed(scope: RoutingRuleOverride["scope"], source: RoutingRuleValues, effective: RoutingRuleValues) {
  const output: RoutingRuleOverride[] = []
  const walk = (before: unknown, after: unknown, path: string) => {
    if (before && after && typeof before === "object" && typeof after === "object"
      && !Array.isArray(before) && !Array.isArray(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        walk((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], path ? `${path}.${key}` : key)
      }
      return
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) output.push({ scope, field: path, source: before, effective: after })
  }
  walk(source, effective, "")
  return output
}

function applyAbsolute(
  base: RoutingRuleValues,
  intent: {
    trackWidthMm?: number
    minTrackWidthMm?: number
    clearanceMm?: number
    maxLengthMm?: number
    allowedLayers?: LayerSelector
    via?: { diameterMm?: number; drillMm?: number }
    impedance?: { targetOhm: number; tolerancePercent?: number }
  },
  board: RoutingBoard,
): RoutingRuleValues {
  const exact = intent.trackWidthMm
  const minimum = exact ?? intent.minTrackWidthMm ?? base.minTrackWidthMm
  return {
    ...base,
    minTrackWidthMm: minimum,
    preferredTrackWidthMm: exact ?? Math.max(base.preferredTrackWidthMm, minimum),
    ...(intent.clearanceMm === undefined ? {} : { clearanceMm: intent.clearanceMm }),
    ...(intent.maxLengthMm === undefined ? {} : { maxLengthMm: intent.maxLengthMm }),
    ...(intent.allowedLayers === undefined ? {} : { allowedLayers: selectedLayers(board, intent.allowedLayers) }),
    ...(intent.impedance === undefined ? {} : {
      impedanceOhm: intent.impedance.targetOhm,
      ...(intent.impedance.tolerancePercent === undefined ? {} : { impedanceTolerancePercent: intent.impedance.tolerancePercent }),
    }),
    via: {
      ...base.via,
      minDiameterMm: intent.via?.diameterMm ?? base.via.minDiameterMm,
      preferredDiameterMm: intent.via?.diameterMm ?? base.via.preferredDiameterMm,
      minDrillMm: intent.via?.drillMm ?? base.via.minDrillMm,
      preferredDrillMm: intent.via?.drillMm ?? base.via.preferredDrillMm,
    },
  }
}

function pairRules(base: RoutingRuleValues, pair: DifferentialPairIntent, board: RoutingBoard): RoutingRuleValues {
  const absolute = applyAbsolute(base, pair, board)
  return {
    ...absolute,
    differential: {
      trackWidthMm: pair.trackWidthMm ?? base.differential?.trackWidthMm ?? absolute.preferredTrackWidthMm,
      gapMm: pair.gapMm ?? base.differential?.gapMm ?? base.clearanceMm,
      ...(pair.maxSkewMm ?? base.differential?.maxSkewMm) === undefined ? {} : {
        maxSkewMm: pair.maxSkewMm ?? base.differential?.maxSkewMm,
      },
      ...(pair.maxUncoupledLengthMm ?? base.differential?.maxUncoupledLengthMm) === undefined ? {} : {
        maxUncoupledLengthMm: pair.maxUncoupledLengthMm ?? base.differential?.maxUncoupledLengthMm,
      },
    },
  }
}

export function compileRoutingRules(
  board: RoutingBoard,
  program: RoutingProgram,
  backendCapabilities?: RouterBackendCapabilities,
): CompiledRoutingRules {
  const validation = validateRoutingProgram(program)
  const diagnostics = [...validation.diagnostics]
  if (!validation.valid) return {
    effective: board.rules,
    overriddenFields: [],
    diagnostics,
    requiredCapabilities: [],
  }
  const knownNets = new Set(board.nets.map((net) => net.name))
  const knownLayers = new Set(board.layers.map((layer) => layer.name))
  const byNet = new Map(board.nets.map((net) => [net.name, valuesForNet(board.rules, net.name)]))
  const originalByNet = new Map(byNet)
  const required = new Set<RouterCapability>()

  const checkNet = (net: string) => {
    if (!knownNets.has(net)) diagnostics.push(diagnostic("DSL_UNKNOWN_NET", `Net ${net} does not exist.`))
  }
  const checkLayers = (selector?: LayerSelector) => {
    for (const layer of selectedLayers(board, selector)) if (!knownLayers.has(layer)) {
      diagnostics.push(diagnostic("DSL_UNKNOWN_LAYER", `Copper layer ${layer} does not exist.`))
    }
  }

  for (const polygon of program.polygons) {
    required.add("preserve-fixed-copper")
    required.add("fixed-zone-obstacles")
    required.add("preconnected-pad-groups")
    checkNet(polygon.net)
    checkLayers(polygon.layers)
    for (const target of polygon.targets) {
      if (target.kind === "net") checkNet(target.net)
      else {
        const pads = board.pads.filter((item) => item.component === target.component && item.number === target.pad)
        if (!pads.length) diagnostics.push(diagnostic("DSL_UNKNOWN_PAD", `Pad ${target.component}.${target.pad} does not exist.`))
        else if (pads.some((pad) => pad.net !== polygon.net)) diagnostics.push(diagnostic(
          "DSL_PAD_NET_MISMATCH", `Physical pads for ${target.component}.${target.pad} are not all on ${polygon.net}.`,
        ))
      }
    }
  }
  for (const plane of program.planes) {
    checkNet(plane.net)
    checkLayers(plane.layers)
    if (plane.region.kind === "components") diagnostics.push(diagnostic("UNSUPPORTED_CONSTRAINT", "components(...) plane regions are reserved but not implemented."))
  }
  for (const signal of program.signalNets) {
    checkNet(signal.net); checkLayers(signal.allowedLayers)
    if (signal.impedance) required.add("impedance-controlled")
    const base = byNet.get(signal.net) ?? board.rules.default
    byNet.set(signal.net, applyAbsolute(base, signal, board))
  }
  const fallbackOz = program.manufacturing?.fallbackCopperThicknessOz
    ?? board.stackup?.fallbackCopperThicknessOz ?? 1
  const widthCeiling = program.manufacturing?.maxTrackWidthMm ?? 10
  const platingUm = program.manufacturing?.viaPlatingThicknessUm ?? DEFAULT_VIA_PLATING_UM
  for (const power of program.powerNets) {
    checkNet(power.net); checkLayers(power.allowedLayers)
    const base = byNet.get(power.net) ?? board.rules.default
    if (power.minTrackWidthMm !== undefined && power.minTrackWidthMm < HARD_MIN_TRACK_WIDTH_MM - EPSILON) {
      diagnostics.push(diagnostic(
        "DSL_RULE_CONFLICT",
        `${power.net} requests ${power.minTrackWidthMm.toFixed(3)} mm copper, below the hard ${HARD_MIN_TRACK_WIDTH_MM.toFixed(3)} mm routing floor.`,
      ))
    }
    const physicalWidth = power.maxCurrentA === undefined ? 0 : Math.max(...copperThicknesses(
      board, power.allowedLayers, fallbackOz,
    ).map((layer) => calculateTrackWidthMm(
      power.maxCurrentA!, power.maxTempRiseC ?? DEFAULT_TEMP_RISE_C, layer.thicknessMm, layer.external,
    )))
    const preferredWidth = roundedUp(Math.max(
      HARD_MIN_TRACK_WIDTH_MM,
      base.preferredTrackWidthMm,
      physicalWidth,
      power.minTrackWidthMm ?? 0,
    ))
    const maximum = Math.min(power.maxTrackWidthMm ?? widthCeiling, 10)
    if (preferredWidth > maximum + EPSILON) diagnostics.push(diagnostic(
      "DSL_RULE_CONFLICT", `${power.net} needs ${preferredWidth.toFixed(2)} mm copper, above maxTrackWidthMm=${maximum.toFixed(2)} mm.`,
    ))
    const explicit = applyAbsolute(base, {
      clearanceMm: power.clearanceMm,
      allowedLayers: power.allowedLayers,
      via: power.via,
    }, board)
    const requiredArea = preferredWidth * Math.max(...copperThicknesses(board, power.allowedLayers, fallbackOz).map((layer) => layer.thicknessMm))
    const barrelArea = Math.PI * explicit.via.preferredDrillMm * platingUm / 1_000
    const requiredParallelVias = Math.max(1, Math.ceil(requiredArea / barrelArea - EPSILON))
    if (requiredParallelVias > 1) required.add("parallel-vias")
    byNet.set(power.net, {
      ...explicit,
      minTrackWidthMm: HARD_MIN_TRACK_WIDTH_MM,
      preferredTrackWidthMm: Math.max(explicit.preferredTrackWidthMm, preferredWidth),
      via: {
        ...explicit.via,
        minParallelCount: requiredParallelVias,
      },
    })
    if (!Number.isFinite(requiredParallelVias)) diagnostics.push(diagnostic("DSL_VIA_CONFLICT", `${power.net} has invalid via current geometry.`))
  }
  for (const pair of program.differentialPairs) {
    required.add("differential-pairs")
    if (pair.impedance) required.add("impedance-controlled")
    checkNet(pair.positive); checkNet(pair.negative); checkLayers(pair.allowedLayers)
    const positiveBase = byNet.get(pair.positive) ?? board.rules.default
    const negativeBase = byNet.get(pair.negative) ?? board.rules.default
    byNet.set(pair.positive, pairRules(positiveBase, pair, board))
    byNet.set(pair.negative, pairRules(negativeBase, pair, board))
  }
  const differentialPairs = [...(board.rules.differentialPairs ?? [])]
  for (const pair of program.differentialPairs) {
    const replacement = { id: pair.id, positive: pair.positive, negative: pair.negative }
    const index = differentialPairs.findIndex((item) => item.id === pair.id)
    if (index >= 0) differentialPairs[index] = replacement
    else differentialPairs.push(replacement)
  }
  const matchedGroups = [...(board.rules.matchedGroups ?? [])]
  for (const group of program.matchedGroups) {
    required.add("matched-length")
    for (const net of group.nets) checkNet(net)
    const inherited = matchedGroups.find((item) => item.id === group.id)
    const toleranceMm = group.toleranceMm ?? inherited?.toleranceMm
    if (toleranceMm === undefined) diagnostics.push(diagnostic(
      "DSL_MATCH_TOLERANCE_REQUIRED", `${group.id} needs toleranceMm because no source rule supplies it.`,
    ))
    else {
      const index = matchedGroups.findIndex((item) => item.id === group.id)
      const replacement = { id: group.id, nets: [...group.nets], toleranceMm }
      if (index >= 0) matchedGroups[index] = replacement
      else matchedGroups.push(replacement)
    }
  }
  if (program.operation !== "apply-drc") required.add("ordinary-routing")
  const effective: RoutingRules = {
    default: board.rules.default,
    nets: board.nets.map(({ name }) => ({ net: name, values: byNet.get(name) ?? board.rules.default })),
    ...(differentialPairs.length ? { differentialPairs } : {}),
    ...(matchedGroups.length ? { matchedGroups } : {}),
  }
  const overriddenFields = effective.nets.flatMap(({ net, values }) => changed(
    { net }, originalByNet.get(net) ?? board.rules.default, values,
  ))
  if (program.operation === "route") {
    const powerNets = new Set(program.powerNets.map((item) => item.net))
    const weakening = overriddenFields.filter((item) => {
      if (typeof item.source !== "number" || typeof item.effective !== "number") return false
      if (item.field === "minTrackWidthMm"
        && typeof item.scope === "object"
        && "net" in item.scope
        && powerNets.has(item.scope.net)
        && Math.abs(item.effective - HARD_MIN_TRACK_WIDTH_MM) <= EPSILON) return false
      if (/maxLength|maxSkew|maxUncoupled|tolerance/i.test(item.field)) return item.effective > item.source
      return /clearance|minTrackWidth|diameter|drill|gap/i.test(item.field) && item.effective < item.source
    })
    if (weakening.length) diagnostics.push(diagnostic(
      "DRC_APPLY_REQUIRED", "runRouting() cannot use rules weaker than unchanged source DRC; use runAll().", weakening,
    ))
  }
  if (backendCapabilities) {
    const supported = new Set(backendCapabilities.supported)
    const missing = [...required].filter((capability) => !supported.has(capability))
    if (missing.length) diagnostics.push(diagnostic("CAPABILITY_MISMATCH", "Backend lacks required capabilities.", { missing }))
    if (backendCapabilities.maxCopperLayers !== undefined && board.layers.length > backendCapabilities.maxCopperLayers) {
      diagnostics.push(diagnostic("CAPABILITY_MISMATCH", "Backend copper-layer limit is too small.", {
        actual: board.layers.length, maximum: backendCapabilities.maxCopperLayers,
      }))
    }
  }
  return {
    effective,
    overriddenFields,
    diagnostics,
    requiredCapabilities: [...required],
  }
}
