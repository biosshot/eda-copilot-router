import { Script, createContext } from "node:vm"

export type PolygonLayerSelector =
  | { kind: "outer" }
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "named"; names: string[] }

export type PolygonPadTarget = {
  kind: "pad"
  component: string
  pad: string
}

export type PolygonNetTarget = {
  kind: "net"
  net: string
}

export type PolygonTarget = PolygonPadTarget | PolygonNetTarget
export type PolygonMode = "compact"

export type PlaneRegionSelector =
  | { kind: "board" }
  | { kind: "components"; designators: string[] }

export type PlaneStitchingIntent = {
  gridMm: number
  maxPadViaDistanceMm: number
  via: "drc-min"
  viaInPad: boolean
  maxVias: number
}

export type PlaneIntent = {
  kind: "plane"
  net: string
  layers: PolygonLayerSelector
  region: PlaneRegionSelector
  paddingMm: number
  priority: number
  stitching: false | PlaneStitchingIntent
}

export type PolygonIntent = {
  kind: "polygon"
  net: string
  targets: PolygonTarget[]
  layers: PolygonLayerSelector
  mode: PolygonMode
  priority: number
  /** Maximum target-to-target copper-free span, normalized by the narrower pad width. */
  maxPadFreeGapWidths: number
}

export type PolygonProgram = {
  polygons: PolygonIntent[]
  planes: PlaneIntent[]
}

const nonEmpty = (value: unknown, label: string) => {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim().length === 0) {
    throw new Error(`${label} must be a non-empty string or number`)
  }
  return String(value).trim()
}

function isTarget(value: unknown): value is PolygonTarget {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<PolygonTarget>
  return candidate.kind === "pad"
    ? typeof candidate.component === "string" && typeof candidate.pad === "string"
    : candidate.kind === "net" && typeof candidate.net === "string"
}

class PolygonRuleBuilder {
  constructor(private readonly intent: PolygonIntent) {}

  connect(...targets: PolygonTarget[]) {
    if (!targets.length || !targets.every(isTarget)) {
      throw new Error("polygon.connect(...) requires pad(...) or net(...) targets")
    }
    this.intent.targets.push(...targets.map((target) => structuredClone(target)))
    return this
  }

  on(selector: PolygonLayerSelector) {
    if (!selector || !["outer", "top", "bottom", "named"].includes(selector.kind)) {
      throw new Error("polygon.on(...) requires a layer selector")
    }
    this.intent.layers = structuredClone(selector)
    return this
  }

  compact() {
    this.intent.mode = "compact"
    return this
  }

  priority(value: number) {
    if (!Number.isInteger(value) || value < 0) throw new Error("polygon.priority must be an integer >= 0")
    this.intent.priority = value
    return this
  }

  maxPadFreeGap(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("polygon.maxPadFreeGap must be a finite number > 0")
    }
    this.intent.maxPadFreeGapWidths = value
    return this
  }
}

class PolygonDslBuilder {
  private readonly polygons: PolygonIntent[] = []
  private readonly planes: PlaneIntent[] = []

  createSandbox() {
    return {
      polygon: (net: string) => this.addPolygon(net),
      plane: (options: unknown) => this.addPlane(options),
      pad: (component: string, padNumber: string | number): PolygonPadTarget => ({
        kind: "pad",
        component: nonEmpty(component, "pad component"),
        pad: nonEmpty(padNumber, "pad number"),
      }),
      net: (name: string): PolygonNetTarget => ({ kind: "net", net: nonEmpty(name, "target net") }),
      outerLayers: (): PolygonLayerSelector => ({ kind: "outer" }),
      topLayer: (): PolygonLayerSelector => ({ kind: "top" }),
      bottomLayer: (): PolygonLayerSelector => ({ kind: "bottom" }),
      layers: (...names: string[]): PolygonLayerSelector => ({
        kind: "named",
        names: names.map((name, index) => {
          const normalized = nonEmpty(name, `layers[${index}]`)
          if (!/^(TOP|BOTTOM|INNER_[1-9][0-9]?)$/.test(normalized)) {
            throw new Error(`layers[${index}] must use a universal RawPcb copper layer name`)
          }
          return normalized
        }),
      }),
      board: (): PlaneRegionSelector => ({ kind: "board" }),
      components: (...designators: string[]): PlaneRegionSelector => ({
        kind: "components",
        designators: designators.map((designator, index) => nonEmpty(designator, `components[${index}]`)),
      }),
    }
  }

