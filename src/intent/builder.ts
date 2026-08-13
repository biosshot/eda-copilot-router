import type {
  BoardRegion,
  CompactPolygonIntent,
  ComponentsRegion,
  CopperIntent,
  CopperTarget,
  DifferentialPairIntent,
  ImpedanceConstraint,
  LayerSelector,
  ManufacturingIntent,
  MatchedGroupIntent,
  NamedLayerSelector,
  NetIntent,
  NetPadsSelector,
  OuterLayerSelector,
  OuterLayersSelector,
  PadSelector,
  PlaneIntent,
  PowerNetIntent,
  RegionSelector,
  RoutingIntentV2,
  SignalConstraintIntent,
  SpecialRoutingIntent,
  StitchingEnabled,
  ViaConstraint,
} from "./types.js";
import { assertRoutingIntent } from "./validation.js";

export interface IntentBuilder<T> {
  build(): T;
}

type Buildable<T> = T | IntentBuilder<T>;

const materialize = <T>(value: Buildable<T>): T =>
  typeof value === "object" && value !== null && "build" in value &&
    typeof (value as IntentBuilder<T>).build === "function"
    ? (value as IntentBuilder<T>).build()
    : value as T;

const nonEmpty = (value: string, label: string): string => {
  const normalized = String(value).trim();
  if (normalized.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return normalized;
};

const positive = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be greater than zero`);
  return value;
};

const nonNegative = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be zero or greater`);
  return value;
};

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
};

export const pad = (component: string, padNumber: string | number): PadSelector => ({
  kind: "pad",
  component: nonEmpty(component, "component"),
  pad: nonEmpty(String(padNumber), "pad"),
});

export const netPads = (net: string): NetPadsSelector => ({
  kind: "net-pads",
  net: nonEmpty(net, "net"),
});

export const board = (): BoardRegion => ({ kind: "board" });

export const components = (...references: string[]): ComponentsRegion => ({
  kind: "components",
  components: references.map((reference) => nonEmpty(reference, "component")),
});

export const layer = (name: string): NamedLayerSelector => ({
  kind: "layer",
  layer: nonEmpty(name, "layer"),
});

export const topLayer = (): OuterLayerSelector => ({ kind: "outer-layer", side: "top" });
export const bottomLayer = (): OuterLayerSelector => ({ kind: "outer-layer", side: "bottom" });
export const outerLayers = (): OuterLayersSelector => ({ kind: "outer-layers" });

export class CompactPolygonBuilder implements IntentBuilder<CompactPolygonIntent> {
  private readonly value: Partial<CompactPolygonIntent> & Pick<CompactPolygonIntent, "kind" | "id" | "net">;

  constructor(id: string, net: string, value?: CompactPolygonBuilder["value"]) {
    this.value = value ?? {
      kind: "compact-polygon",
      id: nonEmpty(id, "polygon id"),
      net: nonEmpty(net, "net"),
      connect: [],
    };
  }

  private with(patch: Partial<CompactPolygonIntent>): CompactPolygonBuilder {
    return new CompactPolygonBuilder(this.value.id, this.value.net, { ...this.value, ...patch });
  }

  connect(...targets: CopperTarget[]): CompactPolygonBuilder {
    return this.with({ connect: targets.map((target) => ({ ...target })) });
  }

  on(layers: LayerSelector): CompactPolygonBuilder {
    return this.with({ layers: { ...layers } });
  }

  priority(value: number): CompactPolygonBuilder {
    return this.with({ priority: nonNegative(value, "priority") });
  }

  maxPadFreeGapWidths(value: number): CompactPolygonBuilder {
    return this.with({ maxPadFreeGapWidths: positive(value, "maxPadFreeGapWidths") });
  }

  build(): CompactPolygonIntent {
    if (!this.value.layers || !this.value.connect?.length) {
      throw new TypeError("compact polygon requires .connect(...) and .on(...)");
    }
    return { ...this.value } as CompactPolygonIntent;
  }
}

