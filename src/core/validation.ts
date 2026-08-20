import type {
  PointMm,
  PolygonMm,
  RoutedTrack,
  RoutedVia,
  RoutedZone,
  RoutingBoard,
  RoutingCopper,
  RoutingDiagnostic,
  RoutingRuleValues,
} from "./contracts.js"

export type ValidationResult<T> = Readonly<{
  ok: boolean
  value?: T
  diagnostics: readonly RoutingDiagnostic[]
}>

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0
}

function point(value: unknown): value is PointMm {
  return object(value) && finite(value.x) && finite(value.y)
}

function path(value: unknown, minimum: number) {
  return Array.isArray(value) && value.length >= minimum && value.every(point)
}

function polygon(value: unknown): value is PolygonMm {
  return object(value) && path(value.outer, 3)
    && (value.holes === undefined || (Array.isArray(value.holes) && value.holes.every((item) => path(item, 3))))
}

function padShape(value: unknown) {
  if (!object(value) || typeof value.kind !== "string") return false
  if (value.kind === "circle") return positive(value.diameterMm)
  if (value.kind === "rect" || value.kind === "oval") {
    return positive(value.widthMm) && positive(value.heightMm)
  }
  if (value.kind === "round-rect") return positive(value.widthMm) && positive(value.heightMm)
    && finite(value.cornerRadiusMm) && value.cornerRadiusMm >= 0
    && value.cornerRadiusMm <= Math.min(value.widthMm, value.heightMm) / 2
  if (value.kind === "polygon") return polygon(value.polygon)
  return false
}

function error(diagnostics: RoutingDiagnostic[], code: string, message: string, path?: string) {
  diagnostics.push({ code, severity: "error", message, ...(path ? { path } : {}) })
}

function zoneOptions(value: Record<string, unknown>, diagnostics: RoutingDiagnostic[], path: string) {
  if (value.clearanceMm !== undefined && (!finite(value.clearanceMm) || value.clearanceMm < 0)) {
    error(diagnostics, "ROUTING_ZONE_INVALID", `${path}.clearanceMm must be >= 0.`, `${path}.clearanceMm`)
  }
  if (value.minThicknessMm !== undefined && !positive(value.minThicknessMm)) {
    error(diagnostics, "ROUTING_ZONE_INVALID", `${path}.minThicknessMm must be > 0.`, `${path}.minThicknessMm`)
  }
  if (value.removeIslandsBelowMm2 !== undefined
    && (!finite(value.removeIslandsBelowMm2) || value.removeIslandsBelowMm2 < 0)) {
    error(diagnostics, "ROUTING_ZONE_INVALID", `${path}.removeIslandsBelowMm2 must be >= 0.`, `${path}.removeIslandsBelowMm2`)
  }
  if (value.fill !== undefined) {
    if (!object(value.fill) || !["solid", "hatched"].includes(String(value.fill.style))) {
      error(diagnostics, "ROUTING_ZONE_INVALID", `${path}.fill is invalid.`, `${path}.fill`)
    } else {
      for (const field of ["hatchThicknessMm", "hatchGapMm"] as const) if (value.fill[field] !== undefined
        && !positive(value.fill[field])) error(diagnostics, "ROUTING_ZONE_INVALID", `${path}.fill.${field} must be > 0.`, `${path}.fill.${field}`)
      if (value.fill.hatchOrientationDeg !== undefined && !finite(value.fill.hatchOrientationDeg)) {
        error(diagnostics, "ROUTING_ZONE_INVALID", `${path}.fill.hatchOrientationDeg must be finite.`, `${path}.fill.hatchOrientationDeg`)
      }
    }
  }
  if (value.padConnection !== undefined) {
    if (!object(value.padConnection) || !["solid", "thermal", "none"].includes(String(value.padConnection.mode))) {
      error(diagnostics, "ROUTING_ZONE_INVALID", `${path}.padConnection is invalid.`, `${path}.padConnection`)
    } else {
      for (const field of ["thermalGapMm", "spokeWidthMm"] as const) if (value.padConnection[field] !== undefined
        && !positive(value.padConnection[field])) error(diagnostics, "ROUTING_ZONE_INVALID", `${path}.padConnection.${field} must be > 0.`, `${path}.padConnection.${field}`)
      if (value.padConnection.spokeCount !== undefined && (!Number.isInteger(value.padConnection.spokeCount)
        || Number(value.padConnection.spokeCount) < 2 || Number(value.padConnection.spokeCount) > 8)) {
        error(diagnostics, "ROUTING_ZONE_INVALID", `${path}.padConnection.spokeCount must be 2..8.`, `${path}.padConnection.spokeCount`)
      }
      if (value.padConnection.spokeAngleDeg !== undefined && !finite(value.padConnection.spokeAngleDeg)) {
        error(diagnostics, "ROUTING_ZONE_INVALID", `${path}.padConnection.spokeAngleDeg must be finite.`, `${path}.padConnection.spokeAngleDeg`)
      }
    }
  }
}

