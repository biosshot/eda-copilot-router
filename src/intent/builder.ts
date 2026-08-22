import { Script, createContext } from "node:vm"
import type {
  ClearRoutingIntent,
  BusDetectIntent,
  ComponentTarget,
  CopperTarget,
  DifferentialPairIntent,
  DrcIntent,
  FanoutIntent,
  FanoutTarget,
  ImpedanceConstraint,
  LayerSelector,
  MatchedGroupIntent,
  NetClassIntent,
  PadTarget,
  PlaneIntent,
  PlaneStitchingIntent,
  PolygonIntent,
  PowerNetIntent,
  RegionSelector,
  RoutingPolicy,
  RoutingProgram,
  SignalNetIntent,
  StackIntent,
  ViaConstraint,
  ViaStitchIntent,
  ViaGeometryIntent,
  ZoneOptions,
} from "./types.js"

const PHYSICAL_LAYER = /^(TOP|BOTTOM|INNER_(?:[1-9]|[12][0-9]|30))$/
const LAYER_SELECTOR = /^(TOP|BOTTOM|OUTER|ALL|INNER_(?:[1-9]|[12][0-9]|30))$/

function nonEmpty(value: unknown, label: string) {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
    throw new TypeError(`${label} must be a non-empty string or number`)
  }
  return String(value).trim()
}

function positive(value: unknown, label: string) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new RangeError(`${label} must be > 0`)
  return number
}

function nonNegative(value: unknown, label: string) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new RangeError(`${label} must be >= 0`)
  return number
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return number
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertKnownKeys(source: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new TypeError(`${label} has unknown field(s): ${unknown.join(", ")}`)
}

function optionalPositive(source: Record<string, unknown>, key: string) {
  return source[key] === undefined ? {} : { [key]: positive(source[key], key) }
}

function optionalBoolean(source: Record<string, unknown>, key: string) {
  return source[key] === undefined ? {} : { [key]: Boolean(source[key]) }
}

function canonicalPhysicalLayer(value: unknown, label: string) {
  const name = nonEmpty(value, label).toUpperCase()
  if (!PHYSICAL_LAYER.test(name)) throw new TypeError(`${label} must be TOP, BOTTOM, or INNER_1..INNER_30`)
  return name
}

function cloneLayer(value: unknown, label: string): LayerSelector {
  if (typeof value === "string") {
    const name = nonEmpty(value, label).toUpperCase()
    if (!LAYER_SELECTOR.test(name)) throw new TypeError(`${label} uses an unknown canonical layer ${name}`)
    if (name === "TOP") return { kind: "top" }
    if (name === "BOTTOM") return { kind: "bottom" }
    if (name === "OUTER") return { kind: "outer" }
    if (name === "ALL") return { kind: "all" }
    return { kind: "named", names: [name] }
  }
  if (Array.isArray(value) && value.length) return {
    kind: "named",
    names: [...new Set(value.map((item, index) => canonicalPhysicalLayer(item, `${label}[${index}]`)))],
  }
  const selector = object(value, label)
  if (["outer", "all", "top", "bottom"].includes(String(selector.kind))) {
    return { kind: selector.kind as "outer" | "all" | "top" | "bottom" }
  }
  if (selector.kind === "named" && Array.isArray(selector.names) && selector.names.length) return {
    kind: "named",
    names: selector.names.map((item, index) => canonicalPhysicalLayer(item, `${label}.names[${index}]`)),
  }
  throw new TypeError(`${label} must use TOP, BOTTOM, INNER_n, OUTER, ALL, or an array of physical layers`)
}

function optionalLayer(source: Record<string, unknown>, key: string) {
  return source[key] === undefined ? {} : { [key]: cloneLayer(source[key], key) }
}

function optionalVia(source: Record<string, unknown>, label = "via"): { via?: ViaConstraint } {
  if (source.via === undefined) return {}
  const via = object(source.via, label)
  assertKnownKeys(via, ["diameterMm", "drillMm", "minDiameterMm", "minDrillMm"], label)
  return {
    via: {
      ...optionalPositive(via, "diameterMm"),
      ...optionalPositive(via, "drillMm"),
      ...optionalPositive(via, "minDiameterMm"),
      ...optionalPositive(via, "minDrillMm"),
    },
  }
}

