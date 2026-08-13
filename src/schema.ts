const DRAFT = "https://json-schema.org/draft/2020-12/schema"
const id = { type: "string", minLength: 1 } as const
const positive = { type: "number", exclusiveMinimum: 0 } as const
const nonNegative = { type: "number", minimum: 0 } as const
const point = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: { x: { type: "number" }, y: { type: "number" } },
} as const
const path = { type: "array", minItems: 3, items: point } as const
const polygon = {
  type: "object",
  additionalProperties: false,
  required: ["outer"],
  properties: {
    outer: path,
    holes: { type: "array", items: path },
  },
} as const
const padShape = {
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["kind", "diameterMm"],
      properties: { kind: { const: "circle" }, diameterMm: positive },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "widthMm", "heightMm"],
      properties: { kind: { enum: ["rect", "oval"] }, widthMm: positive, heightMm: positive },
    },
    {
      type: "object", additionalProperties: false,
      required: ["kind", "widthMm", "heightMm", "cornerRadiusMm"],
      properties: {
        kind: { const: "round-rect" }, widthMm: positive, heightMm: positive,
        cornerRadiusMm: nonNegative,
      },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "polygon"],
      properties: { kind: { const: "polygon" }, polygon },
    },
  ],
} as const
const range = {
  type: "object",
  additionalProperties: false,
  required: ["minMm", "preferredMm", "maxMm"],
  properties: { minMm: positive, preferredMm: positive, maxMm: positive },
} as const
const ruleValues = {
  type: "object",
  required: ["clearanceMm", "edgeClearanceMm", "trackWidth", "via"],
  properties: {
    clearanceMm: nonNegative,
    edgeClearanceMm: nonNegative,
    trackWidth: range,
    via: {
      type: "object",
      required: ["diameterMm", "drillMm"],
      properties: { diameterMm: range, drillMm: range },
    },
    holeToHoleClearanceMm: nonNegative,
    maxLengthMm: positive,
    diffPair: {
      type: "object",
      required: ["gapMm"],
      properties: { gapMm: range, maxSkewMm: nonNegative, maxUncoupledLengthMm: positive },
    },
  },
} as const
const track = {
  type: "object",
  required: ["kind", "id", "netId", "layerId", "start", "end", "widthMm"],
  properties: {
    kind: { const: "track" }, id, netId: id, layerId: id,
    start: point, end: point, widthMm: positive, locked: { type: "boolean" },
  },
} as const
const arc = {
  type: "object",
  required: ["kind", "id", "netId", "layerId", "start", "mid", "end", "widthMm"],
  properties: {
    kind: { const: "arc" }, id, netId: id, layerId: id,
    start: point, mid: point, end: point, widthMm: positive, locked: { type: "boolean" },
  },
} as const
const via = {
  type: "object",
  required: ["kind", "id", "netId", "at", "diameterMm", "drillMm", "fromLayerId", "toLayerId", "viaType"],
  properties: {
    kind: { const: "via" }, id, netId: id, at: point,
    diameterMm: positive, drillMm: positive, fromLayerId: id, toLayerId: id,
    viaType: { enum: ["through", "blind-buried", "micro"] }, locked: { type: "boolean" },
  },
} as const
const zone = {
  type: "object",
  required: ["kind", "id", "netId", "layerId", "outline", "filled", "fillState", "connection"],
  properties: {
    kind: { const: "zone" }, id, netId: id, layerId: id, outline: polygon,
    filled: { type: "array", items: polygon },
    fillState: { enum: ["unfilled", "filled", "stale"] },
    priority: { type: "number" }, minThicknessMm: positive,
    connection: { enum: ["solid", "thermal", "none"] }, locked: { type: "boolean" },
  },
} as const
const copperPrimitive = { oneOf: [track, arc, via, zone] } as const

