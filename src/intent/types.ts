import type { RoutingOperation } from "../core/contracts.js"

/** Canonical, EDA-neutral copper-layer selector used by the compiled program. */
export type LayerSelector =
  | Readonly<{ kind: "outer" }>
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "top" }>
  | Readonly<{ kind: "bottom" }>
  | Readonly<{ kind: "named"; names: readonly string[] }>

export type PadTarget = Readonly<{ kind: "pad"; component: string; pad: string }>
export type ComponentTarget = Readonly<{ kind: "component"; component: string }>
export type NetTarget = Readonly<{ kind: "net"; net: string }>
export type CopperTarget = PadTarget | NetTarget
export type FanoutTarget = ComponentTarget | PadTarget
export type FanoutMethod = "auto" | "stub" | "underpad"
export type FanoutIntent = Readonly<{
  target: FanoutTarget
  method: FanoutMethod
  extensionMm: number
}>

export type RegionSelector =
  | Readonly<{ kind: "board" }>
  | Readonly<{ kind: "components"; designators: readonly string[] }>

export type ZoneOptions = Readonly<{
  clearanceMm?: number
  minThicknessMm?: number
  fill?: Readonly<{
    style?: "solid" | "hatched"
    hatchThicknessMm?: number
    hatchGapMm?: number
    hatchOrientationDeg?: number
  }>
  padConnection?: Readonly<{
    mode?: "solid" | "thermal" | "none"
    thermalGapMm?: number
    spokeWidthMm?: number
    spokeCount?: number
    spokeAngleDeg?: number
  }>
  removeIslandsBelowMm2?: number
}>

export type PolygonIntent = Readonly<{
  kind: "polygon"
  net: string
  targets: readonly CopperTarget[]
  layers: LayerSelector
  mode: "compact"
  /** Compiler-owned stable order. It is deliberately not authorable in the DSL. */
  priority: number
  maxPadFreeGapWidths: number
  zone?: ZoneOptions
}>

export type ViaGeometryIntent = Readonly<{
  diameterMm?: number
  drillMm?: number
}>

export type PlaneStitchingIntent = false | Readonly<{
  gridMm: number
  maxPadViaDistanceMm: number
  via: "drc-min" | Readonly<{ diameterMm: number; drillMm: number }>
  viaInPad: boolean
}>

export type PlaneIntent = Readonly<{
  kind: "plane"
  net: string
  layers: LayerSelector
  region: RegionSelector
  /** Compiler-owned. Board-wide GND is always the lowest-priority zone. */
  priority: number
  stitching: PlaneStitchingIntent
  zone?: ZoneOptions
}>

export type ViaConstraint = ViaGeometryIntent & Readonly<{
  minDiameterMm?: number
  minDrillMm?: number
}>

export type ImpedanceConstraint = Readonly<{
  targetOhm: number
  tolerancePercent?: number
  /** Omitted and "auto" both select the physically nearest unambiguous reference copper. */
  referenceNet?: string | "auto"
}>

export type BusDetectOptions = Readonly<{
  detectionRadiusMm?: number
  minNets?: number
  attractionRadiusMm?: number
}>

export type BusDetectIntent = true | BusDetectOptions

export type RuleIntent = Readonly<{
  /** Nominal/preferred routed width. */
  trackWidthMm?: number
  /** Hard lower bound, including neck-down geometry. */
  minTrackWidthMm?: number
  clearanceMm?: number
  edgeClearanceMm?: number
  holeToHoleClearanceMm?: number
  allowedLayers?: LayerSelector
  via?: ViaConstraint
}>

export type DrcIntent = RuleIntent

export type NetClassIntent = RuleIntent & Readonly<{
  kind: "net-class"
  name: string
  nets: readonly string[]
}>

/** Relative routing importance. Omission in the DSL means `normal`. */
export type NetPriority = "critical" | "high" | "normal" | "low"

/** Via policy for an individual net. Omission in the DSL means `auto`. */
export type ViaPreference = "auto" | "avoid" | "forbid"

export type NetRoutingPreference = Readonly<{
  priority?: NetPriority
  viaPreference?: ViaPreference
}>

export type SignalNetIntent = RuleIntent & NetRoutingPreference & Readonly<{
  kind: "signal-net"
  net: string
  netClass?: string
  impedance?: ImpedanceConstraint
}>

export type PowerNetIntent = RuleIntent & NetRoutingPreference & Readonly<{
  kind: "power-net"
  net: string
  netClass?: string
  maxCurrentA?: number
  maxTempRiseC?: number
  maxTrackWidthMm?: number
  powerPads?: readonly PadTarget[]
  tapWidthMm?: number | "drc-min"
}>

