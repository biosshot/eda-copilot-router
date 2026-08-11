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
  /** Explicitly permit a board-scale native EDA zone. */
  plane(): this;
  /** Higher-priority zones are exported first. */
  priority(value: number): this;
  /** Maximum pad-free span in widths of the narrower target pad. Default: 4.5. */
  maxPadFreeGap(value: number): this;
}

/** Describe copper intent without coordinates or fill/clearance implementation details. */
declare function polygon(net: string): PolygonRule;
/** Select one pad by owning component designator and pad number. */
declare function pad(component: string, padNumber: string | number): PolygonTarget;
/** Select every pad on a net. The name must match polygon(net). */
declare function net(name: string): PolygonTarget;
declare function outerLayers(): LayerSelector;
declare function topLayer(): LayerSelector;
declare function bottomLayer(): LayerSelector;
declare function layers(...names: RawCopperLayer[]): LayerSelector;
