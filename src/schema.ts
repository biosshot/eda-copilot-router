/**
 * Runtime validators are authoritative. These lightweight JSON Schemas cover
 * the stable outer contract without introducing schema/version fields into
 * routing data itself.
 */
export const ROUTING_BOARD_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "RoutingBoard",
  type: "object",
  additionalProperties: false,
  required: ["outline", "cutouts", "layers", "nets", "components", "pads", "keepouts", "rules", "copper"],
  properties: {
    outline: { type: "array", minItems: 3 },
    cutouts: { type: "array" },
    layers: { type: "array", minItems: 1 },
    nets: { type: "array" },
    components: { type: "array" },
    pads: { type: "array" },
    keepouts: { type: "array" },
    stackup: { type: "object" },
    rules: { type: "object" },
    copper: { type: "object", required: ["fixed", "editable"] },
  },
} as const

export const ROUTING_RESULT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "RoutingResult",
  type: "object",
  additionalProperties: false,
  required: ["status", "operation", "rules", "diagnostics", "metrics", "requiresNativeVerification"],
  properties: {
    status: { enum: ["complete", "partial", "error"] },
    operation: { enum: ["apply-drc", "route", "all"] },
    rules: { type: "object" },
    copper: { type: "object" },
    diagnostics: { type: "array" },
    metrics: { type: "object" },
    requiresNativeVerification: { const: true },
  },
} as const
