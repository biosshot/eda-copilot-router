import { Script, createContext } from "node:vm"
import type {
  CopperTarget,
  DifferentialPairIntent,
  LayerSelector,
  ManufacturingIntent,
  MatchedGroupIntent,
  PadTarget,
  PlaneIntent,
  PlaneStitchingIntent,
  PolygonIntent,
  PowerNetIntent,
  RegionSelector,
  RoutingProgram,
  SignalNetIntent,
} from "./types.js"

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

function integer(value: unknown, label: string, minimum = 0) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum) {
    throw new RangeError(`${label} must be an integer >= ${minimum}`)
  }
  return number
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalPositive(source: Record<string, unknown>, key: string) {
  return source[key] === undefined ? {} : { [key]: positive(source[key], key) }
}

function cloneLayer(value: unknown, label: string): LayerSelector {
  const selector = object(value, label)
  if (selector.kind === "outer" || selector.kind === "top" || selector.kind === "bottom") {
    return { kind: selector.kind }
  }
  if (selector.kind === "named" && Array.isArray(selector.names) && selector.names.length) {
    return { kind: "named", names: selector.names.map((item, index) => nonEmpty(item, `${label}.names[${index}]`)) }
  }
  throw new TypeError(`${label} must be topLayer(), bottomLayer(), outerLayers(), or layers(...)`)
}

function optionalLayer(source: Record<string, unknown>, key: string) {
  return source[key] === undefined ? {} : { [key]: cloneLayer(source[key], key) }
}

function optionalVia(source: Record<string, unknown>) {
  if (source.via === undefined) return {}
  const via = object(source.via, "via")
  return {
    via: {
      ...optionalPositive(via, "diameterMm"),
      ...optionalPositive(via, "drillMm"),
    },
  }
}

function optionalImpedance(source: Record<string, unknown>) {
  if (source.impedanceOhm === undefined && source.impedance === undefined) return {}
  const raw = source.impedance === undefined
    ? { targetOhm: source.impedanceOhm, tolerancePercent: source.impedanceTolerancePercent }
    : object(source.impedance, "impedance")
  return {
    impedance: {
      targetOhm: positive(raw.targetOhm, "impedance.targetOhm"),
      ...optionalPositive(raw, "tolerancePercent"),
    },
  }
}

function assertKnownKeys(source: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new TypeError(`${label} has unknown field(s): ${unknown.join(", ")}`)
}

type MutablePolygonIntent = {
  -readonly [Key in keyof PolygonIntent]: PolygonIntent[Key]
}

class PolygonBuilder {
  constructor(private readonly value: MutablePolygonIntent) {}

  connect(...targets: CopperTarget[]) {
    if (!targets.length) throw new TypeError("polygon.connect(...) requires at least one target")
    this.value.targets = [...this.value.targets, ...targets.map((target) => structuredClone(target))]
    return this
  }

  on(layers: LayerSelector) {
    this.value.layers = cloneLayer(layers, "polygon layers")
    return this
  }

  compact() {
    this.value.mode = "compact"
    return this
  }

  priority(value: number) {
    this.value.priority = integer(value, "polygon priority")
    return this
  }

