import { createHash } from "node:crypto"

export type StableId = string
export type Millimeters = number

export type PcbPointV1 = Readonly<{ x: Millimeters; y: Millimeters }>
export type PcbPathV1 = readonly PcbPointV1[]
export type PcbPolygonV1 = Readonly<{
  outer: PcbPathV1
  holes?: readonly PcbPathV1[]
}>

/** Canonical geometry convention at every EDA boundary. */
export type CoordinateConventionV1 = Readonly<{
  units: "mm"
  xAxis: "right"
  yAxis: "down"
  rotation: "clockwise-degrees"
}>

export const RAW_PCB_V1_COORDINATES: CoordinateConventionV1 = Object.freeze({
  units: "mm",
  xAxis: "right",
  yAxis: "down",
  rotation: "clockwise-degrees",
})

export type PcbShapeV1 =
  | Readonly<{ kind: "circle"; diameterMm: Millimeters }>
  | Readonly<{ kind: "rect"; widthMm: Millimeters; heightMm: Millimeters }>
  | Readonly<{
      kind: "round-rect"
      widthMm: Millimeters
      heightMm: Millimeters
      cornerRadiusMm: Millimeters
    }>
  | Readonly<{ kind: "oval"; widthMm: Millimeters; heightMm: Millimeters }>
  /** Polygon coordinates are local to the owning pad origin. */
  | Readonly<{ kind: "polygon"; polygon: PcbPolygonV1 }>

export type PcbSourceV1 = Readonly<{
  eda: string
  edaVersion?: string
  adapter: string
  adapterVersion?: string
  documentId?: string
  revision?: string
  capturedAt?: string
}>

export type CopperLayerV1 = Readonly<{
  id: StableId
  name: string
  index: number
  side: "top" | "inner" | "bottom"
  role: "signal" | "plane" | "mixed"
}>

export type NetV1 = Readonly<{
  id: StableId
  name: string
  classId?: StableId
}>

export type ComponentV1 = Readonly<{
  id: StableId
  designator: string
  footprint?: string
  at: PcbPointV1
  rotationDeg: number
  side: "top" | "bottom"
  /** Optional absolute bounds, reserved for future components(...) regions. */
  bounds?: PcbPolygonV1
  locked?: boolean
}>

export type PadV1 = Readonly<{
  id: StableId
  componentId: StableId
  number: string
  netId?: StableId
  at: PcbPointV1
  rotationDeg: number
  layers: readonly StableId[]
  shape: PcbShapeV1
  hole?: Readonly<{
    shape: "round" | "slot"
    diameterMm: Millimeters
    slotLengthMm?: Millimeters
    offset?: PcbPointV1
    rotationDeg?: number
    plated: boolean
  }>
}>

export type TrackV1 = Readonly<{
  kind: "track"
  id: StableId
  netId: StableId
  layerId: StableId
  start: PcbPointV1
  end: PcbPointV1
  widthMm: Millimeters
  locked?: boolean
}>

export type ArcV1 = Readonly<{
  kind: "arc"
  id: StableId
  netId: StableId
  layerId: StableId
  start: PcbPointV1
  mid: PcbPointV1
  end: PcbPointV1
  widthMm: Millimeters
  locked?: boolean
}>

export type ViaV1 = Readonly<{
  kind: "via"
  id: StableId
  netId: StableId
  at: PcbPointV1
  diameterMm: Millimeters
  drillMm: Millimeters
  fromLayerId: StableId
  toLayerId: StableId
  viaType: "through" | "blind-buried" | "micro"
  locked?: boolean
}>

export type ZoneV1 = Readonly<{
  kind: "zone"
  id: StableId
  netId: StableId
  layerId: StableId
  outline: PcbPolygonV1
  /** Native refill result; never confused with the authoring outline. */
  filled: readonly PcbPolygonV1[]
  fillState: "unfilled" | "filled" | "stale"
  priority?: number
  minThicknessMm?: Millimeters
  connection: "solid" | "thermal" | "none"
  locked?: boolean
}>

export type CopperPrimitiveV1 = TrackV1 | ArcV1 | ViaV1 | ZoneV1

export type KeepoutV1 = Readonly<{
  id: StableId
  layers: readonly StableId[]
  polygon: PcbPolygonV1
  forbid: Readonly<{
    tracks: boolean
    vias: boolean
    zones: boolean
    pads: boolean
  }>
}>

export type RuleRangeV1 = Readonly<{
  minMm: Millimeters
  preferredMm: Millimeters
  maxMm: Millimeters
}>

export type ViaRuleV1 = Readonly<{
  diameterMm: RuleRangeV1
  drillMm: RuleRangeV1
}>

export type CompiledRuleValuesV1 = Readonly<{
  clearanceMm: Millimeters
  edgeClearanceMm: Millimeters
  trackWidth: RuleRangeV1
  via: ViaRuleV1
  holeToHoleClearanceMm?: Millimeters
  maxLengthMm?: Millimeters
  diffPair?: Readonly<{
    gapMm: RuleRangeV1
    maxSkewMm?: Millimeters
    maxUncoupledLengthMm?: Millimeters
  }>
}>

export type CompiledRulesV1 = Readonly<{
  /** Fully resolved fallback after native rule compilation. */
  global: CompiledRuleValuesV1
  /** Exact, conflict-free overrides; absent nets inherit global. */
  byNet: readonly Readonly<{ netId: StableId; values: CompiledRuleValuesV1 }>[]
  /** Exact native equal-length groups, after resolving editor rule selectors. */
  matchedGroups?: readonly Readonly<{
    id: StableId
    netIds: readonly StableId[]
    toleranceMm: Millimeters
  }>[]
}>

