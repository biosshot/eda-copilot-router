import {
  runPolygonDsl
} from "../chunk-DDHTOAPW.js";
import {
  DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM,
  DEFAULT_OBSTACLE_CLEARANCE_MM,
  MAX_ADAPTIVE_CORRIDOR_WIDTH_RATIO,
  MAX_COMPACT_BOARD_AREA_RATIO,
  MAX_OCTILINEAR_ENVELOPE_AREA_RATIO,
  MAX_PAD_FREE_GAP_WIDTHS,
  MIN_BOUNDARY_FEATURE_WIDTH_RATIO,
  PAD_ENVELOPE_EXPANSION_RATIO,
  isOctilinearBoundary,
  mergeOctilinearBoundaries,
  planPolygons,
  ringsFromRawPad,
  ringsFromRawPolygon,
  transformFootprintPoint,
  validateFilledPolygonPlans
} from "../chunk-U26KEDMF.js";
import "../chunk-HGTCHW7P.js";
import "../chunk-L7USXWVD.js";

// src/polygon/spec.ts
import { readFileSync } from "fs";
var PCB_POLYGON_DSL_TS_DOC = readFileSync(new URL("./spec-doc.d.ts", import.meta.url), "utf8");
var PCB_POLYGON_DSL_SPEC = `
Write JavaScript polygon intent using only the TypeScript declarations below. Do not output JSON.

Every polygon must explicitly say what it connects: specific pad(...) targets or all pads of net(...).
Never emit points, coordinates, rectangles, clearances, thermal settings, or editor-specific layer constants.
Prefer compact(). It clusters nearby pads, rejects long pad-free spans, and chooses the smallest useful
wide-corridor candidate under a hard relative area budget. Use maxPadFreeGap(...) when an explicit,
still-local connection needs more than the default 4.5 narrower-pad widths. Explicit pad(...) targets
are mandatory: if they cannot share one compact boundary the planner reports an error and continues.
For net(...) targets, distant local clusters may intentionally remain for the router.
Every compact boundary uses only 0/45/90-degree edges and removes sub-width spikes and protrusions.
Boundary complexity is unrestricted; a valid detailed contour must not be split merely to reduce points.
Use plane() only when a board-scale zone is genuinely intended, such as the final GND plane.

Examples:

\`\`\`js
polygon("VSYS")
  .connect(pad("U1", 8), pad("L1", 2))
  .on(topLayer())
  .compact()

polygon("GND")
  .connect(net("GND"))
  .on(outerLayers())
  .plane()
\`\`\`

\`\`\`ts
${PCB_POLYGON_DSL_TS_DOC}
\`\`\`
`;
export {
  DEFAULT_MINIMUM_CORRIDOR_WIDTH_MM,
  DEFAULT_OBSTACLE_CLEARANCE_MM,
  MAX_ADAPTIVE_CORRIDOR_WIDTH_RATIO,
  MAX_COMPACT_BOARD_AREA_RATIO,
  MAX_OCTILINEAR_ENVELOPE_AREA_RATIO,
  MAX_PAD_FREE_GAP_WIDTHS,
  MIN_BOUNDARY_FEATURE_WIDTH_RATIO,
  PAD_ENVELOPE_EXPANSION_RATIO,
  PCB_POLYGON_DSL_SPEC,
  PCB_POLYGON_DSL_TS_DOC,
  isOctilinearBoundary,
  mergeOctilinearBoundaries,
  planPolygons,
  ringsFromRawPad,
  ringsFromRawPolygon,
  runPolygonDsl,
  transformFootprintPoint,
  validateFilledPolygonPlans
};