  maxPadFreeGap(value: number) {
    this.value.maxPadFreeGapWidths = positive(value, "maxPadFreeGap")
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
  private manufacturingIntent: ManufacturingIntent | undefined
  private operation: RoutingProgram["operation"] | undefined

  sandbox() {
    return {
      polygon: (net: string) => this.polygon(net),
      plane: (options: unknown) => this.plane(options),
      powerNet: (net: string, options: unknown = {}) => this.powerNet(net, options),
      signalNet: (net: string, options: unknown = {}) => this.signalNet(net, options),
      diffPair: (id: string, options: unknown) => this.diffPair(id, options),
      matchedGroup: (id: string, options: unknown) => this.matchedGroup(id, options),
      fabrication: (options: unknown) => this.fabrication(options),
      pad: (component: string, number: string | number): PadTarget => ({
        kind: "pad", component: nonEmpty(component, "pad component"), pad: nonEmpty(number, "pad number"),
      }),
      net: (name: string) => ({ kind: "net" as const, net: nonEmpty(name, "net") }),
      board: (): RegionSelector => ({ kind: "board" }),
      components: (...designators: string[]): RegionSelector => ({
        kind: "components",
        designators: designators.map((item, index) => nonEmpty(item, `components[${index}]`)),
      }),
      outerLayers: (): LayerSelector => ({ kind: "outer" }),
      topLayer: (): LayerSelector => ({ kind: "top" }),
      bottomLayer: (): LayerSelector => ({ kind: "bottom" }),
      layers: (...names: string[]): LayerSelector => ({
        kind: "named",
        names: names.map((item, index) => nonEmpty(item, `layers[${index}]`)),
      }),
      applyDrcRules: () => this.terminal("apply-drc"),
      runRouting: () => this.terminal("route"),
      runAll: () => this.terminal("all"),
    }
  }

  program(): RoutingProgram {
    if (!this.operation) throw new TypeError("routing DSL requires exactly one terminal command")
    for (const [index, polygon] of this.polygons.entries()) {
      if (!polygon.targets.length) throw new TypeError(`polygon ${index + 1} (${polygon.net}) has no targets`)
      for (const target of polygon.targets) {
        if (target.kind === "net" && target.net !== polygon.net) {
          throw new TypeError(`polygon ${polygon.net} cannot connect net(${target.net})`)
        }
      }
    }
    return structuredClone({
      polygons: [...this.polygons].sort((a, b) => b.priority - a.priority),
      planes: [...this.planes].sort((a, b) => b.priority - a.priority),
      signalNets: this.signalNets,
      powerNets: this.powerNets,
      differentialPairs: this.differentialPairs,
      matchedGroups: this.matchedGroups,
      ...(this.manufacturingIntent ? { manufacturing: this.manufacturingIntent } : {}),
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
      mode: "compact", priority: 0, maxPadFreeGapWidths: 4.5,
    }
    this.polygons.push(value)
    return new PolygonBuilder(value)
  }

  private plane(input: unknown): undefined {
    const source = object(input, "plane")
    assertKnownKeys(source, ["net", "layers", "region", "paddingMm", "priority", "stitching"], "plane")
    const region = source.region === undefined ? { kind: "board" as const } : structuredClone(source.region) as RegionSelector
    if (region.kind !== "board" && (region.kind !== "components" || !region.designators?.length)) {
      throw new TypeError("plane.region must be board() or non-empty components(...)")
    }
    let stitching: PlaneStitchingIntent = false
    if (source.stitching !== undefined && source.stitching !== false) {
      const value = source.stitching === true ? {} : object(source.stitching, "plane.stitching")
      const via = value.via === undefined || value.via === "drc-min"
        ? "drc-min" as const
        : {
            diameterMm: positive(object(value.via, "plane.stitching.via").diameterMm, "diameterMm"),
            drillMm: positive(object(value.via, "plane.stitching.via").drillMm, "drillMm"),
          }
      stitching = {
        gridMm: value.gridMm === undefined ? 5 : positive(value.gridMm, "gridMm"),
        maxPadViaDistanceMm: value.maxPadViaDistanceMm === undefined
          ? 10 : positive(value.maxPadViaDistanceMm, "maxPadViaDistanceMm"),
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
      region, paddingMm,
      priority: source.priority === undefined ? 0 : integer(source.priority, "plane.priority"),
      stitching,
    })
    return undefined
  }

  private powerNet(net: string, input: unknown): undefined {
    const source = object(input, "powerNet options")
    assertKnownKeys(source, ["maxCurrentA", "maxTempRiseC", "minTrackWidthMm", "maxTrackWidthMm", "clearanceMm", "allowedLayers", "via"], "powerNet")
    if (source.maxCurrentA === undefined && source.minTrackWidthMm === undefined) {
      throw new TypeError("powerNet requires maxCurrentA or minTrackWidthMm")
    }
    const maxTrackWidthMm = source.maxTrackWidthMm === undefined ? undefined : positive(source.maxTrackWidthMm, "maxTrackWidthMm")
    if (maxTrackWidthMm !== undefined && maxTrackWidthMm > 10) throw new RangeError("maxTrackWidthMm must not exceed 10 mm")
    this.powerNets.push({
      kind: "power-net", net: nonEmpty(net, "power net"),
      ...optionalPositive(source, "maxCurrentA"), ...optionalPositive(source, "maxTempRiseC"),
      ...optionalPositive(source, "minTrackWidthMm"),
      ...(maxTrackWidthMm === undefined ? {} : { maxTrackWidthMm }),
      ...optionalPositive(source, "clearanceMm"),
      ...optionalLayer(source, "allowedLayers"), ...optionalVia(source),
    })
    return undefined
  }

  private signalNet(net: string, input: unknown): undefined {
    const source = object(input, "signalNet options")
    assertKnownKeys(source, ["trackWidthMm", "minTrackWidthMm", "clearanceMm", "maxLengthMm", "allowedLayers", "via", "impedance", "impedanceOhm", "impedanceTolerancePercent"], "signalNet")
    this.signalNets.push({
      kind: "signal-net", net: nonEmpty(net, "signal net"),
      ...optionalPositive(source, "trackWidthMm"), ...optionalPositive(source, "minTrackWidthMm"),
      ...optionalPositive(source, "clearanceMm"), ...optionalPositive(source, "maxLengthMm"),
      ...optionalLayer(source, "allowedLayers"), ...optionalVia(source), ...optionalImpedance(source),
    })
    return undefined
  }

  private diffPair(id: string, input: unknown): undefined {
    const source = object(input, "diffPair options")
    assertKnownKeys(source, ["positive", "negative", "trackWidthMm", "gapMm", "maxSkewMm", "maxUncoupledLengthMm", "clearanceMm", "allowedLayers", "via", "impedance", "impedanceOhm", "impedanceTolerancePercent"], "diffPair")
    this.differentialPairs.push({
      kind: "differential-pair", id: nonEmpty(id, "diff pair id"),
      positive: nonEmpty(source.positive, "diffPair.positive"),
      negative: nonEmpty(source.negative, "diffPair.negative"),
      ...optionalPositive(source, "trackWidthMm"), ...optionalPositive(source, "gapMm"),
      ...optionalPositive(source, "maxSkewMm"), ...optionalPositive(source, "maxUncoupledLengthMm"),
      ...optionalPositive(source, "clearanceMm"), ...optionalLayer(source, "allowedLayers"),
      ...optionalVia(source), ...optionalImpedance(source),
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

  private fabrication(input: unknown): undefined {
    if (this.manufacturingIntent) throw new TypeError("fabrication(...) may be declared only once")
    const source = object(input, "fabrication")
    assertKnownKeys(source, ["fallbackCopperThicknessOz", "viaPlatingThicknessUm", "maxTrackWidthMm"], "fabrication")
    const maxTrackWidthMm = source.maxTrackWidthMm === undefined ? undefined : positive(source.maxTrackWidthMm, "maxTrackWidthMm")
    if (maxTrackWidthMm !== undefined && maxTrackWidthMm > 10) throw new RangeError("maxTrackWidthMm must not exceed 10 mm")
    this.manufacturingIntent = {
      ...optionalPositive(source, "fallbackCopperThicknessOz"),
      ...optionalPositive(source, "viaPlatingThicknessUm"),
      ...(maxTrackWidthMm === undefined ? {} : { maxTrackWidthMm }),
    }
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
