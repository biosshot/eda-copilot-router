import type {
  RoutingBoard,
  RoutingDiagnostic,
  RoutingRuleOverride,
  RoutingRules,
  RoutingRuleValues,
  RoutingStackup,
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

function effectiveStackup(board: RoutingBoard, program: RoutingProgram): RoutingStackup | undefined {
  if (!program.stack?.layers) return board.stackup
  return {
    fallbackCopperThicknessOz: program.stack.fallbackCopperThicknessOz
      ?? board.stackup?.fallbackCopperThicknessOz ?? 1,
    layers: program.stack.layers.map((layer) => layer.kind === "copper"
      ? {
          kind: "copper" as const,
          layer: resolvePhysicalLayer(board, layer.name) ?? layer.name,
          thicknessMm: layer.thicknessMm ?? (layer.thicknessOz
            ?? program.stack?.fallbackCopperThicknessOz
            ?? board.stackup?.fallbackCopperThicknessOz ?? 1) * COPPER_MM_PER_OZ,
        }
      : {
          kind: "dielectric" as const,
          thicknessMm: layer.thicknessMm ?? Number.NaN,
          ...(layer.relativePermittivity === undefined ? {} : { relativePermittivity: layer.relativePermittivity }),
          ...(layer.material === undefined ? {} : { material: layer.material }),
        }),
  }
}

function resolvePhysicalLayer(board: RoutingBoard, name: string) {
  if (name === "TOP") return board.layers.find((layer) => layer.side === "top")?.name
  if (name === "BOTTOM") return board.layers.find((layer) => layer.side === "bottom")?.name
  const match = /^INNER_(\d+)$/.exec(name)
  return match ? board.layers.filter((layer) => layer.side === "inner")
    .sort((left, right) => left.index - right.index)[Number(match[1]) - 1]?.name : undefined
}

function referenceLayers(board: RoutingBoard, program: RoutingProgram, net: string) {
  const names = new Set<string>()
  for (const plane of program.planes.filter((item) => item.net === net)) {
    for (const layer of selectedLayers(board, plane.layers)) names.add(layer)
  }
  for (const zone of [...board.copper.fixed.zones, ...board.copper.editable.zones]) {
    if (zone.net === net) for (const layer of zone.layers) names.add(layer)
  }
  return names
}

function impedanceForMicrostrip(width: number, height: number, thickness: number, er: number) {
  return 87 / Math.sqrt(er + 1.41) * Math.log(5.98 * height / (0.8 * width + thickness))
}

function solveSingleEndedWidth(targetOhm: number, height: number, thickness: number, er: number) {
  return (5.98 * height / Math.exp(targetOhm * Math.sqrt(er + 1.41) / 87) - thickness) / 0.8
}

function nearestReference(
  board: RoutingBoard,
  program: RoutingProgram,
  signalLayer: string,
  referenceNet: string,
) {
  const stack = effectiveStackup(board, program)
  if (!stack) return undefined
  const copperIndexes = stack.layers.flatMap((layer, index) => layer.kind === "copper" ? [{ layer: layer.layer, index }] : [])
  const signal = copperIndexes.find((item) => item.layer === signalLayer)
  const references = referenceLayers(board, program, referenceNet)
  if (!signal || !references.size) return undefined
  // A same-layer pour is not a microstrip reference plane. Keep searching for
  // the nearest other copper layer separated by a dielectric.
  const candidates = copperIndexes.filter((item) => references.has(item.layer) && item.layer !== signalLayer)
    .sort((left, right) => Math.abs(left.index - signal.index) - Math.abs(right.index - signal.index))
  const reference = candidates[0]
  if (!reference) return undefined
  const low = Math.min(signal.index, reference.index)
  const high = Math.max(signal.index, reference.index)
  const dielectric = stack.layers.slice(low + 1, high).filter((layer) => layer.kind === "dielectric")
  if (!dielectric.length || dielectric.some((layer) => !Number.isFinite(layer.thicknessMm)
    || !Number.isFinite(layer.relativePermittivity))) return undefined
  const heightMm = dielectric.reduce((total, layer) => total + layer.thicknessMm, 0)
  const relativePermittivity = dielectric.reduce((total, layer) => (
    total + layer.relativePermittivity! * layer.thicknessMm
  ), 0) / heightMm
  const copper = stack.layers[signal.index]
  return copper.kind === "copper" ? {
    layer: reference.layer,
    heightMm,
    relativePermittivity,
    copperThicknessMm: copper.thicknessMm,
  } : undefined
}

function applyImpedanceConstraint(
  board: RoutingBoard,
  program: RoutingProgram,
  net: string,
  base: RoutingRuleValues,
  constraint: NonNullable<RoutingProgram["signalNets"][number]["impedance"]>,
  diagnostics: RoutingDiagnostic[],
  differentialGapMm?: number,
) {
  const topology = constraint.topology ?? "microstrip"
  const referenceNet = constraint.reference?.net
  const allowed = base.allowedLayers ?? board.layers.map((layer) => layer.name)
  if (!referenceNet) {
    diagnostics.push(diagnostic("IMPEDANCE_REFERENCE_REQUIRED", `${net} impedance requires reference.net.`))
    return base
  }
  if (topology !== "microstrip") {
    diagnostics.push(diagnostic(
      "IMPEDANCE_TOPOLOGY_UNSUPPORTED",
      `${net} ${topology} needs a dedicated field solver; the built-in deterministic solver currently supports microstrip.`,
    ))
    return base
  }
  const candidates = allowed.flatMap((layer) => {
    const reference = nearestReference(board, program, layer, referenceNet)
    if (!reference) return []
    const singleTarget = differentialGapMm === undefined ? constraint.targetOhm : constraint.targetOhm / 2
    let width = solveSingleEndedWidth(singleTarget, reference.heightMm, reference.copperThicknessMm, reference.relativePermittivity)
    if (differentialGapMm !== undefined) {
      for (let iteration = 0; iteration < 8; iteration += 1) {
        const single = impedanceForMicrostrip(width, reference.heightMm, reference.copperThicknessMm, reference.relativePermittivity)
        const factor = 2 * (1 - 0.48 * Math.exp(-0.96 * differentialGapMm / reference.heightMm))
        width *= Math.max(0.25, Math.min(4, single * factor / constraint.targetOhm))
      }
    }
    return Number.isFinite(width) && width > 0 ? [{ layer, reference, width }] : []
  })
  if (!candidates.length) {
    diagnostics.push(diagnostic(
      "IMPEDANCE_STACK_INCOMPLETE",
      `${net} has no routable layer with a nearest ${referenceNet} plane and complete dielectric thickness/relativePermittivity.`,
    ))
    return base
  }
  candidates.sort((left, right) => left.width - right.width || left.layer.localeCompare(right.layer))
  const selected = candidates[0]
  const preferred = roundedUp(Math.max(base.minTrackWidthMm, selected.width))
  const single = impedanceForMicrostrip(preferred, selected.reference.heightMm, selected.reference.copperThicknessMm, selected.reference.relativePermittivity)
  const achieved = differentialGapMm === undefined ? single : single * 2
    * (1 - 0.48 * Math.exp(-0.96 * differentialGapMm / selected.reference.heightMm))
  const tolerance = constraint.tolerancePercent ?? 10
  if (Math.abs(achieved - constraint.targetOhm) / constraint.targetOhm * 100 > tolerance + EPSILON) diagnostics.push(diagnostic(
    "IMPEDANCE_TOLERANCE_UNREACHABLE",
    `${net} resolves to ${achieved.toFixed(1)} ohm at ${preferred.toFixed(3)} mm, outside ±${tolerance}%.`,
  ))
  return {
    ...base,
    preferredTrackWidthMm: preferred,
    impedanceOhm: constraint.targetOhm,
    impedanceTolerancePercent: tolerance,
    impedanceTopology: topology,
    impedanceReferenceNet: referenceNet,
    impedanceReferenceLayers: [selected.reference.layer],
    allowedLayers: [selected.layer],
    ...(differentialGapMm === undefined ? {} : {
      differential: { ...(base.differential ?? { trackWidthMm: preferred, gapMm: differentialGapMm }), trackWidthMm: preferred, gapMm: differentialGapMm },
    }),
  }
}

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
  if (selector.kind === "all") return board.layers.map((layer) => layer.name)
  if (selector.kind === "top") return board.layers.filter((layer) => layer.side === "top").map((layer) => layer.name)
  if (selector.kind === "bottom") return board.layers.filter((layer) => layer.side === "bottom").map((layer) => layer.name)
  if (selector.kind === "outer") return board.layers.filter((layer) => layer.side !== "inner").map((layer) => layer.name)
  return selector.names.map((name) => resolvePhysicalLayer(board, name) ?? name)
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
    edgeClearanceMm?: number
    holeToHoleClearanceMm?: number
    maxLengthMm?: number
    allowedLayers?: LayerSelector
    via?: { diameterMm?: number; drillMm?: number; minDiameterMm?: number; minDrillMm?: number }
    impedance?: {
      targetOhm: number
      tolerancePercent?: number
      topology?: "microstrip" | "stripline" | "coplanar"
      reference?: { net: string }
    }
  },
  board: RoutingBoard,
): RoutingRuleValues {
  const minimum = intent.minTrackWidthMm ?? base.minTrackWidthMm
  const preferred = intent.trackWidthMm ?? Math.max(base.preferredTrackWidthMm, minimum)
  return {
    ...base,
    minTrackWidthMm: minimum,
    preferredTrackWidthMm: preferred,
    ...(intent.clearanceMm === undefined ? {} : { clearanceMm: intent.clearanceMm }),
    ...(intent.edgeClearanceMm === undefined ? {} : { edgeClearanceMm: intent.edgeClearanceMm }),
    ...(intent.holeToHoleClearanceMm === undefined ? {} : { holeToHoleClearanceMm: intent.holeToHoleClearanceMm }),
    ...(intent.maxLengthMm === undefined ? {} : { maxLengthMm: intent.maxLengthMm }),
    ...(intent.allowedLayers === undefined ? {} : { allowedLayers: selectedLayers(board, intent.allowedLayers) }),
    ...(intent.impedance === undefined ? {} : {
      impedanceOhm: intent.impedance.targetOhm,
      ...(intent.impedance.tolerancePercent === undefined ? {} : { impedanceTolerancePercent: intent.impedance.tolerancePercent }),
      ...(intent.impedance.topology === undefined ? {} : { impedanceTopology: intent.impedance.topology }),
      ...(intent.impedance.reference === undefined ? {} : { impedanceReferenceNet: intent.impedance.reference.net }),
    }),
    via: {
      ...base.via,
      minDiameterMm: intent.via?.minDiameterMm ?? base.via.minDiameterMm,
      preferredDiameterMm: intent.via?.diameterMm
        ?? Math.max(base.via.preferredDiameterMm, intent.via?.minDiameterMm ?? base.via.minDiameterMm),
      minDrillMm: intent.via?.minDrillMm ?? base.via.minDrillMm,
      preferredDrillMm: intent.via?.drillMm
        ?? Math.max(base.via.preferredDrillMm, intent.via?.minDrillMm ?? base.via.minDrillMm),
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
  const sourceDefault = board.rules.default
  const effectiveDefault = program.drc ? applyAbsolute(sourceDefault, program.drc, board) : sourceDefault
  const byNet = new Map(board.nets.map((net) => [
    net.name,
    program.drc ? applyAbsolute(valuesForNet(board.rules, net.name), program.drc, board) : valuesForNet(board.rules, net.name),
  ]))
  const originalByNet = new Map(board.nets.map((net) => [net.name, valuesForNet(board.rules, net.name)]))
  const required = new Set<RouterCapability>()

  const checkNet = (net: string) => {
    if (!knownNets.has(net)) diagnostics.push(diagnostic("DSL_UNKNOWN_NET", `Net ${net} does not exist.`))
  }
  const checkLayers = (selector?: LayerSelector) => {
    for (const layer of selectedLayers(board, selector)) if (!knownLayers.has(layer)) {
      diagnostics.push(diagnostic("DSL_UNKNOWN_LAYER", `Copper layer ${layer} does not exist.`))
    }
  }

  const classByName = new Map<string, RoutingProgram["netClasses"][number]>()
  const classValues = new Map<string, RoutingRuleValues>()
  const classForNet = new Map<string, string>()
  for (const netClass of program.netClasses) {
    if (classByName.has(netClass.name)) diagnostics.push(diagnostic("DSL_DUPLICATE_NET_CLASS", `Net class ${netClass.name} is declared more than once.`))
    classByName.set(netClass.name, netClass)
    classValues.set(netClass.name, applyAbsolute(effectiveDefault, netClass, board))
    checkLayers(netClass.allowedLayers)
    for (const net of netClass.nets) {
      checkNet(net)
      const previous = classForNet.get(net)
      if (previous && previous !== netClass.name) diagnostics.push(diagnostic(
        "DSL_NET_CLASS_CONFLICT", `${net} is assigned to both ${previous} and ${netClass.name}.`,
      ))
      classForNet.set(net, netClass.name)
      byNet.set(net, applyAbsolute(byNet.get(net) ?? effectiveDefault, netClass, board))
    }
  }
  for (const intent of [...program.signalNets, ...program.powerNets]) {
    if (!intent.netClass) continue
    const declared = classByName.get(intent.netClass)
    if (!declared) diagnostics.push(diagnostic("DSL_UNKNOWN_NET_CLASS", `Net class ${intent.netClass} does not exist.`))
    else if (!declared.nets.includes(intent.net)) diagnostics.push(diagnostic(
      "DSL_NET_CLASS_MEMBERSHIP", `${intent.net} names class ${intent.netClass} but is not a member of it.`,
    ))
  }

  for (const net of program.onlyNets ?? []) checkNet(net)
  for (const net of program.ignoreNets) checkNet(net)
  const knownComponents = new Set(board.components.map((component) => component.designator))
  for (const target of [
    ...(program.fanouts ?? []).map((item) => item.target),
    ...program.fanoutExclusions,
  ]) {
    if (!knownComponents.has(target.component)) {
      diagnostics.push(diagnostic("DSL_UNKNOWN_COMPONENT", `Component ${target.component} does not exist.`))
      continue
    }
    if (target.kind === "pad" && !board.pads.some((pad) => (
      pad.component === target.component && pad.number === target.pad
    ))) diagnostics.push(diagnostic(
      "DSL_UNKNOWN_PAD", `Pad ${target.component}.${target.pad} does not exist.`,
    ))
  }
  const disabledFanoutComponents = new Set(program.fanoutExclusions
    .filter((target) => target.kind === "component").map((target) => target.component))
  const disabledFanoutPads = new Set(program.fanoutExclusions
    .filter((target) => target.kind === "pad").map((target) => `${target.component}\u0000${target.pad}`))
  for (const intent of program.fanouts ?? []) {
    if (disabledFanoutComponents.has(intent.target.component)
      || (intent.target.kind === "pad" && disabledFanoutPads.has(`${intent.target.component}\u0000${intent.target.pad}`))) {
      diagnostics.push(diagnostic(
        "DSL_FANOUT_POLICY_CONFLICT",
        `Fanout for ${intent.target.component}${intent.target.kind === "pad" ? `.${intent.target.pad}` : ""} is both configured and disabled.`,
      ))
    }
  }
  if (program.onlyNets?.some((net) => program.ignoreNets.includes(net))) diagnostics.push(diagnostic(
    "DSL_SCOPE_CONFLICT", "The same net cannot appear in onlyNets() and ignoreNets().",
  ))
  const selected = (net: string) => (!program.onlyNets || program.onlyNets.includes(net)) && !program.ignoreNets.includes(net)
  for (const [id, members] of [
    ...program.differentialPairs.map((item) => [item.id, [item.positive, item.negative]] as const),
    ...program.matchedGroups.map((item) => [item.id, item.nets] as const),
  ]) {
    const count = members.filter(selected).length
    if (count > 0 && count < members.length) diagnostics.push(diagnostic(
      "DSL_ATOMIC_SCOPE_CONFLICT", `Scope selects only part of atomic special group ${id}.`, { id, members },
    ))
  }
  if (program.clearRouting?.nets !== "all") for (const net of program.clearRouting?.nets ?? []) checkNet(net)

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
    if (signal.impedance?.reference) checkNet(signal.impedance.reference.net)
    const base = byNet.get(signal.net) ?? board.rules.default
    const absolute = applyAbsolute(base, signal, board)
    byNet.set(signal.net, signal.impedance
      ? applyImpedanceConstraint(board, program, signal.net, absolute, signal.impedance, diagnostics)
      : absolute)
  }
  const fallbackOz = program.stack?.fallbackCopperThicknessOz
    ?? board.stackup?.fallbackCopperThicknessOz ?? 1
  const calculationBoard: RoutingBoard = { ...board, stackup: effectiveStackup(board, program) }
  const widthCeiling = program.stack?.maxTrackWidthMm ?? 10
  const platingUm = program.stack?.viaPlatingThicknessUm ?? DEFAULT_VIA_PLATING_UM
  for (const power of program.powerNets) {
    checkNet(power.net); checkLayers(power.allowedLayers)
    for (const target of power.powerPads ?? []) {
      const pads = board.pads.filter((item) => item.component === target.component && item.number === target.pad)
      if (!pads.length) diagnostics.push(diagnostic("DSL_UNKNOWN_PAD", `Pad ${target.component}.${target.pad} does not exist.`))
      else if (pads.some((pad) => pad.net !== power.net)) diagnostics.push(diagnostic(
        "DSL_PAD_NET_MISMATCH", `Physical pads for ${target.component}.${target.pad} are not all on ${power.net}.`,
      ))
    }
    const base = byNet.get(power.net) ?? board.rules.default
    if (power.minTrackWidthMm !== undefined && power.minTrackWidthMm < HARD_MIN_TRACK_WIDTH_MM - EPSILON) {
      diagnostics.push(diagnostic(
        "DSL_RULE_CONFLICT",
        `${power.net} requests ${power.minTrackWidthMm.toFixed(3)} mm copper, below the hard ${HARD_MIN_TRACK_WIDTH_MM.toFixed(3)} mm routing floor.`,
      ))
    }
    const physicalWidth = power.maxCurrentA === undefined ? 0 : Math.max(...copperThicknesses(
      calculationBoard, power.allowedLayers, fallbackOz,
    ).map((layer) => calculateTrackWidthMm(
      power.maxCurrentA!, power.maxTempRiseC ?? DEFAULT_TEMP_RISE_C, layer.thicknessMm, layer.external,
    )))
    const explicit = applyAbsolute(base, {
      trackWidthMm: power.trackWidthMm,
      minTrackWidthMm: power.minTrackWidthMm,
      clearanceMm: power.clearanceMm,
      allowedLayers: power.allowedLayers,
      via: power.via,
    }, board)
    const preferredWidth = roundedUp(Math.max(
      HARD_MIN_TRACK_WIDTH_MM,
      explicit.preferredTrackWidthMm,
      physicalWidth,
    ))
    const maximum = Math.min(power.maxTrackWidthMm ?? widthCeiling, 10)
    if (preferredWidth > maximum + EPSILON) diagnostics.push(diagnostic(
      "DSL_RULE_CONFLICT", `${power.net} needs ${preferredWidth.toFixed(2)} mm copper, above maxTrackWidthMm=${maximum.toFixed(2)} mm.`,
    ))
    const requiredArea = preferredWidth * Math.max(...copperThicknesses(calculationBoard, power.allowedLayers, fallbackOz).map((layer) => layer.thicknessMm))
    const barrelArea = Math.PI * explicit.via.preferredDrillMm * platingUm / 1_000
    const requiredParallelVias = Math.max(1, Math.ceil(requiredArea / barrelArea - EPSILON))
    if (requiredParallelVias > 1) required.add("parallel-vias")
    byNet.set(power.net, {
      ...explicit,
      minTrackWidthMm: Math.max(explicit.minTrackWidthMm, HARD_MIN_TRACK_WIDTH_MM),
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
    if (pair.impedance?.reference) checkNet(pair.impedance.reference.net)
    checkNet(pair.positive); checkNet(pair.negative); checkLayers(pair.allowedLayers)
    const positiveBase = byNet.get(pair.positive) ?? board.rules.default
    const negativeBase = byNet.get(pair.negative) ?? board.rules.default
    const positive = pairRules(positiveBase, pair, board)
    const negative = pairRules(negativeBase, pair, board)
    const gap = positive.differential?.gapMm ?? negative.differential?.gapMm ?? positive.clearanceMm
    byNet.set(pair.positive, pair.impedance
      ? applyImpedanceConstraint(board, program, pair.positive, positive, pair.impedance, diagnostics, gap)
      : positive)
    byNet.set(pair.negative, pair.impedance
      ? applyImpedanceConstraint(board, program, pair.negative, negative, pair.impedance, diagnostics, gap)
      : negative)
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
  for (const fence of program.viaFences) {
    required.add("vias")
    checkNet(fence.net)
    for (const net of fence.along) checkNet(net)
  }
  // runAll() persists the universal KRT neckdown floor without weakening a
  // stricter imported or DSL hard minimum.
  if (program.operation === "all") for (const { name } of board.nets) {
    if (!selected(name) || /^GND$/i.test(name)) continue
    const values = byNet.get(name) ?? board.rules.default
    byNet.set(name, {
      ...values,
      minTrackWidthMm: Math.max(values.minTrackWidthMm, HARD_MIN_TRACK_WIDTH_MM),
    })
  }
  if (program.operation !== "apply-drc") required.add("ordinary-routing")
  const effective: RoutingRules = {
    default: effectiveDefault,
    nets: board.nets.map(({ name }) => ({ net: name, values: byNet.get(name) ?? board.rules.default })),
    ...(differentialPairs.length ? { differentialPairs } : {}),
    ...(matchedGroups.length ? { matchedGroups } : {}),
    ...(program.netClasses.length ? {
      netClasses: program.netClasses.map((item) => ({
        name: item.name,
        nets: item.nets,
        values: classValues.get(item.name) ?? effectiveDefault,
      })),
    } : {}),
  }
  for (const { scope, values } of [
    { scope: "default", values: effective.default },
    ...effective.nets.map(({ net, values }) => ({ scope: `net ${net}`, values })),
  ]) {
    if (values.preferredTrackWidthMm + EPSILON < values.minTrackWidthMm) diagnostics.push(diagnostic(
      "DSL_RULE_CONFLICT",
      `${scope} nominal track width ${values.preferredTrackWidthMm} mm is below its hard minimum ${values.minTrackWidthMm} mm.`,
    ))
    if (values.via.preferredDiameterMm + EPSILON < values.via.minDiameterMm) diagnostics.push(diagnostic(
      "DSL_VIA_CONFLICT",
      `${scope} nominal via diameter ${values.via.preferredDiameterMm} mm is below its hard minimum ${values.via.minDiameterMm} mm.`,
    ))
    if (values.via.preferredDrillMm + EPSILON < values.via.minDrillMm) diagnostics.push(diagnostic(
      "DSL_VIA_CONFLICT",
      `${scope} nominal via drill ${values.via.preferredDrillMm} mm is below its hard minimum ${values.via.minDrillMm} mm.`,
    ))
    if (values.via.preferredDrillMm + EPSILON >= values.via.preferredDiameterMm) diagnostics.push(diagnostic(
      "DSL_VIA_CONFLICT",
      `${scope} nominal via drill must be smaller than its nominal diameter.`,
    ))
  }
  const overriddenFields = [
    ...changed("default", sourceDefault, effectiveDefault),
    ...effective.nets.flatMap(({ net, values }) => changed(
    { net }, originalByNet.get(net) ?? board.rules.default, values,
    )),
  ]
  if (program.operation === "route") {
    const weakening = overriddenFields.filter((item) => {
      if (typeof item.source !== "number" || typeof item.effective !== "number") return false
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