/** Portable interchange schema. Runtime validation also checks references and ordered ranges. */
export const RAW_PCB_V1_JSON_SCHEMA = {
  $schema: DRAFT,
  $id: "https://easyeda-copilot.local/schema/raw-pcb-v1.json",
  title: "RawPcbV1",
  type: "object",
  required: [
    "schema", "version", "coordinates", "source", "board", "layers", "stackup",
    "nets", "components", "pads", "copper", "keepouts", "rules",
  ],
  properties: {
    schema: { const: "raw-pcb" },
    version: { const: 1 },
    coordinates: {
      type: "object",
      additionalProperties: false,
      required: ["units", "xAxis", "yAxis", "rotation"],
      properties: {
        units: { const: "mm" }, xAxis: { const: "right" }, yAxis: { const: "down" },
        rotation: { const: "clockwise-degrees" },
      },
    },
    source: {
      type: "object",
      required: ["eda", "adapter"],
      properties: {
        eda: id, edaVersion: { type: "string" }, adapter: id,
        adapterVersion: { type: "string" }, documentId: { type: "string" },
        revision: { type: "string" }, capturedAt: { type: "string" },
      },
    },
    board: {
      type: "object",
      required: ["outline", "cutouts"],
      properties: { outline: path, cutouts: { type: "array", items: path } },
    },
    layers: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "name", "index", "side", "role"],
        properties: {
          id, name: id, index: { type: "integer", minimum: 0 },
          side: { enum: ["top", "inner", "bottom"] },
          role: { enum: ["signal", "plane", "mixed"] },
        },
      },
    },
    stackup: {
      type: "object",
      required: ["copperThicknessOzFallback", "layers"],
      properties: {
        copperThicknessOzFallback: positive,
        layers: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object", additionalProperties: false,
                required: ["kind", "layerId", "thicknessMm"],
                properties: { kind: { const: "copper" }, layerId: id, thicknessMm: positive },
              },
              {
                type: "object", additionalProperties: false,
                required: ["kind", "id", "thicknessMm"],
                properties: {
                  kind: { const: "dielectric" }, id, thicknessMm: positive,
                  material: { type: "string" }, relativePermittivity: positive,
                },
              },
            ],
          },
        },
      },
    },
    nets: {
      type: "array", items: {
        type: "object", required: ["id", "name"],
        properties: { id, name: id, classId: id },
      },
    },
    components: {
      type: "array", items: {
        type: "object", required: ["id", "designator", "at", "rotationDeg", "side"],
        properties: {
          id, designator: id, footprint: { type: "string" }, at: point,
          rotationDeg: { type: "number" }, side: { enum: ["top", "bottom"] },
          bounds: polygon, locked: { type: "boolean" },
        },
      },
    },
    pads: {
      type: "array", items: {
        type: "object",
        required: ["id", "componentId", "number", "at", "rotationDeg", "layers", "shape"],
        properties: {
          id, componentId: id, number: { type: "string" }, netId: id, at: point,
          rotationDeg: { type: "number" }, layers: { type: "array", minItems: 1, items: id },
          shape: padShape,
          hole: {
            type: "object", required: ["shape", "diameterMm", "plated"],
            properties: {
              shape: { enum: ["round", "slot"] }, diameterMm: positive,
              slotLengthMm: positive, offset: point, rotationDeg: { type: "number" },
              plated: { type: "boolean" },
            },
          },
        },
      },
    },
    copper: {
      type: "object", required: ["tracks", "arcs", "vias", "zones"],
      properties: {
        tracks: { type: "array", items: track }, arcs: { type: "array", items: arc },
        vias: { type: "array", items: via }, zones: { type: "array", items: zone },
      },
    },
    keepouts: {
      type: "array", items: {
        type: "object", required: ["id", "layers", "polygon", "forbid"],
        properties: {
          id, layers: { type: "array", items: id }, polygon,
          forbid: {
            type: "object", required: ["tracks", "vias", "zones", "pads"],
            properties: {
              tracks: { type: "boolean" }, vias: { type: "boolean" },
              zones: { type: "boolean" }, pads: { type: "boolean" },
            },
          },
        },
      },
    },
    rules: {
      type: "object", required: ["global", "byNet"],
      properties: {
        global: ruleValues,
        byNet: {
          type: "array", items: {
            type: "object", required: ["netId", "values"],
            properties: { netId: id, values: ruleValues },
          },
        },
        matchedGroups: {
          type: "array", items: {
            type: "object", additionalProperties: false,
            required: ["id", "netIds", "toleranceMm"],
            properties: {
              id, netIds: { type: "array", minItems: 2, items: id }, toleranceMm: positive,
            },
          },
        },
      },
    },
  },
} as const

export const PCB_SNAPSHOT_V1_JSON_SCHEMA = {
  $schema: DRAFT,
  $id: "https://easyeda-copilot.local/schema/pcb-snapshot-v1.json",
  title: "PcbSnapshotV1",
  type: "object",
  additionalProperties: false,
  required: ["schema", "version", "rawPcb", "contentHash"],
  properties: {
    schema: { const: "pcb-snapshot" }, version: { const: 1 },
    rawPcb: RAW_PCB_V1_JSON_SCHEMA, contentHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
  },
} as const

export const PCB_PATCH_V1_JSON_SCHEMA = {
  $schema: DRAFT,
  $id: "https://easyeda-copilot.local/schema/pcb-patch-v1.json",
  title: "PcbPatchV1",
  type: "object",
  additionalProperties: false,
  required: ["schema", "version", "baseSnapshotHash", "operations", "diagnostics", "coreStatus", "requiresNativeVerification"],
  properties: {
    schema: { const: "pcb-patch" }, version: { const: 1 },
    baseSnapshotHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    operations: {
      type: "array",
      items: {
        oneOf: [
          { type: "object", required: ["op", "item"], properties: { op: { const: "add" }, item: copperPrimitive } },
          { type: "object", required: ["op", "id", "kind"], properties: { op: { const: "remove" }, id, kind: { enum: ["track", "arc", "via", "zone"] } } },
          { type: "object", required: ["op", "id", "kind", "item"], properties: { op: { const: "replace" }, id, kind: { enum: ["track", "arc", "via", "zone"] }, item: copperPrimitive } },
        ],
      },
    },
    diagnostics: { type: "array", items: { type: "object", required: ["code", "severity", "message"] } },
    coreStatus: { enum: ["complete", "partial", "error"] },
    requiresNativeVerification: { const: true },
  },
} as const

