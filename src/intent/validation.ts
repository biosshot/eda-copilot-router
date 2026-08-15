import type { RoutingDiagnostic } from "../core/contracts.js"
import type { RoutingProgram } from "./types.js"

export type ProgramValidation = Readonly<{
  valid: boolean
  diagnostics: readonly RoutingDiagnostic[]
}>

function error(code: string, message: string, path?: string): RoutingDiagnostic {
  return { code, severity: "error", message, ...(path ? { path } : {}) }
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function nonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function exactKeys(value: unknown, allowed: readonly string[], diagnostics: RoutingDiagnostic[], path: string) {
  if (!object(value)) {
    diagnostics.push(error("DSL_NODE_INVALID", `${path} must be an object.`, path))
    return
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) diagnostics.push(error("DSL_UNKNOWN_FIELD", `${path} has unknown field(s): ${unknown.join(", ")}.`, path))
}

function array(value: unknown, path: string, diagnostics: RoutingDiagnostic[]) {
  if (!Array.isArray(value)) diagnostics.push(error("DSL_ARRAY_REQUIRED", `${path} must be an array.`, path))
  return Array.isArray(value) ? value : []
}

function layerSelector(value: unknown, path: string, diagnostics: RoutingDiagnostic[]) {
  if (!object(value)) return diagnostics.push(error("DSL_LAYER_INVALID", `${path} is invalid.`, path))
  if (["top", "bottom", "outer", "all"].includes(String(value.kind))) {
    exactKeys(value, ["kind"], diagnostics, path)
    return
  }
  if (value.kind === "named" && Array.isArray(value.names) && value.names.length
    && value.names.every((item) => typeof item === "string" && /^(TOP|BOTTOM|INNER_(?:[1-9]|[12][0-9]|30))$/.test(item))) {
    exactKeys(value, ["kind", "names"], diagnostics, path)
    return
  }
  diagnostics.push(error("DSL_LAYER_INVALID", `${path} is invalid.`, path))
}

function via(value: unknown, path: string, diagnostics: RoutingDiagnostic[], allowMaxCount = true) {
  if (value === undefined) return
  exactKeys(value, ["diameterMm", "drillMm", "from", "to", ...(allowMaxCount ? ["maxCount"] : [])], diagnostics, path)
  const item = object(value) ? value : {}
  for (const key of ["diameterMm", "drillMm"] as const) if (item[key] !== undefined && !positive(item[key])) {
    diagnostics.push(error("DSL_VALUE_INVALID", `${path}.${key} must be > 0.`, `${path}.${key}`))
  }
  if (positive(item.diameterMm) && positive(item.drillMm) && Number(item.drillMm) >= Number(item.diameterMm)) {
    diagnostics.push(error("DSL_VIA_CONFLICT", `${path} drill must be smaller than diameter.`, path))
  }
  for (const key of ["from", "to"] as const) if (item[key] !== undefined
    && (typeof item[key] !== "string" || !/^(TOP|BOTTOM|INNER_(?:[1-9]|[12][0-9]|30))$/.test(String(item[key])))) {
    diagnostics.push(error("DSL_LAYER_INVALID", `${path}.${key} is not a canonical physical layer.`, `${path}.${key}`))
  }
  if (item.maxCount !== undefined && (!Number.isInteger(item.maxCount) || Number(item.maxCount) < 0)) {
    diagnostics.push(error("DSL_VALUE_INVALID", `${path}.maxCount must be an integer >= 0.`, `${path}.maxCount`))
  }
}

function impedance(value: unknown, path: string, diagnostics: RoutingDiagnostic[]) {
  if (value === undefined) return
  exactKeys(value, ["targetOhm", "tolerancePercent", "topology", "reference", "coplanarGapMm"], diagnostics, path)
  const item = object(value) ? value : {}
  if (!positive(item.targetOhm)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.targetOhm must be > 0.`, `${path}.targetOhm`))
  if (item.tolerancePercent !== undefined && !positive(item.tolerancePercent)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.tolerancePercent must be > 0.`, `${path}.tolerancePercent`))
  if (item.topology !== undefined && !["microstrip", "stripline", "coplanar"].includes(String(item.topology))) {
    diagnostics.push(error("DSL_IMPEDANCE_TOPOLOGY_INVALID", `${path}.topology is invalid.`, `${path}.topology`))
  }
  if (item.coplanarGapMm !== undefined && !positive(item.coplanarGapMm)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.coplanarGapMm must be > 0.`, `${path}.coplanarGapMm`))
  if (item.reference !== undefined) {
    exactKeys(item.reference, ["net"], diagnostics, `${path}.reference`)
    const reference = object(item.reference) ? item.reference : {}
    if (typeof reference.net !== "string" || !reference.net) diagnostics.push(error("DSL_REFERENCE_NET_INVALID", `${path}.reference.net is required.`, `${path}.reference.net`))
  }
}

function rule(value: Record<string, unknown>, path: string, diagnostics: RoutingDiagnostic[]) {
  for (const key of ["trackWidthMm", "minTrackWidthMm", "preferredTrackWidthMm", "clearanceMm", "edgeClearanceMm", "holeToHoleClearanceMm"] as const) {
    if (value[key] !== undefined && !positive(value[key])) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.${key} must be > 0.`, `${path}.${key}`))
  }
  if (value.allowedLayers !== undefined) layerSelector(value.allowedLayers, `${path}.allowedLayers`, diagnostics)
  via(value.via, `${path}.via`, diagnostics)
}

