type IntentStableId = string;
export type NetName = string;

export interface PadSelector {
  readonly kind: "pad";
  readonly component: string;
  readonly pad: string;
}

export interface NetPadsSelector {
  readonly kind: "net-pads";
  readonly net: NetName;
}

export type CopperTarget = PadSelector | NetPadsSelector;

export interface BoardRegion {
  readonly kind: "board";
}

/** Reserved in v2. Engines may reject this region with UNSUPPORTED_CONSTRAINT. */
export interface ComponentsRegion {
  readonly kind: "components";
  readonly components: readonly string[];
}

export type RegionSelector = BoardRegion | ComponentsRegion;

export interface NamedLayerSelector {
  readonly kind: "layer";
  readonly layer: string;
}

export interface OuterLayersSelector {
  readonly kind: "outer-layers";
}

export interface OuterLayerSelector {
  readonly kind: "outer-layer";
  readonly side: "top" | "bottom";
}

export type LayerSelector = NamedLayerSelector | OuterLayerSelector | OuterLayersSelector;

export interface CompactPolygonIntent {
  readonly kind: "compact-polygon";
  readonly id: IntentStableId;
  readonly net: NetName;
  readonly connect: readonly CopperTarget[];
  readonly layers: LayerSelector;
  readonly priority?: number;
  /** Maximum useful pad-free reach, expressed in local pad-width multiples. */
  readonly maxPadFreeGapWidths?: number;
}

export interface StitchingDisabled {
  readonly enabled: false;
}

export interface StitchingEnabled {
  readonly enabled: true;
  readonly gridMm?: number;
  readonly maxVisibleViaDistanceMm?: number;
  /** Omission means the minimum via permitted by compiled DRC. */
  readonly via?: "drc-min" | {
    readonly diameterMm: number;
    readonly drillMm: number;
  };
  readonly viaInPad?: boolean;
  readonly maxVias?: number;
}

export type StitchingIntent = StitchingDisabled | StitchingEnabled;

export interface PlaneIntent {
  readonly kind: "plane";
  readonly id: IntentStableId;
  readonly net: NetName;
  readonly layers: LayerSelector;
  readonly region: RegionSelector;
  /** Reserved for components(...) regions; omitted for a board-wide plane. */
  readonly paddingMm?: number;
  readonly priority?: number;
  /** Explicitly false unless plane(...).stitch(...) is requested. */
  readonly stitching: StitchingIntent;
}

export type CopperIntent = CompactPolygonIntent | PlaneIntent;

export interface ViaConstraint {
  readonly diameterMm?: number;
  readonly drillMm?: number;
}

export interface ImpedanceConstraint {
  readonly targetOhm: number;
  readonly tolerancePercent?: number;
}

export interface PowerNetCommon {
  readonly kind: "power-net";
  readonly net: NetName;
  readonly maxTempRiseC?: number;
  readonly maxTrackWidthMm?: number;
  readonly via?: ViaConstraint;
}

export type PowerNetIntent = PowerNetCommon & (
  | {
      readonly maxCurrentA: number;
      readonly minTrackWidthMm?: never;
    }
  | {
      readonly minTrackWidthMm: number;
      readonly maxCurrentA?: never;
    }
);

export interface SignalConstraintIntent {
  readonly kind: "signal-net";
  readonly net: NetName;
  /** Omitted constraints inherit the compiled board DRC. */
  readonly trackWidthMm?: number;
  readonly clearanceMm?: number;
  readonly maxLengthMm?: number;
  readonly allowedLayers?: LayerSelector;
  readonly via?: ViaConstraint;
  readonly impedance?: ImpedanceConstraint;
}

export type NetIntent = PowerNetIntent | SignalConstraintIntent;

export interface DifferentialPairIntent {
  readonly kind: "differential-pair";
  readonly id: IntentStableId;
  readonly positiveNet: NetName;
  readonly negativeNet: NetName;
  readonly trackWidthMm?: number;
  readonly gapMm?: number;
  readonly maxSkewMm?: number;
  readonly maxUncoupledLengthMm?: number;
  readonly allowedLayers?: LayerSelector;
  readonly impedance?: ImpedanceConstraint;
}

export type MatchedGroupMember =
  | { readonly kind: "net"; readonly net: NetName }
  | { readonly kind: "differential-pair"; readonly id: IntentStableId };

export interface MatchedGroupIntent {
  readonly kind: "matched-group";
  readonly id: IntentStableId;
  readonly members: readonly MatchedGroupMember[];
  /** Omission requires an exact native matched-group constraint in RawPcb. */
  readonly toleranceMm?: number;
}

export type SpecialRoutingIntent = DifferentialPairIntent | MatchedGroupIntent;

export interface ManufacturingIntent {
  /** Used only when the source EDA did not provide a stack-up. Native data wins. */
  readonly fallbackCopperThicknessOz?: number;
  readonly viaPlatingThicknessUm?: number;
  /** Safety ceiling for calculated widths. Must not exceed 10 mm. */
  readonly maxTrackWidthMm?: number;
}

/**
 * EDA-neutral, JSON-serializable routing intent.
 *
 * It deliberately contains no backend name, executable path, search preset or
 * environment-derived option. Those belong to a separate routing policy.
 */
export interface RoutingIntentV2 {
  readonly version: 2;
  readonly copper: readonly CopperIntent[];
  readonly nets: readonly NetIntent[];
  readonly special: readonly SpecialRoutingIntent[];
  readonly manufacturing?: ManufacturingIntent;
}

export type RoutingProfile = "completion-first" | "balanced" | "quality-first";

/** Runtime/search choices kept separate from the portable design intent. */
export interface RoutingPolicy {
  readonly profile?: RoutingProfile;
  readonly maxCandidates?: number;
  readonly timeoutMs?: number;
  readonly meander?: {
    readonly amplitudeMm?: number;
    readonly spacingMm?: number;
  };
}
