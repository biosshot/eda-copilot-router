export { runPolygonDsl } from "./dsl"
export type {
  PlaneIntent,
  PlaneRegionSelector,
  PlaneStitchingIntent,
  PolygonIntent,
  PolygonLayerSelector,
  PolygonMode,
  PolygonProgram,
  PolygonTarget,
} from "./dsl"
export {
  DEFAULT_MAX_POLYGON_SEARCH_ELAPSED_MS,
  DEFAULT_MAX_POLYGON_SEARCH_WORK_UNITS,
  DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM,
  DEFAULT_OBSTACLE_CLEARANCE_MM,
  MAX_ADAPTIVE_CORRIDOR_WIDTH_RATIO,
  MAX_OCTILINEAR_ENVELOPE_AREA_RATIO,
  MAX_PAD_FREE_GAP_WIDTHS,
  mergeOctilinearBoundaries,
  MIN_BOUNDARY_FEATURE_WIDTH_RATIO,
  PAD_ENVELOPE_EXPANSION_RATIO,
} from "./boundary-optimizer"
export { isOctilinearBoundary } from "./boundary-optimizer"
export {
  MAX_COMPACT_BOARD_AREA_RATIO,
  planPolygons,
  ringsFromScenePad,
  ringsFromScenePolygon,
  ringsFromRawPad,
  ringsFromRawPolygon,
  validateFilledPolygonPlans,
} from "./engine"
export type {
  FilledPolygonValidationDiagnostic,
  FilledPolygonValidationResult,
  PolygonGeometryRules,
  PolygonPlannerOptions,
  PolygonPlannerResult,
  PolygonProgramInput,
  ResolvedPolygonPad,
  ZoneOptimizationMetrics,
  ZonePlan,
} from "./engine"
export { PCB_POLYGON_DSL_SPEC, PCB_POLYGON_DSL_TS_DOC } from "./spec"
export type { PolygonScene, PolygonScenePad, PolygonScenePolygon } from "./scene.js"
export { routingBoardToPolygonScene } from "./routing-board-adapter.js"
/** @deprecated Legacy aliases retained only for the existing file workflow. */
export type { RawPcb, RawPcbPad, RawPcbPolygon } from "./raw-pcb"
export { transformFootprintPoint } from "./kicad-adapter"
