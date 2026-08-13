import type {
  CopperTarget,
  ImpedanceConstraint,
  LayerSelector,
  ManufacturingIntent,
  RegionSelector,
  RoutingIntentV2,
  StitchingIntent,
  ViaConstraint,
} from "./types.js";

export interface RoutingIntentDiagnostic {
  readonly severity: "error";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface RoutingIntentValidationOptions {
  /** When supplied, every referenced net must occur in this collection. */
  readonly knownNets?: Iterable<string>;
}

export interface RoutingIntentValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly RoutingIntentDiagnostic[];
}

export class RoutingIntentValidationError extends Error {
  readonly diagnostics: readonly RoutingIntentDiagnostic[];

  constructor(diagnostics: readonly RoutingIntentDiagnostic[]) {
    super(diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n"));
    this.name = "RoutingIntentValidationError";
    this.diagnostics = diagnostics;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isPositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function validateRoutingIntent(
  input: unknown,
  options: RoutingIntentValidationOptions = {},
): RoutingIntentValidationResult {
  const diagnostics: RoutingIntentDiagnostic[] = [];
  const knownNets = options.knownNets === undefined
    ? undefined
    : new Set(Array.from(options.knownNets));

  const error = (code: string, path: string, message: string): void => {
    diagnostics.push({ severity: "error", code, path, message });
  };
  const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], path: string): void => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) error("UNKNOWN_FIELD", `${path}.${key}`, "is not part of RoutingIntentV2");
    }
  };
  const requireString = (value: unknown, path: string): value is string => {
    if (isNonEmptyString(value)) return true;
    error("INVALID_STRING", path, "must be a non-empty string");
    return false;
  };
  const requirePositive = (value: unknown, path: string): value is number => {
    if (isPositive(value)) return true;
    error("INVALID_POSITIVE_VALUE", path, "must be a finite number greater than zero");
    return false;
  };
  const optionalPositive = (value: unknown, path: string): value is number | undefined =>
    value === undefined || requirePositive(value, path);
  const optionalNonNegative = (value: unknown, path: string): value is number | undefined => {
    if (value === undefined || isNonNegative(value)) return true;
    error("INVALID_NON_NEGATIVE_VALUE", path, "must be a finite number greater than or equal to zero");
    return false;
  };
  const referenceNet = (value: unknown, path: string): value is string => {
    if (!requireString(value, path)) return false;
    if (knownNets !== undefined && !knownNets.has(value)) {
      error("UNKNOWN_NET", path, `net ${JSON.stringify(value)} is absent from the source board`);
    }
    return true;
  };

  const validateVia = (value: unknown, path: string): value is ViaConstraint => {
    if (!isRecord(value)) {
      error("INVALID_VIA", path, "must be an object");
      return false;
    }
    exactKeys(value, ["diameterMm", "drillMm"], path);
    const diameterValid = optionalPositive(value.diameterMm, `${path}.diameterMm`);
    const drillValid = optionalPositive(value.drillMm, `${path}.drillMm`);
    if (value.diameterMm === undefined && value.drillMm === undefined) {
      error("EMPTY_CONSTRAINT", path, "must constrain diameterMm, drillMm, or both");
    }
    if (
      diameterValid && drillValid &&
      typeof value.diameterMm === "number" && typeof value.drillMm === "number" &&
      value.drillMm >= value.diameterMm
    ) {
      error("RULE_CONFLICT", path, "drillMm must be smaller than diameterMm");
    }
    return diameterValid && drillValid;
  };

  const validateImpedance = (value: unknown, path: string): value is ImpedanceConstraint => {
    if (!isRecord(value)) {
      error("INVALID_IMPEDANCE", path, "must be an object");
      return false;
    }
    exactKeys(value, ["targetOhm", "tolerancePercent"], path);
    const targetValid = requirePositive(value.targetOhm, `${path}.targetOhm`);
    const toleranceValid = value.tolerancePercent === undefined ||
      requirePositive(value.tolerancePercent, `${path}.tolerancePercent`);
    return targetValid && toleranceValid;
  };

  const validateLayer = (value: unknown, path: string): value is LayerSelector => {
    if (!isRecord(value)) {
      error("INVALID_LAYER_SELECTOR", path, "must be an object");
      return false;
    }
    if (value.kind === "outer-layers") {
      exactKeys(value, ["kind"], path);
      return true;
    }
    if (value.kind === "outer-layer" && (value.side === "top" || value.side === "bottom")) {
      exactKeys(value, ["kind", "side"], path);
      return true;
    }
    if (value.kind === "layer") {
      exactKeys(value, ["kind", "layer"], path);
      return requireString(value.layer, `${path}.layer`);
    }
    error("INVALID_LAYER_SELECTOR", `${path}.kind`, "must be layer, outer-layer, or outer-layers");
    return false;
  };

  const validateTarget = (value: unknown, path: string): value is CopperTarget => {
    if (!isRecord(value)) {
      error("INVALID_COPPER_TARGET", path, "must be an object");
      return false;
    }
    if (value.kind === "pad") {
      exactKeys(value, ["kind", "component", "pad"], path);
      const componentValid = requireString(value.component, `${path}.component`);
      const padValid = requireString(value.pad, `${path}.pad`);
      return componentValid && padValid;
    }
    if (value.kind === "net-pads") {
      exactKeys(value, ["kind", "net"], path);
      return referenceNet(value.net, `${path}.net`);
    }
    error("INVALID_COPPER_TARGET", `${path}.kind`, "must be pad or net-pads");
    return false;
  };

  const validateRegion = (value: unknown, path: string): value is RegionSelector => {
    if (!isRecord(value)) {
      error("INVALID_REGION", path, "must be an object");
      return false;
    }
    if (value.kind === "board") {
      exactKeys(value, ["kind"], path);
      return true;
    }
    if (value.kind === "components") {
      exactKeys(value, ["kind", "components"], path);
      if (!Array.isArray(value.components) || value.components.length === 0) {
        error("INVALID_REGION", `${path}.components`, "must contain at least one component");
        return false;
      }
      const unique = new Set<string>();
      value.components.forEach((component, index) => {
        if (requireString(component, `${path}.components[${index}]`)) {
          if (unique.has(component)) {
            error("DUPLICATE_COMPONENT", `${path}.components[${index}]`, "component is duplicated");
          }
          unique.add(component);
        }
      });
      return true;
    }
    error("INVALID_REGION", `${path}.kind`, "must be board or components");
    return false;
  };

  const validateStitching = (value: unknown, path: string): value is StitchingIntent => {
    if (!isRecord(value) || typeof value.enabled !== "boolean") {
      error("INVALID_STITCHING", path, "must explicitly contain enabled: true or false");
      return false;
    }
    if (!value.enabled) {
      exactKeys(value, ["enabled"], path);
      return true;
    }
    exactKeys(value, ["enabled", "gridMm", "maxVisibleViaDistanceMm", "via", "viaInPad", "maxVias"], path);
    optionalPositive(value.gridMm, `${path}.gridMm`);
    optionalPositive(value.maxVisibleViaDistanceMm, `${path}.maxVisibleViaDistanceMm`);
    if (value.via !== undefined && value.via !== "drc-min") validateVia(value.via, `${path}.via`);
    if (value.viaInPad !== undefined && typeof value.viaInPad !== "boolean") {
      error("INVALID_STITCHING", `${path}.viaInPad`, "must be a boolean");
    }
    const maxVias = value.maxVias;
    if (maxVias !== undefined &&
      (typeof maxVias !== "number" || !Number.isInteger(maxVias) || maxVias <= 0)) {
      error("INVALID_STITCHING", `${path}.maxVias`, "must be a positive integer");
    }
    return true;
  };

  if (!isRecord(input)) {
    error("INVALID_INTENT", "$", "must be an object");
    return { valid: false, diagnostics };
  }
  exactKeys(input, ["version", "copper", "nets", "special", "manufacturing"], "$");
  if (input.version !== 2) error("INVALID_VERSION", "$.version", "must equal 2");

  const stableIds = new Set<string>();
  if (!Array.isArray(input.copper)) {
    error("INVALID_ARRAY", "$.copper", "must be an array");
  } else {
    input.copper.forEach((item, index) => {
      const path = `$.copper[${index}]`;
      if (!isRecord(item)) {
        error("INVALID_COPPER_INTENT", path, "must be an object");
        return;
      }
      if (requireString(item.id, `${path}.id`)) {
        if (stableIds.has(item.id)) error("DUPLICATE_ID", `${path}.id`, "stable intent id is duplicated");
        stableIds.add(item.id);
      }
      referenceNet(item.net, `${path}.net`);
      validateLayer(item.layers, `${path}.layers`);
      optionalNonNegative(item.priority, `${path}.priority`);
      if (item.kind === "compact-polygon") {
        exactKeys(item, ["kind", "id", "net", "connect", "layers", "priority", "maxPadFreeGapWidths"], path);
        if (!Array.isArray(item.connect) || item.connect.length === 0) {
          error("INVALID_TARGETS", `${path}.connect`, "must contain at least one target");
        } else {
          item.connect.forEach((target, targetIndex) => {
            const targetPath = `${path}.connect[${targetIndex}]`;
            if (validateTarget(target, targetPath) &&
              target.kind === "net-pads" && target.net !== item.net) {
              error(
                "RULE_CONFLICT",
                `${targetPath}.net`,
                "net-pads selector must reference the polygon net",
              );
            }
          });
        }
        optionalPositive(item.maxPadFreeGapWidths, `${path}.maxPadFreeGapWidths`);
      } else if (item.kind === "plane") {
        exactKeys(item, ["kind", "id", "net", "layers", "region", "paddingMm", "priority", "stitching"], path);
        validateRegion(item.region, `${path}.region`);
        optionalNonNegative(item.paddingMm, `${path}.paddingMm`);
        const region = item.region;
        if (isRecord(region) && region.kind === "board" && item.paddingMm !== undefined) {
          error("RULE_CONFLICT", `${path}.paddingMm`, "is reserved for components(...) regions");
        }
        validateStitching(item.stitching, `${path}.stitching`);
      } else {
        error("INVALID_COPPER_KIND", `${path}.kind`, "must be compact-polygon or plane");
      }
    });
  }

  const constrainedNets = new Set<string>();
  if (!Array.isArray(input.nets)) {
    error("INVALID_ARRAY", "$.nets", "must be an array");
  } else {
    input.nets.forEach((item, index) => {
      const path = `$.nets[${index}]`;
      if (!isRecord(item)) {
        error("INVALID_NET_INTENT", path, "must be an object");
        return;
      }
      if (referenceNet(item.net, `${path}.net`)) {
        if (constrainedNets.has(item.net)) {
          error("DUPLICATE_NET_INTENT", `${path}.net`, "a net may have only one net intent");
        }
        constrainedNets.add(item.net);
      }
      if (item.kind === "power-net") {
        exactKeys(item, ["kind", "net", "maxCurrentA", "minTrackWidthMm", "maxTempRiseC", "maxTrackWidthMm", "via"], path);
        const hasCurrent = item.maxCurrentA !== undefined;
        const hasMinimumWidth = item.minTrackWidthMm !== undefined;
        if (hasCurrent === hasMinimumWidth) {
          error(
            "RULE_CONFLICT",
            path,
            "power net must define exactly one of maxCurrentA or minTrackWidthMm",
          );
        }
        if (hasCurrent) requirePositive(item.maxCurrentA, `${path}.maxCurrentA`);
        if (hasMinimumWidth) requirePositive(item.minTrackWidthMm, `${path}.minTrackWidthMm`);
        optionalPositive(item.maxTempRiseC, `${path}.maxTempRiseC`);
        if (optionalPositive(item.maxTrackWidthMm, `${path}.maxTrackWidthMm`) &&
          typeof item.maxTrackWidthMm === "number" && item.maxTrackWidthMm > 10) {
          error("RULE_CONFLICT", `${path}.maxTrackWidthMm`, "must not exceed 10 mm");
        }
        if (item.via !== undefined) validateVia(item.via, `${path}.via`);
      } else if (item.kind === "signal-net") {
        exactKeys(item, ["kind", "net", "trackWidthMm", "clearanceMm", "maxLengthMm", "allowedLayers", "via", "impedance"], path);
        optionalPositive(item.trackWidthMm, `${path}.trackWidthMm`);
        optionalPositive(item.clearanceMm, `${path}.clearanceMm`);
        optionalPositive(item.maxLengthMm, `${path}.maxLengthMm`);
        if (item.allowedLayers !== undefined) validateLayer(item.allowedLayers, `${path}.allowedLayers`);
        if (item.via !== undefined) validateVia(item.via, `${path}.via`);
        if (item.impedance !== undefined) validateImpedance(item.impedance, `${path}.impedance`);
      } else {
        error("INVALID_NET_KIND", `${path}.kind`, "must be power-net or signal-net");
      }
    });
  }

  if (!Array.isArray(input.special)) {
    error("INVALID_ARRAY", "$.special", "must be an array");
  } else {
    input.special.forEach((item, index) => {
      const path = `$.special[${index}]`;
      if (!isRecord(item)) {
        error("INVALID_SPECIAL_INTENT", path, "must be an object");
        return;
      }
      if (requireString(item.id, `${path}.id`)) {
        if (stableIds.has(item.id)) error("DUPLICATE_ID", `${path}.id`, "stable intent id is duplicated");
        stableIds.add(item.id);
      }
      if (item.kind === "differential-pair") {
        exactKeys(item, ["kind", "id", "positiveNet", "negativeNet", "trackWidthMm", "gapMm", "maxSkewMm", "maxUncoupledLengthMm", "allowedLayers", "impedance"], path);
        const positiveValid = referenceNet(item.positiveNet, `${path}.positiveNet`);
        const negativeValid = referenceNet(item.negativeNet, `${path}.negativeNet`);
        if (positiveValid && negativeValid && item.positiveNet === item.negativeNet) {
          error("RULE_CONFLICT", path, "positiveNet and negativeNet must differ");
        }
        optionalPositive(item.trackWidthMm, `${path}.trackWidthMm`);
        optionalPositive(item.gapMm, `${path}.gapMm`);
        optionalPositive(item.maxSkewMm, `${path}.maxSkewMm`);
        optionalPositive(item.maxUncoupledLengthMm, `${path}.maxUncoupledLengthMm`);
        if (item.allowedLayers !== undefined) validateLayer(item.allowedLayers, `${path}.allowedLayers`);
        if (item.impedance !== undefined) validateImpedance(item.impedance, `${path}.impedance`);
      } else if (item.kind === "matched-group") {
        exactKeys(item, ["kind", "id", "members", "toleranceMm"], path);
        if (!Array.isArray(item.members) || item.members.length < 2) {
          error("INVALID_MATCHED_GROUP", `${path}.members`, "must contain at least two members");
        } else {
          const members = new Set<string>();
          item.members.forEach((member, memberIndex) => {
            const memberPath = `${path}.members[${memberIndex}]`;
            if (!isRecord(member)) {
              error("INVALID_MATCHED_GROUP_MEMBER", memberPath, "must be an object");
              return;
            }
            let key: string | undefined;
            if (member.kind === "net" && referenceNet(member.net, `${memberPath}.net`)) {
              exactKeys(member, ["kind", "net"], memberPath);
              key = `net:${member.net}`;
            } else if (member.kind === "differential-pair" && requireString(member.id, `${memberPath}.id`)) {
              exactKeys(member, ["kind", "id"], memberPath);
              key = `differential-pair:${member.id}`;
            } else {
              error("INVALID_MATCHED_GROUP_MEMBER", `${memberPath}.kind`, "must be net or differential-pair");
            }
            if (key && members.has(key)) {
              error("DUPLICATE_MATCHED_MEMBER", memberPath, "member is duplicated in the group");
            }
            if (key) members.add(key);
          });
        }
        optionalPositive(item.toleranceMm, `${path}.toleranceMm`);
      } else {
        error("INVALID_SPECIAL_KIND", `${path}.kind`, "must be differential-pair or matched-group");
      }
    });
  }

  if (input.manufacturing !== undefined) {
    if (!isRecord(input.manufacturing)) {
      error("INVALID_MANUFACTURING", "$.manufacturing", "must be an object");
    } else {
      const value: Record<string, unknown> = input.manufacturing;
      exactKeys(value, ["fallbackCopperThicknessOz", "viaPlatingThicknessUm", "maxTrackWidthMm"], "$.manufacturing");
      optionalPositive(value.fallbackCopperThicknessOz, "$.manufacturing.fallbackCopperThicknessOz");
      optionalPositive(value.viaPlatingThicknessUm, "$.manufacturing.viaPlatingThicknessUm");
      if (optionalPositive(value.maxTrackWidthMm, "$.manufacturing.maxTrackWidthMm") &&
        typeof value.maxTrackWidthMm === "number" && value.maxTrackWidthMm > 10) {
        error("RULE_CONFLICT", "$.manufacturing.maxTrackWidthMm", "must not exceed 10 mm");
      }
    }
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

export function assertRoutingIntent(
  input: unknown,
  options: RoutingIntentValidationOptions = {},
): asserts input is RoutingIntentV2 {
  const result = validateRoutingIntent(input, options);
  if (!result.valid) throw new RoutingIntentValidationError(result.diagnostics);
}

export function isRoutingIntentV2(input: unknown): input is RoutingIntentV2 {
  return validateRoutingIntent(input).valid;
}

/** Explicit versioned name used by package consumers and the CLI. */
export const validateRoutingIntentV2 = validateRoutingIntent;

/** Kept exported so consumers can type manufacturing configuration independently. */
export function validateManufacturingIntent(input: ManufacturingIntent): RoutingIntentValidationResult {
  return validateRoutingIntent({ version: 2, copper: [], nets: [], special: [], manufacturing: input });
}
