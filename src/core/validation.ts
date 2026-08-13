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

function error(diagnostics: RoutingDiagnostic[], code: string, message: string, path?: string) {
  diagnostics.push({ code, severity: "error", message, ...(path ? { path } : {}) })
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
  const pads = new Set<string>()
  array(value.pads, diagnostics, "pads").forEach((item, index) => {
    const at = `pads[${index}]`
    if (!object(item) || typeof item.component !== "string" || typeof item.number !== "string" || !point(item.at)
      || !finite(item.rotationDeg) || !Array.isArray(item.layers) || !item.layers.length) {
      error(diagnostics, "ROUTING_PAD_INVALID", `${at} is invalid.`, at)
      return
    }
    const key = `${item.component}:${item.number}`
    if (pads.has(key)) error(diagnostics, "ROUTING_PAD_DUPLICATE", `Pad ${key} is duplicated.`)
    pads.add(key)
    if (!components.has(item.component)) error(diagnostics, "ROUTING_UNKNOWN_COMPONENT", `${at} references ${item.component}.`, at)
    if (item.net !== undefined && !nets.has(String(item.net))) error(diagnostics, "ROUTING_UNKNOWN_NET", `${at} references ${item.net}.`, at)
    for (const layer of item.layers) if (!layers.has(String(layer))) error(diagnostics, "ROUTING_UNKNOWN_LAYER", `${at} references ${layer}.`, at)
  })
  array(value.keepouts, diagnostics, "keepouts")
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
