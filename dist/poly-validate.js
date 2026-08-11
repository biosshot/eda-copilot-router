import {
  parsePcbSource
} from "./chunk-GFOUZRQT.js";
import {
  kicadToRawPcb,
  validateFilledPolygonPlans
} from "./chunk-U26KEDMF.js";
import "./chunk-HGTCHW7P.js";
import {
  readPcb
} from "./chunk-L7USXWVD.js";

// src/poly-validate.ts
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
var boardPath = resolve(process.argv[2] ?? "D:\\MyProject\\kicad\\Powerbank\\Powerbank.poly-generated.kicad_pcb");
var plansPath = resolve(process.argv[3] ?? "results/poly-engine/zone-plans.json");
var outputPath = resolve(process.argv[4] ?? "results/poly-engine/fill-validation.json");
var pcb = await readPcb(boardPath);
var raw = kicadToRawPcb(parsePcbSource(pcb.source), { includeZones: true });
var plans = JSON.parse(await readFile(plansPath, "utf8"));
var validation = validateFilledPolygonPlans(raw, plans);
var output = {
  boardPath,
  plansPath,
  checked: validation.diagnostics.length,
  ready: validation.diagnostics.filter((item) => item.status === "ready").length,
  errors: validation.errors,
  diagnostics: validation.diagnostics,
  plans: validation.plans
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  boardPath,
  checked: output.checked,
  ready: output.ready,
  errors: output.errors,
  outputPath
}, null, 2));
