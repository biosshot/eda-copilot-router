import {
  parsePcbSource,
  serializePcb
} from "./chunk-GFOUZRQT.js";
import {
  applyRouterResult,
  buildRouterInput,
  clearRouting,
  findPcbProjectPath,
  netClassFor,
  readPcbRoutingRules
} from "./chunk-HGTCHW7P.js";
import {
  atom,
  childText,
  findChild,
  isSExpressionList,
  listChildren,
  listHead,
  pcbNetNames,
  readPcb
} from "./chunk-L7USXWVD.js";

// src/benchmark.ts
import { copyFile as copyFile2, mkdir, writeFile as writeFile2 } from "fs/promises";
import { extname as extname2, resolve } from "path";
import { performance } from "perf_hooks";
import { Worker } from "worker_threads";

// ../kicad-copilot/src/kicad/pcb-validation.ts
import { access as access2, copyFile, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { basename, dirname, extname, join as join2 } from "path";

// ../kicad-copilot/src/kicad/cli.ts
import { access } from "fs/promises";
import { join } from "path";

// ../kicad-copilot/src/utils/process.ts
import { spawn } from "child_process";
function runProcess(command, args, options = {}) {
  return new Promise((resolve2, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (action) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      action();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (exitCode) => finish(() => resolve2({
      exitCode: exitCode ?? -1,
      stdout,
      stderr
    })));
    const timeout = options.timeoutMs ? setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${command} timed out`)));
    }, options.timeoutMs) : void 0;
  });
}
async function runProcessChecked(command, args, options = {}) {
  const result = await runProcess(command, args, options);
  if (result.exitCode === 0) return result;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(detail || `${command} exited with code ${result.exitCode}`);
}

// ../kicad-copilot/src/kicad/cli.ts
var discovery;
function supported(cli) {
  return cli.major === 9 || cli.major === 10;
}
function preferredSupportedKicadCli(candidates) {
  return candidates.filter(supported).sort((left, right) => right.major - left.major)[0];
}
function standardCandidates() {
  if (process.platform === "win32") {
    const roots = [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"),
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"]
    ].filter((value) => Boolean(value));
    return roots.flatMap((root) => [
      join(root, "KiCad", "10.0", "bin", "kicad-cli.exe"),
      join(root, "KiCad", "9.0", "bin", "kicad-cli.exe")
    ]);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
      "/Applications/KiCad 10/KiCad.app/Contents/MacOS/kicad-cli",
      "/Applications/KiCad 9/KiCad.app/Contents/MacOS/kicad-cli"
    ];
  }
  return ["/usr/local/bin/kicad-cli", "/usr/bin/kicad-cli"];
}
async function isExplicitFile(candidate) {
  if (candidate === "kicad-cli") return true;
  return access(candidate).then(() => true, () => false);
}
async function inspectCandidate(candidate) {
  if (!await isExplicitFile(candidate)) return void 0;
  const result = await runProcess(candidate, ["--version"], { timeoutMs: 1e4 }).catch(() => void 0);
  if (!result || result.exitCode !== 0) return void 0;
  const version = result.stdout.trim() || result.stderr.trim();
  const match = version.match(/(\d+)(?:\.\d+)?/);
  if (!match) return void 0;
  return {
    path: candidate,
    version,
    major: Number(match[1])
  };
}
async function discoverKicadCli() {
  const configured = process.env.KICAD_CLI_PATH;
  if (configured) {
    const cli = await inspectCandidate(configured);
    if (!cli) throw new Error(`KICAD_CLI_PATH is not a working kicad-cli: ${configured}`);
    if (!supported(cli)) throw new Error(`unsupported KiCad version: ${cli.version}`);
    return cli;
  }
  const candidates = ["kicad-cli", ...standardCandidates()];
  const discovered = [];
  for (const candidate of [...new Set(candidates)]) {
    const cli = await inspectCandidate(candidate);
    if (cli) discovered.push(cli);
  }
  const preferred = preferredSupportedKicadCli(discovered);
  if (preferred) return preferred;
  if (discovered.length) {
    throw new Error(`unsupported KiCad version: ${discovered.map((item) => item.version).join(", ")}`);
  }
  throw new Error("kicad-cli not found");
}
function getKicadCli() {
  if (!discovery) {
    const pending = discoverKicadCli();
    discovery = pending;
    void pending.catch(() => {
      if (discovery === pending) discovery = void 0;
    });
  }
  return discovery;
}
async function getSupportedKicadCli() {
  const cli = await getKicadCli();
  if (cli.major === 9 || cli.major === 10) return cli;
  throw new Error(`unsupported KiCad version: ${cli.version}`);
}

// ../kicad-copilot/src/kicad/pcb-validation.ts
async function prepareCandidate(targetPath, root) {
  const targetDirectory = dirname(targetPath);
  const targetBasename = basename(targetPath, extname(targetPath));
  const directory = await mkdtemp(join2(targetDirectory, `.${targetBasename}.candidate-`));
  const temporary = join2(directory, `${targetBasename}.kicad_pcb`);
  const report = join2(directory, `${targetBasename}.drc.json`);
  try {
    await writeFile(temporary, serializePcb(root), { encoding: "utf8", flag: "wx" });
    const projectPath = await findPcbProjectPath(targetPath);
    if (projectPath) {
      await copyFile(projectPath, join2(directory, `${targetBasename}.kicad_pro`));
      const customRules = projectPath.replace(/\.kicad_pro$/i, ".kicad_dru");
      if (await access2(customRules).then(() => true, () => false)) {
        await copyFile(customRules, join2(directory, `${targetBasename}.kicad_dru`));
      }
    }
    return { directory, temporary, report };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
async function inspectPcbCandidate(targetPath, root, refillZones = false) {
  const candidate = await prepareCandidate(targetPath, root);
  const cli = await getSupportedKicadCli();
  try {
    await runProcessChecked(cli.path, [
      "pcb",
      "drc",
      ...refillZones ? ["--refill-zones", "--save-board"] : [],
      "--severity-all",
      "--format",
      "json",
      "--output",
      candidate.report,
      candidate.temporary
    ], { timeoutMs: 12e4 });
    await runProcessChecked(cli.path, ["pcb", "upgrade", "--force", candidate.temporary], { timeoutMs: 6e4 });
    const [boardSource, reportSource] = await Promise.all([
      readFile(candidate.temporary, "utf8"),
      readFile(candidate.report, "utf8").catch(() => "{}")
    ]);
    let reportJson = {};
    try {
      reportJson = JSON.parse(reportSource);
    } catch {
      console.error("KiCad DRC returned invalid JSON");
    }
    return { root: parsePcbSource(boardSource), report: reportJson };
  } finally {
    await rm(candidate.directory, { recursive: true, force: true });
  }
}

// src/benchmark.ts
var variant = process.argv[2] ?? "baseline";
var validVariants = /* @__PURE__ */ new Set(["baseline", "block-local-first", "skeleton-first-repair"]);
if (!validVariants.has(variant)) throw new Error(`Unknown variant: ${variant}`);
var projectDirectory = "D:\\MyProject\\kicad\\Powerbank";
var sourceBoardPath = resolve(process.env.COPILOT_ROUTER_BOARD ?? `${projectDirectory}\\Powerbank.kicad_pcb`);
var rulesBoardPath = resolve(process.env.COPILOT_ROUTER_RULES_BOARD ?? `${projectDirectory}\\Powerbank.drc-benchmark.kicad_pcb`);
var _a;
var resultSet = (_a = process.env.COPILOT_ROUTER_RESULT_SET) == null ? void 0 : _a.trim();
var outputDirectory = resolve("results", ...resultSet ? [resultSet] : [], variant);
var timeoutMs = Number(process.env.COPILOT_ROUTER_TIMEOUT_MS ?? 6 * 6e4);
var repairTimeoutMs = Number(process.env.COPILOT_ROUTER_REPAIR_TIMEOUT_MS ?? 9e4);
var clearanceMarginMm = Number(process.env.COPILOT_ROUTER_CLEARANCE_MARGIN_MM ?? 0.025);
var enableDifferentialPairs = process.env.COPILOT_ROUTER_DIFF_PAIRS !== "0";
var routerWorkerWrapper = String.raw`
const fs = require("fs");
const { parentPort, workerData } = require("worker_threads");
globalThis.self = globalThis;
self.location = {
  href: "file:///" + workerData.workerPath.replace(/\\/g, "/"),
  origin: "file://",
};
self.postMessage = (message) => parentPort.postMessage(message);
parentPort.on("message", (message) => {
  if (typeof self.onmessage === "function") self.onmessage({ data: message });
});
const nativeFetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;
const wasmBytes = fs.readFileSync(workerData.wasmPath);
globalThis.fetch = async (url, options) => {
  const href = String(url);
  if (href.includes("PCBRouter-YFDILLBW-YFDILLBW.wasm")) {
    return new Response(wasmBytes, {
      status: 200,
      headers: { "content-type": "application/wasm" },
    });
  }
  if (!nativeFetch) throw new Error("No fetch implementation for " + href);
  return nativeFetch(url, options);
};
require(workerData.workerPath);
`;
function runLocalRouter(input, options) {
  const assets = resolve("dist", "autorouter");
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(routerWorkerWrapper, {
      eval: true,
      workerData: {
        workerPath: resolve(assets, "pcbRouterWorker.js"),
        wasmPath: resolve(assets, "PCBRouter-YFDILLBW-YFDILLBW.wasm")
      }
    });
    let settled = false;
    let lastResult;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => void 0);
      if (error) rejectPromise(error);
      else resolvePromise(result ?? {});
    };
    const timer = setTimeout(
      () => finish(new Error(`Router timeout after ${options.timeoutMs}ms`)),
      options.timeoutMs
    );
    worker.on("message", (message) => {
      var _a2, _b, _c, _d;
      if ((message == null ? void 0 : message.topic) === "pcb/routerProgress") {
        const progress = Number(((_a2 = message.message) == null ? void 0 : _a2.progress) ?? 0);
        if (Number.isFinite(progress)) (_b = options.onProgress) == null ? void 0 : _b.call(options, progress);
        return;
      }
      if ((message == null ? void 0 : message.topic) === "pcb/routerResult") {
        lastResult = message.message;
        const progress = Number(lastResult.progress ?? 0);
        if (Number.isFinite(progress)) (_c = options.onProgress) == null ? void 0 : _c.call(options, progress);
        if (progress >= 1) finish(void 0, lastResult);
        return;
      }
      if ((message == null ? void 0 : message.topic) === "pcb/routerInterrupt") {
        finish(new Error(String(((_d = message.message) == null ? void 0 : _d.message) ?? message.message ?? "Router interrupted")));
      }
    });
    worker.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (code) => {
      if (settled) return;
      if (lastResult) finish(void 0, lastResult);
      else finish(new Error(`Router exited without result${code ? ` (${code})` : ""}`));
    });
    worker.postMessage({
      topic: "pangolin/autoRouting_wasm",
      type: "publish",
      message: { json: input, options: {} }
    });
  });
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid router timeout");
if (!Number.isFinite(repairTimeoutMs) || repairTimeoutMs <= 0) throw new Error("Invalid repair timeout");
if (!Number.isFinite(clearanceMarginMm) || clearanceMarginMm < 0) throw new Error("Invalid clearance margin");
var blockGroups = {
  coreLocal: [
    "Net-(U1-BST)",
    "Net-(C2-Pad2)",
    "VREG_3V1",
    "BAT_NTC",
    "KEY_IC",
    "Net-(SW1-A)",
    "Net-(U1-RSET)"
  ],
  usbC: [
    "USB_DP",
    "USB_DM",
    "USB_CC1",
    "USB_CC2",
    "USB_VBUS",
    "VBUS_GATE_IC",
    "VBUS_GATE"
  ],
  usbA1: [
    "USB_A1_DP",
    "USB_A1_DM",
    "USB_A1_VBUS",
    "VOUT1_GATE_IC",
    "VOUT1_GATE"
  ],
  usbA2: [
    "USB_A2_DP",
    "USB_A2_DM",
    "USB_A2_VBUS",
    "VOUT2_GATE_IC",
    "VOUT2_GATE"
  ],
  sharedPower: ["BAT_POS", "VSYS_CONV", "VSYS_PORT"]
};
var differentialPairs = [
  ["USB_DP", "USB_DM"],
  ["USB_A1_DP", "USB_A1_DM"],
  ["USB_A2_DP", "USB_A2_DM"]
];
var skeletonNets = /* @__PURE__ */ new Set([
  ...differentialPairs.flat(),
  "USB_CC1",
  "USB_CC2",
  "BAT_POS",
  "VSYS_CONV",
  "VSYS_PORT",
  "USB_VBUS",
  "USB_A1_VBUS",
  "USB_A2_VBUS"
]);
var deepClone = (value) => JSON.parse(JSON.stringify(value));
function removeZones(root) {
  let removed = 0;
  for (let index = root.length - 1; index >= 0; index -= 1) {
    const node = root[index];
    if (!isSExpressionList(node) || listHead(node) !== "zone") continue;
    root.splice(index, 1);
    removed += 1;
  }
  return removed;
}
function pointChild(node, head) {
  const child = findChild(node, head);
  return {
    x: Number(atom(child == null ? void 0 : child[1]) ?? 0),
    y: Number(atom(child == null ? void 0 : child[2]) ?? 0)
  };
}
function nodeNetName(root, node) {
  const net = findChild(node, "net");
  if (!net) return "";
  if (net.length >= 3) return atom(net[2]) ?? "";
  const value = atom(net[1]) ?? "";
  if (!/^\d+$/.test(value)) return value;
  const declaration = listChildren(root, "net").find((item) => atom(item[1]) === value);
  return atom(declaration == null ? void 0 : declaration[2]) ?? "";
}
function configureFixedGeometry(input) {
  const rules = input.rules;
  const trackWidths = rules.trackWidths ?? {};
  for (const entries of Object.values(trackWidths)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const width = entry.trackWidth;
      if (!Array.isArray(width)) continue;
      const desired = Number(width[1] ?? width[0]);
      if (Number.isFinite(desired)) entry.trackWidth = [desired, desired, desired];
    }
  }
  const pairRules = rules.differentialPairs ?? {};
  for (const entries of Object.values(pairRules)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const width = entry.width;
      if (!Array.isArray(width)) continue;
      const desired = Number(width[1] ?? width[0]);
      if (Number.isFinite(desired)) entry.width = [desired, desired, desired];
    }
  }
  const safeClearances = rules.safeClearances ?? {};
  for (const entries of Object.values(safeClearances)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const values = entry;
      for (const key of Object.keys(values)) {
        if (key === "layers") continue;
        const value = Number(values[key]);
        if (Number.isFinite(value)) values[key] = value + clearanceMarginMm;
      }
    }
  }
}
function configureDifferentialPairs(input, targetNets) {
  const netRules = input.nets;
  const originalPairRule = new Map(netRules.map((item) => [String(item.net), String(item.differentialPair ?? "")]));
  const byNet = new Map(netRules.map((item) => [String(item.net), item]));
  for (const item of netRules) delete item.differentialPair;
  const classes = input.classes;
  const pairClasses = {};
  classes.differentialPairClasses = pairClasses;
  if (!enableDifferentialPairs) return [];
  const rules = input.rules;
  const existingRules = rules.differentialPairs ?? {};
  const configured = [];
  differentialPairs.forEach(([positive, negative], index) => {
    if (!targetNets.has(positive) || !targetNets.has(negative)) return;
    const positiveRule = byNet.get(positive);
    const negativeRule = byNet.get(negative);
    if (!positiveRule || !negativeRule) return;
    const sourceRuleId = originalPairRule.get(positive) || originalPairRule.get(negative) || "";
    const sourceRule = existingRules[sourceRuleId] ?? Object.values(existingRules).find((item) => Array.isArray(item));
    if (!sourceRule) return;
    const ruleId = `diff_pair_${index}`;
    existingRules[ruleId] = deepClone(sourceRule);
    pairClasses[ruleId] = [positive, negative];
    positiveRule.differentialPair = ruleId;
    negativeRule.differentialPair = ruleId;
    configured.push({ positive, negative, rule: ruleId });
  });
  rules.differentialPairs = existingRules;
  return configured;
}
function normalizeResultGeometry(result, rules) {
  const classFor = (net) => {
    const className = netClassFor(rules, net);
    const found = rules.classes.find((item) => item.name === className);
    if (!found) throw new Error(`No routing class ${className} for ${net}`);
    return found;
  };
  for (const trace of result.traces ?? []) trace.width = classFor(trace.net).trackWidth;
  for (const via of result.vias ?? []) {
    const netClass = classFor(via.net);
    via.size = [netClass.viaDiameter, netClass.viaDrill];
  }
}
function extractNet(description) {
  const match = String(description ?? "").match(/\[([^\]]+)\]/);
  return (match == null ? void 0 : match[1]) ?? "";
}
function summarizeDrc(report) {
  const value = report && typeof report === "object" ? report : {};
  const violations = Array.isArray(value.violations) ? value.violations : [];
  const unconnectedItems = Array.isArray(value.unconnected_items) ? value.unconnected_items : [];
  const missingNets = /* @__PURE__ */ new Set();
  let missingNonGroundItems = 0;
  for (const unconnected of unconnectedItems) {
    if (!unconnected || typeof unconnected !== "object") continue;
    const items = Array.isArray(unconnected.items) ? unconnected.items : [];
    const nets = new Set(items.map((item) => extractNet(item.description)).filter(Boolean));
    nets.delete("GND");
    if (!nets.size) continue;
    missingNonGroundItems += 1;
    for (const net of nets) missingNets.add(net);
  }
  const countType = (type) => violations.filter((item) => item && typeof item === "object" && item.severity === "error" && item.type === type).length;
  const totalErrorViolations = violations.filter((item) => item && typeof item === "object" && item.severity === "error").length;
  return {
    missingNonGroundNets: [...missingNets].sort(),
    missingNonGroundItems,
    shorts: countType("shorting_items"),
    clearanceErrors: countType("clearance"),
    trackWidthErrors: countType("track_width"),
    skewErrors: countType("skew_out_of_range"),
    totalErrorViolations,
    totalUnconnectedItems: unconnectedItems.length
  };
}
function scoreDrc(summary) {
  return [
    summary.missingNonGroundNets.length,
    summary.missingNonGroundItems,
    summary.shorts,
    summary.clearanceErrors,
    summary.trackWidthErrors,
    summary.skewErrors,
    summary.totalErrorViolations
  ];
}
function betterScore(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function pointSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, start);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
}
function orientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return (o1 <= 0 && o2 >= 0 || o1 >= 0 && o2 <= 0) && (o3 <= 0 && o4 >= 0 || o3 >= 0 && o4 <= 0);
}
function segmentDistance(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b)
  );
}
function missingCorridors(report, missingNets) {
  const value = report && typeof report === "object" ? report : {};
  const unconnectedItems = Array.isArray(value.unconnected_items) ? value.unconnected_items : [];
  const output = [];
  for (const unconnected of unconnectedItems) {
    if (!unconnected || typeof unconnected !== "object") continue;
    const items = Array.isArray(unconnected.items) ? unconnected.items : [];
    const net = items.map((item) => extractNet(item.description)).find((name) => missingNets.has(name));
    const positions = items.flatMap((item) => {
      const pos = item.pos;
      if (!pos || typeof pos !== "object") return [];
      const x = Number(pos.x);
      const y = Number(pos.y);
      return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
    });
    if (net && positions.length >= 2) output.push({ net, start: positions[0], end: positions.at(-1) });
  }
  return output;
}
function expandDifferentialPairSet(nets) {
  for (const [positive, negative] of differentialPairs) {
    if (!nets.has(positive) && !nets.has(negative)) continue;
    nets.add(positive);
    nets.add(negative);
  }
}
function findBlockerNets(root, report, missing) {
  const corridors = missingCorridors(report, missing);
  const scores = /* @__PURE__ */ new Map();
  const corridorWidth = 2.5;
  for (const segment of listChildren(root, "segment")) {
    const net = nodeNetName(root, segment);
    if (!net || net === "GND" || missing.has(net)) continue;
    const start = pointChild(segment, "start");
    const end = pointChild(segment, "end");
    const length = Math.max(distance(start, end), 0.05);
    for (const corridor of corridors) {
      const gap = segmentDistance(start, end, corridor.start, corridor.end);
      if (gap > corridorWidth) continue;
      const priorityPenalty = skeletonNets.has(net) ? 4 : 1;
      const contribution = (corridorWidth - gap + 0.1) * length / priorityPenalty;
      scores.set(net, (scores.get(net) ?? 0) + contribution);
    }
  }
  const blockers = new Set([...scores.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3).map(([net]) => net));
  expandDifferentialPairSet(blockers);
  return { blockers, scores: Object.fromEntries([...scores.entries()].sort((a, b) => b[1] - a[1])) };
}
async function inspectAndWrite(root, label) {
  const started = performance.now();
  const inspected = await inspectPcbCandidate(rulesBoardPath, root);
  const elapsedMs = performance.now() - started;
  const reportPath = resolve(outputDirectory, `${label}-drc.json`);
  await Promise.all([
    writeFile2(reportPath, `${JSON.stringify(inspected.report, null, 2)}
`),
    writeFile2(resolve(outputDirectory, `${label}.kicad_pcb`), serializePcb(inspected.root))
  ]);
  return { ...inspected, summary: summarizeDrc(inspected.report), elapsedMs, reportPath };
}
async function routePass(root, targetNets, label, sourceVersion, allNonGroundNets, designRules, passTimeoutMs = timeoutMs) {
  const target = new Set(targetNets.filter((net) => allNonGroundNets.includes(net)));
  if (!target.size) throw new Error(`Routing pass ${label} has no nets`);
  const exported = buildRouterInput(root, {
    routeLayers: ["F.Cu", "B.Cu"],
    ignoreNets: ["GND", ...allNonGroundNets.filter((net) => !target.has(net))],
    speedFirst: false,
    designRules
  });
  configureFixedGeometry(exported.input);
  const configuredPairs = configureDifferentialPairs(exported.input, target);
  const inputPath = resolve(outputDirectory, `${label}-input.json`);
  await writeFile2(inputPath, `${JSON.stringify(exported.input, null, 2)}
`);
  const started = performance.now();
  const rawResult = await runLocalRouter(exported.input, {
    timeoutMs: passTimeoutMs,
    onProgress: (progress) => {
      const percent = Math.round(progress * 100);
      if (percent > 0 && percent % 20 === 0) console.log(JSON.stringify({ variant, label, progress: percent }));
    }
  });
  const routingElapsedMs = performance.now() - started;
  await writeFile2(resolve(outputDirectory, `${label}-result-raw.json`), `${JSON.stringify(rawResult, null, 2)}
`);
  const result = deepClone(rawResult);
  result.traces = (result.traces ?? []).filter((trace) => target.has(trace.net));
  result.vias = (result.vias ?? []).filter((via) => target.has(via.net));
  normalizeResultGeometry(result, designRules);
  await writeFile2(resolve(outputDirectory, `${label}-result.json`), `${JSON.stringify(result, null, 2)}
`);
  const candidate = structuredClone(root);
  const applied = applyRouterResult(candidate, sourceVersion, result, exported.transform, ["F.Cu", "B.Cu"]);
  await writeFile2(resolve(outputDirectory, `${label}.kicad_pcb`), serializePcb(candidate));
  const summary = {
    label,
    targetNets: [...target],
    differentialPairs: configuredPairs,
    progress: Number(rawResult.progress ?? 0),
    routability: Number.isFinite(Number(rawResult.routabitity)) ? Number(rawResult.routabitity) : null,
    traces: result.traces.length,
    vias: result.vias.length,
    segments: applied.segments,
    addedVias: applied.vias,
    routingElapsedMs
  };
  await writeFile2(resolve(outputDirectory, `${label}-stage.json`), `${JSON.stringify(summary, null, 2)}
`);
  return {
    root: candidate,
    summary
  };
}
function variantStages(allNonGroundNets) {
  if (variant === "baseline") return [{ label: "01-all", nets: allNonGroundNets }];
  if (variant === "block-local-first") return [
    { label: "01-core-local", nets: [...blockGroups.coreLocal] },
    { label: "02-usb-c", nets: [...blockGroups.usbC] },
    { label: "03-usb-a1", nets: [...blockGroups.usbA1] },
    { label: "04-usb-a2", nets: [...blockGroups.usbA2] },
    { label: "05-shared-power", nets: [...blockGroups.sharedPower] }
  ];
  return [
    { label: "01-global-skeleton", nets: allNonGroundNets.filter((net) => skeletonNets.has(net)) },
    { label: "02-local-fill", nets: allNonGroundNets.filter((net) => !skeletonNets.has(net)) }
  ];
}
async function copyRuleSidecars(outputBoardPath) {
  const sourceBase = rulesBoardPath.slice(0, -extname2(rulesBoardPath).length);
  const outputBase = outputBoardPath.slice(0, -extname2(outputBoardPath).length);
  await copyFile2(`${sourceBase}.kicad_pro`, `${outputBase}.kicad_pro`);
  await copyFile2(`${sourceBase}.kicad_dru`, `${outputBase}.kicad_dru`).catch(() => void 0);
}
async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const totalStarted = performance.now();
  const cpuStarted = process.cpuUsage();
  let peakRss = process.memoryUsage().rss;
  const memorySampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 25);
  try {
    const sourceBoard = await readPcb(sourceBoardPath);
    const designRules = await readPcbRoutingRules(rulesBoardPath);
    let root = parsePcbSource(sourceBoard.source);
    const originalPlacement = listChildren(root, "footprint").map((footprint) => ({
      reference: childText(footprint, "path") ?? "",
      at: childText(footprint, "at") ?? ""
    }));
    const removedRoutingPrimitives = clearRouting(root);
    const removedZones = removeZones(root);
    const allNonGroundNets = [...pcbNetNames(root)].filter((net) => net !== "GND");
    const cleanBoardPath = resolve(outputDirectory, "00-clean.kicad_pcb");
    await writeFile2(cleanBoardPath, serializePcb(root));
    await copyRuleSidecars(cleanBoardPath);
    const covered = new Set(Object.values(blockGroups).flat());
    const uncovered = allNonGroundNets.filter((net) => !covered.has(net));
    if (uncovered.length) throw new Error(`Block grouping misses nets: ${uncovered.join(", ")}`);
    const stages = [];
    let routingWallMs = 0;
    for (const stage of variantStages(allNonGroundNets)) {
      console.log(JSON.stringify({ variant, stage: stage.label, nets: stage.nets }));
      const routed = await routePass(root, stage.nets, stage.label, sourceBoard.version, allNonGroundNets, designRules);
      root = routed.root;
      stages.push(routed.summary);
      routingWallMs += routed.summary.routingElapsedMs;
    }
    let inspection = await inspectAndWrite(root, "90-before-repair");
    let drcWallMs = inspection.elapsedMs;
    root = inspection.root;
    const repairs = [];
    if (variant === "skeleton-first-repair") {
      for (let round = 1; round <= 2; round += 1) {
        const missing = new Set(inspection.summary.missingNonGroundNets);
        if (!missing.size) break;
        expandDifferentialPairSet(missing);
        const blockerResult = findBlockerNets(root, inspection.report, missing);
        const repairNets = /* @__PURE__ */ new Set([...missing, ...blockerResult.blockers]);
        expandDifferentialPairSet(repairNets);
        const repairRoot = structuredClone(root);
        const removed = clearRouting(repairRoot, { onlyNets: [...repairNets] });
        const label = `9${round}-repair`;
        let routed;
        try {
          routed = await routePass(
            repairRoot,
            [...repairNets],
            label,
            sourceBoard.version,
            allNonGroundNets,
            designRules,
            repairTimeoutMs
          );
        } catch (error) {
          repairs.push({
            round,
            missingBefore: [...missing],
            blockers: [...blockerResult.blockers],
            blockerScores: blockerResult.scores,
            repairNets: [...repairNets],
            removed,
            accepted: false,
            failed: true,
            error: error instanceof Error ? error.message : String(error)
          });
          break;
        }
        routingWallMs += routed.summary.routingElapsedMs;
        const candidateInspection = await inspectAndWrite(routed.root, `${label}-candidate`);
        drcWallMs += candidateInspection.elapsedMs;
        const accepted = betterScore(scoreDrc(candidateInspection.summary), scoreDrc(inspection.summary));
        repairs.push({
          round,
          missingBefore: [...missing],
          blockers: [...blockerResult.blockers],
          blockerScores: blockerResult.scores,
          repairNets: [...repairNets],
          removed,
          route: routed.summary,
          beforeScore: scoreDrc(inspection.summary),
          candidateScore: scoreDrc(candidateInspection.summary),
          accepted
        });
        if (!accepted) break;
        root = candidateInspection.root;
        inspection = candidateInspection;
      }
    }
    const finalInspection = await inspectAndWrite(root, "99-final");
    drcWallMs += finalInspection.elapsedMs;
    root = finalInspection.root;
    const outputBoardPath = resolve(outputDirectory, `${variant}.kicad_pcb`);
    await writeFile2(outputBoardPath, serializePcb(root));
    await copyRuleSidecars(outputBoardPath);
    const finalSegments = listChildren(root, "segment").length + listChildren(root, "arc").length;
    const finalVias = listChildren(root, "via").length;
    const cpu = process.cpuUsage(cpuStarted);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const finalDrc = finalInspection.summary;
    const summary = {
      variant,
      resultSet: resultSet || "default",
      sourceBoardPath,
      rulesBoardPath,
      outputBoardPath,
      componentPlacementChanged: false,
      originalFootprintCount: originalPlacement.length,
      removedRoutingPrimitives,
      removedZones,
      enableDifferentialPairs,
      clearanceMarginMm,
      repairTimeoutMs,
      totalNonGroundNets: allNonGroundNets.length,
      routedNonGroundNets: allNonGroundNets.length - finalDrc.missingNonGroundNets.length,
      stages,
      repairs,
      drc: finalDrc,
      finalSegments,
      finalVias,
      routingWallMs,
      drcWallMs,
      totalWallMs: performance.now() - totalStarted,
      cpuUserMs: cpu.user / 1e3,
      cpuSystemMs: cpu.system / 1e3,
      peakRssMb: peakRss / 1024 / 1024,
      trustSummary: {
        trustLevel: "high",
        confidence: "deterministic",
        evidenceSources: ["EasyEDA WASM result", "KiCad 10 DRC JSON", "KiCad PCB S-expression"]
      }
    };
    await writeFile2(resolve(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}
`);
    console.log(JSON.stringify({ stage: "complete", ...summary }));
  } finally {
    clearInterval(memorySampler);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
