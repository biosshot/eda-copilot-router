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

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function positive(value: unknown) {
  return finite(value) && value > 0
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

function via(value: unknown, path: string, diagnostics: RoutingDiagnostic[]) {
  if (value === undefined) return
  exactKeys(value, ["diameterMm", "drillMm", "minDiameterMm", "minDrillMm"], diagnostics, path)
  const item = object(value) ? value : {}
  for (const key of ["diameterMm", "drillMm", "minDiameterMm", "minDrillMm"] as const) if (item[key] !== undefined && !positive(item[key])) {
    diagnostics.push(error("DSL_VALUE_INVALID", `${path}.${key} must be > 0.`, `${path}.${key}`))
  }
  if (positive(item.diameterMm) && positive(item.drillMm) && Number(item.drillMm) >= Number(item.diameterMm)) {
    diagnostics.push(error("DSL_VIA_CONFLICT", `${path} drill must be smaller than diameter.`, path))
  }
  if (positive(item.minDiameterMm) && positive(item.minDrillMm) && Number(item.minDrillMm) >= Number(item.minDiameterMm)) {
    diagnostics.push(error("DSL_VIA_CONFLICT", `${path} minimum drill must be smaller than minimum diameter.`, path))
  }
  if (positive(item.minDiameterMm) && positive(item.diameterMm) && Number(item.minDiameterMm) > Number(item.diameterMm)) {
    diagnostics.push(error("DSL_VIA_CONFLICT", `${path} minimum diameter exceeds nominal diameter.`, path))
  }
  if (positive(item.minDrillMm) && positive(item.drillMm) && Number(item.minDrillMm) > Number(item.drillMm)) {
    diagnostics.push(error("DSL_VIA_CONFLICT", `${path} minimum drill exceeds nominal drill.`, path))
  }
}

function impedance(value: unknown, path: string, diagnostics: RoutingDiagnostic[]) {
  if (value === undefined) return
  exactKeys(value, ["targetOhm", "tolerancePercent", "referenceNet"], diagnostics, path)
  const item = object(value) ? value : {}
  if (!positive(item.targetOhm)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.targetOhm must be > 0.`, `${path}.targetOhm`))
  if (item.tolerancePercent !== undefined && !positive(item.tolerancePercent)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.tolerancePercent must be > 0.`, `${path}.tolerancePercent`))
  if (item.referenceNet !== undefined && (typeof item.referenceNet !== "string" || !item.referenceNet)) diagnostics.push(error("DSL_REFERENCE_NET_INVALID", `${path}.referenceNet must be a net name or auto.`, `${path}.referenceNet`))
}