  toProgram(): PolygonProgram {
    if (this.polygons.length === 0 && this.planes.length === 0) {
      throw new Error("polygon DSL produced no polygon or plane rules")
    }
    for (const [index, intent] of this.polygons.entries()) {
      if (!intent.targets.length) throw new Error(`polygon rule ${index + 1} (${intent.net}) has no connect(...) targets`)
      for (const target of intent.targets) {
        if (target.kind === "net" && target.net !== intent.net) {
          throw new Error(`polygon ${intent.net} cannot connect net(${target.net})`)
        }
      }
    }
    return {
      polygons: this.polygons
        .map((intent) => structuredClone(intent))
        .sort((a, b) => b.priority - a.priority),
      planes: this.planes
        .map((intent) => structuredClone(intent))
        .sort((a, b) => b.priority - a.priority),
    }
  }

  private addPlane(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("plane(...) requires an options object")
    }
    const options = value as Record<string, unknown>
    const layers = options.layers ?? { kind: "outer" }
    if (!layers || typeof layers !== "object"
      || !["outer", "top", "bottom", "named"].includes(String((layers as { kind?: unknown }).kind))) {
      throw new Error("plane.layers requires a layer selector")
    }
    const region = options.region ?? { kind: "board" }
    if (!region || typeof region !== "object"
      || !["board", "components"].includes(String((region as { kind?: unknown }).kind))) {
      throw new Error("plane.region requires board() or components(...)")
    }
    const normalizedRegion = structuredClone(region) as PlaneRegionSelector
    if (normalizedRegion.kind === "components" && !normalizedRegion.designators?.length) {
      throw new Error("components(...) requires at least one designator")
    }
    const finiteNonNegative = (input: unknown, fallback: number, label: string) => {
      const number = input === undefined ? fallback : Number(input)
      if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a finite number >= 0`)
      return number
    }
    const positive = (input: unknown, fallback: number, label: string) => {
      const number = input === undefined ? fallback : Number(input)
      if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a finite number > 0`)
      return number
    }
    const integer = (input: unknown, fallback: number, label: string) => {
      const number = input === undefined ? fallback : Number(input)
      if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be an integer >= 0`)
      return number
    }
    let stitching: PlaneIntent["stitching"] = false
    if (options.stitching !== false && options.stitching !== null) {
      const source = options.stitching === true || options.stitching === undefined
        ? {}
        : options.stitching
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new Error("plane.stitching must be true, false, or an options object")
      }
      const item = source as Record<string, unknown>
      if (item.via !== undefined && item.via !== "drc-min") {
        throw new Error('plane.stitching.via currently supports only "drc-min"')
      }
      stitching = {
        gridMm: positive(item.gridMm, 5, "plane.stitching.gridMm"),
        maxPadViaDistanceMm: positive(
          item.maxPadViaDistanceMm,
          10,
          "plane.stitching.maxPadViaDistanceMm",
        ),
        via: "drc-min",
        viaInPad: item.viaInPad === undefined ? true : Boolean(item.viaInPad),
        maxVias: integer(item.maxVias, 500, "plane.stitching.maxVias"),
      }
    }
    const paddingMm = finiteNonNegative(options.paddingMm, 0, "plane.paddingMm")
    if (normalizedRegion.kind === "board" && paddingMm > 0) {
      throw new Error("plane.paddingMm is reserved for components(...) regions")
    }
    const priority = integer(options.priority, 0, "plane.priority")
    this.planes.push({
      kind: "plane",
      net: nonEmpty(options.net, "plane net"),
      layers: structuredClone(layers) as PolygonLayerSelector,
      region: normalizedRegion,
      paddingMm,
      priority,
      stitching,
    })
  }

  private addPolygon(netValue: string) {
    const intent: PolygonIntent = {
      kind: "polygon",
      net: nonEmpty(netValue, "polygon net"),
      targets: [],
      layers: { kind: "top" },
      mode: "compact",
      priority: 0,
      maxPadFreeGapWidths: 4.5,
    }
    this.polygons.push(intent)
    return new PolygonRuleBuilder(intent)
  }
}

export function runPolygonDsl(code: string): PolygonProgram {
  const builder = new PolygonDslBuilder()
  const sandbox = createContext(builder.createSandbox(), {
    codeGeneration: { strings: false, wasm: false },
  })
  new Script(`"use strict";\n${code}`, { filename: "pcb-polygon-dsl.js" })
    .runInContext(sandbox, { timeout: 500, displayErrors: true })
  return builder.toProgram()
}
