type RawCopperLayer = "TOP" | "BOTTOM" | `INNER_${number}`;
type LayerSelector = { readonly kind: string };
type PolygonTarget = { readonly kind: "pad" | "net" };

interface PolygonRule {
  /** Explicitly name the pads to join, or select every pad of this net. Required. */
  connect(...targets: PolygonTarget[]): this;
  /** Select universal RawPcb copper layers. Default: topLayer(). */
  on(selector: LayerSelector): this;
  /** Build a local outline. It is skipped when it exceeds the engine's board-area budget. Default. */
  compact(): this;
  /** Higher-priority zones are exported first. */
  priority(value: number): this;
  /** Maximum pad-free span in widths of the narrower target pad. Default: 4.5. */
  maxPadFreeGap(value: number): this;
}

/** Describe copper intent without coordinates or fill/clearance implementation details. */
declare function polygon(net: string): PolygonRule;

type PlaneRegion = { readonly kind: "board" | "components" };
type PlaneStitching = boolean | {
  /** Uniform stitching grid. Default: 5 mm. */
  gridMm?: number;
  /** Reuse a directly visible GND via within this distance. Default: 10 mm. */
  maxPadViaDistanceMm?: number;
  /** Use the minimum legal via/drill from native DRC. */
  via?: "drc-min";
  /** Put a via at an uncovered SMD pad centre. Default: true. */
  viaInPad?: boolean;
  /** Hard safety limit. Default: 500. */
  maxVias?: number;
};

/** Create a late native plane. Board-wide regions are implemented now. */
declare function plane(options: {
  net: string;
  layers?: LayerSelector;
  region?: PlaneRegion;
  /** Reserved for components(...); not implemented yet. */
  paddingMm?: number;
  priority?: number;
  stitching?: PlaneStitching;
}): void;

declare function board(): PlaneRegion;
/** Reserved DSL syntax; the current engine reports it as unsupported. */
declare function components(...designators: string[]): PlaneRegion;
/** Select one pad by owning component designator and pad number. */
declare function pad(component: string, padNumber: string | number): PolygonTarget;
/** Select every pad on a net. The name must match polygon(net). */
declare function net(name: string): PolygonTarget;
declare function outerLayers(): LayerSelector;
declare function topLayer(): LayerSelector;
declare function bottomLayer(): LayerSelector;
declare function layers(...names: RawCopperLayer[]): LayerSelector;