function optionalImpedance(source: Record<string, unknown>): { impedance?: ImpedanceConstraint } {
  if (source.impedance === undefined) return {}
  const raw = object(source.impedance, "impedance")
  // reference is accepted only as a migration alias. The compiled contract is
  // the flat referenceNet field and never carries topology/layer/gap inputs.
  assertKnownKeys(raw, ["targetOhm", "tolerancePercent", "referenceNet", "reference"], "impedance")
  let referenceNet: string | "auto" | undefined
  if (raw.referenceNet !== undefined) {
    const value = nonEmpty(raw.referenceNet, "impedance.referenceNet")
    referenceNet = value === "auto" ? "auto" : value
  } else if (raw.reference !== undefined) {
    const item = object(raw.reference, "impedance.reference")
    assertKnownKeys(item, ["net"], "impedance.reference")
    referenceNet = nonEmpty(item.net, "impedance.reference.net")
  }
  return {
    impedance: {
      targetOhm: positive(raw.targetOhm, "impedance.targetOhm"),
      ...optionalPositive(raw, "tolerancePercent"),
      ...(referenceNet === undefined ? {} : { referenceNet }),
    },
  }
}

function zoneOptions(value: unknown, label: string): ZoneOptions {
  const source = object(value, label)
  assertKnownKeys(source, ["clearanceMm", "minThicknessMm", "fill", "padConnection", "removeIslandsBelowMm2"], label)
  let fill: ZoneOptions["fill"]
  if (source.fill !== undefined) {
    const item = object(source.fill, `${label}.fill`)
    assertKnownKeys(item, ["style", "hatchThicknessMm", "hatchGapMm", "hatchOrientationDeg"], `${label}.fill`)
    const style = item.style === undefined ? "solid" : nonEmpty(item.style, `${label}.fill.style`)
    if (style !== "solid" && style !== "hatched") throw new TypeError(`${label}.fill.style must be solid or hatched`)
    if (style !== "hatched" && [item.hatchThicknessMm, item.hatchGapMm, item.hatchOrientationDeg].some((field) => field !== undefined)) {
      throw new TypeError(`${label}.fill hatch fields require style: "hatched"`)
    }
    fill = {
      style,
      ...optionalPositive(item, "hatchThicknessMm"),
      ...optionalPositive(item, "hatchGapMm"),
      ...(item.hatchOrientationDeg === undefined ? {} : {
        hatchOrientationDeg: ((Number(item.hatchOrientationDeg) % 180) + 180) % 180,
      }),
    }
  }
  let padConnection: ZoneOptions["padConnection"]
  if (source.padConnection !== undefined) {
    const item = object(source.padConnection, `${label}.padConnection`)
    assertKnownKeys(item, ["mode", "thermalGapMm", "spokeWidthMm", "spokeCount", "spokeAngleDeg"], `${label}.padConnection`)
    const mode = item.mode === undefined ? "solid" : nonEmpty(item.mode, `${label}.padConnection.mode`)
    if (!['solid', 'thermal', 'none'].includes(mode)) throw new TypeError(`${label}.padConnection.mode must be solid, thermal, or none`)
    if (mode !== "thermal" && [item.thermalGapMm, item.spokeWidthMm, item.spokeCount, item.spokeAngleDeg].some((field) => field !== undefined)) {
      throw new TypeError(`${label}.padConnection thermal fields require mode: "thermal"`)
    }
    padConnection = {
      mode: mode as "solid" | "thermal" | "none",
      ...optionalPositive(item, "thermalGapMm"),
      ...optionalPositive(item, "spokeWidthMm"),
      ...(item.spokeCount === undefined ? {} : { spokeCount: integer(item.spokeCount, `${label}.padConnection.spokeCount`, 2, 8) }),
      ...(item.spokeAngleDeg === undefined ? {} : { spokeAngleDeg: ((Number(item.spokeAngleDeg) % 180) + 180) % 180 }),
    }
  }
  return {
    ...optionalPositive(source, "clearanceMm"),
    ...optionalPositive(source, "minThicknessMm"),
    ...(fill ? { fill } : {}),
    ...(padConnection ? { padConnection } : {}),
    ...(source.removeIslandsBelowMm2 === undefined ? {} : {
      removeIslandsBelowMm2: nonNegative(source.removeIslandsBelowMm2, `${label}.removeIslandsBelowMm2`),
    }),
  }
}

const RULE_KEYS = [
  "trackWidthMm", "minTrackWidthMm", "clearanceMm",
  "edgeClearanceMm", "holeToHoleClearanceMm", "allowedLayers", "via",
] as const

function ruleFields(source: Record<string, unknown>) {
  return {
    ...optionalPositive(source, "trackWidthMm"),
    ...optionalPositive(source, "minTrackWidthMm"),
    ...optionalPositive(source, "clearanceMm"),
    ...optionalPositive(source, "edgeClearanceMm"),
    ...optionalPositive(source, "holeToHoleClearanceMm"),
    ...optionalLayer(source, "allowedLayers"),
    ...optionalVia(source),
  }
}

type MutablePolygonIntent = { -readonly [Key in keyof PolygonIntent]: PolygonIntent[Key] }