export const polygon = (id: string, net: string): CompactPolygonBuilder =>
  new CompactPolygonBuilder(id, net);

export interface StitchingOptions {
  readonly gridMm?: number;
  readonly maxVisibleViaDistanceMm?: number;
  readonly via?: StitchingEnabled["via"];
  readonly viaInPad?: boolean;
  readonly maxVias?: number;
}

export class PlaneBuilder implements IntentBuilder<PlaneIntent> {
  private readonly value: Partial<PlaneIntent> & Pick<PlaneIntent, "kind" | "id" | "net">;

  constructor(id: string, net: string, value?: PlaneBuilder["value"]) {
    this.value = value ?? {
      kind: "plane",
      id: nonEmpty(id, "plane id"),
      net: nonEmpty(net, "net"),
      region: board(),
      stitching: { enabled: false },
    };
  }

  private with(patch: Partial<PlaneIntent>): PlaneBuilder {
    return new PlaneBuilder(this.value.id, this.value.net, { ...this.value, ...patch });
  }

  on(layers: LayerSelector): PlaneBuilder {
    return this.with({ layers: { ...layers } });
  }

  region(region: RegionSelector): PlaneBuilder {
    return this.with({
      region: region.kind === "components"
        ? { ...region, components: [...region.components] }
        : { ...region },
    });
  }

  paddingMm(valueMm: number): PlaneBuilder {
    return this.with({ paddingMm: nonNegative(valueMm, "paddingMm") });
  }

  priority(value: number): PlaneBuilder {
    return this.with({ priority: nonNegative(value, "priority") });
  }

  stitch(options: StitchingOptions = {}): PlaneBuilder {
    return this.with({
      stitching: {
        enabled: true,
        ...(options.gridMm === undefined ? {} : { gridMm: positive(options.gridMm, "gridMm") }),
        ...(options.maxVisibleViaDistanceMm === undefined
          ? {}
          : { maxVisibleViaDistanceMm: positive(options.maxVisibleViaDistanceMm, "maxVisibleViaDistanceMm") }),
        ...(options.via === undefined
          ? {}
          : {
              via: typeof options.via === "string"
                ? options.via
                : { ...options.via },
            }),
        ...(options.viaInPad === undefined ? {} : { viaInPad: Boolean(options.viaInPad) }),
        ...(options.maxVias === undefined ? {} : { maxVias: positiveInteger(options.maxVias, "maxVias") }),
      },
    });
  }

  build(): PlaneIntent {
    if (!this.value.layers) throw new TypeError("plane requires .on(...)");
    return { ...this.value } as PlaneIntent;
  }
}

export const plane = (id: string, net: string): PlaneBuilder => new PlaneBuilder(id, net);

interface MutablePowerNet {
  readonly kind: "power-net";
  readonly net: string;
  readonly maxCurrentA?: number;
  readonly minTrackWidthMm?: number;
  readonly maxTempRiseC?: number;
  readonly maxTrackWidthMm?: number;
  readonly via?: ViaConstraint;
}

export class PowerNetBuilder implements IntentBuilder<PowerNetIntent> {
  private readonly value: MutablePowerNet;

  constructor(net: string, value?: MutablePowerNet) {
    this.value = value ?? { kind: "power-net", net: nonEmpty(net, "net") };
  }

  private with(patch: Partial<MutablePowerNet>): PowerNetBuilder {
    return new PowerNetBuilder(this.value.net, { ...this.value, ...patch });
  }

  maxCurrent(valueA: number): PowerNetBuilder {
    const { minTrackWidthMm: _removed, ...rest } = this.value;
    return new PowerNetBuilder(this.value.net, { ...rest, maxCurrentA: positive(valueA, "maxCurrentA") });
  }

  minimumTrackWidth(valueMm: number): PowerNetBuilder {
    const { maxCurrentA: _removed, ...rest } = this.value;
    return new PowerNetBuilder(this.value.net, { ...rest, minTrackWidthMm: positive(valueMm, "minTrackWidthMm") });
  }