function array(value: unknown, diagnostics: RoutingDiagnostic[], path: string) {
  if (!Array.isArray(value)) {
    error(diagnostics, "ROUTING_BOARD_ARRAY_REQUIRED", `${path} must be an array.`, path)
    return []
  }
  return value
}

function ruleValues(value: unknown, diagnostics: RoutingDiagnostic[], path: string): value is RoutingRuleValues {
  if (!object(value)) {
    error(diagnostics, "ROUTING_RULE_REQUIRED", `${path} must be an object.`, path)
    return false
  }
  for (const field of ["clearanceMm", "edgeClearanceMm", "minTrackWidthMm", "preferredTrackWidthMm"] as const) {
    if (!finite(value[field]) || value[field] < 0) error(diagnostics, "ROUTING_RULE_INVALID", `${path}.${field} must be >= 0.`, `${path}.${field}`)
  }
  if (finite(value.minTrackWidthMm) && finite(value.preferredTrackWidthMm)
    && value.minTrackWidthMm > value.preferredTrackWidthMm) error(
    diagnostics, "ROUTING_RULE_CONFLICT", `${path} minimum width exceeds preferred width.`, path,
  )
  if (!object(value.via)) error(diagnostics, "ROUTING_RULE_INVALID", `${path}.via is required.`, `${path}.via`)
  else {
    for (const field of ["minDiameterMm", "preferredDiameterMm", "minDrillMm", "preferredDrillMm"] as const) {
      if (!positive(value.via[field])) error(diagnostics, "ROUTING_RULE_INVALID", `${path}.via.${field} must be > 0.`, `${path}.via.${field}`)
    }
    if (finite(value.via.minDiameterMm) && finite(value.via.minDrillMm)
      && value.via.minDrillMm >= value.via.minDiameterMm) error(
      diagnostics, "ROUTING_RULE_CONFLICT", `${path} via drill must be smaller than diameter.`, `${path}.via`,
    )
  }
  return true
}

function validateCopper(
  value: unknown,
  diagnostics: RoutingDiagnostic[],
  path: string,
  nets: Set<string>,
  layers: Set<string>,
): value is RoutingCopper {
  if (!object(value)) {
    error(diagnostics, "ROUTING_COPPER_REQUIRED", `${path} must be an object.`, path)
    return false
  }
  const tracks = array(value.tracks, diagnostics, `${path}.tracks`)
  const vias = array(value.vias, diagnostics, `${path}.vias`)
  const zones = array(value.zones, diagnostics, `${path}.zones`)
  tracks.forEach((candidate, index) => {
    const at = `${path}.tracks[${index}]`
    if (!object(candidate) || typeof candidate.net !== "string" || typeof candidate.layer !== "string"
      || !positive(candidate.widthMm) || !pathArray(candidate.points)) {
      error(diagnostics, "ROUTING_TRACK_INVALID", `${at} is not a valid routed track.`, at)
      return
    }
    if (!nets.has(candidate.net)) error(diagnostics, "ROUTING_UNKNOWN_NET", `${at} references unknown net ${candidate.net}.`, at)
    if (!layers.has(candidate.layer)) error(diagnostics, "ROUTING_UNKNOWN_LAYER", `${at} references unknown layer ${candidate.layer}.`, at)
  })
  vias.forEach((candidate, index) => {
    const at = `${path}.vias[${index}]`
    if (!object(candidate) || typeof candidate.net !== "string" || !point(candidate.at)
      || !positive(candidate.diameterMm) || !positive(candidate.drillMm)
      || candidate.drillMm >= candidate.diameterMm
      || typeof candidate.fromLayer !== "string" || typeof candidate.toLayer !== "string") {
      error(diagnostics, "ROUTING_VIA_INVALID", `${at} is not a valid routed via.`, at)
      return
    }
    if (!nets.has(candidate.net)) error(diagnostics, "ROUTING_UNKNOWN_NET", `${at} references unknown net ${candidate.net}.`, at)
    for (const layer of [candidate.fromLayer, candidate.toLayer]) if (!layers.has(layer)) {
      error(diagnostics, "ROUTING_UNKNOWN_LAYER", `${at} references unknown layer ${layer}.`, at)
    }
  })
  zones.forEach((candidate, index) => {
    const at = `${path}.zones[${index}]`
    if (!object(candidate) || typeof candidate.net !== "string" || !Array.isArray(candidate.layers)
      || !candidate.layers.length || !candidate.layers.every((item) => typeof item === "string")
      || !polygon(candidate.outline)) {
      error(diagnostics, "ROUTING_ZONE_INVALID", `${at} is not a valid routed zone.`, at)
      return
    }
    if (!nets.has(candidate.net)) error(diagnostics, "ROUTING_UNKNOWN_NET", `${at} references unknown net ${candidate.net}.`, at)
    for (const layer of candidate.layers) if (!layers.has(layer)) {
      error(diagnostics, "ROUTING_UNKNOWN_LAYER", `${at} references unknown layer ${layer}.`, at)
    }
    zoneOptions(candidate, diagnostics, at)
  })
  return true
}