class PolygonBuilder {
  constructor(private readonly value: MutablePolygonIntent) {}

  connect(...targets: CopperTarget[]) {
    if (!targets.length) throw new TypeError("polygon.connect(...) requires at least one target")
    this.value.targets = [...this.value.targets, ...targets.map((target) => structuredClone(target))]
    return this
  }

  on(layers: unknown) {
    this.value.layers = cloneLayer(layers, "polygon layers")
    return this
  }

  compact(options?: unknown) {
    this.value.mode = "compact"
    if (options !== undefined) {
      const source = object(options, "polygon.compact")
      assertKnownKeys(source, ["maxPadFreeGapWidths"], "polygon.compact")
      if (source.maxPadFreeGapWidths !== undefined) {
        this.value.maxPadFreeGapWidths = positive(source.maxPadFreeGapWidths, "maxPadFreeGapWidths")
      }
    }
    return this
  }

  maxPadFreeGapWidths(value: number) {
    this.value.maxPadFreeGapWidths = positive(value, "maxPadFreeGapWidths")
    return this
  }

  zone(options: unknown) {
    this.value.zone = zoneOptions(options, "polygon.zone")
    return this
  }
}

class RoutingDslBuilder {
  private readonly polygons: MutablePolygonIntent[] = []
  private readonly planes: PlaneIntent[] = []
  private readonly signalNets: SignalNetIntent[] = []
  private readonly powerNets: PowerNetIntent[] = []
  private readonly differentialPairs: DifferentialPairIntent[] = []
  private readonly matchedGroups: MatchedGroupIntent[] = []
  private readonly viaStitches: ViaStitchIntent[] = []
  private readonly fanouts = new Map<string, FanoutIntent>()
  private readonly fanoutExclusions = new Map<string, FanoutTarget>()
  private readonly netClasses: NetClassIntent[] = []
  private drcIntent: DrcIntent | undefined
  private stackIntent: StackIntent | undefined
  private qualityIntent: RoutingPolicy | undefined
  private busDetectIntent: BusDetectIntent | undefined
  private onlyNetNames: string[] | undefined
  private readonly ignoredNetNames = new Set<string>()
  private clearIntent: ClearRoutingIntent | undefined
  private operation: RoutingProgram["operation"] | undefined

  sandbox() {
    return {
      polygon: (net: string) => this.polygon(net),
      plane: (options: unknown) => this.plane(options),
      drc: (options: unknown) => this.drc(options),
      netClass: (name: string, options: unknown) => this.netClass(name, options),
      powerNet: (net: string, options: unknown = {}) => this.powerNet(net, options),
      signalNet: (net: string, options: unknown = {}) => this.signalNet(net, options),
      diffPair: (id: string, options: unknown) => this.diffPair(id, options),
      matchedGroup: (id: string, options: unknown) => this.matchedGroup(id, options),
      viaStitch: (id: string, options: unknown) => this.viaStitch(id, options),
      fanout: (target: FanoutTarget, options: unknown = {}) => this.fanout(target, options),
      disableFanout: (...targets: FanoutTarget[]) => this.disableFanout(targets),
      stack: (options: unknown) => this.stack(options),
      quality: (options: unknown) => this.quality(options),
      busDetect: (value: unknown = true) => this.busDetect(value),
      onlyNets: (...nets: string[]) => this.onlyNets(nets),
      ignoreNets: (...nets: string[]) => this.ignoreNets(nets),
      clearRouting: (options: unknown = {}) => this.clearRouting(options),
      pad: (component: string, number: string | number): PadTarget => ({
        kind: "pad", component: nonEmpty(component, "pad component"), pad: nonEmpty(number, "pad number"),
      }),
      component: (designator: string): ComponentTarget => ({
        kind: "component", component: nonEmpty(designator, "component designator"),
      }),
      net: (name: string) => ({ kind: "net" as const, net: nonEmpty(name, "net") }),
      board: (): RegionSelector => ({ kind: "board" }),
      components: (...designators: string[]): RegionSelector => ({
        kind: "components",
        designators: designators.map((item, index) => nonEmpty(item, `components[${index}]`)),
      }),
      applyDrcRules: () => this.terminal("apply-drc"),
      applyStackup: () => this.terminal("apply-stackup"),
      runCopper: () => this.terminal("copper"),
      runRouting: () => this.terminal("route"),
      runAll: () => this.terminal("all"),
    }
  }

