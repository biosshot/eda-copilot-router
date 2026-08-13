export type Millimeters = number

export type PointMm = Readonly<{ x: Millimeters; y: Millimeters }>
export type PolygonMm = Readonly<{
  outer: readonly PointMm[]
  holes?: readonly (readonly PointMm[])[]
}>

export type RoutingLayer = Readonly<{
  id: string
  name: string
  index: number
  side: "top" | "inner" | "bottom"
}>

export type RoutingNet = Readonly<{
  name: string
}>

export type RoutingComponent = Readonly<{
  designator: string
  at: PointMm
  rotationDeg: number
  side: "top" | "bottom"
  bounds?: PolygonMm
}>

export type RoutingPadShape =
  | Readonly<{ kind: "circle"; diameterMm: Millimeters }>
  | Readonly<{ kind: "rect"; widthMm: Millimeters; heightMm: Millimeters }>
  | Readonly<{
      kind: "round-rect"
      widthMm: Millimeters
      heightMm: Millimeters
      cornerRadiusMm: Millimeters
    }>
  | Readonly<{ kind: "oval"; widthMm: Millimeters; heightMm: Millimeters }>
  | Readonly<{ kind: "polygon"; polygon: PolygonMm }>

export type RoutingPad = Readonly<{
  id?: string
  component: string
  number: string
  net?: string
  at: PointMm
  rotationDeg: number
  layers: readonly string[]
  shape: RoutingPadShape
  hole?: Readonly<{
    shape: "round" | "slot"
    diameterMm: Millimeters
    slotLengthMm?: Millimeters
    offset?: PointMm
    rotationDeg?: number
    plated: boolean
  }>
}>

export type RoutingKeepout = Readonly<{
  id?: string
  layers: readonly string[]
  polygon: PolygonMm
  forbid: Readonly<{
    tracks: boolean
    vias: boolean
    zones: boolean
  }>
}>

export type RoutedTrack = Readonly<{
  id?: string
  net: string
  layer: string
  widthMm: Millimeters
  /** A track is one constant-width polyline with at least two points. */
  points: readonly PointMm[]
}>

export type RoutedVia = Readonly<{
  id?: string
  net: string
  at: PointMm
  diameterMm: Millimeters
  drillMm: Millimeters
  fromLayer: string
  toLayer: string
  type?: "through" | "blind-buried" | "micro"
}>

export type RoutedZone = Readonly<{
  id?: string
  net: string
  layers: readonly string[]
  outline: PolygonMm
  priority?: number
  minThicknessMm?: Millimeters
  connection?: "solid" | "thermal" | "none"
}>

export type RoutingCopper = Readonly<{
  tracks: readonly RoutedTrack[]
  vias: readonly RoutedVia[]
  zones: readonly RoutedZone[]
}>

export type ViaRules = Readonly<{
  minDiameterMm: Millimeters
  preferredDiameterMm: Millimeters
  minDrillMm: Millimeters
  preferredDrillMm: Millimeters
}>

export type DifferentialRules = Readonly<{
  trackWidthMm: Millimeters
  gapMm: Millimeters
  maxSkewMm?: Millimeters
  maxUncoupledLengthMm?: Millimeters
}>

/** Fully materialized hard and preferred geometry for one rule scope. */
export type RoutingRuleValues = Readonly<{
  clearanceMm: Millimeters
  edgeClearanceMm: Millimeters
  minTrackWidthMm: Millimeters
  preferredTrackWidthMm: Millimeters
  via: ViaRules
  allowedLayers?: readonly string[]
  maxLengthMm?: Millimeters
  impedanceOhm?: number
  impedanceTolerancePercent?: number
  differential?: DifferentialRules
}>

export type MatchedLengthRule = Readonly<{
  id: string
  nets: readonly string[]
  toleranceMm: Millimeters
}>

export type RoutingRules = Readonly<{
  default: RoutingRuleValues
  /** Each entry is already fully materialized; absent nets inherit default. */
  nets: readonly Readonly<{ net: string; values: RoutingRuleValues }>[]
  matchedGroups?: readonly MatchedLengthRule[]
}>

export type RoutingStackup = Readonly<{
  fallbackCopperThicknessOz?: number
  layers: readonly (
    | Readonly<{ kind: "copper"; layer: string; thicknessMm: Millimeters }>
    | Readonly<{
        kind: "dielectric"
        thicknessMm: Millimeters
        relativePermittivity?: number
        material?: string
      }>
  )[]
}>

/**
 * The single EDA-neutral in-memory model. It intentionally contains only data
 * required by routing and is not a lossless EasyEDA or KiCad document.
 */
export type RoutingBoard = Readonly<{
  outline: readonly PointMm[]
  cutouts: readonly (readonly PointMm[])[]
  layers: readonly RoutingLayer[]
  nets: readonly RoutingNet[]
  components: readonly RoutingComponent[]
  pads: readonly RoutingPad[]
  keepouts: readonly RoutingKeepout[]
  stackup?: RoutingStackup
  rules: RoutingRules
  copper: Readonly<{
    /** Immutable source copper and obstacles. */
    fixed: RoutingCopper
    /** Copper owned by this routing transaction and replaceable as a whole. */
    editable: RoutingCopper
  }>
}>

export type RoutingDiagnostic = Readonly<{
  code: string
  severity: "info" | "warning" | "error"
  message: string
  path?: string
  details?: unknown
}>

export type RoutingRuleOverride = Readonly<{
  scope: "default" | Readonly<{ net: string }> | Readonly<{ matchedGroup: string }>
  field: string
  source: unknown
  effective: unknown
}>

export type RoutingOperation = "apply-drc" | "route" | "all"

export type RoutingMetrics = Readonly<{
  elapsedMs: number
  routedNetCount?: number
  openNetCount?: number
  trackLengthMm?: number
  viaCount?: number
  candidateCount?: number
  backend?: string
  details?: Readonly<Record<string, unknown>>
}>

export type RoutingResult = Readonly<{
  status: "complete" | "partial" | "error"
  operation: RoutingOperation
  rules: Readonly<{
    effective: RoutingRules
    applyRequested: boolean
    overriddenFields: readonly RoutingRuleOverride[]
  }>
  /** Present only for runRouting() and runAll(). */
  copper?: RoutingCopper
  diagnostics: readonly RoutingDiagnostic[]
  metrics: RoutingMetrics
  requiresNativeVerification: true
}>

export const EMPTY_ROUTING_COPPER: RoutingCopper = Object.freeze({
  tracks: Object.freeze([]),
  vias: Object.freeze([]),
  zones: Object.freeze([]),
})
