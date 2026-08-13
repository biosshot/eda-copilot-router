import type {
  CompiledRuleValuesV1,
  PcbSnapshotV1,
  RuleRangeV1,
  RoutingDiagnostic,
  ViaRuleV1,
} from "../core/contracts.js";
import type {
  RouterBackendCapabilities,
  RouterCapability,
} from "../adapters/contracts.js";
import type {
  DifferentialPairIntent,
  ImpedanceConstraint,
  LayerSelector,
  RoutingIntentV2,
  ViaConstraint,
} from "./types.js";
import { validateRoutingIntent } from "./validation.js";

export interface RoutingIntentPreflightOptions {
  /**
   * Optional backend declaration. When omitted, preflight still returns the
   * capabilities that orchestration must negotiate before execution.
   */
  readonly backendCapabilities?: RouterBackendCapabilities | readonly RouterCapability[];
  /** True for a full-board route; false for polygon/special-only stages. */
  readonly routeUnqualifiedNets?: boolean;
}

export interface RoutingIntentPreflightResult {
  readonly valid: boolean;
  readonly requiredCapabilities: readonly RouterCapability[];
  readonly diagnostics: readonly RoutingDiagnostic[];
}

const CAPABILITY_ORDER: readonly RouterCapability[] = [
  "ordinary-routing",
  "vias",
  "zones",
  "plane-stitching",
  "differential-pairs",
  "matched-length",
  "impedance-controlled",
  "preserve-existing-copper",
];