  program(): RoutingProgram {
    if (!this.operation) throw new TypeError("routing DSL requires exactly one terminal command")
    for (const [index, polygon] of this.polygons.entries()) {
      if (!polygon.targets.length) throw new TypeError(`polygon ${index + 1} (${polygon.net}) has no targets`)
      for (const target of polygon.targets) if (target.kind === "net" && target.net !== polygon.net) {
        throw new TypeError(`polygon ${polygon.net} cannot connect net(${target.net})`)
      }
    }
    return structuredClone({
      polygons: this.polygons,
      planes: this.planes,
      signalNets: this.signalNets,
      powerNets: this.powerNets,
      differentialPairs: this.differentialPairs,
      matchedGroups: this.matchedGroups,
      viaStitches: this.viaStitches,
      fanouts: [...this.fanouts.values()],
      fanoutExclusions: [...this.fanoutExclusions.values()],
      netClasses: this.netClasses,
      ...(this.drcIntent ? { drc: this.drcIntent } : {}),
      ...(this.stackIntent ? { stack: this.stackIntent } : {}),
      ...(this.qualityIntent ? { quality: this.qualityIntent } : {}),
      ...(this.busDetectIntent ? { busDetect: this.busDetectIntent } : {}),
      ...(this.onlyNetNames ? { onlyNets: this.onlyNetNames } : {}),
      ignoreNets: [...this.ignoredNetNames],
      ...(this.clearIntent ? { clearRouting: this.clearIntent } : {}),
      operation: this.operation,
    })
  }

  private terminal(operation: RoutingProgram["operation"]): undefined {
    if (this.operation) throw new TypeError("routing DSL accepts exactly one terminal command")
    this.operation = operation
    return undefined
  }

  private polygon(net: string) {
    const value: MutablePolygonIntent = {
      kind: "polygon", net: nonEmpty(net, "polygon net"), targets: [], layers: { kind: "top" },
      mode: "compact", priority: this.polygons.length, maxPadFreeGapWidths: 4.5,
    }
    this.polygons.push(value)
    return new PolygonBuilder(value)
  }

  private plane(input: unknown): undefined {
    const source = object(input, "plane")
    assertKnownKeys(source, ["net", "layers", "region", "paddingMm", "stitching", "zone"], "plane")
    const region = source.region === undefined ? { kind: "board" as const } : structuredClone(source.region) as RegionSelector
    if (region.kind !== "board" && (region.kind !== "components" || !region.designators?.length)) {
      throw new TypeError("plane.region must be board() or non-empty components(...)")
    }
    let stitching: PlaneStitchingIntent = false
    if (source.stitching !== undefined && source.stitching !== false) {
      const value = source.stitching === true ? {} : object(source.stitching, "plane.stitching")
      assertKnownKeys(value, ["gridMm", "maxVisibleViaDistanceMm", "maxPadViaDistanceMm", "via", "viaInPad", "maxVias"], "plane.stitching")
      const via = value.via === undefined || value.via === "drc-min"
        ? "drc-min" as const
        : (() => {
            const item = object(value.via, "plane.stitching.via")
            assertKnownKeys(item, ["diameterMm", "drillMm"], "plane.stitching.via")
            return { diameterMm: positive(item.diameterMm, "diameterMm"), drillMm: positive(item.drillMm, "drillMm") }
          })()
      const maxDistance = value.maxVisibleViaDistanceMm ?? value.maxPadViaDistanceMm
      stitching = {
        gridMm: value.gridMm === undefined ? 5 : positive(value.gridMm, "gridMm"),
        maxPadViaDistanceMm: maxDistance === undefined ? 10 : positive(maxDistance, "maxVisibleViaDistanceMm"),
        via,
        viaInPad: value.viaInPad === undefined ? true : Boolean(value.viaInPad),
        maxVias: value.maxVias === undefined ? 500 : integer(value.maxVias, "maxVias", 1),
      }
    }
    const paddingMm = source.paddingMm === undefined ? 0 : nonNegative(source.paddingMm, "paddingMm")
    if (region.kind === "board" && paddingMm > 0) throw new TypeError("plane padding is reserved for components(...)")
    this.planes.push({
      kind: "plane", net: nonEmpty(source.net, "plane net"),
      layers: source.layers === undefined ? { kind: "outer" } : cloneLayer(source.layers, "plane.layers"),
      region, paddingMm, priority: 0, stitching,
      ...(source.zone === undefined ? {} : { zone: zoneOptions(source.zone, "plane.zone") }),
    })
    return undefined
  }

  private drc(input: unknown): undefined {
    if (this.drcIntent) throw new TypeError("drc(...) may be declared only once")
    const source = object(input, "drc")
    assertKnownKeys(source, RULE_KEYS, "drc")
    this.drcIntent = ruleFields(source)
    return undefined
  }