function zone(value: unknown, path: string, diagnostics: RoutingDiagnostic[]) {
  if (value === undefined) return
  exactKeys(value, ["clearanceMm", "minThicknessMm", "fill", "padConnection", "removeIslandsBelowMm2"], diagnostics, path)
  const item = object(value) ? value : {}
  for (const key of ["clearanceMm", "minThicknessMm"] as const) if (item[key] !== undefined && !positive(item[key])) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.${key} must be > 0.`, `${path}.${key}`))
  if (item.removeIslandsBelowMm2 !== undefined && !nonNegative(item.removeIslandsBelowMm2)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.removeIslandsBelowMm2 must be >= 0.`, `${path}.removeIslandsBelowMm2`))
  if (item.fill !== undefined) {
    exactKeys(item.fill, ["style", "hatchThicknessMm", "hatchGapMm", "hatchOrientationDeg"], diagnostics, `${path}.fill`)
    const fill = object(item.fill) ? item.fill : {}
    if (fill.style !== undefined && !['solid', 'hatched'].includes(String(fill.style))) diagnostics.push(error("DSL_ZONE_FILL_INVALID", `${path}.fill.style is invalid.`, `${path}.fill.style`))
    for (const key of ["hatchThicknessMm", "hatchGapMm"] as const) if (fill[key] !== undefined && !positive(fill[key])) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.fill.${key} must be > 0.`, `${path}.fill.${key}`))
    if (fill.hatchOrientationDeg !== undefined && !finite(fill.hatchOrientationDeg)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.fill.hatchOrientationDeg must be finite.`, `${path}.fill.hatchOrientationDeg`))
    if (fill.style !== "hatched" && [fill.hatchThicknessMm, fill.hatchGapMm, fill.hatchOrientationDeg].some((field) => field !== undefined)) diagnostics.push(error("DSL_ZONE_FILL_CONFLICT", `${path} hatch fields require hatched fill.`, `${path}.fill`))
  }
  if (item.padConnection !== undefined) {
    exactKeys(item.padConnection, ["mode", "thermalGapMm", "spokeWidthMm", "spokeCount", "spokeAngleDeg"], diagnostics, `${path}.padConnection`)
    const pad = object(item.padConnection) ? item.padConnection : {}
    if (pad.mode !== undefined && !['solid', 'thermal', 'none'].includes(String(pad.mode))) diagnostics.push(error("DSL_ZONE_CONNECTION_INVALID", `${path}.padConnection.mode is invalid.`, `${path}.padConnection.mode`))
    for (const key of ["thermalGapMm", "spokeWidthMm"] as const) if (pad[key] !== undefined && !positive(pad[key])) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.padConnection.${key} must be > 0.`, `${path}.padConnection.${key}`))
    if (pad.spokeCount !== undefined && (!Number.isInteger(pad.spokeCount) || Number(pad.spokeCount) < 2 || Number(pad.spokeCount) > 8)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.padConnection.spokeCount must be 2..8.`, `${path}.padConnection.spokeCount`))
    if (pad.spokeAngleDeg !== undefined && !finite(pad.spokeAngleDeg)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.padConnection.spokeAngleDeg must be finite.`, `${path}.padConnection.spokeAngleDeg`))
    if (pad.mode !== "thermal" && [pad.thermalGapMm, pad.spokeWidthMm, pad.spokeCount, pad.spokeAngleDeg].some((field) => field !== undefined)) diagnostics.push(error("DSL_ZONE_CONNECTION_CONFLICT", `${path} thermal fields require thermal mode.`, `${path}.padConnection`))
  }
}

function rule(value: Record<string, unknown>, path: string, diagnostics: RoutingDiagnostic[]) {
  for (const key of ["trackWidthMm", "minTrackWidthMm", "clearanceMm", "edgeClearanceMm", "holeToHoleClearanceMm"] as const) {
    if (value[key] !== undefined && !positive(value[key])) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.${key} must be > 0.`, `${path}.${key}`))
  }
  if (positive(value.minTrackWidthMm) && positive(value.trackWidthMm)
    && Number(value.minTrackWidthMm) > Number(value.trackWidthMm)) {
    diagnostics.push(error("DSL_RULE_CONFLICT", `${path} minimum track width exceeds nominal track width.`, path))
  }
  if (value.allowedLayers !== undefined) layerSelector(value.allowedLayers, `${path}.allowedLayers`, diagnostics)
  via(value.via, `${path}.via`, diagnostics)
}

const RULE_KEYS = ["trackWidthMm", "minTrackWidthMm", "clearanceMm", "edgeClearanceMm", "holeToHoleClearanceMm", "allowedLayers", "via"]
const NET_PRIORITIES = ["critical", "high", "normal", "low"]
const VIA_PREFERENCES = ["auto", "avoid", "forbid"]

function netRoutingPreference(value: Record<string, unknown>, path: string, diagnostics: RoutingDiagnostic[]) {
  if (value.priority !== undefined && !NET_PRIORITIES.includes(String(value.priority))) {
    diagnostics.push(error("DSL_NET_PRIORITY_INVALID", `${path}.priority must be critical, high, normal, or low.`, `${path}.priority`))
  }
  if (value.viaPreference !== undefined && !VIA_PREFERENCES.includes(String(value.viaPreference))) {
    diagnostics.push(error("DSL_VIA_PREFERENCE_INVALID", `${path}.viaPreference must be auto, avoid, or forbid.`, `${path}.viaPreference`))
  }
}

