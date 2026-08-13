import {
  applyPcbPatchV1,
  hashRawPcbV1,
  type CopperPrimitiveV1,
  type PcbPatchV1,
  type PcbPointV1,
  type PcbSnapshotV1,
  type RawPcbV1,
  type RoutingDiagnostic,
} from "./contracts.js"

export type ValidationResult<T> = Readonly<{
  ok: boolean
  value?: T
  diagnostics: readonly RoutingDiagnostic[]
}>

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function point(value: unknown): value is PcbPointV1 {
  return object(value) && finite(value.x) && finite(value.y)
}

function path(value: unknown, minimum = 2): boolean {
  return Array.isArray(value) && value.length >= minimum && value.every(point)
}

function polygon(value: unknown): boolean {
  return object(value)
    && path(value.outer, 3)
    && (value.holes === undefined
      || (Array.isArray(value.holes) && value.holes.every((item) => path(item, 3))))
}

function shape(value: unknown): boolean {
  if (!object(value)) return false
  if (value.kind === "circle") return positive(value.diameterMm)
  if (value.kind === "rect" || value.kind === "oval") {
    return positive(value.widthMm) && positive(value.heightMm)
  }
  if (value.kind === "round-rect") {
    return positive(value.widthMm) && positive(value.heightMm)
      && finite(value.cornerRadiusMm) && value.cornerRadiusMm >= 0
      && value.cornerRadiusMm <= Math.min(value.widthMm, value.heightMm) / 2
  }
  return value.kind === "polygon" && polygon(value.polygon)
}

function diagnostic(
  diagnostics: RoutingDiagnostic[],
  code: string,
  message: string,
  path?: string,
) {
  diagnostics.push({ code, severity: "error", message, ...(path ? { path } : {}) })
}

function arrayField(
  parent: Record<string, unknown>,
  key: string,
  diagnostics: RoutingDiagnostic[],
): unknown[] {
  const value = parent[key]
  if (!Array.isArray(value)) {
    diagnostic(diagnostics, "RAWPCB_ARRAY_REQUIRED", `${key} must be an array.`, key)
    return []
  }
  return value
}

function validateRange(value: unknown, at: string, diagnostics: RoutingDiagnostic[]) {
  if (!object(value)
    || !positive(value.minMm)
    || !positive(value.preferredMm)
    || !positive(value.maxMm)
    || value.minMm > value.preferredMm
    || value.preferredMm > value.maxMm) {
    diagnostic(
      diagnostics,
      "RAWPCB_INVALID_RULE_RANGE",
      "Rule range must be positive and ordered min <= preferred <= max.",
      at,
    )
  }
}

function validateRuleValues(value: unknown, at: string, diagnostics: RoutingDiagnostic[]) {
  if (!object(value)) {
    diagnostic(diagnostics, "RAWPCB_INVALID_RULE", "Compiled rule must be an object.", at)
    return
  }
  if (!finite(value.clearanceMm) || value.clearanceMm < 0) {
    diagnostic(diagnostics, "RAWPCB_INVALID_CLEARANCE", "clearanceMm must be >= 0.", at)
  }
  if (!finite(value.edgeClearanceMm) || value.edgeClearanceMm < 0) {
    diagnostic(diagnostics, "RAWPCB_INVALID_EDGE_CLEARANCE", "edgeClearanceMm must be >= 0.", at)
  }
  validateRange(value.trackWidth, `${at}.trackWidth`, diagnostics)
  if (!object(value.via)) {
    diagnostic(diagnostics, "RAWPCB_INVALID_VIA_RULE", "via rule is required.", `${at}.via`)
  } else {
    validateRange(value.via.diameterMm, `${at}.via.diameterMm`, diagnostics)
    validateRange(value.via.drillMm, `${at}.via.drillMm`, diagnostics)
  }
  if (object(value.diffPair)) {
    validateRange(value.diffPair.gapMm, `${at}.diffPair.gapMm`, diagnostics)
    if (value.diffPair.maxSkewMm !== undefined
      && (!finite(value.diffPair.maxSkewMm) || value.diffPair.maxSkewMm < 0)) {
      diagnostic(diagnostics, "RAWPCB_INVALID_SKEW", "maxSkewMm must be >= 0.", at)
    }
  }
}