export type DifferentialPairIntent = RuleIntent & Readonly<{
  kind: "differential-pair"
  id: string
  positive: string
  negative: string
  gapMm?: number
  maxSkewMm?: number
  maxUncoupledLengthMm?: number
  impedance?: ImpedanceConstraint
}>

export type MatchedGroupIntent = Readonly<{
  kind: "matched-group"
  id: string
  nets: readonly string[]
  toleranceMm?: number
}>

export type DrcRelationEdit = Readonly<
  | { kind: "upsert-net-class"; name: string; nets: readonly string[] }
  | { kind: "assign-net-class"; name: string; nets: readonly string[] }
  | { kind: "remove-from-net-class"; name?: string; nets: readonly string[] }
  | { kind: "delete-net-class"; name: string }
  | { kind: "upsert-diff-pair"; id: string; positive: string; negative: string }
  | { kind: "delete-diff-pair"; id: string }
  | { kind: "upsert-matched-group"; id: string; nets: readonly string[] }
  | { kind: "add-to-matched-group"; id: string; nets: readonly string[] }
  | { kind: "remove-from-matched-group"; id: string; nets: readonly string[] }
  | { kind: "move-to-matched-group"; id: string; nets: readonly string[] }
  | { kind: "delete-matched-group"; id: string }
>

export type ViaStitchCommon = Readonly<{
  id: string
  via?: "drc-min" | Readonly<Pick<ViaGeometryIntent, "diameterMm" | "drillMm">>
}>

export type ViaStitchIntent =
  | ViaStitchCommon & Readonly<{
      kind: "via-stitch"
      mode: "grid"
      net: string
      region: RegionSelector
      pitchMm: number
      viaInPad?: boolean
    }>
  | ViaStitchCommon & Readonly<{
      kind: "via-stitch"
      mode: "along"
      net: string
      routes: readonly string[]
      pitchMm?: number
      offsetMm?: number
      rows?: number
      rowSpacingMm?: number
      stagger?: boolean
    }>
  | ViaStitchCommon & Readonly<{
      kind: "via-stitch"
      mode: "around"
      net: string
      target: RegionSelector | FanoutTarget
      pitchMm?: number
      offsetMm?: number
      rows?: number
      side?: "inside" | "outside"
    }>
  | ViaStitchCommon & Readonly<{
      kind: "via-stitch"
      mode: "return"
      referenceNet: string | "auto"
      forNets?: readonly string[]
      maxDistanceMm?: number
    }>

export type StackCopperLayerIntent = Readonly<{
  name: string
  kind: "copper"
  thicknessOz?: number
  thicknessMm?: number
}>

export type StackDielectricLayerIntent = Readonly<{
  name?: string
  kind: "dielectric"
  thicknessMm?: number
  relativePermittivity?: number
  lossTangent?: number
  material?: string
}>

export type StackIntent = Readonly<{
  boardThicknessMm?: number
  fallbackCopperThicknessOz?: number
  viaPlatingThicknessUm?: number
  maxTrackWidthMm?: number
  layers?: readonly (StackCopperLayerIntent | StackDielectricLayerIntent)[]
  solderMask?: Readonly<{
    top?: Readonly<{ thicknessMm?: number; relativePermittivity?: number }>
    bottom?: Readonly<{ thicknessMm?: number; relativePermittivity?: number }>
  }>
}>

export type ClearRoutingNetSelector = "all" | readonly string[]

/** Canonical independent native-copper deletion scopes accumulated from clearRouting(...) calls. */
export type ClearRoutingIntent = Readonly<{
  tracks?: ClearRoutingNetSelector
  vias?: ClearRoutingNetSelector
  zones?: ClearRoutingNetSelector
}>

export type RoutingProgram = Readonly<{
  polygons: readonly PolygonIntent[]
  planes: readonly PlaneIntent[]
  signalNets: readonly SignalNetIntent[]
  powerNets: readonly PowerNetIntent[]
  differentialPairs: readonly DifferentialPairIntent[]
  matchedGroups: readonly MatchedGroupIntent[]
  viaStitches: readonly ViaStitchIntent[]
  /** Explicit opt-in requests for dense-package fanout. */
  fanouts: readonly FanoutIntent[]
  /** Components or logical pads that explicit dense-package fanout must leave untouched. */
  fanoutExclusions: readonly FanoutTarget[]
  netClasses: readonly NetClassIntent[]
  /** Ordered, explicit edits of native DRC relation membership. */
  relationEdits?: readonly DrcRelationEdit[]
  drc?: DrcIntent
  stack?: StackIntent
  busDetect?: BusDetectIntent
  onlyNets?: readonly string[]
  ignoreNets: readonly string[]
  clearRouting?: ClearRoutingIntent
  operation: RoutingOperation
}>

export type CompiledRoutingProgram = RoutingProgram
