import type { RoutingBoard, RoutingLayer, RoutingRuleValues, RoutingStackup } from "./contracts.js"
import type { StackIntent } from "../intent/types.js"

const COPPER_MM_PER_OZ = 0.03479

export type RoutingStackPlane = Readonly<{
  layer: string
  nets: readonly string[]
}>

/** Resolve stack-declared plane layers into the materialized board namespace. */
export function routingStackPlanes(
  board: Pick<RoutingBoard, "layers">,
  stack: StackIntent | undefined,
): readonly RoutingStackPlane[] {
  const copper = stack?.layers?.filter((layer) => layer.kind === "copper") ?? []
  return copper.flatMap((layer, index) => layer.plane
    ? [{ layer: board.layers[index]?.name ?? layer.name, nets: [...layer.plane.nets] }]
    : [])
}

function physicalLayerName(board: RoutingBoard, canonical: string) {
  if (canonical === "TOP") return board.layers.find((layer) => layer.side === "top")?.name ?? canonical
  if (canonical === "BOTTOM") return board.layers.find((layer) => layer.side === "bottom")?.name ?? canonical
  const match = /^INNER_(\d+)$/.exec(canonical)
  if (!match) return canonical
  const position = Number(match[1]) - 1
  const existing = board.layers.filter((layer) => layer.side === "inner")
    .sort((left, right) => left.index - right.index)[position]?.name
  if (existing) return existing
  const kiCadNames = board.layers.some((layer) => layer.name === "F.Cu")
    && board.layers.some((layer) => layer.name === "B.Cu")
  return kiCadNames ? `In${position + 1}.Cu` : canonical
}

function expandsAllLayers(source: readonly string[] | undefined, board: RoutingBoard) {
  if (!source || source.length !== board.layers.length) return false
  const names = new Set(source)
  return board.layers.every((layer) => names.has(layer.name))
}

function expandRuleLayers(values: RoutingRuleValues, board: RoutingBoard, layers: readonly RoutingLayer[]): RoutingRuleValues {
  return expandsAllLayers(values.allowedLayers, board)
    ? { ...values, allowedLayers: layers.map((layer) => layer.name) }
    : values
}

function effectiveStackup(board: RoutingBoard, stack: StackIntent, layers: readonly RoutingLayer[]): RoutingStackup {
  const fallbackCopperThicknessOz = stack.fallbackCopperThicknessOz
    ?? board.stackup?.fallbackCopperThicknessOz ?? 1
  const sourceLayers = stack.layers ?? board.stackup?.layers ?? layers.map((layer) => ({
    kind: "copper" as const,
    layer: layer.name,
    thicknessMm: fallbackCopperThicknessOz * COPPER_MM_PER_OZ,
  }))
  let copperIndex = 0
  return {
    ...(stack.boardThicknessMm === undefined
      ? board.stackup?.boardThicknessMm === undefined ? {} : { boardThicknessMm: board.stackup.boardThicknessMm }
      : { boardThicknessMm: stack.boardThicknessMm }),
    fallbackCopperThicknessOz,
    ...(stack.viaPlatingThicknessUm === undefined
      ? board.stackup?.viaPlatingThicknessUm === undefined ? {} : { viaPlatingThicknessUm: board.stackup.viaPlatingThicknessUm }
      : { viaPlatingThicknessUm: stack.viaPlatingThicknessUm }),
    layers: sourceLayers.map((layer, layerIndex) => {
      const inherited = board.stackup?.layers[layerIndex]
      if (layer.kind === "copper") {
        const sourceName = "layer" in layer ? layer.layer : layer.name
        const physical = stack.layers ? layers[copperIndex++]?.name ?? sourceName : sourceName
        return {
          kind: "copper" as const,
          layer: physical,
          thicknessMm: "thicknessOz" in layer && layer.thicknessOz !== undefined
            ? layer.thicknessOz * COPPER_MM_PER_OZ
            : layer.thicknessMm ?? (inherited?.kind === "copper" ? inherited.thicknessMm : undefined)
              ?? fallbackCopperThicknessOz * COPPER_MM_PER_OZ,
        }
      }
      const inheritedDielectric = inherited?.kind === "dielectric" ? inherited : undefined
      const name = ("name" in layer ? layer.name : undefined) ?? inheritedDielectric?.name
      const relativePermittivity = layer.relativePermittivity ?? inheritedDielectric?.relativePermittivity
      const lossTangent = ("lossTangent" in layer ? layer.lossTangent : undefined) ?? inheritedDielectric?.lossTangent
      const material = layer.material ?? inheritedDielectric?.material
      return {
        kind: "dielectric" as const,
        ...(name === undefined ? {} : { name }),
        thicknessMm: layer.thicknessMm ?? inheritedDielectric?.thicknessMm ?? Number.NaN,
        ...(relativePermittivity === undefined ? {} : { relativePermittivity }),
        ...(lossTangent === undefined ? {} : { lossTangent }),
        ...(material === undefined ? {} : { material }),
      }
    }),
    ...(stack.solderMask === undefined
      ? board.stackup?.solderMask === undefined ? {} : { solderMask: board.stackup.solderMask }
      : { solderMask: stack.solderMask }),
  }
}

/** Build the physical board seen by planners and backends from stack(...). */
export function materializeRoutingStackup(board: RoutingBoard, stack: StackIntent | undefined): RoutingBoard {
  if (!stack) return board
  const copper = stack.layers?.filter((layer) => layer.kind === "copper")
  const layers: readonly RoutingLayer[] = copper?.length
    ? copper.map((layer, index) => ({
        name: physicalLayerName(board, layer.name),
        index,
        side: index === 0 ? "top" as const : index === copper.length - 1 ? "bottom" as const : "inner" as const,
      }))
    : board.layers
  const layerNames = layers.map((layer) => layer.name)
  return {
    ...board,
    layers,
    pads: board.pads.map((pad) => expandsAllLayers(pad.layers, board) ? { ...pad, layers: layerNames } : pad),
    keepouts: board.keepouts.map((keepout) => expandsAllLayers(keepout.layers, board)
      ? { ...keepout, layers: layerNames }
      : keepout),
    rules: {
      ...board.rules,
      default: expandRuleLayers(board.rules.default, board, layers),
      nets: board.rules.nets.map((entry) => ({
        ...entry,
        values: expandRuleLayers(entry.values, board, layers),
      })),
    },
    stackup: effectiveStackup(board, stack, layers),
  }
}
