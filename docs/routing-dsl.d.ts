/**
 * Local routing DSL. A file is a sequence of statements followed by exactly
 * one of applyDrcRules(), runRouting(), or runAll(). Dimensions are mm.
 * Omitted values inherit the imported board/DSN rules.
 */

type PhysicalLayer = "TOP" | "BOTTOM" | `INNER_${number}`;
type LayerSelector = PhysicalLayer | "OUTER" | "ALL" | PhysicalLayer[];
type CopperTarget = object;
type RegionSelector = object;
type FanoutTarget = object;

interface ViaOptions {
  diameterMm?: number;
  drillMm?: number;
  from?: PhysicalLayer;
  to?: PhysicalLayer;
  maxCount?: number;
}

interface FanoutOptions {
  /** auto tries a surface stub first, then underpad for the remaining nets. */
  method?: "auto" | "stub" | "underpad";
  /** Distance past the pad edge before the surface stub bends. Default: 0.1 mm. */
  extensionMm?: number;
}

interface RuleOptions {
  trackWidthMm?: number;
  minTrackWidthMm?: number;
  preferredTrackWidthMm?: number;
  clearanceMm?: number;
  edgeClearanceMm?: number;
  holeToHoleClearanceMm?: number;
  allowedLayers?: LayerSelector;
  via?: ViaOptions;
}

interface ImpedanceOptions {
  targetOhm: number;
  tolerancePercent?: number;
  topology?: "microstrip" | "stripline" | "coplanar";
  /** The nearest actual copper plane for this net is selected automatically. */
  reference: { net: string };
  coplanarGapMm?: number;
}

declare function pad(component: string, pad: string | number): CopperTarget;
/** Select an entire component for component-scoped routing policy. */
declare function component(designator: string): FanoutTarget;
declare function net(name: string): CopperTarget;
declare function board(): RegionSelector;
/** Reserved and rejected until component-bounded regions are implemented. */
declare function components(...designators: string[]): RegionSelector;

interface PolygonBuilder {
  connect(...targets: CopperTarget[]): this;
  on(layers: LayerSelector): this;
  compact(options?: { maxPadFreeGapWidths?: number }): this;
  maxPadFreeGapWidths(value: number): this;
}

declare function polygon(net: string): PolygonBuilder;

declare function plane(options: {
  net: string;
  layers?: LayerSelector;
  region?: RegionSelector;
  paddingMm?: number;
  stitching?: false | true | {
    gridMm?: number;
    maxVisibleViaDistanceMm?: number;
    via?: "drc-min" | Pick<ViaOptions, "diameterMm" | "drillMm">;
    viaInPad?: boolean;
    maxVias?: number;
  };
}): void;

declare function drc(options: RuleOptions): void;
declare function netClass(name: string, options: RuleOptions & { nets: string[] }): void;

declare function signalNet(net: string, options?: RuleOptions & {
  netClass?: string;
  maxLengthMm?: number;
  impedance?: ImpedanceOptions;
}): void;

declare function powerNet(net: string, options?: RuleOptions & {
  netClass?: string;
  maxCurrentA?: number;
  maxTempRiseC?: number;
  maxTrackWidthMm?: number;
  /** Pads carrying the trunk current. Other pads use tapWidthMm. */
  powerPads?: CopperTarget[];
  tapWidthMm?: number | "drc-min";
}): void;

declare function diffPair(id: string, options: RuleOptions & {
  positive: string;
  negative: string;
  gapMm?: number;
  maxSkewMm?: number;
  maxUncoupledLengthMm?: number;
  impedance?: ImpedanceOptions;
}): void;

declare function matchedGroup(id: string, options: {
  nets: string[];
  toleranceMm?: number;
}): void;

/** Route along[] in the existing special stage, then fence retained tracks on both sides. */
declare function viaFence(id: string, options: {
  along: string[];
  net: string;
  pitchMm?: number;
  offsetMm?: number;
  /** Rows on each side of the trace. Default: 2; range: 1..8. */
  rows?: number;
  /** Lateral center-to-center row spacing. Default: triangular pitch. */
  rowSpacingMm?: number;
  /** Shift every second row by pitchMm / 2. Default: true. */
  stagger?: boolean;
  via?: Omit<ViaOptions, "maxCount">;
}): void;

/** Configure automatic fanout for a component or one logical pad. */
declare function fanout(target: FanoutTarget, options?: FanoutOptions): void;

/**
 * Disable automatic dense-package fanout for whole components or individual
 * logical pads. This does not exclude their nets from normal routing.
 */
declare function disableFanout(...targets: FanoutTarget[]): void;

declare function stack(options: {
  boardThicknessMm?: number;
  fallbackCopperThicknessOz?: number;
  viaPlatingThicknessUm?: number;
  maxTrackWidthMm?: number;
  layers?: Array<
    | { kind: "copper"; name: PhysicalLayer; thicknessOz?: number; thicknessMm?: number }
    | { kind: "dielectric"; name?: string; thicknessMm?: number; relativePermittivity?: number; lossTangent?: number; material?: string }
  >;
  solderMask?: {
    top?: { thicknessMm?: number; relativePermittivity?: number };
    bottom?: { thicknessMm?: number; relativePermittivity?: number };
  };
}): void;

declare function quality(options: {
  profile?: "fast" | "balanced" | "quality-first" | "completion-first";
  /** 1..16; use at most 3 unless a broader portfolio is intentional. */
  maxCandidates?: number;
}): void;

declare function onlyNets(...nets: string[]): void;
declare function ignoreNets(...nets: string[]): void;
declare function clearRouting(options?: {
  nets?: "all" | string[];
  /** Alias for nets, retained for natural agent requests. */
  only?: string[];
  items?: Array<"tracks" | "vias" | "zones">;
}): void;

declare function applyDrcRules(): void;
declare function runRouting(): void;
declare function runAll(): void;
