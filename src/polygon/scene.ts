/**
 * Private geometry view used by the compact-polygon algorithms.
 *
 * This is deliberately not a second public board contract. EDA adapters and
 * the public RoutingBoard adapter normalize their input into this small view
 * immediately before invoking the geometry engine.
 */
export type PcbPoint = { x: number; y: number }
export type PcbLayerName = string

export type PolygonScenePad = {
  id?: string
  component?: string
  x: number
  y: number
  net: string
  padNumber: string
  layer: PcbLayerName | "MULTI"
  rotation: number
  /** Preferred normalized geometry. */
  rings?: PcbPoint[][]
  /** Legacy adapter geometry; accepted only at this private boundary. */
  shape?: unknown[]
  hole?: {
    data: Array<string | number>
    offsetX: number
    offsetY: number
    rotation: number
  }
}

export type PolygonScenePolygon = {
  net: string
  layer: PcbLayerName | "MULTI"
  fill: boolean
  lineWidth: number
  sources: unknown[][]
}

export type PolygonSceneTrack = {
  x1: number
  y1: number
  x2: number
  y2: number
  width: number
  layer: PcbLayerName
  net: string
}

export type PolygonSceneArc = PolygonSceneTrack & { arcAngle: number }

export type PolygonSceneVia = {
  net?: string
  x: number
  y: number
  diameter: number
  drill: number
}

export type PolygonSceneComponent = {
  designator: string
  x: number
  y: number
  rotate: number
  layer: PcbLayerName
  bbox?: { left: number; right: number; top: number; bottom: number }
}

export type PolygonScene = {
  board?: { polygon: PcbPoint[] }
  layers?: {
    top: PcbLayerName
    bottom: PcbLayerName
    copper: PcbLayerName[]
  }
  components: PolygonSceneComponent[]
  pads: PolygonScenePad[]
  tracks: PolygonSceneTrack[]
  arcs: PolygonSceneArc[]
  vias: PolygonSceneVia[]
  /** Actual filled copper only when used for refill validation. */
  polygons: PolygonScenePolygon[]
}
