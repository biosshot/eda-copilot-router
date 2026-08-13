import type { RoutingDiagnostic } from "../core/contracts.js"
import type {
  DifferentialPairIntent,
  MatchedGroupIntent,
  PowerNetIntent,
  RoutingProgram,
  SignalNetIntent,
} from "./types.js"

export type ProgramValidation = Readonly<{
  valid: boolean
  diagnostics: readonly RoutingDiagnostic[]
}>

function error(code: string, message: string, path?: string): RoutingDiagnostic {
  return { code, severity: "error", message, ...(path ? { path } : {}) }
}

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(
  value: unknown,
  allowed: readonly string[],
  diagnostics: RoutingDiagnostic[],
  path: string,
) {
  if (!object(value)) {
    diagnostics.push(error("DSL_NODE_INVALID", `${path} must be an object.`, path))
    return
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) diagnostics.push(error(
    "DSL_UNKNOWN_FIELD",
    `${path} has unknown field(s): ${unknown.join(", ")}.`,
    path,
  ))
}

function entries(value: unknown) {
  return Array.isArray(value) ? value : []
}

function requiredArray(value: unknown, path: string, diagnostics: RoutingDiagnostic[]) {
  if (!Array.isArray(value)) diagnostics.push(error("DSL_ARRAY_REQUIRED", `${path} must be an array.`, path))
  return entries(value)
}

function layerSelector(value: unknown, path: string, diagnostics: RoutingDiagnostic[]) {
  if (!object(value)) {
    diagnostics.push(error("DSL_LAYER_INVALID", `${path} is invalid.`, path))
    return
  }
  if (["top", "bottom", "outer"].includes(String(value.kind))) {
    exactKeys(value, ["kind"], diagnostics, path)
    return
  }
  if (value.kind === "named" && Array.isArray(value.names) && value.names.length
    && value.names.every((item) => typeof item === "string" && item.trim())) {
    exactKeys(value, ["kind", "names"], diagnostics, path)
    return
  }
  diagnostics.push(error("DSL_LAYER_INVALID", `${path} is invalid.`, path))
}

function viaConstraint(value: unknown, path: string, diagnostics: RoutingDiagnostic[]) {
  if (value === undefined) return
  exactKeys(value, ["diameterMm", "drillMm"], diagnostics, path)
  const via = object(value) ? value : {}
  for (const key of ["diameterMm", "drillMm"] as const) if (via[key] !== undefined && !positive(via[key])) {
    diagnostics.push(error("DSL_VALUE_INVALID", `${path}.${key} must be > 0.`, `${path}.${key}`))
  }
}

function impedanceConstraint(value: unknown, path: string, diagnostics: RoutingDiagnostic[]) {
  if (value === undefined) return
  exactKeys(value, ["targetOhm", "tolerancePercent"], diagnostics, path)
  const impedance = object(value) ? value : {}
  if (!positive(impedance.targetOhm)) diagnostics.push(error(
    "DSL_VALUE_INVALID", `${path}.targetOhm must be > 0.`, `${path}.targetOhm`,
  ))
  if (impedance.tolerancePercent !== undefined && !positive(impedance.tolerancePercent)) diagnostics.push(error(
    "DSL_VALUE_INVALID", `${path}.tolerancePercent must be > 0.`, `${path}.tolerancePercent`,
  ))
}