  minTrackWidth(valueMm: number): PowerNetBuilder {
    return this.minimumTrackWidth(valueMm);
  }

  maxTempRise(valueC: number): PowerNetBuilder {
    return this.with({ maxTempRiseC: positive(valueC, "maxTempRiseC") });
  }

  maxTrackWidth(valueMm: number): PowerNetBuilder {
    if (positive(valueMm, "maxTrackWidthMm") > 10) {
      throw new RangeError("maxTrackWidthMm must not exceed 10 mm");
    }
    return this.with({ maxTrackWidthMm: valueMm });
  }

  via(value: ViaConstraint): PowerNetBuilder {
    return this.with({ via: { ...value } });
  }

  build(): PowerNetIntent {
    if ((this.value.maxCurrentA === undefined) === (this.value.minTrackWidthMm === undefined)) {
      throw new TypeError("power net requires exactly one of .maxCurrent(...) or .minimumTrackWidth(...)");
    }
    return { ...this.value } as PowerNetIntent;
  }
}

export const powerNet = (net: string): PowerNetBuilder => new PowerNetBuilder(net);

export class SignalNetBuilder implements IntentBuilder<SignalConstraintIntent> {
  private readonly value: SignalConstraintIntent;

  constructor(net: string, value?: SignalConstraintIntent) {
    this.value = value ?? { kind: "signal-net", net: nonEmpty(net, "net") };
  }

  private with(patch: Partial<SignalConstraintIntent>): SignalNetBuilder {
    return new SignalNetBuilder(this.value.net, { ...this.value, ...patch });
  }

  trackWidth(valueMm: number): SignalNetBuilder {
    return this.with({ trackWidthMm: positive(valueMm, "trackWidthMm") });
  }

  clearance(valueMm: number): SignalNetBuilder {
    return this.with({ clearanceMm: positive(valueMm, "clearanceMm") });
  }

  maxLength(valueMm: number): SignalNetBuilder {
    return this.with({ maxLengthMm: positive(valueMm, "maxLengthMm") });
  }

  on(layers: LayerSelector): SignalNetBuilder {
    return this.with({ allowedLayers: { ...layers } });
  }

  via(value: ViaConstraint): SignalNetBuilder {
    return this.with({ via: { ...value } });
  }

  impedance(targetOhm: number, tolerancePercent?: number): SignalNetBuilder {
    return this.with({
      impedance: {
        targetOhm: positive(targetOhm, "targetOhm"),
        ...(tolerancePercent === undefined
          ? {}
          : { tolerancePercent: positive(tolerancePercent, "tolerancePercent") }),
      },
    });
  }

  build(): SignalConstraintIntent {
    return { ...this.value };
  }
}

export const signalNet = (net: string): SignalNetBuilder => new SignalNetBuilder(net);

export class DifferentialPairBuilder implements IntentBuilder<DifferentialPairIntent> {
  private readonly value: DifferentialPairIntent;

  constructor(id: string, positiveNet: string, negativeNet: string, value?: DifferentialPairIntent) {
    this.value = value ?? {
      kind: "differential-pair",
      id: nonEmpty(id, "differential pair id"),
      positiveNet: nonEmpty(positiveNet, "positive net"),
      negativeNet: nonEmpty(negativeNet, "negative net"),
    };
  }

  private with(patch: Partial<DifferentialPairIntent>): DifferentialPairBuilder {
    return new DifferentialPairBuilder(
      this.value.id,
      this.value.positiveNet,
      this.value.negativeNet,
      { ...this.value, ...patch },
    );
  }

  trackWidth(valueMm: number): DifferentialPairBuilder {
    return this.with({ trackWidthMm: positive(valueMm, "trackWidthMm") });
  }

  gap(valueMm: number): DifferentialPairBuilder {
    return this.with({ gapMm: positive(valueMm, "gapMm") });
  }

