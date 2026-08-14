import type { RoutingOperation } from "../core/contracts.js"

export type LayerSelector =
  | Readonly<{ kind: "outer" }>
  | Readonly<{ kind: "top" }>
  | Readonly<{ kind: "bottom" }>
  | Readonly<{ kind: "named"; names: readonly string[] }>

export type PadTarget = Readonly<{ kind: "pad"; component: string; pad: string }>
export type NetTarget = Readonly<{ kind: "net"; net: string }>
export type CopperTarget = PadTarget | NetTarget

export type RegionSelector =
  | Readonly<{ kind: "board" }>
  | Readonly<{ kind: "components"; designators: readonly string[] }>

export type PolygonIntent = Readonly<{
  kind: "polygon"
  net: string
  targets: readonly CopperTarget[]
  layers: LayerSelector
  mode: "compact"
  priority: number
  maxPadFreeGapWidths: number
}>

export type PlaneStitchingIntent = false | Readonly<{
  gridMm: number
  maxPadViaDistanceMm: number
  via: "drc-min" | Readonly<{ diameterMm: number; drillMm: number }>
  viaInPad: boolean
  maxVias: number
}>

export type PlaneIntent = Readonly<{
  kind: "plane"
  net: string
  layers: LayerSelector
  region: RegionSelector
  paddingMm: number
  priority: number
  stitching: PlaneStitchingIntent
}>

export type ViaConstraint = Readonly<{
  diameterMm?: number
  drillMm?: number
}>

export type ImpedanceConstraint = Readonly<{
  targetOhm: number
  tolerancePercent?: number
}>

export type SignalNetIntent = Readonly<{
  kind: "signal-net"
  net: string
  trackWidthMm?: number
  minTrackWidthMm?: number
  clearanceMm?: number
  maxLengthMm?: number
  allowedLayers?: LayerSelector
  via?: ViaConstraint
  impedance?: ImpedanceConstraint
}>

export type PowerNetIntent = Readonly<{
  kind: "power-net"
  net: string
  /** Semantic requirement. May coexist with compatible absolute limits. */
  maxCurrentA?: number
  maxTempRiseC?: number
  /** Preferred trunk width when current is omitted; local neck-downs may use the fixed hard floor. */
  minTrackWidthMm?: number
  maxTrackWidthMm?: number
  clearanceMm?: number
  allowedLayers?: LayerSelector
  via?: ViaConstraint
}>

export type DifferentialPairIntent = Readonly<{
  kind: "differential-pair"
  id: string
  positive: string
  negative: string
  trackWidthMm?: number
  gapMm?: number
  maxSkewMm?: number
  maxUncoupledLengthMm?: number
  clearanceMm?: number
  allowedLayers?: LayerSelector
  via?: ViaConstraint
  impedance?: ImpedanceConstraint
}>

export type MatchedGroupIntent = Readonly<{
  kind: "matched-group"
  id: string
  nets: readonly string[]
  toleranceMm?: number
}>

export type ManufacturingIntent = Readonly<{
  fallbackCopperThicknessOz?: number
  viaPlatingThicknessUm?: number
  maxTrackWidthMm?: number
}>

export type RoutingProgram = Readonly<{
  polygons: readonly PolygonIntent[]
  planes: readonly PlaneIntent[]
  signalNets: readonly SignalNetIntent[]
  powerNets: readonly PowerNetIntent[]
  differentialPairs: readonly DifferentialPairIntent[]
  matchedGroups: readonly MatchedGroupIntent[]
  manufacturing?: ManufacturingIntent
  operation: RoutingOperation
}>

export type CompiledRoutingProgram = RoutingProgram

export type RoutingProfile = "completion-first" | "balanced" | "quality-first"

export type RoutingPolicy = Readonly<{
  profile?: RoutingProfile
  maxCandidates?: number
  timeoutMs?: number
  meander?: Readonly<{ amplitudeMm?: number; spacingMm?: number }>
}>