function collectIds(
  values: readonly unknown[],
  at: string,
  diagnostics: RoutingDiagnostic[],
): Set<string> {
  const ids = new Set<string>()
  values.forEach((value, index) => {
    const id = object(value) ? value.id : undefined
    if (!stableId(id)) {
      diagnostic(diagnostics, "RAWPCB_STABLE_ID_REQUIRED", "Stable non-empty id is required.", `${at}[${index}].id`)
    } else if (ids.has(id)) {
      diagnostic(diagnostics, "RAWPCB_DUPLICATE_ID", `Duplicate id: ${id}`, `${at}[${index}].id`)
    } else ids.add(id)
  })
  return ids
}

function copperKind(value: unknown): value is CopperPrimitiveV1 {
  return object(value) && ["track", "arc", "via", "zone"].includes(String(value.kind))
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
  diagnostics: RoutingDiagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      diagnostic(diagnostics, "RAWPCB_UNKNOWN_FIELD", `Unknown field ${key}.`, `${at}.${key}`)
    }
  }
}

export function validateRawPcbV1(value: unknown): ValidationResult<RawPcbV1> {
  const diagnostics: RoutingDiagnostic[] = []
  if (!object(value)) {
    return {
      ok: false,
      diagnostics: [{ code: "RAWPCB_OBJECT_REQUIRED", severity: "error", message: "RawPcbV1 must be an object." }],
    }
  }
  if (value.schema !== "raw-pcb" || value.version !== 1) {
    diagnostic(diagnostics, "RAWPCB_VERSION_UNSUPPORTED", "Expected raw-pcb version 1.")
  }
  if (!object(value.coordinates)
    || value.coordinates.units !== "mm"
    || value.coordinates.xAxis !== "right"
    || value.coordinates.yAxis !== "down"
    || value.coordinates.rotation !== "clockwise-degrees") {
    diagnostic(diagnostics, "RAWPCB_COORDINATE_CONVENTION", "RawPcbV1 must use canonical mm coordinates.", "coordinates")
  }
  if (!object(value.source) || !stableId(value.source.eda) || !stableId(value.source.adapter)) {
    diagnostic(diagnostics, "RAWPCB_SOURCE_REQUIRED", "source.eda and source.adapter are required.", "source")
  }
  if (!object(value.board) || !path(value.board.outline, 3)
    || !Array.isArray(value.board.cutouts)
    || !value.board.cutouts.every((item) => path(item, 3))) {
    diagnostic(diagnostics, "RAWPCB_INVALID_BOARD", "Board needs an outline and cutout arrays.", "board")
  }

  const layers = arrayField(value, "layers", diagnostics)
  const nets = arrayField(value, "nets", diagnostics)
  const components = arrayField(value, "components", diagnostics)
  const pads = arrayField(value, "pads", diagnostics)
  const keepouts = arrayField(value, "keepouts", diagnostics)
  const layerIds = collectIds(layers, "layers", diagnostics)
  const netIds = collectIds(nets, "nets", diagnostics)
  const componentIds = collectIds(components, "components", diagnostics)
  collectIds(pads, "pads", diagnostics)
  collectIds(keepouts, "keepouts", diagnostics)

  layers.forEach((item, index) => {
    if (!object(item) || !stableId(item.name) || !Number.isInteger(item.index)
      || !["top", "inner", "bottom"].includes(String(item.side))
      || !["signal", "plane", "mixed"].includes(String(item.role))) {
      diagnostic(diagnostics, "RAWPCB_INVALID_LAYER", "Invalid copper layer.", `layers[${index}]`)
    }
  })
  nets.forEach((item, index) => {
    if (!object(item) || !stableId(item.name)) {
      diagnostic(diagnostics, "RAWPCB_INVALID_NET", "Net name is required.", `nets[${index}]`)
    }
  })
  components.forEach((item, index) => {
    if (!object(item) || !stableId(item.designator) || !point(item.at)
      || !finite(item.rotationDeg) || !["top", "bottom"].includes(String(item.side))) {
      diagnostic(diagnostics, "RAWPCB_INVALID_COMPONENT", "Invalid component geometry.", `components[${index}]`)
    }
    if (object(item) && item.bounds !== undefined && !polygon(item.bounds)) {
      diagnostic(diagnostics, "RAWPCB_INVALID_COMPONENT_BOUNDS", "Component bounds must be a polygon.", `components[${index}].bounds`)
    }
  })
  pads.forEach((item, index) => {
    if (!object(item) || !stableId(item.componentId) || !componentIds.has(String(item.componentId))
      || typeof item.number !== "string" || !point(item.at) || !finite(item.rotationDeg)
      || !Array.isArray(item.layers) || !item.layers.every((id) => stableId(id) && layerIds.has(id))
      || !shape(item.shape)) {
      diagnostic(diagnostics, "RAWPCB_INVALID_PAD", "Invalid pad or reference.", `pads[${index}]`)
    }
    if (object(item) && item.netId !== undefined && !netIds.has(String(item.netId))) {
      diagnostic(diagnostics, "RAWPCB_UNKNOWN_NET", "Pad references an unknown net.", `pads[${index}].netId`)
    }
    if (object(item) && item.hole !== undefined) {
      const hole = item.hole
      if (!object(hole) || !["round", "slot"].includes(String(hole.shape))
        || !positive(hole.diameterMm) || typeof hole.plated !== "boolean"
        || (hole.shape === "slot" && !positive(hole.slotLengthMm))
        || (hole.offset !== undefined && !point(hole.offset))
        || (hole.rotationDeg !== undefined && !finite(hole.rotationDeg))) {
        diagnostic(diagnostics, "RAWPCB_INVALID_PAD_HOLE", "Invalid pad drill geometry.", `pads[${index}].hole`)
      }
    }
  })

  if (!object(value.copper)) {
    diagnostic(diagnostics, "RAWPCB_COPPER_REQUIRED", "copper collections are required.", "copper")
  }
  const copper = object(value.copper) ? value.copper : {}
  const collections = (["tracks", "arcs", "vias", "zones"] as const)
    .map((key) => [key, arrayField(copper, key, diagnostics)] as const)
  const allCopper = collections.flatMap(([, items]) => items)
  const copperIds = collectIds(allCopper, "copper", diagnostics)
  if (copperIds.size !== allCopper.length) {
    diagnostic(diagnostics, "RAWPCB_COPPER_IDS_NOT_UNIQUE", "Copper IDs must be unique across all copper kinds.", "copper")
  }
  collections.forEach(([collection, items]) => items.forEach((item, index) => {
    const at = `copper.${collection}[${index}]`
    const expected = collection === "tracks" ? "track"
      : collection === "arcs" ? "arc" : collection === "vias" ? "via" : "zone"
    if (!copperKind(item) || item.kind !== expected || !netIds.has(String(item.netId))) {
      diagnostic(diagnostics, "RAWPCB_INVALID_COPPER", `Invalid ${expected} identity or net.`, at)
      return
    }
    if (item.kind === "track" && (!layerIds.has(item.layerId)
      || !point(item.start) || !point(item.end) || !positive(item.widthMm))) {
      diagnostic(diagnostics, "RAWPCB_INVALID_TRACK", "Invalid track geometry.", at)
    }
    if (item.kind === "arc" && (!layerIds.has(item.layerId)
      || !point(item.start) || !point(item.mid) || !point(item.end) || !positive(item.widthMm))) {
      diagnostic(diagnostics, "RAWPCB_INVALID_ARC", "Invalid arc geometry.", at)
    }
    if (item.kind === "via" && (!point(item.at) || !positive(item.diameterMm)
      || !positive(item.drillMm) || item.drillMm >= item.diameterMm
      || !layerIds.has(item.fromLayerId) || !layerIds.has(item.toLayerId))) {
      diagnostic(diagnostics, "RAWPCB_INVALID_VIA", "Invalid via geometry or layer span.", at)
    }
    if (item.kind === "zone" && (!layerIds.has(item.layerId) || !polygon(item.outline)
      || !Array.isArray(item.filled) || !item.filled.every(polygon)
      || !["unfilled", "filled", "stale"].includes(String(item.fillState))
      || !["solid", "thermal", "none"].includes(String(item.connection)))) {
      diagnostic(diagnostics, "RAWPCB_INVALID_ZONE", "Invalid zone outline/fill.", at)
    }
    if (item.kind === "zone" && (item.priority !== undefined && !finite(item.priority)
      || item.minThicknessMm !== undefined && !positive(item.minThicknessMm))) {
      diagnostic(diagnostics, "RAWPCB_INVALID_ZONE_SETTINGS", "Invalid zone priority or minimum thickness.", at)
    }
  }))

  keepouts.forEach((item, index) => {
    if (!object(item) || !Array.isArray(item.layers)
      || !item.layers.every((id) => stableId(id) && layerIds.has(id))
      || !polygon(item.polygon) || !object(item.forbid)) {
      diagnostic(diagnostics, "RAWPCB_INVALID_KEEPOUT", "Invalid keepout.", `keepouts[${index}]`)
    } else if (![item.forbid.tracks, item.forbid.vias, item.forbid.zones, item.forbid.pads]
      .every((entry) => typeof entry === "boolean")) {
      diagnostic(diagnostics, "RAWPCB_INVALID_KEEPOUT_FLAGS", "Keepout flags must be booleans.", `keepouts[${index}].forbid`)
    }
  })

  if (!object(value.stackup) || !positive(value.stackup.copperThicknessOzFallback)
    || !Array.isArray(value.stackup.layers)) {
    diagnostic(diagnostics, "RAWPCB_INVALID_STACKUP", "Invalid stackup.", "stackup")
  } else value.stackup.layers.forEach((item, index) => {
    if (!object(item) || !positive(item.thicknessMm)
      || (item.kind === "copper" && (!stableId(item.layerId) || !layerIds.has(String(item.layerId))))
      || (item.kind === "dielectric" && (!stableId(item.id)
        || item.relativePermittivity !== undefined && !positive(item.relativePermittivity)))
      || !["copper", "dielectric"].includes(String(item.kind))) {
      diagnostic(diagnostics, "RAWPCB_INVALID_STACKUP_LAYER", "Invalid stackup layer.", `stackup.layers[${index}]`)
    }
  })

  if (!object(value.rules) || !Array.isArray(value.rules.byNet)) {
    diagnostic(diagnostics, "RAWPCB_COMPILED_RULES_REQUIRED", "Compiled rules are required.", "rules")
  } else {
    validateRuleValues(value.rules.global, "rules.global", diagnostics)
    const seen = new Set<string>()
    value.rules.byNet.forEach((entry, index) => {
      if (!object(entry) || !stableId(entry.netId) || !netIds.has(String(entry.netId))) {
        diagnostic(diagnostics, "RAWPCB_INVALID_NET_RULE", "Net rule references an unknown net.", `rules.byNet[${index}]`)
      } else if (seen.has(entry.netId)) {
        diagnostic(diagnostics, "RAWPCB_RULE_CONFLICT", "A net has more than one compiled rule.", `rules.byNet[${index}]`)
      } else seen.add(entry.netId)
      if (object(entry)) validateRuleValues(entry.values, `rules.byNet[${index}].values`, diagnostics)
    })
    if (value.rules.matchedGroups !== undefined) {
      if (!Array.isArray(value.rules.matchedGroups)) {
        diagnostic(diagnostics, "RAWPCB_INVALID_MATCHED_GROUPS", "matchedGroups must be an array.", "rules.matchedGroups")
      } else value.rules.matchedGroups.forEach((group, index) => {
        if (!object(group) || !stableId(group.id) || !Array.isArray(group.netIds)
          || group.netIds.length < 2 || !group.netIds.every((netId) => stableId(netId) && netIds.has(netId))
          || !positive(group.toleranceMm)) {
          diagnostic(diagnostics, "RAWPCB_INVALID_MATCHED_GROUP", "Invalid compiled matched group.", `rules.matchedGroups[${index}]`)
        }
      })
    }
  }

  return { ok: diagnostics.length === 0, value: value as RawPcbV1, diagnostics }
}