const RULE_KEYS = ["trackWidthMm", "minTrackWidthMm", "preferredTrackWidthMm", "clearanceMm", "edgeClearanceMm", "holeToHoleClearanceMm", "allowedLayers", "via"]

export function validateRoutingProgram(program: RoutingProgram): ProgramValidation {
  const diagnostics: RoutingDiagnostic[] = []
  if (!program || typeof program !== "object") return { valid: false, diagnostics: [error("DSL_PROGRAM_REQUIRED", "Routing program is required.")] }
  exactKeys(program, [
    "polygons", "planes", "signalNets", "powerNets", "differentialPairs", "matchedGroups", "viaFences",
    "netClasses", "drc", "stack", "quality", "onlyNets", "ignoreNets", "clearRouting", "operation",
  ], diagnostics, "program")
  if (!["apply-drc", "route", "all"].includes(program.operation)) diagnostics.push(error("DSL_TERMINAL_REQUIRED", "Routing program requires one terminal command.", "operation"))
  const polygons = array(program.polygons, "polygons", diagnostics)
  const planes = array(program.planes, "planes", diagnostics)
  const signalNets = array(program.signalNets, "signalNets", diagnostics)
  const powerNets = array(program.powerNets, "powerNets", diagnostics)
  const pairs = array(program.differentialPairs, "differentialPairs", diagnostics)
  const groups = array(program.matchedGroups, "matchedGroups", diagnostics)
  const fences = array(program.viaFences, "viaFences", diagnostics)
  const classes = array(program.netClasses, "netClasses", diagnostics)
  array(program.ignoreNets, "ignoreNets", diagnostics)
  const ids = new Set<string>()

  polygons.forEach((raw, index) => {
    const path = `polygons[${index}]`; exactKeys(raw, ["kind", "net", "targets", "layers", "mode", "priority", "maxPadFreeGapWidths"], diagnostics, path)
    const item = object(raw) ? raw : {}
    if (item.kind !== "polygon" || typeof item.net !== "string" || !item.net || item.mode !== "compact") diagnostics.push(error("DSL_POLYGON_INVALID", `${path} is incomplete.`, path))
    layerSelector(item.layers, `${path}.layers`, diagnostics)
    if (!nonNegative(item.priority) || !Number.isInteger(item.priority)) diagnostics.push(error("DSL_INTERNAL_PRIORITY_INVALID", `${path}.priority is invalid.`, `${path}.priority`))
    if (!positive(item.maxPadFreeGapWidths)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.maxPadFreeGapWidths must be > 0.`, `${path}.maxPadFreeGapWidths`))
    const targets = array(item.targets, `${path}.targets`, diagnostics)
    if (!targets.length) diagnostics.push(error("DSL_POLYGON_INVALID", `${path} needs targets.`, path))
    targets.forEach((targetRaw, targetIndex) => {
      const targetPath = `${path}.targets[${targetIndex}]`; const target = object(targetRaw) ? targetRaw : {}
      if (target.kind === "pad") {
        exactKeys(target, ["kind", "component", "pad"], diagnostics, targetPath)
        if (typeof target.component !== "string" || !target.component || typeof target.pad !== "string" || !target.pad) diagnostics.push(error("DSL_TARGET_INVALID", `${targetPath} is invalid.`, targetPath))
      } else if (target.kind === "net") {
        exactKeys(target, ["kind", "net"], diagnostics, targetPath)
        if (typeof target.net !== "string" || !target.net) diagnostics.push(error("DSL_TARGET_INVALID", `${targetPath} is invalid.`, targetPath))
      } else diagnostics.push(error("DSL_TARGET_INVALID", `${targetPath} is invalid.`, targetPath))
    })
  })

  planes.forEach((raw, index) => {
    const path = `planes[${index}]`; exactKeys(raw, ["kind", "net", "layers", "region", "paddingMm", "priority", "stitching"], diagnostics, path)
    const item = object(raw) ? raw : {}
    if (item.kind !== "plane" || typeof item.net !== "string" || !item.net) diagnostics.push(error("DSL_PLANE_INVALID", `${path} is invalid.`, path))
    layerSelector(item.layers, `${path}.layers`, diagnostics)
    const region = object(item.region) ? item.region : {}; exactKeys(region, region.kind === "components" ? ["kind", "designators"] : ["kind"], diagnostics, `${path}.region`)
    if (region.kind !== "board" && (region.kind !== "components" || !Array.isArray(region.designators) || !region.designators.length)) diagnostics.push(error("DSL_REGION_INVALID", `${path}.region is invalid.`, `${path}.region`))
    if (item.stitching !== false) {
      exactKeys(item.stitching, ["gridMm", "maxPadViaDistanceMm", "via", "viaInPad", "maxVias"], diagnostics, `${path}.stitching`)
      const stitching = object(item.stitching) ? item.stitching : {}
      if (stitching.via !== "drc-min") via(stitching.via, `${path}.stitching.via`, diagnostics, false)
    }
  })

  signalNets.forEach((raw, index) => {
    const path = `signalNets[${index}]`; exactKeys(raw, ["kind", "net", "netClass", "maxLengthMm", "impedance", ...RULE_KEYS], diagnostics, path)
    const item = object(raw) ? raw : {}; if (item.kind !== "signal-net" || typeof item.net !== "string" || !item.net) diagnostics.push(error("DSL_SIGNAL_INVALID", `${path} is invalid.`, path))
    rule(item, path, diagnostics); impedance(item.impedance, `${path}.impedance`, diagnostics)
  })

  powerNets.forEach((raw, index) => {
    const path = `powerNets[${index}]`; exactKeys(raw, ["kind", "net", "netClass", "maxCurrentA", "maxTempRiseC", "maxTrackWidthMm", "powerPads", "tapWidthMm", ...RULE_KEYS], diagnostics, path)
    const item = object(raw) ? raw : {}; if (item.kind !== "power-net" || typeof item.net !== "string" || !item.net) diagnostics.push(error("DSL_POWER_INVALID", `${path} is invalid.`, path))
    rule(item, path, diagnostics)
    for (const key of ["maxCurrentA", "maxTempRiseC", "maxTrackWidthMm"] as const) if (item[key] !== undefined && !positive(item[key])) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.${key} must be > 0.`, `${path}.${key}`))
    if (Number(item.maxTrackWidthMm ?? 0) > 10) diagnostics.push(error("DSL_MAX_WIDTH_LIMIT", "maxTrackWidthMm may not exceed 10 mm.", `${path}.maxTrackWidthMm`))
    if (item.minTrackWidthMm !== undefined && item.maxTrackWidthMm !== undefined && Number(item.minTrackWidthMm) > Number(item.maxTrackWidthMm)) diagnostics.push(error("DSL_RULE_CONFLICT", `${item.net} minimum width exceeds maximum width.`, path))
    if (item.tapWidthMm !== undefined && item.tapWidthMm !== "drc-min" && !positive(item.tapWidthMm)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.tapWidthMm is invalid.`, `${path}.tapWidthMm`))
  })

  pairs.forEach((raw, index) => {
    const path = `differentialPairs[${index}]`; exactKeys(raw, ["kind", "id", "positive", "negative", "gapMm", "maxSkewMm", "maxUncoupledLengthMm", "impedance", ...RULE_KEYS], diagnostics, path)
    const item = object(raw) ? raw : {}; const id = typeof item.id === "string" ? item.id : ""
    if (!id || typeof item.positive !== "string" || !item.positive || typeof item.negative !== "string" || !item.negative) diagnostics.push(error("DSL_DIFF_PAIR_INVALID", `${path} is incomplete.`, path))
    if (id && ids.has(id)) diagnostics.push(error("DSL_DUPLICATE_ID", `Duplicate special id ${id}.`, `${path}.id`)); if (id) ids.add(id)
    if (item.positive === item.negative) diagnostics.push(error("DSL_DIFF_PAIR_SAME_NET", `${id} uses the same net twice.`, path))
    rule(item, path, diagnostics); impedance(item.impedance, `${path}.impedance`, diagnostics)
  })

  groups.forEach((raw, index) => {
    const path = `matchedGroups[${index}]`; exactKeys(raw, ["kind", "id", "nets", "toleranceMm"], diagnostics, path)
    const item = object(raw) ? raw : {}; const id = typeof item.id === "string" ? item.id : ""
    if (!id || !Array.isArray(item.nets) || item.nets.length < 2 || !item.nets.every((net) => typeof net === "string" && net)) diagnostics.push(error("DSL_MATCHED_GROUP_INVALID", `${path} needs an id and at least two nets.`, path))
    if (id && ids.has(id)) diagnostics.push(error("DSL_DUPLICATE_ID", `Duplicate special id ${id}.`, `${path}.id`)); if (id) ids.add(id)
  })

  fences.forEach((raw, index) => {
    const path = `viaFences[${index}]`; exactKeys(raw, ["kind", "id", "along", "net", "pitchMm", "offsetMm", "rows", "rowSpacingMm", "stagger", "via"], diagnostics, path)
    const item = object(raw) ? raw : {}; const id = typeof item.id === "string" ? item.id : ""
    if (!id || item.kind !== "via-fence" || !Array.isArray(item.along) || !item.along.length || !item.along.every((net) => typeof net === "string" && net) || typeof item.net !== "string" || !item.net) diagnostics.push(error("DSL_VIA_FENCE_INVALID", `${path} is incomplete.`, path))
    if (id && ids.has(id)) diagnostics.push(error("DSL_DUPLICATE_ID", `Duplicate special id ${id}.`, `${path}.id`)); if (id) ids.add(id)
    if (item.pitchMm !== undefined && !positive(item.pitchMm)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.pitchMm must be > 0.`, `${path}.pitchMm`))
    if (item.offsetMm !== undefined && !positive(item.offsetMm)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.offsetMm must be > 0.`, `${path}.offsetMm`))
    if (item.rows !== undefined && (!Number.isInteger(item.rows) || Number(item.rows) < 1 || Number(item.rows) > 8)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.rows must be an integer from 1 to 8.`, `${path}.rows`))
    if (item.rowSpacingMm !== undefined && !positive(item.rowSpacingMm)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.rowSpacingMm must be > 0.`, `${path}.rowSpacingMm`))
    if (item.stagger !== undefined && typeof item.stagger !== "boolean") diagnostics.push(error("DSL_VALUE_INVALID", `${path}.stagger must be boolean.`, `${path}.stagger`))
    via(item.via, `${path}.via`, diagnostics, false)
  })

  classes.forEach((raw, index) => {
    const path = `netClasses[${index}]`; exactKeys(raw, ["kind", "name", "nets", ...RULE_KEYS], diagnostics, path)
    const item = object(raw) ? raw : {}; if (item.kind !== "net-class" || typeof item.name !== "string" || !item.name || !Array.isArray(item.nets) || !item.nets.length) diagnostics.push(error("DSL_NET_CLASS_INVALID", `${path} is invalid.`, path))
    rule(item, path, diagnostics)
  })

  if (program.drc !== undefined) { exactKeys(program.drc, RULE_KEYS, diagnostics, "drc"); if (object(program.drc)) rule(program.drc, "drc", diagnostics) }
  if (program.quality !== undefined) {
    exactKeys(program.quality, ["profile", "maxCandidates", "meander"], diagnostics, "quality")
    if (program.quality.maxCandidates !== undefined && (!Number.isInteger(program.quality.maxCandidates) || program.quality.maxCandidates < 1 || program.quality.maxCandidates > 16)) diagnostics.push(error("DSL_CANDIDATE_LIMIT", "quality.maxCandidates must be 1..16.", "quality.maxCandidates"))
    if (program.quality.profile !== undefined && !["fast", "balanced", "quality-first", "completion-first"].includes(program.quality.profile)) diagnostics.push(error("DSL_QUALITY_PROFILE_INVALID", "quality.profile is invalid.", "quality.profile"))
  }
  if (program.onlyNets !== undefined && (!Array.isArray(program.onlyNets) || !program.onlyNets.length)) diagnostics.push(error("DSL_SCOPE_INVALID", "onlyNets must be non-empty.", "onlyNets"))
  if (program.clearRouting !== undefined) {
    exactKeys(program.clearRouting, ["nets", "items"], diagnostics, "clearRouting")
    if (program.clearRouting.nets !== "all" && (!Array.isArray(program.clearRouting.nets) || !program.clearRouting.nets.length)) diagnostics.push(error("DSL_CLEAR_SCOPE_INVALID", "clearRouting.nets is invalid.", "clearRouting.nets"))
  }
  if (program.stack !== undefined) {
    exactKeys(program.stack, ["boardThicknessMm", "fallbackCopperThicknessOz", "viaPlatingThicknessUm", "maxTrackWidthMm", "layers", "solderMask"], diagnostics, "stack")
    if (program.stack.maxTrackWidthMm !== undefined && program.stack.maxTrackWidthMm > 10) diagnostics.push(error("DSL_MAX_WIDTH_LIMIT", "stack.maxTrackWidthMm may not exceed 10 mm.", "stack.maxTrackWidthMm"))
    if (program.stack.layers !== undefined) array(program.stack.layers, "stack.layers", diagnostics).forEach((raw, index) => {
      const path = `stack.layers[${index}]`; const item = object(raw) ? raw : {}
      if (item.kind === "copper") {
        exactKeys(item, ["kind", "name", "thicknessOz", "thicknessMm"], diagnostics, path)
        if (item.thicknessOz !== undefined && item.thicknessMm !== undefined) diagnostics.push(error("DSL_STACK_CONFLICT", `${path} cannot specify thicknessOz and thicknessMm together.`, path))
      } else if (item.kind === "dielectric") {
        exactKeys(item, ["kind", "name", "thicknessMm", "relativePermittivity", "lossTangent", "material"], diagnostics, path)
      } else diagnostics.push(error("DSL_STACK_LAYER_INVALID", `${path}.kind must be copper or dielectric.`, path))
    })
  }
  return { valid: !diagnostics.some((item) => item.severity === "error"), diagnostics }
}
