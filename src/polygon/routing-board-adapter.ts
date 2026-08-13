import type {
  PointMm,
  RoutingBoard,
  RoutingPad,
  RoutingPadShape,
} from "../core/contracts.js"
import type {
  PcbPoint,
  PolygonScene,
  PolygonScenePad,
} from "./scene.js"

function rotate(point: PointMm, degrees: number): PcbPoint {
  const radians = degrees * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  return {
    x: point.x * cosine - point.y * sine,
    y: point.x * sine + point.y * cosine,
  }
}

function place(points: readonly PointMm[], pad: RoutingPad) {
  return points.map((point) => {
    const local = rotate(point, pad.rotationDeg)
    return { x: pad.at.x + local.x, y: pad.at.y + local.y }
  })
}

function ellipse(width: number, height: number, count = 24): PointMm[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = Math.PI * 2 * index / count
    return { x: Math.cos(angle) * width / 2, y: Math.sin(angle) * height / 2 }
  })
}

function roundedRect(width: number, height: number, radius: number): PointMm[] {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  if (r <= 1e-9) return [
    { x: -width / 2, y: -height / 2 },
    { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 },
    { x: -width / 2, y: height / 2 },
  ]
  const result: PointMm[] = []
  for (const corner of [
    { x: width / 2 - r, y: -height / 2 + r, start: -90 },
    { x: width / 2 - r, y: height / 2 - r, start: 0 },
    { x: -width / 2 + r, y: height / 2 - r, start: 90 },
    { x: -width / 2 + r, y: -height / 2 + r, start: 180 },
  ]) {
    for (let index = 0; index <= 3; index += 1) {
      const angle = (corner.start + index * 30) * Math.PI / 180
      result.push({ x: corner.x + Math.cos(angle) * r, y: corner.y + Math.sin(angle) * r })
    }
  }
  return result
}

function shapeRings(shape: RoutingPadShape, pad: RoutingPad): PcbPoint[][] {
  switch (shape.kind) {
    case "circle": return [place(ellipse(shape.diameterMm, shape.diameterMm), pad)]
    case "rect": return [place(roundedRect(shape.widthMm, shape.heightMm, 0), pad)]
    case "round-rect": return [place(roundedRect(
      shape.widthMm, shape.heightMm, shape.cornerRadiusMm,
    ), pad)]
    case "oval": return [place(roundedRect(
      shape.widthMm, shape.heightMm, Math.min(shape.widthMm, shape.heightMm) / 2,
    ), pad)]
    case "polygon": return [
      place(shape.polygon.outer, pad),
      ...(shape.polygon.holes ?? []).map((ring) => place(ring, pad)),
    ]
  }
}

function scenePad(board: RoutingBoard, pad: RoutingPad): PolygonScenePad {
  const layers = new Set(pad.layers)
  const allCopper = board.layers.map((layer) => layer.name)
  const through = allCopper.length > 1 && allCopper.every((layer) => layers.has(layer))
  return {
    ...(pad.id ? { id: pad.id } : {}),
    component: pad.component,
    padNumber: pad.number,
    net: pad.net ?? "",
    x: pad.at.x,
    y: pad.at.y,
    layer: through || pad.layers.length > 1 ? "MULTI" : (pad.layers[0] ?? ""),
    rotation: 0,
    rings: shapeRings(pad.shape, pad),
  }
}

/** Normalize the public board contract for the private polygon geometry engine. */
export function routingBoardToPolygonScene(board: RoutingBoard): PolygonScene {
  const top = board.layers.find((layer) => layer.side === "top")?.name
  const bottom = board.layers.find((layer) => layer.side === "bottom")?.name
  if (!top || !bottom) throw new TypeError("RoutingBoard needs top and bottom copper layers")
  return {
    board: { polygon: board.outline.map((point) => ({ ...point })) },
    layers: { top, bottom, copper: board.layers.map((layer) => layer.name) },
    components: board.components.map((component) => ({
      designator: component.designator,
      x: component.at.x,
      y: component.at.y,
      rotate: component.rotationDeg,
      layer: component.side === "top" ? top : bottom,
    })),
    pads: board.pads.map((pad) => scenePad(board, pad)),
    tracks: [],
    arcs: [],
    vias: [],
    polygons: [],
  }
}
