import {
  parsePcbSource,
  serializePcb
} from "./chunk-GFOUZRQT.js";
import {
  runPolygonDsl
} from "./chunk-DDHTOAPW.js";
import {
  appendPlannedZones,
  isOctilinearBoundary,
  kicadToRawPcb,
  planPolygons,
  removeKicadZones,
  ringsFromRawPad
} from "./chunk-U26KEDMF.js";
import {
  clearRouting,
  netClassFor,
  readPcbRoutingRules
} from "./chunk-HGTCHW7P.js";
import {
  listChildren,
  readPcb
} from "./chunk-L7USXWVD.js";

// src/poly-test.ts
import { copyFile, mkdir, readFile, stat, writeFile } from "fs/promises";
import { basename, dirname, extname, resolve } from "path";

// src/polygon/render.ts
var escapeXml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function pathData(rings) {
  return rings.filter((ring) => ring.length >= 3).map((ring) => `M ${ring.map((point) => `${point.x} ${point.y}`).join(" L ")} Z`).join(" ");
}
var layerColor = (layer) => layer === "TOP" ? "#ff5d4a" : layer === "BOTTOM" ? "#3e91ff" : "#ad7bff";
function renderZonePlansSvg(pcb2, plans, options = {}) {
  var _a;
  const board = ((_a = pcb2.board) == null ? void 0 : _a.polygon) ?? [];
  if (board.length < 3) throw new Error("cannot render RawPcb without board outline");
  const layers = new Set(options.layers ?? ["TOP", "BOTTOM"]);
  const visiblePlans = plans.filter((plan) => layers.has(plan.layer) && plan.boundary);
  const margin = 3;
  const xs = board.map((point) => point.x);
  const ys = board.map((point) => point.y);
  const left = Math.min(...xs) - margin;
  const right = Math.max(...xs) + margin;
  const top = Math.min(...ys) - margin;
  const bottom = Math.max(...ys) + margin;
  const width = right - left;
  const height = bottom - top;
  const boundaries = visiblePlans.map((plan) => {
    const d = pathData([plan.boundary]);
    const ready = plan.status === "ready";
    const color = ready ? layerColor(plan.layer) : plan.status === "error" ? "#ff2d55" : "#ffb020";
    const title2 = ready ? `${plan.net} ${plan.layer} ${plan.intent.mode}` : `${plan.status.toUpperCase()} ${plan.net}: ${plan.reason}`;
    return `<path d="${d}" fill="${color}" fill-opacity="${ready ? 0.34 : 0.08}" stroke="${color}" stroke-width="${ready ? 0.12 : 0.22}" ${ready ? "" : 'stroke-dasharray="0.7 0.45"'}><title>${escapeXml(title2)}</title></path>`;
  }).join("\n");
  const pads = pcb2.pads.filter((pad) => pad.layer === "MULTI" || layers.has(pad.layer)).map((pad) => {
    const d = pathData(ringsFromRawPad(pad));
    const targeted = plans.some((plan) => plan.targetPads.some((target) => target.id && target.id === pad.id || target.component === pad.component && target.padNumber === pad.padNumber && target.x === pad.x && target.y === pad.y));
    const fill = targeted ? "#f7ca45" : "#d8dee9";
    const owner = pad.component ? `${pad.component}/` : "";
    return d ? `<path d="${d}" fill="${fill}" fill-opacity="0.9" stroke="#242b35" stroke-width="0.05"><title>${escapeXml(pad.net || "NPTH")} ${escapeXml(owner + pad.padNumber)}</title></path>` : "";
  }).join("\n");
  const title = options.title ?? "Native EDA zone boundary plans";
  const readyCount = visiblePlans.filter((plan) => plan.status === "ready").length;
  const skippedCount = visiblePlans.filter((plan) => plan.status === "skipped").length;
  const errorCount = visiblePlans.filter((plan) => plan.status === "error").length;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${Math.round(1200 * height / width)}" viewBox="${left} ${top} ${width} ${height}">
<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="#11151c"/>
<path d="${pathData([board])}" fill="#1b222c" stroke="#d8dee9" stroke-width="0.12"/>
<g>${boundaries}</g>
<g>${pads}</g>
<g font-family="Segoe UI,Arial,sans-serif" font-size="1.25" fill="#ffffff">
  <rect x="${left + 1}" y="${top + 0.7}" width="${Math.min(width - 2, 62)}" height="2.3" rx="0.4" fill="#080b10" fill-opacity="0.82"/>
  <text x="${left + 1.8}" y="${top + 2.25}">${escapeXml(title)} \xB7 ${readyCount} ready \xB7 ${skippedCount} skipped \xB7 ${errorCount} errors</text>
</g>
</svg>`;
}

// src/poly-test.ts
var sourceBoard = resolve(process.argv[2] ?? "D:\\MyProject\\kicad\\Powerbank\\Powerbank.kicad_pcb");
var dslPath = resolve(process.argv[3] ?? "examples/powerbank.polygons.js");
var resultDirectory = resolve(process.argv[4] ?? "results/poly-engine");
var sourceBase = basename(sourceBoard, extname(sourceBoard));
var projectDirectory = dirname(sourceBoard);
var cleanBoardPath = resolve(projectDirectory, `${sourceBase}.poly-clean.kicad_pcb`);
var generatedBoardPath = resolve(projectDirectory, `${sourceBase}.poly-generated.kicad_pcb`);
await mkdir(resultDirectory, { recursive: true });
var pcb = await readPcb(sourceBoard);
var cleanRoot = parsePcbSource(pcb.source);
var removedRouting = clearRouting(cleanRoot);
var removedZones = removeKicadZones(cleanRoot);
var cleanSource = serializePcb(cleanRoot);
await writeFile(cleanBoardPath, cleanSource);
if (listChildren(cleanRoot, "segment").length || listChildren(cleanRoot, "arc").length || listChildren(cleanRoot, "via").length) {
  throw new Error("clean test board still contains tracks/arcs/vias");
}
var raw = kicadToRawPcb(cleanRoot, { includeZones: false });
var dsl = await readFile(dslPath, "utf8");
var program = runPolygonDsl(dsl);
var routingRules = await readPcbRoutingRules(sourceBoard);
var geometryRulesForNet = (net) => {
  const className = netClassFor(routingRules, net);
  const rule = routingRules.classes.find((item) => item.name === className);
  const trackWidth = Math.max(routingRules.minimumTrackWidth, (rule == null ? void 0 : rule.trackWidth) ?? 0.2);
  return {
    obstacleClearanceMm: Math.max(routingRules.minimumClearance, (rule == null ? void 0 : rule.clearance) ?? 0.2),
    minimumCorridorWidthMm: trackWidth * 3
  };
};
var rssBefore = process.memoryUsage().rss;
var result = planPolygons(raw, program, { rulesForNet: geometryRulesForNet });
var rssAfter = process.memoryUsage().rss;
for (const plan of result.plans.filter((item) => item.status === "ready" && item.intent.mode === "compact")) {
  if (!plan.boundary || !isOctilinearBoundary(plan.boundary)) {
    throw new Error(`${plan.net} compact boundary contains an angle other than 0/45/90 degrees`);
  }
}
var clearanceForNet = (net) => {
  const className = netClassFor(routingRules, net);
  const rule = routingRules.classes.find((item) => item.name === className);
  return Math.max(routingRules.minimumClearance, (rule == null ? void 0 : rule.clearance) ?? 0.2);
};
var generatedRoot = parsePcbSource(cleanSource);
var generatedZones = appendPlannedZones(generatedRoot, result.plans, {
  clearanceForNet,
  minThickness: Math.max(0.05, routingRules.minimumTrackWidth)
});
await writeFile(generatedBoardPath, serializePcb(generatedRoot));
var copyProjectSidecars = async (targetBoardPath) => {
  const targetBase = targetBoardPath.replace(/\.kicad_pcb$/i, "");
  for (const extension of [".kicad_pro", ".kicad_dru"]) {
    const source = resolve(projectDirectory, `${sourceBase}${extension}`);
    try {
      await stat(source);
      await copyFile(source, `${targetBase}${extension}`);
    } catch {
    }
  }
};
await copyProjectSidecars(cleanBoardPath);
await copyProjectSidecars(generatedBoardPath);
var combinedSvg = renderZonePlansSvg(raw, result.plans, { title: "Powerbank \xB7 optimized power polygons \xB7 TOP + BOTTOM" });
var topSvg = renderZonePlansSvg(raw, result.plans, { layers: ["TOP"], title: "Powerbank \xB7 optimized power polygons \xB7 TOP" });
var bottomSvg = renderZonePlansSvg(raw, result.plans, { layers: ["BOTTOM"], title: "Powerbank \xB7 optimized power polygons \xB7 BOTTOM" });
var metrics = {
  sourceBoard,
  cleanBoardPath,
  generatedBoardPath,
  dslPath,
  resultDirectory,
  removedRouting,
  removedZones,
  generatedZones,
  input: {
    components: raw.components.length,
    pads: raw.pads.length,
    tracks: raw.tracks.length,
    arcs: raw.arcs.length,
    vias: raw.vias.length,
    polygons: raw.polygons.length
  },
  engine: result.metrics,
  rssDeltaBytes: rssAfter - rssBefore,
  plans: result.plans.map((plan) => ({
    net: plan.net,
    layer: plan.layer,
    mode: plan.intent.mode,
    status: plan.status,
    reason: plan.reason,
    targetPads: plan.targetPads.length,
    boundaryAreaMm2: plan.boundaryAreaMm2,
    boardAreaRatio: plan.boardAreaRatio,
    optimization: plan.optimization,
    warnings: plan.warnings
  }))
};
await Promise.all([
  writeFile(resolve(resultDirectory, "polygon-intent.json"), JSON.stringify(program, null, 2)),
  writeFile(resolve(resultDirectory, "raw-input.json"), JSON.stringify(raw, null, 2)),
  writeFile(resolve(resultDirectory, "zone-plans.json"), JSON.stringify(result.plans, null, 2)),
  writeFile(resolve(resultDirectory, "metrics.json"), JSON.stringify(metrics, null, 2)),
  writeFile(resolve(resultDirectory, "powerbank-polygons.svg"), combinedSvg),
  writeFile(resolve(resultDirectory, "powerbank-polygons-top.svg"), topSvg),
  writeFile(resolve(resultDirectory, "powerbank-polygons-bottom.svg"), bottomSvg)
]);
console.log(JSON.stringify(metrics, null, 2));