export function validateRoutingProgram(program: RoutingProgram): ProgramValidation {
  const diagnostics: RoutingDiagnostic[] = []
  if (!program || typeof program !== "object") {
    return { valid: false, diagnostics: [error("DSL_PROGRAM_REQUIRED", "Routing program is required.")] }
  }
  exactKeys(program, [
    "polygons", "planes", "signalNets", "powerNets", "differentialPairs",
    "matchedGroups", "manufacturing", "operation",
  ], diagnostics, "program")
  if (!["apply-drc", "route", "all"].includes(program.operation)) {
    diagnostics.push(error("DSL_TERMINAL_REQUIRED", "Routing program requires one terminal command.", "operation"))
  }
  const polygons = requiredArray(program.polygons, "polygons", diagnostics)
  const planes = requiredArray(program.planes, "planes", diagnostics)
  const signalNets = requiredArray(program.signalNets, "signalNets", diagnostics)
  const powerNets = requiredArray(program.powerNets, "powerNets", diagnostics)
  const differentialPairs = requiredArray(program.differentialPairs, "differentialPairs", diagnostics)
  const matchedGroups = requiredArray(program.matchedGroups, "matchedGroups", diagnostics)
  const ids = new Set<string>()
  for (const [index, value] of polygons.entries()) {
    const at = `polygons[${index}]`
    exactKeys(value, ["kind", "net", "targets", "layers", "mode", "priority", "maxPadFreeGapWidths"], diagnostics, at)
    const polygon = object(value) ? value : {}
    if (polygon.kind !== "polygon" || typeof polygon.net !== "string" || !polygon.net
      || polygon.mode !== "compact" || !Array.isArray(polygon.targets) || !polygon.targets.length) {
      diagnostics.push(error("DSL_POLYGON_INVALID", `${at} is incomplete.`, at))
    }
    layerSelector(polygon.layers, `${at}.layers`, diagnostics)
    for (const [targetIndex, targetValue] of entries(polygon.targets).entries()) {
      const targetPath = `${at}.targets[${targetIndex}]`
      const target = object(targetValue) ? targetValue : {}
      if (target.kind === "pad") {
        exactKeys(target, ["kind", "component", "pad"], diagnostics, targetPath)
        if (typeof target.component !== "string" || !target.component || typeof target.pad !== "string" || !target.pad) {
          diagnostics.push(error("DSL_TARGET_INVALID", `${targetPath} is invalid.`, targetPath))
        }
      } else if (target.kind === "net") {
        exactKeys(target, ["kind", "net"], diagnostics, targetPath)
        if (typeof target.net !== "string" || !target.net) diagnostics.push(error("DSL_TARGET_INVALID", `${targetPath} is invalid.`, targetPath))
      } else diagnostics.push(error("DSL_TARGET_INVALID", `${targetPath} is invalid.`, targetPath))
    }
  }
  for (const [index, value] of planes.entries()) {
    const at = `planes[${index}]`
    exactKeys(value, ["kind", "net", "layers", "region", "paddingMm", "priority", "stitching"], diagnostics, at)
    const plane = object(value) ? value : {}
    if (plane.kind !== "plane" || typeof plane.net !== "string" || !plane.net) diagnostics.push(error("DSL_PLANE_INVALID", `${at} is invalid.`, at))
    layerSelector(plane.layers, `${at}.layers`, diagnostics)
    const region = object(plane.region) ? plane.region : {}
    exactKeys(region, region.kind === "components" ? ["kind", "designators"] : ["kind"], diagnostics, `${at}.region`)
    if (region.kind !== "board" && (region.kind !== "components" || !Array.isArray(region.designators) || !region.designators.length)) {
      diagnostics.push(error("DSL_REGION_INVALID", `${at}.region is invalid.`, `${at}.region`))
    }
    if (plane.stitching !== false) {
      exactKeys(plane.stitching, ["gridMm", "maxPadViaDistanceMm", "via", "viaInPad", "maxVias"], diagnostics, `${at}.stitching`)
    }
  }
  for (const [index, value] of signalNets.entries()) {
    const at = `signalNets[${index}]`
    exactKeys(value, ["kind", "net", "trackWidthMm", "minTrackWidthMm", "clearanceMm", "maxLengthMm", "allowedLayers", "via", "impedance"], diagnostics, at)
    const signal = object(value) ? value : {}
    if (signal.kind !== "signal-net" || typeof signal.net !== "string" || !signal.net) diagnostics.push(error("DSL_SIGNAL_INVALID", `${at} is invalid.`, at))
    if (signal.allowedLayers !== undefined) layerSelector(signal.allowedLayers, `${at}.allowedLayers`, diagnostics)
    viaConstraint(signal.via, `${at}.via`, diagnostics)
    impedanceConstraint(signal.impedance, `${at}.impedance`, diagnostics)
  }
  for (const [index, pair] of (differentialPairs.filter(object) as DifferentialPairIntent[]).entries()) {
    exactKeys(
      pair,
      ["kind", "id", "positive", "negative", "trackWidthMm", "gapMm", "maxSkewMm", "maxUncoupledLengthMm", "clearanceMm", "allowedLayers", "via", "impedance"],
      diagnostics,
      `differentialPairs[${index}]`,
    )
    if (ids.has(pair.id)) diagnostics.push(error("DSL_DUPLICATE_ID", `Duplicate special rule id ${pair.id}.`, `differentialPairs[${index}].id`))
    ids.add(pair.id)
    if (pair.positive === pair.negative) diagnostics.push(error("DSL_DIFF_PAIR_SAME_NET", `${pair.id} uses the same net twice.`))
    if (pair.via?.diameterMm !== undefined && pair.via?.drillMm !== undefined
      && pair.via.drillMm >= pair.via.diameterMm) {
      diagnostics.push(error("DSL_VIA_CONFLICT", `${pair.id} via drill must be smaller than its diameter.`))
    }
    if (typeof pair.id !== "string" || !pair.id || typeof pair.positive !== "string" || !pair.positive
      || typeof pair.negative !== "string" || !pair.negative) diagnostics.push(error(
      "DSL_DIFF_PAIR_INVALID", `differentialPairs[${index}] is incomplete.`, `differentialPairs[${index}]`,
    ))
    if (pair.allowedLayers !== undefined) layerSelector(pair.allowedLayers, `differentialPairs[${index}].allowedLayers`, diagnostics)
    viaConstraint(pair.via, `differentialPairs[${index}].via`, diagnostics)
    impedanceConstraint(pair.impedance, `differentialPairs[${index}].impedance`, diagnostics)
  }
  for (const [index, group] of (matchedGroups.filter(object) as MatchedGroupIntent[]).entries()) {
    exactKeys(group, ["kind", "id", "nets", "toleranceMm"], diagnostics, `matchedGroups[${index}]`)
    if (ids.has(group.id)) diagnostics.push(error("DSL_DUPLICATE_ID", `Duplicate special rule id ${group.id}.`, `matchedGroups[${index}].id`))
    ids.add(group.id)
    if (!Array.isArray(group.nets) || group.nets.length < 2 || !group.nets.every((net) => typeof net === "string" && net)) {
      diagnostics.push(error("DSL_MATCHED_GROUP_INVALID", `${group.id ?? index} needs at least two nets.`))
    } else if (new Set(group.nets).size !== group.nets.length) diagnostics.push(error("DSL_MATCHED_GROUP_DUPLICATE_NET", `${group.id} contains duplicate nets.`))
  }
  for (const [index, power] of (powerNets.filter(object) as PowerNetIntent[]).entries()) {
    exactKeys(
      power,
      ["kind", "net", "maxCurrentA", "maxTempRiseC", "minTrackWidthMm", "maxTrackWidthMm", "clearanceMm", "allowedLayers", "via"],
      diagnostics,
      `powerNets[${index}]`,
    )
    if (!positive(power.maxCurrentA) && !positive(power.minTrackWidthMm)) {
      diagnostics.push(error("DSL_POWER_REQUIREMENT_MISSING", `${power.net} needs maxCurrentA or minTrackWidthMm.`, `powerNets[${index}]`))
    }
    if (power.maxTrackWidthMm !== undefined && power.maxTrackWidthMm > 10) {
      diagnostics.push(error("DSL_MAX_WIDTH_LIMIT", "maxTrackWidthMm may not exceed 10 mm.", `powerNets[${index}].maxTrackWidthMm`))
    }
    if (power.minTrackWidthMm !== undefined && power.maxTrackWidthMm !== undefined
      && power.minTrackWidthMm > power.maxTrackWidthMm) {
      diagnostics.push(error("DSL_RULE_CONFLICT", `${power.net} minimum width exceeds its maximum width.`))
    }
    if (power.allowedLayers !== undefined) layerSelector(power.allowedLayers, `powerNets[${index}].allowedLayers`, diagnostics)
    viaConstraint(power.via, `powerNets[${index}].via`, diagnostics)
  }
  for (const net of [
    ...(powerNets.filter(object) as PowerNetIntent[]),
    ...(signalNets.filter(object) as SignalNetIntent[]),
    ...(differentialPairs.filter(object) as DifferentialPairIntent[]),
  ]) {
    if (net.via?.diameterMm !== undefined && net.via?.drillMm !== undefined
      && net.via.drillMm >= net.via.diameterMm) diagnostics.push(error(
      "DSL_VIA_CONFLICT", "Via drill must be smaller than its diameter.",
    ))
  }
  if (program.manufacturing !== undefined) {
    exactKeys(program.manufacturing, ["fallbackCopperThicknessOz", "viaPlatingThicknessUm", "maxTrackWidthMm"], diagnostics, "manufacturing")
  }
  return { valid: !diagnostics.some((item) => item.severity === "error"), diagnostics }
}