  private netClass(name: string, input: unknown): undefined {
    const source = object(input, "netClass")
    assertKnownKeys(source, ["nets", ...RULE_KEYS], "netClass")
    if (!Array.isArray(source.nets) || !source.nets.length) throw new TypeError("netClass.nets must be a non-empty array")
    this.netClasses.push({
      kind: "net-class", name: nonEmpty(name, "netClass name"),
      nets: [...new Set(source.nets.map((item, index) => nonEmpty(item, `netClass.nets[${index}]`)))],
      ...ruleFields(source),
    })
    return undefined
  }

  private powerNet(net: string, input: unknown): undefined {
    const source = object(input, "powerNet options")
    assertKnownKeys(source, [
      "netClass", "maxCurrentA", "maxTempRiseC", "minTrackWidthMm", "maxTrackWidthMm",
      "trackWidthMm", "clearanceMm", "edgeClearanceMm", "allowedLayers", "via", "powerPads", "tapWidthMm",
    ], "powerNet")
    const maxTrackWidthMm = source.maxTrackWidthMm === undefined ? undefined : positive(source.maxTrackWidthMm, "maxTrackWidthMm")
    if (maxTrackWidthMm !== undefined && maxTrackWidthMm > 10) throw new RangeError("maxTrackWidthMm must not exceed 10 mm")
    let powerPads: PadTarget[] | undefined
    if (source.powerPads !== undefined) {
      if (!Array.isArray(source.powerPads) || !source.powerPads.length) throw new TypeError("powerPads must be a non-empty pad(...) array")
      powerPads = source.powerPads.map((target, index) => {
        const item = object(target, `powerPads[${index}]`)
        if (item.kind !== "pad") throw new TypeError(`powerPads[${index}] must be pad(...)`)
        return { kind: "pad", component: nonEmpty(item.component, "power pad component"), pad: nonEmpty(item.pad, "power pad number") }
      })
    }
    const tapWidth = source.tapWidthMm === undefined || source.tapWidthMm === "drc-min"
      ? source.tapWidthMm
      : positive(source.tapWidthMm, "tapWidthMm")
    this.powerNets.push({
      kind: "power-net", net: nonEmpty(net, "power net"),
      ...(source.netClass === undefined ? {} : { netClass: nonEmpty(source.netClass, "powerNet.netClass") }),
      ...ruleFields(source), ...optionalPositive(source, "maxCurrentA"), ...optionalPositive(source, "maxTempRiseC"),
      ...(maxTrackWidthMm === undefined ? {} : { maxTrackWidthMm }),
      ...(powerPads ? { powerPads } : {}), ...(tapWidth === undefined ? {} : { tapWidthMm: tapWidth }),
    })
    return undefined
  }

  private signalNet(net: string, input: unknown): undefined {
    const source = object(input, "signalNet options")
    assertKnownKeys(source, ["netClass", "impedance", ...RULE_KEYS], "signalNet")
    this.signalNets.push({
      kind: "signal-net", net: nonEmpty(net, "signal net"),
      ...(source.netClass === undefined ? {} : { netClass: nonEmpty(source.netClass, "signalNet.netClass") }),
      ...ruleFields(source), ...optionalImpedance(source),
    })
    return undefined
  }

  private diffPair(id: string, input: unknown): undefined {
    const source = object(input, "diffPair options")
    assertKnownKeys(source, [
      "positive", "negative", "gapMm", "maxSkewMm", "maxUncoupledLengthMm", "impedance", ...RULE_KEYS,
    ], "diffPair")
    this.differentialPairs.push({
      kind: "differential-pair", id: nonEmpty(id, "diff pair id"),
      positive: nonEmpty(source.positive, "diffPair.positive"), negative: nonEmpty(source.negative, "diffPair.negative"),
      ...ruleFields(source), ...optionalPositive(source, "gapMm"), ...optionalPositive(source, "maxSkewMm"),
      ...optionalPositive(source, "maxUncoupledLengthMm"), ...optionalImpedance(source),
    })
    return undefined
  }

  private matchedGroup(id: string, input: unknown): undefined {
    const source = object(input, "matchedGroup options")
    assertKnownKeys(source, ["nets", "toleranceMm"], "matchedGroup")
    if (!Array.isArray(source.nets) || source.nets.length < 2) throw new TypeError("matchedGroup.nets needs at least two nets")
    this.matchedGroups.push({
      kind: "matched-group", id: nonEmpty(id, "matched group id"),
      nets: source.nets.map((item, index) => nonEmpty(item, `matchedGroup.nets[${index}]`)),
      ...optionalPositive(source, "toleranceMm"),
    })
    return undefined
  }