function error(
  diagnostics: RoutingDiagnostic[],
  code: string,
  path: string,
  message: string,
  details?: unknown,
): void {
  diagnostics.push({
    code,
    severity: "error",
    path,
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function explicitValueInRange(
  diagnostics: RoutingDiagnostic[],
  path: string,
  label: string,
  value: number | undefined,
  range: RuleRangeV1,
): void {
  if (value === undefined) return;
  if (value < range.minMm || value > range.maxMm) {
    error(
      diagnostics,
      "RULE_CONFLICT",
      path,
      `${label} ${value} mm is outside the compiled native range ` +
        `[${range.minMm}, ${range.maxMm}] mm.`,
      { requestedMm: value, nativeRangeMm: range },
    );
  }
}

function intersectRanges(
  diagnostics: RoutingDiagnostic[],
  path: string,
  label: string,
  ranges: readonly RuleRangeV1[],
): RuleRangeV1 | undefined {
  if (ranges.length === 0) return undefined;
  const minMm = Math.max(...ranges.map((range) => range.minMm));
  const maxMm = Math.min(...ranges.map((range) => range.maxMm));
  if (minMm > maxMm) {
    error(
      diagnostics,
      "RULE_CONFLICT",
      path,
      `${label} native rule ranges have an empty intersection.`,
      { ranges },
    );
    return undefined;
  }
  const preferredCandidates = ranges
    .map((range) => range.preferredMm)
    .filter((value) => value >= minMm && value <= maxMm);
  return {
    minMm,
    preferredMm: preferredCandidates[0] ?? minMm,
    maxMm,
  };
}

function clearanceDoesNotWeaken(
  diagnostics: RoutingDiagnostic[],
  path: string,
  requestedMm: number | undefined,
  nativeMinimumMm: number,
): void {
  if (requestedMm === undefined || requestedMm >= nativeMinimumMm) return;
  error(
    diagnostics,
    "RULE_CONFLICT",
    path,
    `Requested clearance ${requestedMm} mm is below the compiled native minimum ` +
      `${nativeMinimumMm} mm.`,
    { requestedMm, nativeMinimumMm },
  );
}

function maximumDoesNotWeaken(
  diagnostics: RoutingDiagnostic[],
  path: string,
  label: string,
  requestedMm: number | undefined,
  nativeMaximumMm: number | undefined,
): void {
  if (requestedMm === undefined || nativeMaximumMm === undefined || requestedMm <= nativeMaximumMm) {
    return;
  }
  error(
    diagnostics,
    "RULE_CONFLICT",
    path,
    `${label} ${requestedMm} mm is looser than the compiled native maximum ` +
      `${nativeMaximumMm} mm.`,
    { requestedMm, nativeMaximumMm },
  );
}

function viaInRange(
  diagnostics: RoutingDiagnostic[],
  path: string,
  requested: ViaConstraint | undefined,
  native: ViaRuleV1,
): void {
  if (!requested) return;
  explicitValueInRange(
    diagnostics,
    `${path}.diameterMm`,
    "Via diameter",
    requested.diameterMm,
    native.diameterMm,
  );
  explicitValueInRange(
    diagnostics,
    `${path}.drillMm`,
    "Via drill",
    requested.drillMm,
    native.drillMm,
  );

  const smallestPossibleDrill = requested.drillMm ?? native.drillMm.minMm;
  const largestPossibleDiameter = requested.diameterMm ?? native.diameterMm.maxMm;
  if (smallestPossibleDrill >= largestPossibleDiameter) {
    error(
      diagnostics,
      "RULE_CONFLICT",
      path,
      "Requested via constraints have no legal drill/diameter combination.",
      { requested, native },
    );
  }
}

function hasUsableImpedanceStackup(snapshot: PcbSnapshotV1): boolean {
  return snapshot.rawPcb.stackup.layers.some((layer) =>
    layer.kind === "dielectric" &&
    Number.isFinite(layer.thicknessMm) &&
    layer.thicknessMm > 0 &&
    typeof layer.relativePermittivity === "number" &&
    Number.isFinite(layer.relativePermittivity) &&
    layer.relativePermittivity > 0
  );
}

/**
 * Compile the portable DSL against one immutable board snapshot.
 *
 * This function performs no backend calls. It only checks board references,
 * rule intersections and capability requirements, so a conflict terminates
 * orchestration before an external router is started.
 */
export function preflightRoutingIntent(
  snapshot: PcbSnapshotV1,
  intent: RoutingIntentV2,
  options: RoutingIntentPreflightOptions = {},
): RoutingIntentPreflightResult {
  const diagnostics: RoutingDiagnostic[] = [];
  const required = new Set<RouterCapability>();
  if (options.routeUnqualifiedNets) required.add("ordinary-routing");

  const netsByName = new Map<string, PcbSnapshotV1["rawPcb"]["nets"][number]>();
  for (const [index, net] of snapshot.rawPcb.nets.entries()) {
    if (netsByName.has(net.name)) {
      error(
        diagnostics,
        "RULE_CONFLICT",
        `$.snapshot.rawPcb.nets[${index}].name`,
        `Net name ${JSON.stringify(net.name)} is ambiguous in RawPcb.`,
      );
    } else {
      netsByName.set(net.name, net);
    }
  }

  const syntax = validateRoutingIntent(intent, { knownNets: netsByName.keys() });
  diagnostics.push(...syntax.diagnostics);
  if (!syntax.valid) return { valid: false, requiredCapabilities: [], diagnostics };

  const rulesByNetId = new Map<string, CompiledRuleValuesV1>();
  snapshot.rawPcb.rules.byNet.forEach((entry, index) => {
    if (rulesByNetId.has(entry.netId)) {
      error(
        diagnostics,
        "RULE_CONFLICT",
        `$.snapshot.rawPcb.rules.byNet[${index}]`,
        `More than one compiled native rule exists for net id ${JSON.stringify(entry.netId)}.`,
      );
    } else {
      rulesByNetId.set(entry.netId, entry.values);
    }
  });

  const rulesForNet = (netName: string): CompiledRuleValuesV1 | undefined => {
    const net = netsByName.get(netName);
    return net ? (rulesByNetId.get(net.id) ?? snapshot.rawPcb.rules.global) : undefined;
  };

  const resolveLayers = (selector: LayerSelector, path: string): readonly string[] => {
    const resolved = selector.kind === "outer-layers"
      ? snapshot.rawPcb.layers
        .filter((layer) => layer.side === "top" || layer.side === "bottom")
        .map((layer) => layer.id)
      : selector.kind === "outer-layer"
        ? snapshot.rawPcb.layers
          .filter((layer) => layer.side === selector.side)
          .map((layer) => layer.id)
      : snapshot.rawPcb.layers
        .filter((layer) => layer.id === selector.layer || layer.name === selector.layer)
        .map((layer) => layer.id);
    const unique = [...new Set(resolved)];
    if (unique.length === 0) {
      error(
        diagnostics,
        "RULE_CONFLICT",
        path,
        selector.kind === "outer-layers"
          ? "RawPcb has no available outer copper layer."
          : selector.kind === "outer-layer"
            ? `RawPcb has no ${selector.side} outer copper layer.`
            : `Copper layer ${JSON.stringify(selector.layer)} is unavailable.`,
      );
    } else if (selector.kind !== "outer-layers" && unique.length > 1) {
      error(
        diagnostics,
        "RULE_CONFLICT",
        path,
        "Copper layer selector is ambiguous.",
        { layerIds: unique },
      );
    }
    return unique;
  };

  const checkImpedance = (
    impedance: ImpedanceConstraint | undefined,
    path: string,
  ): void => {
    if (!impedance) return;
    required.add("impedance-controlled");
    if (!hasUsableImpedanceStackup(snapshot)) {
      error(
        diagnostics,
        "UNSUPPORTED_CONSTRAINT",
        path,
        "Impedance control requires dielectric thickness and relative permittivity in RawPcb stackup.",
      );
    }
  };

  for (const [index, copper] of intent.copper.entries()) {
    const path = `$.copper[${index}]`;
    required.add("zones");
    resolveLayers(copper.layers, `${path}.layers`);
    if (copper.kind === "compact-polygon") {
      for (const [targetIndex, target] of copper.connect.entries()) {
        if (target.kind !== "pad") continue;
        const targetPath = `${path}.connect[${targetIndex}]`;
        const owners = snapshot.rawPcb.components.filter((component) => component.designator === target.component);
        if (owners.length !== 1) {
          error(diagnostics, "RULE_CONFLICT", targetPath, `Component ${JSON.stringify(target.component)} is absent or ambiguous.`);
          continue;
        }
        const pads = snapshot.rawPcb.pads.filter((pad) =>
          pad.componentId === owners[0].id && pad.number === target.pad
        );
        if (pads.length !== 1) {
          error(diagnostics, "RULE_CONFLICT", targetPath, `Pad ${target.component}.${target.pad} is absent or ambiguous.`);
          continue;
        }
        const polygonNet = netsByName.get(copper.net);
        if (pads[0].netId !== polygonNet?.id) {
          error(diagnostics, "RULE_CONFLICT", targetPath, `Pad ${target.component}.${target.pad} is not on net ${copper.net}.`);
        }
      }
    }
    if (copper.kind === "plane") {
      if (copper.region.kind === "components") {
        error(
          diagnostics,
          "UNSUPPORTED_CONSTRAINT",
          `${path}.region`,
          "components(...) regions are reserved by RoutingIntentV2 and are not implemented.",
        );
      }
      if (copper.stitching.enabled) {
        required.add("plane-stitching");
        required.add("vias");
        if (copper.stitching.via && copper.stitching.via !== "drc-min") {
          const native = rulesForNet(copper.net);
          if (native) viaInRange(
            diagnostics,
            `${path}.stitching.via`,
            copper.stitching.via,
            native.via,
          );
        }
      }
    }
  }

  for (const [index, netIntent] of intent.nets.entries()) {
    const path = `$.nets[${index}]`;
    const native = rulesForNet(netIntent.net);
    if (!native) continue;
    if (netIntent.kind === "power-net") {
      explicitValueInRange(
        diagnostics,
        `${path}.minTrackWidthMm`,
        "Minimum track width",
        netIntent.minTrackWidthMm,
        native.trackWidth,
      );
      if (netIntent.maxTrackWidthMm !== undefined &&
        netIntent.maxTrackWidthMm < native.trackWidth.minMm) {
        error(
          diagnostics,
          "RULE_CONFLICT",
          `${path}.maxTrackWidthMm`,
          `Maximum track width ${netIntent.maxTrackWidthMm} mm leaves no value at or above ` +
            `the native minimum ${native.trackWidth.minMm} mm.`,
        );
      }
      if (netIntent.minTrackWidthMm !== undefined &&
        netIntent.maxTrackWidthMm !== undefined &&
        netIntent.minTrackWidthMm > netIntent.maxTrackWidthMm) {
        error(
          diagnostics,
          "RULE_CONFLICT",
          path,
          "minTrackWidthMm exceeds maxTrackWidthMm.",
        );
      }
      if (netIntent.via) {
        required.add("vias");
        viaInRange(diagnostics, `${path}.via`, netIntent.via, native.via);
      }
      continue;
    }

    explicitValueInRange(
      diagnostics,
      `${path}.trackWidthMm`,
      "Track width",
      netIntent.trackWidthMm,
      native.trackWidth,
    );
    clearanceDoesNotWeaken(
      diagnostics,
      `${path}.clearanceMm`,
      netIntent.clearanceMm,
      native.clearanceMm,
    );
    if (netIntent.allowedLayers) resolveLayers(netIntent.allowedLayers, `${path}.allowedLayers`);
    if (netIntent.via) {
      required.add("vias");
      viaInRange(diagnostics, `${path}.via`, netIntent.via, native.via);
    }
    checkImpedance(netIntent.impedance, `${path}.impedance`);

    // RawPcbV1 intentionally has no compiled max-length field yet. When a
    // future capture provides one, enforce the same max-only intersection.
    const nativeMaximumLength = native.maxLengthMm;
    maximumDoesNotWeaken(
      diagnostics,
      `${path}.maxLengthMm`,
      "Maximum length",
      netIntent.maxLengthMm,
      nativeMaximumLength,
    );
  }

  const differentialPairs = new Map<string, DifferentialPairIntent>();
  for (const special of intent.special) {
    if (special.kind === "differential-pair") differentialPairs.set(special.id, special);
  }

  for (const [index, special] of intent.special.entries()) {
    const path = `$.special[${index}]`;
    if (special.kind === "matched-group") {
      required.add("matched-length");
      special.members.forEach((member, memberIndex) => {
        if (member.kind === "differential-pair" && !differentialPairs.has(member.id)) {
          error(
            diagnostics,
            "RULE_CONFLICT",
            `${path}.members[${memberIndex}].id`,
            `Differential-pair member ${JSON.stringify(member.id)} is not declared in this intent.`,
          );
        }
      });
      if (special.toleranceMm === undefined) {
        const memberNetIds = special.members.flatMap((member) => {
          if (member.kind === "net") return [netsByName.get(member.net)?.id].filter((id): id is string => Boolean(id));
          const pair = differentialPairs.get(member.id);
          return pair ? [netsByName.get(pair.positiveNet)?.id, netsByName.get(pair.negativeNet)?.id]
            .filter((id): id is string => Boolean(id)) : [];
        }).sort();
        const nativeGroup = snapshot.rawPcb.rules.matchedGroups?.find((group) =>
          [...group.netIds].sort().join("\u0000") === memberNetIds.join("\u0000")
        );
        if (!nativeGroup) {
          error(diagnostics, "UNSUPPORTED_CONSTRAINT", `${path}.toleranceMm`, "Matched-group tolerance is omitted and no exact compiled native group exists.");
        }
      }
      continue;
    }

    required.add("differential-pairs");
    const positiveRules = rulesForNet(special.positiveNet);
    const negativeRules = rulesForNet(special.negativeNet);
    if (!positiveRules || !negativeRules) continue;

    const trackWidthRange = intersectRanges(
      diagnostics,
      `${path}.trackWidthMm`,
      "Differential-pair track width",
      [positiveRules.trackWidth, negativeRules.trackWidth],
    );
    if (trackWidthRange) explicitValueInRange(
      diagnostics,
      `${path}.trackWidthMm`,
      "Differential-pair track width",
      special.trackWidthMm,
      trackWidthRange,
    );

    const pairRules = [positiveRules.diffPair, negativeRules.diffPair].filter(
      (value): value is NonNullable<CompiledRuleValuesV1["diffPair"]> => value !== undefined,
    );
    const gapRange = intersectRanges(
      diagnostics,
      `${path}.gapMm`,
      "Differential-pair gap",
      pairRules.map((nativePair) => nativePair.gapMm),
    );
    if (gapRange) explicitValueInRange(
      diagnostics,
      `${path}.gapMm`,
      "Differential-pair gap",
      special.gapMm,
      gapRange,
    );
    const nativeMaximumSkew = pairRules
      .map((nativePair) => nativePair.maxSkewMm)
      .filter((value): value is number => value !== undefined)
      .reduce<number | undefined>(
        (smallest, value) => smallest === undefined ? value : Math.min(smallest, value),
        undefined,
      );
    maximumDoesNotWeaken(
      diagnostics,
      `${path}.maxSkewMm`,
      "Maximum differential-pair skew",
      special.maxSkewMm,
      nativeMaximumSkew,
    );
    const nativeMaximumUncoupled = pairRules
      .map((nativePair) => nativePair.maxUncoupledLengthMm)
      .filter((value): value is number => value !== undefined)
      .reduce<number | undefined>(
        (smallest, value) => smallest === undefined ? value : Math.min(smallest, value),
        undefined,
      );
    maximumDoesNotWeaken(
      diagnostics,
      `${path}.maxUncoupledLengthMm`,
      "Maximum uncoupled length",
      special.maxUncoupledLengthMm,
      nativeMaximumUncoupled,
    );
    // Pair rules are fully compiled per net; the intersections above prevent
    // the backend from silently choosing one member's weaker values.
    if (special.allowedLayers) resolveLayers(special.allowedLayers, `${path}.allowedLayers`);
    checkImpedance(special.impedance, `${path}.impedance`);
  }

  const hasExistingCopper = snapshot.rawPcb.copper.tracks.length > 0 ||
    snapshot.rawPcb.copper.arcs.length > 0 ||
    snapshot.rawPcb.copper.vias.length > 0 ||
    snapshot.rawPcb.copper.zones.length > 0;
  if (hasExistingCopper || intent.copper.length > 0) required.add("preserve-existing-copper");

  const requiredCapabilities = CAPABILITY_ORDER.filter((capability) => required.has(capability));
  const declaredCapabilities = options.backendCapabilities === undefined
    ? undefined
    : new Set(
      Array.isArray(options.backendCapabilities)
        ? options.backendCapabilities as readonly RouterCapability[]
        : (options.backendCapabilities as RouterBackendCapabilities).supported,
    );
  if (declaredCapabilities) {
    const missing = requiredCapabilities.filter((capability) => !declaredCapabilities.has(capability));
    if (missing.length > 0) {
      error(
        diagnostics,
        "UNSUPPORTED_CONSTRAINT",
        "$.backendCapabilities",
        `Backend lacks required capabilities: ${missing.join(", ")}.`,
        { missing },
      );
    }
  }

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    requiredCapabilities,
    diagnostics,
  };
}
