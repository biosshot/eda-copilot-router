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

function circleAt(center: PointMm, diameterMm: number) {
  return ellipse(diameterMm, diameterMm).map((point) => ({
    x: point.x + center.x,
    y: point.y + center.y,
  }))
}

function trackSegmentRing(start: PointMm, end: PointMm, widthMm: number) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const radius = widthMm / 2
  const points: PcbPoint[] = []
  for (let index = 0; index <= 8; index += 1) {
    const current = angle - Math.PI / 2 + Math.PI * index / 8
    points.push({ x: end.x + Math.cos(current) * radius, y: end.y + Math.sin(current) * radius })
  }
  for (let index = 0; index <= 8; index += 1) {
    const current = angle + Math.PI / 2 + Math.PI * index / 8
    points.push({ x: start.x + Math.cos(current) * radius, y: start.y + Math.sin(current) * radius })
  }
  return points
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
  const copper = [board.copper.fixed, board.copper.editable]
  const tracks = copper.flatMap((scope) => scope.tracks.flatMap((track) => track.points.slice(1).map((end, index) => ({
    x1: track.points[index].x,
    y1: track.points[index].y,
    x2: end.x,
    y2: end.y,
    width: track.widthMm,
    layer: track.layer,
    net: track.net,
  }))))
  const vias = copper.flatMap((scope) => scope.vias.map((via) => ({
    net: via.net,
    x: via.at.x,
    y: via.at.y,
    diameter: via.diameterMm,
    drill: via.drillMm,
  })))
  const polygons = copper.flatMap((scope) => scope.zones.flatMap((zone) => zone.layers.map((layer) => ({
    ...(zone.net === undefined ? {} : { net: zone.net }),
    layer,
    fill: true,
    lineWidth: zone.minThicknessMm ?? 0,
    sources: [],
    rings: [
      zone.outline.outer.map((point) => ({ ...point })),
      ...(zone.outline.holes ?? []).map((ring) => ring.map((point) => ({ ...point }))),
    ],
  }))))
  const obstacles: PolygonScenePad[] = [
    ...tracks.map((track, index) => ({
      id: `copper-track:${index}`,
      padNumber: "",
      net: track.net,
      x: (track.x1 + track.x2) / 2,
      y: (track.y1 + track.y2) / 2,
      layer: track.layer,
      rotation: 0,
      rings: [trackSegmentRing(
        { x: track.x1, y: track.y1 }, { x: track.x2, y: track.y2 }, track.width,
      )],
    })),
    ...vias.map((via, index) => ({
      id: `copper-via:${index}`,
      padNumber: "",
      net: via.net ?? "__fixed-copper__",
      x: via.x,
      y: via.y,
      layer: "MULTI" as const,
      rotation: 0,
      rings: [circleAt({ x: via.x, y: via.y }, via.diameter)],
    })),
    ...polygons.map((polygon, index) => ({
      id: `copper-zone:${index}`,
      padNumber: "",
      net: polygon.net ?? "__fixed-copper__",
      x: polygon.rings[0]?.[0]?.x ?? 0,
      y: polygon.rings[0]?.[0]?.y ?? 0,
      layer: polygon.layer,
      rotation: 0,
      // The outer contour is conservative when the native zone has holes.
      rings: polygon.rings.length ? [polygon.rings[0]] : [],
    })),
    ...board.cutouts.map((ring, index) => ({
      id: `board-cutout:${index}`,
      padNumber: "",
      net: "__mechanical-obstacle__",
      x: ring[0]?.x ?? 0,
      y: ring[0]?.y ?? 0,
      layer: "MULTI" as const,
      rotation: 0,
      rings: [ring.map((point) => ({ ...point }))],
    })),
    ...board.keepouts.flatMap((keepout, index) => keepout.forbid.zones ? keepout.layers.map((layer) => ({
      id: `zone-keepout:${index}:${layer}`,
      padNumber: "",
      net: "__zone-keepout__",
      x: keepout.polygon.outer[0]?.x ?? 0,
      y: keepout.polygon.outer[0]?.y ?? 0,
      layer,
      rotation: 0,
      rings: [keepout.polygon.outer.map((point) => ({ ...point }))],
    })) : []),
  ]
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
    obstacles,
    tracks,
    arcs: [],
    vias,
    polygons,
  }
}