export function validatePcbSnapshotV1(value: unknown): ValidationResult<PcbSnapshotV1> {
  const diagnostics: RoutingDiagnostic[] = []
  if (!object(value) || value.schema !== "pcb-snapshot" || value.version !== 1
    || !stableId(value.contentHash)) {
    diagnostic(diagnostics, "PCB_SNAPSHOT_VERSION_UNSUPPORTED", "Expected pcb-snapshot version 1.")
    return { ok: false, diagnostics }
  }
  const raw = validateRawPcbV1(value.rawPcb)
  diagnostics.push(...raw.diagnostics)
  if (raw.value && value.contentHash !== hashRawPcbV1(raw.value)) {
    diagnostic(diagnostics, "PCB_SNAPSHOT_HASH_MISMATCH", "Snapshot contentHash does not match RawPcb content.", "contentHash")
  }
  return { ok: diagnostics.length === 0, value: value as PcbSnapshotV1, diagnostics }
}

export function validatePcbPatchV1(value: unknown): ValidationResult<PcbPatchV1> {
  const diagnostics: RoutingDiagnostic[] = []
  if (!object(value) || value.schema !== "pcb-patch" || value.version !== 1
    || !stableId(value.baseSnapshotHash) || !Array.isArray(value.operations)
    || !Array.isArray(value.diagnostics)
    || !["complete", "partial", "error"].includes(String(value.coreStatus))
    || value.requiresNativeVerification !== true) {
    diagnostic(diagnostics, "PCB_PATCH_INVALID", "Expected pcb-patch version 1 with operations and verification marker.")
    return { ok: false, diagnostics }
  }
  value.operations.forEach((operation, index) => {
    if (!object(operation) || !["add", "remove", "replace"].includes(String(operation.op))) {
      diagnostic(diagnostics, "PCB_PATCH_OPERATION_INVALID", "Invalid patch operation.", `operations[${index}]`)
      return
    }
    if (operation.op === "add" && !copperKind(operation.item)) {
      diagnostic(diagnostics, "PCB_PATCH_ITEM_INVALID", "Add requires a copper primitive.", `operations[${index}].item`)
    }
    if ((operation.op === "remove" || operation.op === "replace")
      && (!stableId(operation.id) || !["track", "arc", "via", "zone"].includes(String(operation.kind)))) {
      diagnostic(diagnostics, "PCB_PATCH_TARGET_INVALID", "Remove/replace requires kind and stable id.", `operations[${index}]`)
    }
    if (operation.op === "replace" && (!copperKind(operation.item)
      || operation.item.id !== operation.id || operation.item.kind !== operation.kind)) {
      diagnostic(diagnostics, "PCB_PATCH_REPLACE_INVALID", "Replacement kind and id must match its target.", `operations[${index}]`)
    }
  })
  return { ok: diagnostics.length === 0, value: value as PcbPatchV1, diagnostics }
}

/** Validate a patch together with every net/layer/geometry reference of its result. */
export function validatePcbPatchForSnapshotV1(
  snapshot: PcbSnapshotV1,
  value: unknown,
): ValidationResult<PcbPatchV1> {
  const patchResult = validatePcbPatchV1(value)
  if (!patchResult.ok || !patchResult.value) return patchResult
  try {
    const output = applyPcbPatchV1(snapshot, patchResult.value)
    const outputResult = validatePcbSnapshotV1(output)
    return {
      ok: outputResult.ok,
      value: outputResult.ok ? patchResult.value : undefined,
      diagnostics: outputResult.diagnostics,
    }
  } catch (cause) {
    return {
      ok: false,
      diagnostics: [{
        code: "PCB_PATCH_REJECTED",
        severity: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      }],
    }
  }
}