export function validateRoutingProgram(program: RoutingProgram): ProgramValidation {
  const diagnostics: RoutingDiagnostic[] = []
  if (!program || typeof program !== "object") return { valid: false, diagnostics: [error("DSL_PROGRAM_REQUIRED", "Routing program is required.")] }
  exactKeys(program, [
    "polygons", "planes", "signalNets", "powerNets", "differentialPairs", "matchedGroups", "viaStitches",
    "fanouts", "fanoutExclusions", "netClasses", "relationEdits", "drc", "stack", "busDetect", "onlyNets", "ignoreNets", "clearRouting", "operation",
  ], diagnostics, "program")
  if (!["apply-drc", "apply-stackup", "copper", "route", "all"].includes(program.operation)) diagnostics.push(error("DSL_TERMINAL_REQUIRED", "Routing program requires one terminal command.", "operation"))
  const polygons = array(program.polygons, "polygons", diagnostics)
  const planes = array(program.planes, "planes", diagnostics)
  const signalNets = array(program.signalNets, "signalNets", diagnostics)
  const powerNets = array(program.powerNets, "powerNets", diagnostics)
  const pairs = array(program.differentialPairs, "differentialPairs", diagnostics)
  const groups = array(program.matchedGroups, "matchedGroups", diagnostics)
  const stitches = array(program.viaStitches, "viaStitches", diagnostics)
  const fanouts = array(program.fanouts, "fanouts", diagnostics)
  const fanoutExclusions = array(program.fanoutExclusions, "fanoutExclusions", diagnostics)
  const classes = array(program.netClasses, "netClasses", diagnostics)
  const relationEdits = program.relationEdits === undefined ? [] : array(program.relationEdits, "relationEdits", diagnostics)
  array(program.ignoreNets, "ignoreNets", diagnostics)
  const ids = new Set<string>()

  polygons.forEach((raw, index) => {
    const path = `polygons[${index}]`; exactKeys(raw, ["kind", "net", "targets", "layers", "mode", "priority", "maxPadFreeGapWidths", "zone"], diagnostics, path)
    const item = object(raw) ? raw : {}
    if (item.kind !== "polygon" || typeof item.net !== "string" || !item.net || item.mode !== "compact") diagnostics.push(error("DSL_POLYGON_INVALID", `${path} is incomplete.`, path))
    layerSelector(item.layers, `${path}.layers`, diagnostics)
    if (!nonNegative(item.priority) || !Number.isInteger(item.priority)) diagnostics.push(error("DSL_INTERNAL_PRIORITY_INVALID", `${path}.priority is invalid.`, `${path}.priority`))
    if (!positive(item.maxPadFreeGapWidths)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.maxPadFreeGapWidths must be > 0.`, `${path}.maxPadFreeGapWidths`))
    zone(item.zone, `${path}.zone`, diagnostics)
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
    const path = `planes[${index}]`; exactKeys(raw, ["kind", "net", "layers", "region", "priority", "stitching", "zone"], diagnostics, path)
    const item = object(raw) ? raw : {}
    if (item.kind !== "plane" || typeof item.net !== "string" || !item.net) diagnostics.push(error("DSL_PLANE_INVALID", `${path} is invalid.`, path))
    layerSelector(item.layers, `${path}.layers`, diagnostics)
    const region = object(item.region) ? item.region : {}; exactKeys(region, region.kind === "components" ? ["kind", "designators"] : ["kind"], diagnostics, `${path}.region`)
    if (region.kind !== "board" && (region.kind !== "components" || !Array.isArray(region.designators) || !region.designators.length)) diagnostics.push(error("DSL_REGION_INVALID", `${path}.region is invalid.`, `${path}.region`))
    if (item.stitching !== false) {
      exactKeys(item.stitching, ["gridMm", "maxPadViaDistanceMm", "via", "viaInPad"], diagnostics, `${path}.stitching`)
      const stitching = object(item.stitching) ? item.stitching : {}
      if (stitching.via !== "drc-min") via(stitching.via, `${path}.stitching.via`, diagnostics)
    }
    zone(item.zone, `${path}.zone`, diagnostics)
  })

  signalNets.forEach((raw, index) => {
    const path = `signalNets[${index}]`; exactKeys(raw, ["kind", "net", "netClass", "impedance", "priority", "viaPreference", ...RULE_KEYS], diagnostics, path)
    const item = object(raw) ? raw : {}; if (item.kind !== "signal-net" || typeof item.net !== "string" || !item.net) diagnostics.push(error("DSL_SIGNAL_INVALID", `${path} is invalid.`, path))
    rule(item, path, diagnostics); impedance(item.impedance, `${path}.impedance`, diagnostics); netRoutingPreference(item, path, diagnostics)
  })

  powerNets.forEach((raw, index) => {
    const path = `powerNets[${index}]`; exactKeys(raw, ["kind", "net", "netClass", "maxCurrentA", "maxTempRiseC", "maxTrackWidthMm", "powerPads", "tapWidthMm", "priority", "viaPreference", ...RULE_KEYS], diagnostics, path)
    const item = object(raw) ? raw : {}; if (item.kind !== "power-net" || typeof item.net !== "string" || !item.net) diagnostics.push(error("DSL_POWER_INVALID", `${path} is invalid.`, path))
    rule(item, path, diagnostics); netRoutingPreference(item, path, diagnostics)
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

  stitches.forEach((raw, index) => {
    const path = `viaStitches[${index}]`
    const item = object(raw) ? raw : {}; const id = typeof item.id === "string" ? item.id : ""
    const common = ["kind", "id", "mode", "via"]
    const specific = item.mode === "grid" ? ["net", "region", "pitchMm", "viaInPad"]
      : item.mode === "along" ? ["net", "routes", "pitchMm", "offsetMm", "rows", "rowSpacingMm", "stagger"]
      : item.mode === "around" ? ["net", "target", "pitchMm", "offsetMm", "rows", "side"]
      : item.mode === "return" ? ["referenceNet", "forNets", "maxDistanceMm"] : []
    exactKeys(raw, [...common, ...specific], diagnostics, path)
    if (!id || item.kind !== "via-stitch" || !["grid", "along", "around", "return"].includes(String(item.mode))) diagnostics.push(error("DSL_VIA_STITCH_INVALID", `${path} is incomplete.`, path))
    if (id && ids.has(id)) diagnostics.push(error("DSL_DUPLICATE_ID", `Duplicate special id ${id}.`, `${path}.id`)); if (id) ids.add(id)
    if (item.mode !== "return" && (typeof item.net !== "string" || !item.net)) diagnostics.push(error("DSL_VIA_STITCH_INVALID", `${path}.net is required.`, `${path}.net`))
    if (item.mode === "along" && (!Array.isArray(item.routes) || !item.routes.length || !item.routes.every((net) => typeof net === "string" && net))) diagnostics.push(error("DSL_VIA_STITCH_INVALID", `${path}.routes is invalid.`, `${path}.routes`))
    if (item.mode === "return" && (typeof item.referenceNet !== "string" || !item.referenceNet)) diagnostics.push(error("DSL_VIA_STITCH_INVALID", `${path}.referenceNet is required.`, `${path}.referenceNet`))
    if (item.mode === "grid") {
      const region = object(item.region) ? item.region : {}
      exactKeys(region, region.kind === "components" ? ["kind", "designators"] : ["kind"], diagnostics, `${path}.region`)
      if (region.kind !== "board" && (region.kind !== "components" || !Array.isArray(region.designators)
        || !region.designators.length || !region.designators.every((name) => typeof name === "string" && name))) diagnostics.push(error("DSL_REGION_INVALID", `${path}.region is invalid.`, `${path}.region`))
      if (item.pitchMm === undefined) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.pitchMm must be > 0.`, `${path}.pitchMm`))
      if (item.viaInPad !== undefined && typeof item.viaInPad !== "boolean") diagnostics.push(error("DSL_VALUE_INVALID", `${path}.viaInPad must be boolean.`, `${path}.viaInPad`))
    }
    if (item.mode === "around") {
      const target = object(item.target) ? item.target : {}
      if (!["board", "components", "component", "pad"].includes(String(target.kind))) diagnostics.push(error("DSL_VIA_STITCH_INVALID", `${path}.target is invalid.`, `${path}.target`))
      if (item.side !== undefined && item.side !== "inside" && item.side !== "outside") diagnostics.push(error("DSL_VALUE_INVALID", `${path}.side must be inside or outside.`, `${path}.side`))
    }
    if (item.mode === "return") {
      if (item.forNets !== undefined && (!Array.isArray(item.forNets) || !item.forNets.length
        || !item.forNets.every((net) => typeof net === "string" && net))) diagnostics.push(error("DSL_VIA_STITCH_INVALID", `${path}.forNets is invalid.`, `${path}.forNets`))
      if (item.maxDistanceMm !== undefined && !positive(item.maxDistanceMm)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.maxDistanceMm must be > 0.`, `${path}.maxDistanceMm`))
    }
    if (item.pitchMm !== undefined && !positive(item.pitchMm)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.pitchMm must be > 0.`, `${path}.pitchMm`))
    if (item.offsetMm !== undefined && !positive(item.offsetMm)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.offsetMm must be > 0.`, `${path}.offsetMm`))
    if (item.rows !== undefined && (!Number.isInteger(item.rows) || Number(item.rows) < 1 || Number(item.rows) > 8)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.rows must be an integer from 1 to 8.`, `${path}.rows`))
    if (item.rowSpacingMm !== undefined && !positive(item.rowSpacingMm)) diagnostics.push(error("DSL_VALUE_INVALID", `${path}.rowSpacingMm must be > 0.`, `${path}.rowSpacingMm`))
    if (item.stagger !== undefined && typeof item.stagger !== "boolean") diagnostics.push(error("DSL_VALUE_INVALID", `${path}.stagger must be boolean.`, `${path}.stagger`))
    if (item.via !== "drc-min") via(item.via, `${path}.via`, diagnostics)
  })

  fanouts.forEach((raw, index) => {
    const path = `fanouts[${index}]`
    exactKeys(raw, ["target", "method", "extensionMm"], diagnostics, path)
    const item = object(raw) ? raw : {}
    if (!object(item.target)) diagnostics.push(error(
      "DSL_FANOUT_TARGET_INVALID", `${path}.target must be component(...) or pad(...).`, `${path}.target`,
    ))
    else if (item.target.kind === "component") {
      exactKeys(item.target, ["kind", "component"], diagnostics, `${path}.target`)
      if (typeof item.target.component !== "string" || !item.target.component) diagnostics.push(error(
        "DSL_FANOUT_TARGET_INVALID", `${path}.target must identify a component.`, `${path}.target`,
      ))
    } else if (item.target.kind === "pad") {
      exactKeys(item.target, ["kind", "component", "pad"], diagnostics, `${path}.target`)
      if (typeof item.target.component !== "string" || !item.target.component
        || typeof item.target.pad !== "string" || !item.target.pad) diagnostics.push(error(
        "DSL_FANOUT_TARGET_INVALID", `${path}.target must identify a logical pad.`, `${path}.target`,
      ))
    } else diagnostics.push(error(
      "DSL_FANOUT_TARGET_INVALID", `${path}.target must be component(...) or pad(...).`, `${path}.target`,
    ))
    if (!["auto", "stub", "underpad"].includes(String(item.method))) diagnostics.push(error(
      "DSL_FANOUT_METHOD_INVALID", `${path}.method must be auto, stub, or underpad.`, `${path}.method`,
    ))
    if (!nonNegative(item.extensionMm)) diagnostics.push(error(
      "DSL_VALUE_INVALID", `${path}.extensionMm must be >= 0.`, `${path}.extensionMm`,
    ))
  })

  fanoutExclusions.forEach((raw, index) => {
    const path = `fanoutExclusions[${index}]`
    const item = object(raw) ? raw : {}
    if (item.kind === "component") {
      exactKeys(item, ["kind", "component"], diagnostics, path)
      if (typeof item.component !== "string" || !item.component) diagnostics.push(error(
        "DSL_FANOUT_TARGET_INVALID", `${path} must identify a component.`, path,
      ))
      return
    }
    if (item.kind === "pad") {
      exactKeys(item, ["kind", "component", "pad"], diagnostics, path)
      if (typeof item.component !== "string" || !item.component || typeof item.pad !== "string" || !item.pad) diagnostics.push(error(
        "DSL_FANOUT_TARGET_INVALID", `${path} must identify a logical pad.`, path,
      ))
      return
    }
    diagnostics.push(error(
      "DSL_FANOUT_TARGET_INVALID", `${path} must be component(...) or pad(...).`, path,
    ))
  })

  classes.forEach((raw, index) => {
    const path = `netClasses[${index}]`; exactKeys(raw, ["kind", "name", "nets", ...RULE_KEYS], diagnostics, path)
    const item = object(raw) ? raw : {}; if (item.kind !== "net-class" || typeof item.name !== "string" || !item.name || !Array.isArray(item.nets) || !item.nets.length) diagnostics.push(error("DSL_NET_CLASS_INVALID", `${path} is invalid.`, path))
    rule(item, path, diagnostics)
  })

  relationEdits.forEach((raw, index) => {
    const path = `relationEdits[${index}]`
    const item = object(raw) ? raw : {}
    const common = ["kind"]
    if (["upsert-net-class", "assign-net-class", "remove-from-net-class"].includes(String(item.kind))) {
      exactKeys(item, [...common, "name", "nets"], diagnostics, path)
      if (item.kind !== "remove-from-net-class" && (typeof item.name !== "string" || !item.name)) diagnostics.push(error("DSL_DRC_EDIT_INVALID", `${path}.name is required.`, path))
      if (item.name !== undefined && (typeof item.name !== "string" || !item.name)) diagnostics.push(error("DSL_DRC_EDIT_INVALID", `${path}.name is invalid.`, path))
      if (!Array.isArray(item.nets) || !item.nets.length || !item.nets.every((net) => typeof net === "string" && net)) diagnostics.push(error("DSL_DRC_EDIT_INVALID", `${path}.nets is invalid.`, path))
      return
    }
    if (["upsert-matched-group", "add-to-matched-group", "remove-from-matched-group", "move-to-matched-group"].includes(String(item.kind))) {
      exactKeys(item, [...common, "id", "nets"], diagnostics, path)
      if (typeof item.id !== "string" || !item.id || !Array.isArray(item.nets) || !item.nets.length
        || !item.nets.every((net) => typeof net === "string" && net)) diagnostics.push(error("DSL_DRC_EDIT_INVALID", `${path} is invalid.`, path))
      return
    }
    if (item.kind === "upsert-diff-pair") {
      exactKeys(item, [...common, "id", "positive", "negative"], diagnostics, path)
      if (typeof item.id !== "string" || !item.id || typeof item.positive !== "string" || !item.positive
        || typeof item.negative !== "string" || !item.negative || item.positive === item.negative) diagnostics.push(error("DSL_DRC_EDIT_INVALID", `${path} is invalid.`, path))
      return
    }
    if (["delete-net-class", "delete-diff-pair", "delete-matched-group"].includes(String(item.kind))) {
      const key = item.kind === "delete-net-class" ? "name" : "id"
      exactKeys(item, [...common, key], diagnostics, path)
      if (typeof item[key] !== "string" || !item[key]) diagnostics.push(error("DSL_DRC_EDIT_INVALID", `${path}.${key} is invalid.`, path))
      return
    }
    diagnostics.push(error("DSL_DRC_EDIT_INVALID", `${path}.kind is invalid.`, path))
  })

  if (program.drc !== undefined) { exactKeys(program.drc, RULE_KEYS, diagnostics, "drc"); if (object(program.drc)) rule(program.drc, "drc", diagnostics) }
  if (program.busDetect !== undefined && program.busDetect !== true) {
    exactKeys(program.busDetect, ["detectionRadiusMm", "minNets", "attractionRadiusMm"], diagnostics, "busDetect")
    if (program.busDetect.minNets !== undefined && (!Number.isInteger(program.busDetect.minNets) || program.busDetect.minNets < 2)) diagnostics.push(error("DSL_VALUE_INVALID", "busDetect.minNets must be an integer >= 2.", "busDetect.minNets"))
    for (const key of ["detectionRadiusMm", "attractionRadiusMm"] as const) if (program.busDetect[key] !== undefined && !positive(program.busDetect[key])) diagnostics.push(error("DSL_VALUE_INVALID", `busDetect.${key} must be > 0.`, `busDetect.${key}`))
  }
  if (program.onlyNets !== undefined && (!Array.isArray(program.onlyNets) || !program.onlyNets.length)) diagnostics.push(error("DSL_SCOPE_INVALID", "onlyNets must be non-empty.", "onlyNets"))
  if (program.clearRouting !== undefined) {
    exactKeys(program.clearRouting, ["tracks", "vias", "zones"], diagnostics, "clearRouting")
    const scopes = ["tracks", "vias", "zones"] as const
    if (!scopes.some((item) => program.clearRouting?.[item] !== undefined)) diagnostics.push(error("DSL_CLEAR_SCOPE_INVALID", "clearRouting has no item scopes.", "clearRouting"))
    for (const item of scopes) {
      const nets = program.clearRouting[item]
      if (nets !== undefined && nets !== "all" && (!Array.isArray(nets) || !nets.length)) diagnostics.push(error("DSL_CLEAR_SCOPE_INVALID", `clearRouting.${item} is invalid.`, `clearRouting.${item}`))
    }
  }
  if (program.stack !== undefined) {
    exactKeys(program.stack, ["boardThicknessMm", "fallbackCopperThicknessOz", "viaPlatingThicknessUm", "maxTrackWidthMm", "layers", "solderMask"], diagnostics, "stack")
    if (program.stack.maxTrackWidthMm !== undefined && program.stack.maxTrackWidthMm > 10) diagnostics.push(error("DSL_MAX_WIDTH_LIMIT", "stack.maxTrackWidthMm may not exceed 10 mm.", "stack.maxTrackWidthMm"))
    if (program.stack.layers !== undefined) array(program.stack.layers, "stack.layers", diagnostics).forEach((raw, index) => {
      const path = `stack.layers[${index}]`; const item = object(raw) ? raw : {}
      if (item.kind === "copper") {
        exactKeys(item, ["kind", "name", "thicknessOz", "thicknessMm", "plane"], diagnostics, path)
        if (item.thicknessOz !== undefined && item.thicknessMm !== undefined) diagnostics.push(error("DSL_STACK_CONFLICT", `${path} cannot specify thicknessOz and thicknessMm together.`, path))
        if (item.plane !== undefined) {
          const planePath = `${path}.plane`
          if (!object(item.plane)) diagnostics.push(error("DSL_STACK_PLANE_INVALID", `${planePath} must be an object.`, planePath))
          else {
            exactKeys(item.plane, ["nets"], diagnostics, planePath)
            if (!Array.isArray(item.plane.nets) || !item.plane.nets.length
              || item.plane.nets.some((net) => typeof net !== "string" || !net.trim())) diagnostics.push(error(
                "DSL_STACK_PLANE_INVALID",
                `${planePath}.nets must be a non-empty array of net names.`,
                `${planePath}.nets`,
              ))
          }
        }
      } else if (item.kind === "dielectric") {
        exactKeys(item, ["kind", "name", "thicknessMm", "relativePermittivity", "lossTangent", "material"], diagnostics, path)
      } else diagnostics.push(error("DSL_STACK_LAYER_INVALID", `${path}.kind must be copper or dielectric.`, path))
    })
  }
  return { valid: !diagnostics.some((item) => item.severity === "error"), diagnostics }
}