export type StackupV1 = Readonly<{
  copperThicknessOzFallback: number
  layers: readonly (
    | Readonly<{
        kind: "copper"
        layerId: StableId
        thicknessMm: Millimeters
      }>
    | Readonly<{
        kind: "dielectric"
        id: StableId
        thicknessMm: Millimeters
        material?: string
        relativePermittivity?: number
      }>
  )[]
}>

export type RawPcbV1 = Readonly<{
  schema: "raw-pcb"
  version: 1
  coordinates: CoordinateConventionV1
  source: PcbSourceV1
  board: Readonly<{
    outline: PcbPathV1
    cutouts: readonly PcbPathV1[]
  }>
  layers: readonly CopperLayerV1[]
  stackup: StackupV1
  nets: readonly NetV1[]
  components: readonly ComponentV1[]
  pads: readonly PadV1[]
  copper: Readonly<{
    tracks: readonly TrackV1[]
    arcs: readonly ArcV1[]
    vias: readonly ViaV1[]
    zones: readonly ZoneV1[]
  }>
  keepouts: readonly KeepoutV1[]
  rules: CompiledRulesV1
}>

export type PcbSnapshotV1 = Readonly<{
  schema: "pcb-snapshot"
  version: 1
  rawPcb: RawPcbV1
  /** SHA-256 over canonical RawPcb JSON, including source provenance. */
  contentHash: string
}>

export type RoutingDiagnostic = Readonly<{
  code: string
  severity: "info" | "warning" | "error"
  message: string
  path?: string
  details?: unknown
}>

export type CoreStatus = "complete" | "partial" | "error"

export type PcbPatchOperationV1 =
  | Readonly<{ op: "add"; item: CopperPrimitiveV1 }>
  | Readonly<{ op: "remove"; id: StableId; kind: CopperPrimitiveV1["kind"] }>
  | Readonly<{
      op: "replace"
      id: StableId
      kind: CopperPrimitiveV1["kind"]
      item: CopperPrimitiveV1
    }>

export type PcbPatchV1 = Readonly<{
  schema: "pcb-patch"
  version: 1
  baseSnapshotHash: string
  operations: readonly PcbPatchOperationV1[]
  diagnostics: readonly RoutingDiagnostic[]
  coreStatus: CoreStatus
  /** Core routing never substitutes for the target EDA's final refill/DRC. */
  requiresNativeVerification: true
}>

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]))
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("RawPcb contains a non-finite number")
    return Object.is(value, -0) ? 0 : value
  }
  return value
}

export function hashRawPcbV1(rawPcb: RawPcbV1): string {
  const json = JSON.stringify(canonicalize(rawPcb))
  return `sha256:${createHash("sha256").update(json).digest("hex")}`
}

export function createPcbSnapshotV1(rawPcb: RawPcbV1): PcbSnapshotV1 {
  return {
    schema: "pcb-snapshot",
    version: 1,
    rawPcb,
    contentHash: hashRawPcbV1(rawPcb),
  }
}

function copperItems(rawPcb: RawPcbV1): CopperPrimitiveV1[] {
  return [
    ...rawPcb.copper.tracks,
    ...rawPcb.copper.arcs,
    ...rawPcb.copper.vias,
    ...rawPcb.copper.zones,
  ]
}

function splitCopper(items: readonly CopperPrimitiveV1[]): RawPcbV1["copper"] {
  return {
    tracks: items.filter((item): item is TrackV1 => item.kind === "track"),
    arcs: items.filter((item): item is ArcV1 => item.kind === "arc"),
    vias: items.filter((item): item is ViaV1 => item.kind === "via"),
    zones: items.filter((item): item is ZoneV1 => item.kind === "zone"),
  }
}

/** Apply router output without invoking an EDA or mutating the input snapshot. */
export function applyPcbPatchV1(
  snapshot: PcbSnapshotV1,
  patch: PcbPatchV1,
): PcbSnapshotV1 {
  const actualHash = hashRawPcbV1(snapshot.rawPcb)
  if (snapshot.contentHash !== actualHash || patch.baseSnapshotHash !== actualHash) {
    throw new Error("PCB_PATCH_BASE_MISMATCH: patch does not target this exact snapshot")
  }

  const items = new Map(copperItems(snapshot.rawPcb).map((item) => [item.id, item]))
  for (const operation of patch.operations) {
    if (operation.op === "add") {
      if (items.has(operation.item.id)) {
        throw new Error(`PCB_PATCH_DUPLICATE_ID: ${operation.item.id}`)
      }
      items.set(operation.item.id, operation.item)
      continue
    }

    const current = items.get(operation.id)
    if (!current || current.kind !== operation.kind) {
      throw new Error(`PCB_PATCH_TARGET_MISSING: ${operation.kind}:${operation.id}`)
    }
    if (current.locked) {
      throw new Error(`PCB_PATCH_LOCKED_COPPER: ${operation.kind}:${operation.id}`)
    }
    if (operation.op === "remove") {
      items.delete(operation.id)
      continue
    }
    if (operation.item.id !== operation.id || operation.item.kind !== operation.kind) {
      throw new Error(`PCB_PATCH_REPLACE_ID_MISMATCH: ${operation.id}`)
    }
    items.set(operation.id, operation.item)
  }

  return createPcbSnapshotV1({
    ...snapshot.rawPcb,
    copper: splitCopper([...items.values()]),
  })
}