  private stitchVia(source: Record<string, unknown>, label: string) {
    if (source.via === undefined || source.via === "drc-min") return source.via as "drc-min" | undefined
    const item = object(source.via, `${label}.via`)
    assertKnownKeys(item, ["diameterMm", "drillMm"], `${label}.via`)
    return { ...optionalPositive(item, "diameterMm"), ...optionalPositive(item, "drillMm") }
  }

  private viaStitch(id: string, input: unknown): undefined {
    const source = object(input, "viaStitch options")
    const mode = nonEmpty(source.mode, "viaStitch.mode") as ViaStitchIntent["mode"]
    const common = {
      kind: "via-stitch" as const,
      id: nonEmpty(id, "viaStitch id"),
      ...(this.stitchVia(source, "viaStitch") === undefined ? {} : { via: this.stitchVia(source, "viaStitch") }),
      ...(source.maxVias === undefined ? {} : { maxVias: integer(source.maxVias, "viaStitch.maxVias", 1) }),
    }
    if (mode === "grid") {
      assertKnownKeys(source, ["mode", "net", "region", "pitchMm", "viaInPad", "via", "maxVias"], "viaStitch")
      const region = structuredClone(source.region) as RegionSelector
      if (!region || (region.kind !== "board" && (region.kind !== "components" || !region.designators?.length))) throw new TypeError("viaStitch.region must be board() or components(...)")
      this.viaStitches.push({ ...common, mode, net: nonEmpty(source.net, "viaStitch.net"), region, pitchMm: positive(source.pitchMm, "viaStitch.pitchMm"), ...optionalBoolean(source, "viaInPad") })
    } else if (mode === "along") {
      assertKnownKeys(source, ["mode", "net", "routes", "pitchMm", "offsetMm", "rows", "rowSpacingMm", "stagger", "via", "maxVias"], "viaStitch")
      if (!Array.isArray(source.routes) || !source.routes.length) throw new TypeError("viaStitch.routes must be a non-empty net array")
      this.viaStitches.push({
        ...common, mode, net: nonEmpty(source.net, "viaStitch.net"),
        routes: [...new Set(source.routes.map((item, index) => nonEmpty(item, `viaStitch.routes[${index}]`)))],
        ...optionalPositive(source, "pitchMm"), ...optionalPositive(source, "offsetMm"),
        ...(source.rows === undefined ? {} : { rows: integer(source.rows, "viaStitch.rows", 1, 8) }),
        ...optionalPositive(source, "rowSpacingMm"), ...optionalBoolean(source, "stagger"),
      })
    } else if (mode === "around") {
      assertKnownKeys(source, ["mode", "net", "target", "pitchMm", "offsetMm", "rows", "side", "via", "maxVias"], "viaStitch")
      const target = structuredClone(source.target) as RegionSelector | FanoutTarget
      if (!target || !["board", "components", "component", "pad"].includes(target.kind)) throw new TypeError("viaStitch.target must be board(), components(...), component(...), or pad(...)")
      const side = source.side === undefined ? undefined : nonEmpty(source.side, "viaStitch.side")
      if (side !== undefined && side !== "inside" && side !== "outside") throw new TypeError("viaStitch.side must be inside or outside")
      this.viaStitches.push({ ...common, mode, net: nonEmpty(source.net, "viaStitch.net"), target, ...optionalPositive(source, "pitchMm"), ...optionalPositive(source, "offsetMm"), ...(source.rows === undefined ? {} : { rows: integer(source.rows, "viaStitch.rows", 1, 8) }), ...(side ? { side } : {}) })
    } else if (mode === "return") {
      assertKnownKeys(source, ["mode", "referenceNet", "forNets", "maxDistanceMm", "via", "maxVias"], "viaStitch")
      const referenceNet = nonEmpty(source.referenceNet, "viaStitch.referenceNet")
      if (source.forNets !== undefined && (!Array.isArray(source.forNets) || !source.forNets.length)) throw new TypeError("viaStitch.forNets must be a non-empty net array")
      this.viaStitches.push({ ...common, mode, referenceNet: referenceNet === "auto" ? "auto" : referenceNet, ...(source.forNets === undefined ? {} : { forNets: [...new Set(source.forNets.map((item, index) => nonEmpty(item, `viaStitch.forNets[${index}]`)))] }), ...optionalPositive(source, "maxDistanceMm") })
    } else throw new TypeError("viaStitch.mode must be grid, along, around, or return")
    return undefined
  }

  private busDetect(value: unknown): undefined {
    if (value === false) { this.busDetectIntent = undefined; return undefined }
    if (value === true || value === undefined) { this.busDetectIntent = true; return undefined }
    const source = object(value, "busDetect options")
    assertKnownKeys(source, ["detectionRadiusMm", "minNets", "attractionRadiusMm"], "busDetect")
    this.busDetectIntent = {
      ...optionalPositive(source, "detectionRadiusMm"),
      ...(source.minNets === undefined ? {} : { minNets: integer(source.minNets, "busDetect.minNets", 2) }),
      ...optionalPositive(source, "attractionRadiusMm"),
    }
    return undefined
  }