  maxSkew(valueMm: number): DifferentialPairBuilder {
    return this.with({ maxSkewMm: positive(valueMm, "maxSkewMm") });
  }

  maxUncoupledLength(valueMm: number): DifferentialPairBuilder {
    return this.with({ maxUncoupledLengthMm: positive(valueMm, "maxUncoupledLengthMm") });
  }

  on(layers: LayerSelector): DifferentialPairBuilder {
    return this.with({ allowedLayers: { ...layers } });
  }

  impedance(targetOhm: number, tolerancePercent?: number): DifferentialPairBuilder {
    const value: ImpedanceConstraint = {
      targetOhm: positive(targetOhm, "targetOhm"),
      ...(tolerancePercent === undefined
        ? {}
        : { tolerancePercent: positive(tolerancePercent, "tolerancePercent") }),
    };
    return this.with({ impedance: value });
  }

  build(): DifferentialPairIntent {
    return { ...this.value };
  }
}

export const diffPair = (id: string, positiveNet: string, negativeNet: string): DifferentialPairBuilder =>
  new DifferentialPairBuilder(id, positiveNet, negativeNet);

interface MutableMatchedGroup {
  readonly kind: "matched-group";
  readonly id: string;
  readonly members: readonly MatchedGroupIntent["members"][number][];
  readonly toleranceMm?: number;
}

export class MatchedGroupBuilder implements IntentBuilder<MatchedGroupIntent> {
  private readonly value: MutableMatchedGroup;

  constructor(id: string, value?: MutableMatchedGroup) {
    this.value = value ?? { kind: "matched-group", id: nonEmpty(id, "matched group id"), members: [] };
  }

  private with(patch: Partial<MutableMatchedGroup>): MatchedGroupBuilder {
    return new MatchedGroupBuilder(this.value.id, { ...this.value, ...patch });
  }

  nets(...nets: string[]): MatchedGroupBuilder {
    return this.with({
      members: [
        ...this.value.members,
        ...nets.map((net) => ({ kind: "net" as const, net: nonEmpty(net, "net") })),
      ],
    });
  }

  differentialPairs(...ids: string[]): MatchedGroupBuilder {
    return this.with({
      members: [
        ...this.value.members,
        ...ids.map((id) => ({ kind: "differential-pair" as const, id: nonEmpty(id, "differential pair id") })),
      ],
    });
  }

  members(...members: MatchedGroupIntent["members"]): MatchedGroupBuilder {
    return this.with({ members: members.map((member) => ({ ...member })) });
  }

  toleranceMm(valueMm: number): MatchedGroupBuilder {
    return this.with({ toleranceMm: positive(valueMm, "toleranceMm") });
  }

  build(): MatchedGroupIntent {
    if (this.value.members.length < 2) throw new TypeError("matched group requires at least two members");
    return { ...this.value } as MatchedGroupIntent;
  }
}

export const matchedGroup = (id: string): MatchedGroupBuilder => new MatchedGroupBuilder(id);

export const fabrication = (intent: ManufacturingIntent): ManufacturingIntent => ({ ...intent });

export interface RoutingBuilderInput {
  readonly copper?: readonly Buildable<CopperIntent>[];
  readonly nets?: readonly Buildable<NetIntent>[];
  readonly special?: readonly Buildable<SpecialRoutingIntent>[];
  readonly manufacturing?: ManufacturingIntent;
}

/** Materializes builders into a validated, plain JSON-compatible AST. */
export function routing(input: RoutingBuilderInput = {}): RoutingIntentV2 {
  const intent: RoutingIntentV2 = {
    version: 2,
    copper: (input.copper ?? []).map((item) => materialize(item)),
    nets: (input.nets ?? []).map((item) => materialize(item)),
    special: (input.special ?? []).map((item) => materialize(item)),
    ...(input.manufacturing === undefined ? {} : { manufacturing: { ...input.manufacturing } }),
  };
  assertRoutingIntent(intent);
  return intent;
}
