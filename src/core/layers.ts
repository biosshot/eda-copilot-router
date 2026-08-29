import type {
  RoutedTrack,
  RoutedVia,
  RoutedZone,
  RoutingBoard,
  RoutingCopper,
  RoutingLayer,
  RoutingRuleValues,
  RoutingRules,
  RoutingStackup,
} from "./contracts.js"

/**
 * Human-facing layer selectors and engine-native layer names are deliberately
 * different namespaces.  The generic core owns only these canonical physical
 * identifiers; adapters translate them at their boundary.
 */
export type CanonicalLayerId = "TOP" | "BOTTOM" | `INNER_${number}`

export type ResolvedLayer = Readonly<{
  id: CanonicalLayerId
  originalName: string
  index: number
  side: RoutingLayer["side"]
  kiCadName: string
}>

export type LayerCatalog = Readonly<{
  layers: readonly ResolvedLayer[]
  canonicalName(name: string): string
  kiCadName(name: string): string
}>

function canonicalFor(layer: RoutingLayer, innerIndex: number): CanonicalLayerId {
  if (layer.side === "top") return "TOP"
  if (layer.side === "bottom") return "BOTTOM"
  return `INNER_${innerIndex}`
}

function kicadFor(id: CanonicalLayerId) {
  if (id === "TOP") return "F.Cu"
  if (id === "BOTTOM") return "B.Cu"
  const inner = /^INNER_(\d+)$/.exec(id)
  return inner ? `In${inner[1]}.Cu` : id
}

/** Resolve a board's adapter-owned layer names once, by physical order. */
export function createLayerCatalog(layers: readonly RoutingLayer[]): LayerCatalog {
  const innerOrder = new Map(
    layers.filter((layer) => layer.side === "inner")
      .sort((left, right) => left.index - right.index)
      .map((layer, index) => [layer, index + 1] as const),
  )
  const resolved = layers.map((layer): ResolvedLayer => {
    const id = canonicalFor(layer, innerOrder.get(layer) ?? 1)
    return { id, originalName: layer.name, index: layer.index, side: layer.side, kiCadName: kicadFor(id) }
  })
  const byName = new Map<string, ResolvedLayer>()
  for (const layer of resolved) {
    byName.set(layer.originalName, layer)
    byName.set(layer.id, layer)
    byName.set(layer.kiCadName, layer)
  }
  return Object.freeze({
    layers: Object.freeze(resolved),
    canonicalName(name: string) { return byName.get(name)?.id ?? name },
    kiCadName(name: string) { return byName.get(name)?.kiCadName ?? name },
  })
}

function canonicalRule(values: RoutingRuleValues, catalog: LayerCatalog): RoutingRuleValues {
  return {
    ...values,
    ...(values.allowedLayers
      ? { allowedLayers: values.allowedLayers.map((layer) => catalog.canonicalName(layer)) }
      : {}),
    ...(values.impedanceReferenceLayers
      ? { impedanceReferenceLayers: values.impedanceReferenceLayers.map((layer) => catalog.canonicalName(layer)) }
      : {}),
  }
}

function canonicalRules(rules: RoutingRules, catalog: LayerCatalog): RoutingRules {
  return {
    ...rules,
    default: canonicalRule(rules.default, catalog),
    nets: rules.nets.map((entry) => ({ ...entry, values: canonicalRule(entry.values, catalog) })),
    ...(rules.netClasses
      ? { netClasses: rules.netClasses.map((entry) => ({ ...entry, values: canonicalRule(entry.values, catalog) })) }
      : {}),
  }
}

function canonicalTrack(track: RoutedTrack, catalog: LayerCatalog): RoutedTrack {
  return { ...track, layer: catalog.canonicalName(track.layer) }
}

function canonicalVia(via: RoutedVia, catalog: LayerCatalog): RoutedVia {
  return {
    ...via,
    fromLayer: catalog.canonicalName(via.fromLayer),
    toLayer: catalog.canonicalName(via.toLayer),
  }
}

function canonicalZone(zone: RoutedZone, catalog: LayerCatalog): RoutedZone {
  return { ...zone, layers: zone.layers.map((layer) => catalog.canonicalName(layer)) }
}

export function canonicalizeCopper(copper: RoutingCopper, catalog: LayerCatalog): RoutingCopper {
  return {
    tracks: copper.tracks.map((track) => canonicalTrack(track, catalog)),
    vias: copper.vias.map((via) => canonicalVia(via, catalog)),
    zones: copper.zones.map((zone) => canonicalZone(zone, catalog)),
  }
}

function canonicalStackup(stackup: RoutingStackup | undefined, catalog: LayerCatalog) {
  if (!stackup) return undefined
  return {
    ...stackup,
    layers: stackup.layers.map((layer) => layer.kind === "copper"
      ? { ...layer, layer: catalog.canonicalName(layer.layer) }
      : layer),
  } satisfies RoutingStackup
}

/**
 * Convert an imported board into the only layer namespace accepted inside the
 * router core.  This is intentionally a one-way operation: results stay
 * canonical until an EDA adapter translates them for application.
 */
export function canonicalizeRoutingBoard(board: RoutingBoard) {
  const catalog = createLayerCatalog(board.layers)
  const stackup = canonicalStackup(board.stackup, catalog)
  const canonical: RoutingBoard = {
    ...board,
    layers: board.layers.map((layer) => ({ ...layer, name: catalog.canonicalName(layer.name) })),
    pads: board.pads.map((pad) => ({
      ...pad,
      layers: pad.layers.map((layer) => catalog.canonicalName(layer)),
    })),
    keepouts: board.keepouts.map((keepout) => ({
      ...keepout,
      layers: keepout.layers.map((layer) => catalog.canonicalName(layer)),
    })),
    ...(stackup ? { stackup } : {}),
    rules: canonicalRules(board.rules, catalog),
    copper: {
      fixed: canonicalizeCopper(board.copper.fixed, catalog),
      editable: canonicalizeCopper(board.copper.editable, catalog),
    },
  }
  return { board: canonical, catalog }
}

/** Translate canonical core copper to KiCad's required physical layer names. */
export function copperToKiCadLayers(copper: RoutingCopper, catalog: LayerCatalog): RoutingCopper {
  return {
    tracks: copper.tracks.map((track) => ({ ...track, layer: catalog.kiCadName(track.layer) })),
    vias: copper.vias.map((via) => ({
      ...via,
      fromLayer: catalog.kiCadName(via.fromLayer),
      toLayer: catalog.kiCadName(via.toLayer),
    })),
    zones: copper.zones.map((zone) => ({
      ...zone,
      layers: zone.layers.map((layer) => catalog.kiCadName(layer)),
    })),
  }
}