  private fanout(value: FanoutTarget, input: unknown): undefined {
    const source = object(input, "fanout options")
    assertKnownKeys(source, ["method", "extensionMm"], "fanout")
    const target = this.fanoutTarget(value, "fanout target")
    const method = source.method === undefined ? "auto" : nonEmpty(source.method, "fanout.method")
    if (!["auto", "stub", "underpad"].includes(method)) {
      throw new TypeError("fanout.method must be auto, stub, or underpad")
    }
    const key = this.fanoutTargetKey(target)
    this.fanouts.set(key, {
      target,
      method: method as FanoutIntent["method"],
      extensionMm: source.extensionMm === undefined ? 0.1 : nonNegative(source.extensionMm, "fanout.extensionMm"),
    })
    return undefined
  }

  private fanoutTarget(value: FanoutTarget, label: string): FanoutTarget {
    const target = object(value, label)
    if (target.kind === "component") {
      assertKnownKeys(target, ["kind", "component"], label)
      return { kind: "component", component: nonEmpty(target.component, `${label}.component`) }
    }
    if (target.kind === "pad") {
      assertKnownKeys(target, ["kind", "component", "pad"], label)
      return {
        kind: "pad",
        component: nonEmpty(target.component, `${label}.component`),
        pad: nonEmpty(target.pad, `${label}.pad`),
      }
    }
    throw new TypeError(`${label} must be component(...) or pad(...)`)
  }

  private fanoutTargetKey(target: FanoutTarget) {
    return target.kind === "component"
      ? `component\u0000${target.component}`
      : `pad\u0000${target.component}\u0000${target.pad}`
  }

  private disableFanout(targets: FanoutTarget[]): undefined {
    if (!targets.length) throw new TypeError("disableFanout(...) requires component(...) or pad(...)")
    for (const [index, value] of targets.entries()) {
      const target = this.fanoutTarget(value, `disableFanout[${index}]`)
      this.fanoutExclusions.set(this.fanoutTargetKey(target), target)
    }
    return undefined
  }

  private stack(input: unknown): undefined {
    if (this.stackIntent) throw new TypeError("stack(...) may be declared only once")
    const source = object(input, "stack")
    assertKnownKeys(source, [
      "boardThicknessMm", "fallbackCopperThicknessOz", "viaPlatingThicknessUm", "maxTrackWidthMm", "layers", "solderMask",
    ], "stack")
    const maxTrackWidthMm = source.maxTrackWidthMm === undefined ? undefined : positive(source.maxTrackWidthMm, "stack.maxTrackWidthMm")
    if (maxTrackWidthMm !== undefined && maxTrackWidthMm > 10) throw new RangeError("stack.maxTrackWidthMm must not exceed 10 mm")
    let layers: StackIntent["layers"]
    if (source.layers !== undefined) {
      if (!Array.isArray(source.layers) || !source.layers.length) throw new TypeError("stack.layers must be a non-empty array")
      layers = source.layers.map((value, index) => {
        const item = object(value, `stack.layers[${index}]`)
        if (item.kind === "copper") {
          assertKnownKeys(item, ["name", "kind", "thicknessOz", "thicknessMm"], `stack.layers[${index}]`)
          if (item.thicknessOz !== undefined && item.thicknessMm !== undefined) {
            throw new TypeError(`stack.layers[${index}] may specify thicknessOz or thicknessMm, not both`)
          }
          return {
            kind: "copper" as const, name: canonicalPhysicalLayer(item.name, `stack.layers[${index}].name`),
            ...optionalPositive(item, "thicknessOz"), ...optionalPositive(item, "thicknessMm"),
          }
        }
        if (item.kind !== "dielectric") throw new TypeError(`stack.layers[${index}].kind must be copper or dielectric`)
        assertKnownKeys(item, ["name", "kind", "thicknessMm", "relativePermittivity", "lossTangent", "material"], `stack.layers[${index}]`)
        return {
          kind: "dielectric" as const,
          ...(item.name === undefined ? {} : { name: nonEmpty(item.name, `stack.layers[${index}].name`) }),
          ...optionalPositive(item, "thicknessMm"), ...optionalPositive(item, "relativePermittivity"),
          ...optionalPositive(item, "lossTangent"),
          ...(item.material === undefined ? {} : { material: nonEmpty(item.material, `stack.layers[${index}].material`) }),
        }
      })
      const copperNames = layers.filter((layer) => layer.kind === "copper").map((layer) => layer.name)
      if (copperNames.length < 2) throw new TypeError("stack.layers requires at least TOP and BOTTOM copper layers")
      const expected = ["TOP", ...copperNames.slice(1, -1).map((_, index) => `INNER_${index + 1}`), "BOTTOM"]
      if (copperNames.some((name, index) => name !== expected[index])) {
        throw new TypeError("stack copper layers must be ordered TOP, INNER_1..INNER_n, BOTTOM")
      }
    }
    let solderMask: StackIntent["solderMask"]
    if (source.solderMask !== undefined) {
      const mask = object(source.solderMask, "stack.solderMask")
      assertKnownKeys(mask, ["top", "bottom"], "stack.solderMask")
      const side = (value: unknown, label: string) => {
        if (value === undefined) return undefined
        const item = object(value, label)
        assertKnownKeys(item, ["thicknessMm", "relativePermittivity"], label)
        return { ...optionalPositive(item, "thicknessMm"), ...optionalPositive(item, "relativePermittivity") }
      }
      const top = side(mask.top, "stack.solderMask.top")
      const bottom = side(mask.bottom, "stack.solderMask.bottom")
      solderMask = { ...(top ? { top } : {}), ...(bottom ? { bottom } : {}) }
    }
    this.stackIntent = {
      ...optionalPositive(source, "boardThicknessMm"), ...optionalPositive(source, "fallbackCopperThicknessOz"),
      ...optionalPositive(source, "viaPlatingThicknessUm"),
      ...(maxTrackWidthMm === undefined ? {} : { maxTrackWidthMm }), ...(layers ? { layers } : {}),
      ...(solderMask ? { solderMask } : {}),
    }
    return undefined
  }