function pathArray(value: unknown): value is readonly PointMm[] {
  return path(value, 2)
}

export function validateRoutingBoard(value: unknown): ValidationResult<RoutingBoard> {
  const diagnostics: RoutingDiagnostic[] = []
  if (!object(value)) return {
    ok: false,
    diagnostics: [{ code: "ROUTING_BOARD_REQUIRED", severity: "error", message: "RoutingBoard must be an object." }],
  }
  if (!path(value.outline, 3)) error(diagnostics, "ROUTING_OUTLINE_INVALID", "outline needs at least three finite mm points.", "outline")
  array(value.cutouts, diagnostics, "cutouts").forEach((item, index) => {
    if (!path(item, 3)) error(diagnostics, "ROUTING_CUTOUT_INVALID", `cutouts[${index}] is invalid.`, `cutouts[${index}]`)
  })
  const layerItems = array(value.layers, diagnostics, "layers")
  const netItems = array(value.nets, diagnostics, "nets")
  const layers = new Set<string>()
  const nets = new Set<string>()
  layerItems.forEach((item, index) => {
    if (!object(item) || typeof item.name !== "string" || !item.name.trim() || !Number.isInteger(item.index)
      || !["top", "inner", "bottom"].includes(String(item.side))) {
      error(diagnostics, "ROUTING_LAYER_INVALID", `layers[${index}] is invalid.`, `layers[${index}]`)
      return
    }
    if (layers.has(item.name)) error(diagnostics, "ROUTING_LAYER_DUPLICATE", `Layer ${item.name} is duplicated.`)
    layers.add(item.name)
  })
  netItems.forEach((item, index) => {
    if (!object(item) || typeof item.name !== "string" || !item.name.trim()) {
      error(diagnostics, "ROUTING_NET_INVALID", `nets[${index}] is invalid.`, `nets[${index}]`)
      return
    }
    if (nets.has(item.name)) error(diagnostics, "ROUTING_NET_DUPLICATE", `Net ${item.name} is duplicated.`)
    nets.add(item.name)
  })
  const components = new Set<string>()
  array(value.components, diagnostics, "components").forEach((item, index) => {
    if (!object(item) || typeof item.designator !== "string" || !item.designator.trim() || !point(item.at)
      || !finite(item.rotationDeg) || !["top", "bottom"].includes(String(item.side))) {
      error(diagnostics, "ROUTING_COMPONENT_INVALID", `components[${index}] is invalid.`, `components[${index}]`)
      return
    }
    if (components.has(item.designator)) error(diagnostics, "ROUTING_COMPONENT_DUPLICATE", `Component ${item.designator} is duplicated.`)
    components.add(item.designator)
  })
  const padIds = new Set<string>()
  array(value.pads, diagnostics, "pads").forEach((item, index) => {
    const at = `pads[${index}]`
    if (!object(item) || typeof item.component !== "string" || typeof item.number !== "string" || !point(item.at)
      || !finite(item.rotationDeg) || !Array.isArray(item.layers) || !item.layers.length
      || !padShape(item.shape)) {
      error(diagnostics, "ROUTING_PAD_INVALID", `${at} is invalid.`, at)
      return
    }
    if (typeof item.id === "string" && item.id) {
      if (padIds.has(item.id)) error(diagnostics, "ROUTING_PAD_ID_DUPLICATE", `Pad id ${item.id} is duplicated.`)
      padIds.add(item.id)
    }
    if (!components.has(item.component)) error(diagnostics, "ROUTING_UNKNOWN_COMPONENT", `${at} references ${item.component}.`, at)
    if (item.net !== undefined && !nets.has(String(item.net))) error(diagnostics, "ROUTING_UNKNOWN_NET", `${at} references ${item.net}.`, at)
    for (const layer of item.layers) if (!layers.has(String(layer))) error(diagnostics, "ROUTING_UNKNOWN_LAYER", `${at} references ${layer}.`, at)
  })
  array(value.keepouts, diagnostics, "keepouts").forEach((item, index) => {
    const at = `keepouts[${index}]`
    const forbid = object(item) ? item.forbid : undefined
    if (!object(item) || !Array.isArray(item.layers) || !item.layers.length
      || !item.layers.every((layer) => typeof layer === "string" && layers.has(layer))
      || !polygon(item.polygon) || !object(forbid)
      || !["tracks", "vias", "zones"].every((field) => typeof forbid?.[field] === "boolean")) {
      error(diagnostics, "ROUTING_KEEPOUT_INVALID", `${at} is invalid.`, at)
    }
  })
  if (!object(value.rules)) error(diagnostics, "ROUTING_RULES_REQUIRED", "rules are required.", "rules")
  else {
    ruleValues(value.rules.default, diagnostics, "rules.default")
    const assignments = new Set<string>()
    array(value.rules.nets, diagnostics, "rules.nets").forEach((item, index) => {
      if (!object(item) || typeof item.net !== "string") error(diagnostics, "ROUTING_RULE_INVALID", `rules.nets[${index}] is invalid.`)
      else {
        if (!nets.has(item.net)) error(diagnostics, "ROUTING_UNKNOWN_NET", `rules.nets[${index}] references ${item.net}.`)
        if (assignments.has(item.net)) error(diagnostics, "ROUTING_RULE_DUPLICATE", `${item.net} has duplicate materialized rules.`)
        assignments.add(item.net)
        ruleValues(item.values, diagnostics, `rules.nets[${index}].values`)
      }
    })
    const specialIds = new Set<string>()
    if (value.rules.differentialPairs !== undefined) array(
      value.rules.differentialPairs,
      diagnostics,
      "rules.differentialPairs",
    ).forEach((item, index) => {
      const at = `rules.differentialPairs[${index}]`
      if (!object(item) || typeof item.id !== "string" || !item.id.trim()
        || typeof item.positive !== "string" || typeof item.negative !== "string"
        || item.positive === item.negative) {
        error(diagnostics, "ROUTING_DIFF_PAIR_INVALID", `${at} is invalid.`, at)
        return
      }
      if (specialIds.has(item.id)) error(diagnostics, "ROUTING_RULE_DUPLICATE", `Special rule id ${item.id} is duplicated.`, at)
      specialIds.add(item.id)
      if (!nets.has(item.positive) || !nets.has(item.negative)) error(
        diagnostics,
        "ROUTING_UNKNOWN_NET",
        `${at} references an unknown net.`,
        at,
      )
    })
    if (value.rules.matchedGroups !== undefined) array(
      value.rules.matchedGroups,
      diagnostics,
      "rules.matchedGroups",
    ).forEach((item, index) => {
      const at = `rules.matchedGroups[${index}]`
      if (!object(item) || typeof item.id !== "string" || !item.id.trim()
        || !Array.isArray(item.nets) || item.nets.length < 2
        || !item.nets.every((net) => typeof net === "string" && nets.has(net))
        || !positive(item.toleranceMm)) {
        error(diagnostics, "ROUTING_MATCHED_GROUP_INVALID", `${at} is invalid.`, at)
        return
      }
      if (specialIds.has(item.id)) error(diagnostics, "ROUTING_RULE_DUPLICATE", `Special rule id ${item.id} is duplicated.`, at)
      specialIds.add(item.id)
    })
  }
  if (!object(value.copper)) error(diagnostics, "ROUTING_COPPER_REQUIRED", "copper is required.", "copper")
  else {
    validateCopper(value.copper.fixed, diagnostics, "copper.fixed", nets, layers)
    validateCopper(value.copper.editable, diagnostics, "copper.editable", nets, layers)
  }
  return { ok: !diagnostics.some((item) => item.severity === "error"), value: value as RoutingBoard, diagnostics }
}

export function validateRoutingCopper(copper: unknown, board: RoutingBoard): ValidationResult<RoutingCopper> {
  const diagnostics: RoutingDiagnostic[] = []
  validateCopper(
    copper, diagnostics, "copper",
    new Set(board.nets.map((net) => net.name)),
    new Set(board.layers.map((layer) => layer.name)),
  )
  return { ok: !diagnostics.some((item) => item.severity === "error"), value: copper as RoutingCopper, diagnostics }
}
