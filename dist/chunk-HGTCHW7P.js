import {
  atom,
  childText,
  findChild,
  footprintAt,
  footprintLayer,
  footprintReference,
  isSExpressionList,
  listChildren,
  listHead,
  padNet,
  padNumber,
  pcbFootprints,
  token
} from "./chunk-L7USXWVD.js";

// ../kicad-copilot/src/pcb/router-rules.ts
import { readFile, readdir } from "fs/promises";
import { basename, dirname, extname, join, resolve } from "path";
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
function classRule(value) {
  const item = object(value);
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (!name) return void 0;
  return {
    name,
    clearance: finite(item.clearance, 0.2),
    trackWidth: finite(item.track_width, 0.25),
    viaDiameter: finite(item.via_diameter, 0.6),
    viaDrill: finite(item.via_drill, 0.3),
    diffPairWidth: finite(item.diff_pair_width, finite(item.track_width, 0.25)),
    diffPairGap: finite(item.diff_pair_gap, finite(item.clearance, 0.2))
  };
}
function assignments(value) {
  const output = {};
  for (const [net, assigned] of Object.entries(object(value))) {
    if (typeof assigned === "string") output[net] = assigned;
    else if (Array.isArray(assigned)) {
      const first = assigned.find((item) => typeof item === "string");
      if (first) output[net] = first;
    }
  }
  return output;
}
function patterns(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = object(entry);
    return typeof item.netclass === "string" && typeof item.pattern === "string" ? [{ netclass: item.netclass, pattern: item.pattern }] : [];
  });
}
function parseRoutingRules(source) {
  const root = object(JSON.parse(source));
  const netSettings = object(root.net_settings);
  const designSettings = object(object(root.board).design_settings);
  const globalRules = object(designSettings.rules);
  const classes = (Array.isArray(netSettings.classes) ? netSettings.classes : []).map(classRule).filter((value) => Boolean(value));
  if (!classes.some((item) => item.name === "Default")) {
    classes.push(classRule({ name: "Default" }));
  }
  return {
    minimumClearance: finite(globalRules.min_clearance, 0),
    minimumTrackWidth: finite(globalRules.min_track_width, 0),
    minimumViaDiameter: finite(globalRules.min_via_diameter, 0),
    minimumViaDrill: finite(globalRules.min_through_hole_diameter, 0),
    minimumViaAnnularWidth: finite(globalRules.min_via_annular_width, 0),
    copperEdgeClearance: finite(globalRules.min_copper_edge_clearance, 0),
    classes,
    assignments: assignments(netSettings.netclass_assignments),
    patterns: patterns(netSettings.netclass_patterns)
  };
}
async function findPcbProjectPath(pcbPath) {
  const absolute = resolve(pcbPath);
  const directory = dirname(absolute);
  const matching = join(directory, `${basename(absolute, extname(absolute))}.kicad_pro`);
  if (await readFile(matching, "utf8").then(() => true, () => false)) return matching;
  const candidates = (await readdir(directory, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".kicad_pro"));
  return candidates.length === 1 ? join(directory, candidates[0].name) : void 0;
}
async function readPcbRoutingRules(pcbPath) {
  const path = await findPcbProjectPath(pcbPath);
  if (!path) return parseRoutingRules("{}");
  return parseRoutingRules(await readFile(path, "utf8"));
}
function patternRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}
function netClassFor(rules, net) {
  const names = new Set(rules.classes.map((item) => item.name));
  const direct = rules.assignments[net];
  if (direct && names.has(direct)) return direct;
  const matched = rules.patterns.find((item) => names.has(item.netclass) && patternRegex(item.pattern).test(net));
  return (matched == null ? void 0 : matched.netclass) || "Default";
}