const layerSelector = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "layer"],
      properties: { kind: { const: "layer" }, layer: id },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "side"],
      properties: { kind: { const: "outer-layer" }, side: { enum: ["top", "bottom"] } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { const: "outer-layers" } },
    },
  ],
} as const

const impedance = {
  type: "object",
  additionalProperties: false,
  required: ["targetOhm"],
  properties: { targetOhm: positive, tolerancePercent: positive },
} as const

/**
 * Serializable design intent schema. Runtime validation also checks stable-ID
 * uniqueness, net references and cross-field rule conflicts.
 */
export const ROUTING_INTENT_V2_JSON_SCHEMA = {
  $schema: DRAFT,
  $id: "https://easyeda-copilot.local/schema/routing-intent-v2.json",
  title: "RoutingIntentV2",
  type: "object",
  additionalProperties: false,
  required: ["version", "copper", "nets", "special"],
  properties: {
    version: { const: 2 },
    copper: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id", "net", "connect", "layers"],
            properties: {
              kind: { const: "compact-polygon" }, id, net: id,
              connect: {
                type: "array",
                minItems: 1,
                items: {
                  oneOf: [
                    {
                      type: "object", additionalProperties: false,
                      required: ["kind", "component", "pad"],
                      properties: { kind: { const: "pad" }, component: id, pad: id },
                    },
                    {
                      type: "object", additionalProperties: false,
                      required: ["kind", "net"],
                      properties: { kind: { const: "net-pads" }, net: id },
                    },
                  ],
                },
              },
              layers: layerSelector,
              priority: { type: "number", minimum: 0 },
              maxPadFreeGapWidths: positive,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id", "net", "layers", "region", "stitching"],
            properties: {
              kind: { const: "plane" }, id, net: id, layers: layerSelector,
              region: {
                oneOf: [
                  { type: "object", required: ["kind"], properties: { kind: { const: "board" } } },
                  {
                    type: "object", required: ["kind", "components"],
                    properties: {
                      kind: { const: "components" },
                      components: { type: "array", minItems: 1, items: id },
                    },
                  },
                ],
              },
              paddingMm: nonNegative,
              priority: { type: "number", minimum: 0 },
              stitching: {
                oneOf: [
                  { type: "object", required: ["enabled"], properties: { enabled: { const: false } } },
                  {
                    type: "object", required: ["enabled"],
                    properties: {
                      enabled: { const: true }, gridMm: positive,
                      maxVisibleViaDistanceMm: positive,
                      viaInPad: { type: "boolean" }, maxVias: { type: "integer", minimum: 1 },
                      via: {
                        oneOf: [
                          { const: "drc-min" },
                          {
                            type: "object", required: ["diameterMm", "drillMm"],
                            properties: { diameterMm: positive, drillMm: positive },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    },
    nets: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object", required: ["kind", "net"],
            properties: {
              kind: { const: "power-net" }, net: id, maxCurrentA: positive,
              minTrackWidthMm: positive, maxTempRiseC: positive,
              maxTrackWidthMm: { type: "number", exclusiveMinimum: 0, maximum: 10 },
            },
          },
          {
            type: "object", required: ["kind", "net"],
            properties: {
              kind: { const: "signal-net" }, net: id, trackWidthMm: positive,
              clearanceMm: positive, maxLengthMm: positive,
              allowedLayers: layerSelector, impedance,
            },
          },
        ],
      },
    },
    special: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object", required: ["kind", "id", "positiveNet", "negativeNet"],
            properties: {
              kind: { const: "differential-pair" }, id, positiveNet: id, negativeNet: id,
              trackWidthMm: positive, gapMm: positive, maxSkewMm: positive,
              maxUncoupledLengthMm: positive, allowedLayers: layerSelector, impedance,
            },
          },
          {
            type: "object", required: ["kind", "id", "members"],
            properties: {
              kind: { const: "matched-group" }, id,
              members: {
                type: "array", minItems: 2,
                items: {
                  oneOf: [
                    { type: "object", required: ["kind", "net"], properties: { kind: { const: "net" }, net: id } },
                    { type: "object", required: ["kind", "id"], properties: { kind: { const: "differential-pair" }, id } },
                  ],
                },
              },
              toleranceMm: positive,
            },
          },
        ],
      },
    },
    manufacturing: {
      type: "object",
      properties: {
        fallbackCopperThicknessOz: positive, viaPlatingThicknessUm: positive,
        maxTrackWidthMm: { type: "number", exclusiveMinimum: 0, maximum: 10 },
      },
    },
  },
} as const