  private quality(input: unknown): undefined {
    if (this.qualityIntent) throw new TypeError("quality(...) may be declared only once")
    const source = object(input, "quality")
    assertKnownKeys(source, ["profile", "maxCandidates"], "quality")
    const profile = source.profile === undefined ? "balanced" : nonEmpty(source.profile, "quality.profile")
    if (!["fast", "balanced", "quality-first", "completion-first"].includes(profile)) throw new TypeError("unknown quality profile")
    this.qualityIntent = {
      profile: profile as RoutingPolicy["profile"],
      maxCandidates: source.maxCandidates === undefined ? 1 : integer(source.maxCandidates, "quality.maxCandidates", 1, 16),
    }
    return undefined
  }

  private onlyNets(nets: string[]): undefined {
    if (this.onlyNetNames) throw new TypeError("onlyNets(...) may be declared only once")
    if (!nets.length) throw new TypeError("onlyNets(...) requires at least one net")
    this.onlyNetNames = [...new Set(nets.map((item, index) => nonEmpty(item, `onlyNets[${index}]`)))]
    return undefined
  }

  private ignoreNets(nets: string[]): undefined {
    if (!nets.length) throw new TypeError("ignoreNets(...) requires at least one net")
    nets.forEach((item, index) => this.ignoredNetNames.add(nonEmpty(item, `ignoreNets[${index}]`)))
    return undefined
  }

  private clearRouting(input: unknown): undefined {
    if (this.clearIntent) throw new TypeError("clearRouting(...) may be declared only once")
    const source = object(input, "clearRouting")
    assertKnownKeys(source, ["nets", "only", "items"], "clearRouting")
    const rawNets = source.nets ?? source.only ?? "all"
    const nets = rawNets === "all" ? "all" as const : (() => {
      if (!Array.isArray(rawNets) || !rawNets.length) throw new TypeError('clearRouting.nets must be "all" or a non-empty net array')
      return [...new Set(rawNets.map((item, index) => nonEmpty(item, `clearRouting.nets[${index}]`)))]
    })()
    const rawItems = source.items ?? ["tracks", "vias"]
    if (!Array.isArray(rawItems) || !rawItems.length) throw new TypeError("clearRouting.items must be a non-empty array")
    const items = [...new Set(rawItems.map((item) => nonEmpty(item, "clearRouting item")))]
    if (items.some((item) => !["tracks", "vias", "zones"].includes(item))) throw new TypeError("clearRouting.items supports tracks, vias, and zones")
    this.clearIntent = { nets, items: items as ClearRoutingIntent["items"] }
    return undefined
  }
}

/** Evaluate the local statement DSL and return its serializable program. */
export function compileRoutingDsl(code: string): RoutingProgram {
  const builder = new RoutingDslBuilder()
  const sandbox = createContext(builder.sandbox(), { codeGeneration: { strings: false, wasm: false } })
  new Script(`"use strict";\n${code}`, { filename: "routing.dsl.js" })
    .runInContext(sandbox, { timeout: 1_000, displayErrors: true })
  return builder.program()
}