// ../kicad-copilot/src/pcb/router-adapter.ts
import { randomUUID } from "crypto";
function numberAt(node, index) {
  const value = Number(atom(node == null ? void 0 : node[index]));
  return Number.isFinite(value) ? value : 0;
}
function pointAt(node) {
  return { x: numberAt(node, 1), y: numberAt(node, 2) };
}
function samePoint(a, b) {
  return Math.abs(a.x - b.x) < 1e-5 && Math.abs(a.y - b.y) < 1e-5;
}
function polygonArea(points) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}
function closedClockwisePath(points) {
  const open = points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1] ? points.slice(0, -1) : [...points];
  const signedArea = open.reduce((sum, point, index) => {
    const next = open[(index + 1) % open.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
  if (signedArea > 0) open.reverse();
  return [...open, [...open[0]]];
}
function arcPoints(node) {
  const start = pointAt(findChild(node, "start"));
  const mid = pointAt(findChild(node, "mid"));
  const end = pointAt(findChild(node, "end"));
  const determinant = 2 * (start.x * (mid.y - end.y) + mid.x * (end.y - start.y) + end.x * (start.y - mid.y));
  if (Math.abs(determinant) < 1e-9) return [start, end];
  const start2 = start.x ** 2 + start.y ** 2;
  const mid2 = mid.x ** 2 + mid.y ** 2;
  const end2 = end.x ** 2 + end.y ** 2;
  const center = {
    x: (start2 * (mid.y - end.y) + mid2 * (end.y - start.y) + end2 * (start.y - mid.y)) / determinant,
    y: (start2 * (end.x - mid.x) + mid2 * (start.x - end.x) + end2 * (mid.x - start.x)) / determinant
  };
  const angle = (point) => Math.atan2(point.y - center.y, point.x - center.x);
  let from = angle(start);
  const through = angle(mid);
  let to = angle(end);
  const tau = Math.PI * 2;
  const normalized = (value) => (value % tau + tau) % tau;
  const ccwSpan = normalized(to - from);
  const ccwMid = normalized(through - from);
  if (ccwMid > ccwSpan) {
    while (to > from) to -= tau;
    if (to === from) to -= tau;
  } else {
    while (to < from) to += tau;
  }
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const count = Math.max(2, Math.ceil(Math.abs(to - from) * radius / 0.5));
  return Array.from({ length: count + 1 }, (_, index) => {
    const current = from + (to - from) * index / count;
    return { x: center.x + Math.cos(current) * radius, y: center.y + Math.sin(current) * radius };
  });
}
function edgeCutChains(root) {
  const edges = [];
  if (listChildren(root, "gr_curve").some((node) => childText(node, "layer") === "Edge.Cuts")) {
    throw new Error("Bezier Edge.Cuts are not supported by the local router");
  }
  for (const node of listChildren(root, "gr_line")) {
    if (childText(node, "layer") === "Edge.Cuts") edges.push([
      pointAt(findChild(node, "start")),
      pointAt(findChild(node, "end"))
    ]);
  }
  for (const node of listChildren(root, "gr_arc")) {
    if (childText(node, "layer") === "Edge.Cuts") edges.push(arcPoints(node));
  }
  for (const node of listChildren(root, "gr_rect")) {
    if (childText(node, "layer") !== "Edge.Cuts") continue;
    const start = pointAt(findChild(node, "start"));
    const end = pointAt(findChild(node, "end"));
    edges.push([
      start,
      { x: end.x, y: start.y },
      end,
      { x: start.x, y: end.y },
      start
    ]);
  }
  for (const node of listChildren(root, "gr_circle")) {
    if (childText(node, "layer") !== "Edge.Cuts") continue;
    const center = pointAt(findChild(node, "center"));
    const end = pointAt(findChild(node, "end"));
    const radius = Math.hypot(end.x - center.x, end.y - center.y);
    const count = Math.max(24, Math.ceil(Math.PI * 2 * radius / 0.5));
    edges.push(Array.from({ length: count + 1 }, (_, index) => {
      const angle = Math.PI * 2 * index / count;
      return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
    }));
  }
  for (const node of listChildren(root, "gr_poly")) {
    if (childText(node, "layer") !== "Edge.Cuts") continue;
    const points = listChildren(findChild(node, "pts") ?? [], "xy").map(pointAt);
    if (points.length >= 3) edges.push([...points, points[0]]);
  }
  const remaining = [...edges];
  const chains = [];
  while (remaining.length) {
    const chain = [...remaining.shift()];
    while (!samePoint(chain[0], chain.at(-1))) {
      const end = chain.at(-1);
      const index = remaining.findIndex((edge2) => samePoint(edge2[0], end) || samePoint(edge2.at(-1), end));
      if (index < 0) throw new Error("Edge.Cuts is not a closed outline");
      const edge = remaining.splice(index, 1)[0];
      if (samePoint(edge.at(-1), end)) edge.reverse();
      chain.push(...edge.slice(1));
    }
    chains.push(chain.slice(0, -1));
  }
  return chains;
}
function boardOutline(root) {
  const chains = edgeCutChains(root).filter((chain) => chain.length >= 3);
  if (!chains.length) throw new Error("PCB has no closed Edge.Cuts outline");
  chains.sort((a, b) => polygonArea(b) - polygonArea(a));
  const points = chains[0];
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  return {
    points,
    holes: chains.slice(1),
    transform: { centerX: (left + right) / 2, centerY: (top + bottom) / 2 }
  };
}
function toRouterPoint(point, transform) {
  return [point.x - transform.centerX, transform.centerY - point.y];
}
function fromRouterPoint(point, transform) {
  if (point.length < 2 || !point.slice(0, 2).every(Number.isFinite)) throw new Error("invalid router point");
  return { x: point[0] + transform.centerX, y: transform.centerY - point[1] };
}
function routerLayerId(name) {
  if (name === "F.Cu") return 1;
  if (name === "B.Cu") return 2;
  const match = /^In(\d+)\.Cu$/.exec(name);
  return match ? 14 + Number(match[1]) : void 0;
}
function kicadLayerName(id) {
  if (id === 1) return "F.Cu";
  if (id === 2) return "B.Cu";
  return id >= 15 ? `In${id - 14}.Cu` : void 0;
}
function copperLayers(root) {
  const layers = findChild(root, "layers");
  if (!layers) return ["F.Cu", "B.Cu"];
  return layers.slice(1).flatMap((item) => {
    if (!isSExpressionList(item)) return [];
    const name = atom(item[1]);
    return (name == null ? void 0 : name.endsWith(".Cu")) ? [name] : [];
  });
}
function padLayers(pad, availableLayers) {
  var _a;
  const layers = ((_a = findChild(pad, "layers")) == null ? void 0 : _a.slice(1).map(atom).filter((value) => Boolean(value))) ?? [];
  if (layers.some((layer) => layer === "*.Cu")) return availableLayers.map(routerLayerId).filter((id) => id !== void 0);
  return layers.map(routerLayerId).filter((id) => id !== void 0);
}
function rotatePoint(point, degrees) {
  const radians = degrees * Math.PI / 180;
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians)
  };
}
function padGeometry(pad) {
  const shape = atom(pad[3]) || "";
  if (!["circle", "rect", "oval", "roundrect"].includes(shape)) {
    throw new Error(`unsupported router pad shape: ${shape || "unknown"}`);
  }
  const at = findChild(pad, "at");
  const size = findChild(pad, "size");
  const center = { x: numberAt(at, 1), y: -numberAt(at, 2) };
  const width = Math.max(numberAt(size, 1), 0.05);
  const height = Math.max(numberAt(size, 2), 0.05);
  const rotation = -numberAt(at, 3);
  const corners = [
    { x: -width / 2, y: -height / 2 },
    { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 },
    { x: -width / 2, y: height / 2 }
  ].map((point) => rotatePoint(point, rotation)).map((point) => [point.x + center.x, point.y + center.y]);
  return { center, path: closedClockwisePath(corners) };
}
function nodeNetName(root, node) {
  const net = findChild(node, "net");
  if (!net) return "";
  if (net.length >= 3) return atom(net[2]) || "";
  const value = atom(net[1]) || "";
  if (!/^\d+$/.test(value)) return value;
  const found = listChildren(root, "net").find((item) => atom(item[1]) === value);
  return atom(found == null ? void 0 : found[2]) || "";
}
function routerRules(layers, classes) {
  return {
    safeClearances: Object.fromEntries(classes.map((item) => [item.id, [{
      layers,
      trackToTrack: item.clearance,
      trackToVia: item.clearance,
      trackToPad: item.clearance,
      trackToFillRegion: item.clearance,
      trackToProhibitedRegion: item.clearance,
      trackToBoardOutline: item.edgeClearance,
      viaToVia: item.clearance,
      viaToPad: item.clearance,
      viaToFillRegion: item.clearance,
      viaToProhibitedRegion: item.clearance,
      viaToBoardOutline: item.edgeClearance
    }]])),
    trackWidths: Object.fromEntries(classes.map((item) => [item.id, [{
      layers,
      trackWidth: [item.minimumTrackWidth, item.trackWidth, Math.max(item.trackWidth, 2.54)]
    }]])),
    viaSizes: Object.fromEntries(classes.map((item) => [
      `via_${item.id}`,
      [item.viaDiameter, item.viaDrill]
    ])),
    differentialPairs: Object.fromEntries(classes.map((item) => [
      `diff_${item.id}`,
      [{
        layers,
        lengthTolerance: 0.254,
        width: [item.minimumTrackWidth, item.diffPairWidth, Math.max(item.diffPairWidth, 2.54)],
        clearance: [item.diffPairGap, item.diffPairGap]
      }]
    ])),
    trackLengths: { netLength: [0, 0] }
  };
}
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function effectiveRouterClasses(nets, rules, overrides) {
  const fallback = {
    name: "Default",
    clearance: 0.2,
    trackWidth: 0.25,
    viaDiameter: 0.6,
    viaDrill: 0.3,
    diffPairWidth: 0.25,
    diffPairGap: 0.2
  };
  const source = rules || {
    minimumClearance: 0,
    minimumTrackWidth: 0,
    minimumViaDiameter: 0,
    minimumViaDrill: 0,
    minimumViaAnnularWidth: 0,
    copperEdgeClearance: 0,
    classes: [fallback],
    assignments: {},
    patterns: []
  };
  const byName = new Map(source.classes.map((item) => [item.name, item]));
  if (!byName.has("Default")) byName.set("Default", fallback);
  const grouped = /* @__PURE__ */ new Map();
  for (const net of nets) {
    const name = netClassFor(source, net);
    const values = grouped.get(name) || [];
    values.push(net);
    grouped.set(name, values);
  }
  if (!grouped.size) grouped.set("Default", []);
  return [...grouped].map(([name, classNets], index) => {
    const item = byName.get(name) || byName.get("Default");
    const clearance = Math.max(
      positive(overrides.clearance ?? item.clearance, 0.2),
      source.minimumClearance
    );
    const minimumTrackWidth = positive(
      source.minimumTrackWidth,
      positive(overrides.trackWidth ?? item.trackWidth, 0.25)
    );
    const trackWidth = Math.max(
      positive(overrides.trackWidth ?? item.trackWidth, 0.25),
      minimumTrackWidth
    );
    const viaDrill = Math.max(
      positive(overrides.viaDrill ?? item.viaDrill, 0.3),
      positive(source.minimumViaDrill, positive(overrides.viaDrill ?? item.viaDrill, 0.3))
    );
    const viaDiameter = Math.max(
      positive(overrides.viaDiameter ?? item.viaDiameter, 0.6),
      source.minimumViaDiameter,
      viaDrill + source.minimumViaAnnularWidth * 2
    );
    return {
      id: `kicad_class_${index}`,
      nets: classNets,
      clearance,
      edgeClearance: Math.max(clearance, source.copperEdgeClearance),
      minimumTrackWidth,
      trackWidth,
      viaDiameter,
      viaDrill,
      diffPairWidth: Math.max(positive(item.diffPairWidth, trackWidth), minimumTrackWidth),
      diffPairGap: Math.max(positive(item.diffPairGap, clearance), clearance)
    };
  });
}
function buildRouterInput(root, options) {
  const outline = boardOutline(root);
  const availableLayers = copperLayers(root);
  const selected = options.routeLayers.map((name) => {
    if (!availableLayers.includes(name)) throw new Error(`PCB copper layer not found: ${name}`);
    const id = routerLayerId(name);
    if (id === void 0) throw new Error(`unsupported routing layer: ${name}`);
    return id;
  });
  const allLayerIds = availableLayers.map(routerLayerId).filter((id) => id !== void 0);
  const ignored = new Set(options.ignoreNets);
  const components = {};
  const footprints = {};
  const netNames = /* @__PURE__ */ new Set();
  for (const [componentIndex, footprint] of pcbFootprints(root).entries()) {
    const reference = footprintReference(footprint) || `FP${componentIndex + 1}`;
    const footprintKey = `kicad_footprint_${componentIndex}`;
    const pads = {};
    const padPaths = [];
    const nets = {};
    const pinName = {};
    for (const [padIndex, pad] of listChildren(footprint, "pad").entries()) {
      const net = padNet(pad);
      if (net) netNames.add(net);
      const key = `p${padIndex}`;
      const geometry = padGeometry(pad);
      const layers = padLayers(pad, availableLayers);
      if (!layers.length) continue;
      pads[key] = {
        number: padNumber(pad) || String(padIndex + 1),
        layers,
        location: [geometry.center.x, geometry.center.y],
        path: geometry.path,
        diameter: null
      };
      padPaths.push(geometry.path);
      nets[key] = net;
      pinName[key] = padNumber(pad) || String(padIndex + 1);
    }
    if (!Object.keys(pads).length) continue;
    const at = footprintAt(footprint);
    const componentLocation = toRouterPoint(at, outline.transform);
    const componentRotation = (at.rotate % 360 + 360) % 360;
    components[reference] = {
      name: reference,
      footprint: footprintKey,
      layer: footprintLayer(footprint) === "B.Cu" ? 2 : 1,
      location: componentLocation,
      rotation: componentRotation,
      nets,
      pinName,
      reuseModules: { moduleName: "", groupID: "", channelID: reference }
    };
    const padPoints = padPaths.flat();
    footprints[footprintKey] = {
      pads,
      bbox: [
        Math.min(...padPoints.map((point) => point[0])),
        Math.max(...padPoints.map((point) => point[0])),
        Math.min(...padPoints.map((point) => point[1])),
        Math.max(...padPoints.map((point) => point[1]))
      ]
    };
  }
  const routedNets = [...netNames].filter((net) => !ignored.has(net));
  const classes = effectiveRouterClasses(routedNets, options.designRules, options);
  const classByNet = new Map(classes.flatMap((item) => item.nets.map((net) => [net, item])));
  const defaultClass = classes[0] || effectiveRouterClasses([""], options.designRules, options)[0];
  const tracks = listChildren(root, "segment").flatMap((segment, index) => {
    const net = nodeNetName(root, segment);
    const layer = routerLayerId(childText(segment, "layer") || "");
    if (!net || layer === void 0) return [];
    return [{
      id: `existing-${index}`,
      layer,
      net,
      path: [
        toRouterPoint(pointAt(findChild(segment, "start")), outline.transform),
        toRouterPoint(pointAt(findChild(segment, "end")), outline.transform)
      ],
      width: numberAt(findChild(segment, "width"), 1) || defaultClass.trackWidth
    }];
  });
  for (const [index, arc] of listChildren(root, "arc").entries()) {
    const net = nodeNetName(root, arc);
    const layer = routerLayerId(childText(arc, "layer") || "");
    if (!net || layer === void 0) continue;
    tracks.push({
      id: `existing-arc-${index}`,
      layer,
      net,
      path: arcPoints(arc).map((point) => toRouterPoint(point, outline.transform)),
      width: numberAt(findChild(arc, "width"), 1) || defaultClass.trackWidth
    });
  }
  const vias = listChildren(root, "via").flatMap((via, index) => {
    const net = nodeNetName(root, via);
    if (!net) return [];
    return [{
      id: `existing-${index}`,
      location: toRouterPoint(pointAt(findChild(via, "at")), outline.transform),
      net,
      size: [
        numberAt(findChild(via, "size"), 1) || defaultClass.viaDiameter,
        numberAt(findChild(via, "drill"), 1) || defaultClass.viaDrill
      ]
    }];
  });
  const routerOutline = closedClockwisePath(
    outline.points.map((point) => toRouterPoint(point, outline.transform))
  );
  const xs = routerOutline.map((point) => point[0]);
  const ys = routerOutline.map((point) => point[1]);
  const input = {
    boardOutline: { bbox: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], path: routerOutline },
    layers: {
      route: selected,
      notRoute: allLayerIds.filter((id) => !selected.includes(id))
    },
    routingCorner: "45",
    rules: routerRules(selected, classes),
    classes: {
      netClasses: Object.fromEntries(classes.map((item) => [item.id, item.nets])),
      differentialPairClasses: {},
      netClearancesClasses: Object.fromEntries(classes.map((item) => [item.id, item.nets]))
    },
    nets: routedNets.map((net) => {
      const item = classByNet.get(net) || defaultClass;
      return {
        net,
        routing: true,
        safeClearance: item.id,
        trackWidth: item.id,
        viaSize: `via_${item.id}`,
        differentialPair: `diff_${item.id}`,
        trackLength: "netLength"
      };
    }),
    components,
    footprints,
    constraintRegions: {},
    tracks,
    vias,
    fillRegions: [],
    prohibitedRegions: outline.holes.map((hole) => ({
      path: [...hole, hole[0]].map((point) => toRouterPoint(point, outline.transform)),
      layers: allLayerIds
    })),
    ...options.speedFirst ? { iterationCount: 2 } : {}
  };
  return { input, transform: outline.transform, routedNets };
}
function netForm(root, version, name) {
  if (version >= 2025e4) return [token("net"), token(name, true)];
  const existing = listChildren(root, "net").find((item) => atom(item[2]) === name);
  if (!existing) throw new Error(`router returned unknown net: ${name}`);
  return [token("net"), token(atom(existing[1]) || "0")];
}
function applyRouterResult(root, version, result, transform, routeLayers) {
  if (Number(result.progress ?? 0) < 1) throw new Error("auto router did not complete");
  const allowedLayers = new Set(routeLayers);
  const knownNets = /* @__PURE__ */ new Set();
  for (const footprint of pcbFootprints(root)) {
    for (const pad of listChildren(footprint, "pad")) {
      const net = padNet(pad);
      if (net) knownNets.add(net);
    }
  }
  let segments = 0;
  for (const trace of result.traces ?? []) {
    const layer = kicadLayerName(Number(trace.layer));
    if (!layer || !allowedLayers.has(layer)) throw new Error(`router returned disallowed layer: ${trace.layer}`);
    if (!knownNets.has(trace.net)) throw new Error(`router returned unknown net: ${trace.net}`);
    if (!Number.isFinite(trace.width) || trace.width <= 0 || !Array.isArray(trace.path) || trace.path.length < 2) {
      throw new Error("router returned invalid trace");
    }
    for (let index = 0; index < trace.path.length - 1; index += 1) {
      const start = fromRouterPoint(trace.path[index], transform);
      const end = fromRouterPoint(trace.path[index + 1], transform);
      if (samePoint(start, end)) continue;
      root.push([
        token("segment"),
        [token("start"), token(String(start.x)), token(String(start.y))],
        [token("end"), token(String(end.x)), token(String(end.y))],
        [token("width"), token(String(trace.width))],
        [token("layer"), token(layer, true)],
        netForm(root, version, trace.net),
        [token("uuid"), token(randomUUID(), true)]
      ]);
      segments += 1;
    }
  }
  let vias = 0;
  for (const via of result.vias ?? []) {
    if (!knownNets.has(via.net)) throw new Error(`router returned unknown net: ${via.net}`);
    if (!Array.isArray(via.size) || via.size.length < 2 || via.size.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error("router returned invalid via");
    }
    const at = fromRouterPoint(via.location, transform);
    root.push([
      token("via"),
      [token("at"), token(String(at.x)), token(String(at.y))],
      [token("size"), token(String(via.size[0]))],
      [token("drill"), token(String(via.size[1]))],
      [token("layers"), token("F.Cu", true), token("B.Cu", true)],
      netForm(root, version, via.net),
      [token("uuid"), token(randomUUID(), true)]
    ]);
    vias += 1;
  }
  return { segments, vias };
}
function clearRouting(root, options = {}) {
  const only = new Set(options.onlyNets ?? []);
  const ignored = new Set(options.ignoreNets ?? []);
  const removedIds = /* @__PURE__ */ new Set();
  let removed = 0;
  for (let index = root.length - 1; index >= 0; index -= 1) {
    const node = root[index];
    if (!isSExpressionList(node) || !["segment", "arc", "via"].includes(listHead(node) || "")) continue;
    const net = nodeNetName(root, node);
    if (ignored.has(net) || only.size && !only.has(net)) continue;
    const id = childText(node, "uuid") || childText(node, "tstamp");
    if (id) removedIds.add(id);
    root.splice(index, 1);
    removed += 1;
  }
  for (let index = root.length - 1; index >= 0; index -= 1) {
    const group = root[index];
    if (!isSExpressionList(group) || listHead(group) !== "group") continue;
    const members = findChild(group, "members");
    if (!members) continue;
    for (let memberIndex = members.length - 1; memberIndex >= 1; memberIndex -= 1) {
      if (removedIds.has(atom(members[memberIndex]) || "")) members.splice(memberIndex, 1);
    }
    if (members.length === 1 && (atom(group[1]) || "").startsWith("kicad-copilot:stitch:")) {
      root.splice(index, 1);
    }
  }
  return removed;
}

export {
  findPcbProjectPath,
  readPcbRoutingRules,
  netClassFor,
  boardOutline,
  buildRouterInput,
  applyRouterResult,
  clearRouting
};
