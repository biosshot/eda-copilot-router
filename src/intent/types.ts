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

export type RegionSelector =
  | Readonly<{ kind: "board" }>
  | Readonly<{ kind: "components"; designators: readonly string[] }>

export type PolygonIntent = Readonly<{
  kind: "polygon"
  net: string
  targets: readonly CopperTarget[]
  layers: LayerSelector
  mode: "compact"
  /** Compiler-owned stable order. It is deliberately not authorable in the DSL. */
  priority: number
  maxPadFreeGapWidths: number
}>

export type ViaGeometryIntent = Readonly<{
  diameterMm?: number
  drillMm?: number
  from?: string
  to?: string
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
  /** Compiler-owned. Board-wide GND is always the lowest-priority zone. */
  priority: number
  stitching: PlaneStitchingIntent
}>

export type ViaConstraint = ViaGeometryIntent & Readonly<{
  maxCount?: number
}>

export type ImpedanceTopology = "microstrip" | "stripline" | "coplanar"

export type ImpedanceConstraint = Readonly<{
  targetOhm: number
  tolerancePercent?: number
  topology?: ImpedanceTopology
  reference?: Readonly<{ net: string }>
  /** Lateral ground gap for coplanar geometry. */
  coplanarGapMm?: number
}>

export type RuleIntent = Readonly<{
  trackWidthMm?: number
  minTrackWidthMm?: number
  preferredTrackWidthMm?: number
  clearanceMm?: number
  edgeClearanceMm?: number
  holeToHoleClearanceMm?: number
  allowedLayers?: LayerSelector
  via?: ViaConstraint
}>

export type DrcIntent = RuleIntent & Readonly<{
  preferredTrackWidthMm?: number
  holeToHoleClearanceMm?: number
}>

export type NetClassIntent = RuleIntent & Readonly<{
  kind: "net-class"
  name: string
  nets: readonly string[]
  preferredTrackWidthMm?: number
}>

export type SignalNetIntent = RuleIntent & Readonly<{
  kind: "signal-net"
  net: string
  netClass?: string
  maxLengthMm?: number
  impedance?: ImpedanceConstraint
}>

export type PowerNetIntent = RuleIntent & Readonly<{
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

export type ViaFenceIntent = Readonly<{
  kind: "via-fence"
  id: string
  along: readonly string[]
  net: string
  pitchMm?: number
  offsetMm?: number
  /** Number of rows on each side of the routed centerline. Default: 2. */
  rows?: number
  /** Lateral center-to-center distance between adjacent rows. */
  rowSpacingMm?: number
  /** Shift every second row by half a pitch to form a triangular lattice. Default: true. */
  stagger?: boolean
  via?: ViaGeometryIntent
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

export type ClearRoutingIntent = Readonly<{
  nets: "all" | readonly string[]
  items: readonly ("tracks" | "vias" | "zones")[]
}>

export type RoutingProfile = "fast" | "completion-first" | "balanced" | "quality-first"

export type RoutingPolicy = Readonly<{
  profile?: RoutingProfile
  maxCandidates?: number
  meander?: Readonly<{ amplitudeMm?: number; spacingMm?: number }>
}>

export type RoutingProgram = Readonly<{
  polygons: readonly PolygonIntent[]
  planes: readonly PlaneIntent[]
  signalNets: readonly SignalNetIntent[]
  powerNets: readonly PowerNetIntent[]
  differentialPairs: readonly DifferentialPairIntent[]
  matchedGroups: readonly MatchedGroupIntent[]
  viaFences: readonly ViaFenceIntent[]
  /** Components or logical pads that automatic dense-package fanout must leave untouched. */
  fanoutExclusions: readonly FanoutTarget[]
  netClasses: readonly NetClassIntent[]
  drc?: DrcIntent
  stack?: StackIntent
  quality?: RoutingPolicy
  onlyNets?: readonly string[]
  ignoreNets: readonly string[]
  clearRouting?: ClearRoutingIntent
  operation: RoutingOperation
}>

export type CompiledRoutingProgram = RoutingProgram
