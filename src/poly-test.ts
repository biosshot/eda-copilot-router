import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, resolve } from "node:path"
import { listChildren, readPcb } from "../../kicad-copilot/src/kicad/pcb-reader"
import { parsePcbSource, serializePcb } from "../../kicad-copilot/src/kicad/pcb-writer"
import { clearRouting } from "./internal/legacy-kicad-wasm-adapter"
import { netClassFor, readPcbRoutingRules } from "../../kicad-copilot/src/pcb/router-rules"
import { runPolygonDsl } from "./polygon/dsl"
import { planPolygons } from "./polygon/engine"
import { isOctilinearBoundary } from "./polygon/boundary-optimizer"
import { appendPlannedZones, kicadToRawPcb, removeKicadZones } from "./polygon/kicad-adapter"
import { renderZonePlansSvg } from "./polygon/render"

const sourceBoard = resolve(process.argv[2] ?? "D:\\MyProject\\kicad\\Powerbank\\Powerbank.kicad_pcb")
const dslPath = resolve(process.argv[3] ?? "examples/powerbank.polygons.js")
const resultDirectory = resolve(process.argv[4] ?? "results/poly-engine")
const sourceBase = basename(sourceBoard, extname(sourceBoard))
const projectDirectory = dirname(sourceBoard)
const cleanBoardPath = resolve(projectDirectory, `${sourceBase}.poly-clean.kicad_pcb`)
const generatedBoardPath = resolve(projectDirectory, `${sourceBase}.poly-generated.kicad_pcb`)

await mkdir(resultDirectory, { recursive: true })
const pcb = await readPcb(sourceBoard)
const cleanRoot = parsePcbSource(pcb.source)
const removedRouting = clearRouting(cleanRoot)
const removedZones = removeKicadZones(cleanRoot)
const cleanSource = serializePcb(cleanRoot)
await writeFile(cleanBoardPath, cleanSource)

if (listChildren(cleanRoot, "segment").length || listChildren(cleanRoot, "arc").length || listChildren(cleanRoot, "via").length) {
  throw new Error("clean test board still contains tracks/arcs/vias")
}

const raw = kicadToRawPcb(cleanRoot, { includeZones: false })
const dsl = await readFile(dslPath, "utf8")
const program = runPolygonDsl(dsl)
const routingRules = await readPcbRoutingRules(sourceBoard)
const geometryRulesForNet = (net: string) => {
  const className = netClassFor(routingRules, net)
  const rule = routingRules.classes.find((item) => item.name === className)
  const trackWidth = Math.max(routingRules.minimumTrackWidth, rule?.trackWidth ?? 0.2)
  return {
    obstacleClearanceMm: Math.max(routingRules.minimumClearance, rule?.clearance ?? 0.2),
    minimumCorridorWidthMm: trackWidth * 3,
  }
}
const rssBefore = process.memoryUsage().rss
const result = planPolygons(raw, program, { rulesForNet: geometryRulesForNet })
const rssAfter = process.memoryUsage().rss
for (const plan of result.plans.filter((item) => item.status === "ready" && item.intent.mode === "compact")) {
  if (!plan.boundary || !isOctilinearBoundary(plan.boundary)) {
    throw new Error(`${plan.net} compact boundary contains an angle other than 0/45/90 degrees`)
  }
}

// Physical values are backend configuration taken from KiCad's own rules;
// they are intentionally absent from both the LLM DSL and polygon planner.
const clearanceForNet = (net: string) => {
  const className = netClassFor(routingRules, net)
  const rule = routingRules.classes.find((item) => item.name === className)
  return Math.max(routingRules.minimumClearance, rule?.clearance ?? 0.2)
}
const generatedRoot = parsePcbSource(cleanSource)
const generatedZones = appendPlannedZones(generatedRoot, result.plans, {
  clearanceForNet,
  minThickness: Math.max(0.05, routingRules.minimumTrackWidth),
})
await writeFile(generatedBoardPath, serializePcb(generatedRoot))

const copyProjectSidecars = async (targetBoardPath: string) => {
  const targetBase = targetBoardPath.replace(/\.kicad_pcb$/i, "")
  for (const extension of [".kicad_pro", ".kicad_dru"]) {
    const source = resolve(projectDirectory, `${sourceBase}${extension}`)
    try {
      await stat(source)
      await copyFile(source, `${targetBase}${extension}`)
    } catch {}
  }
}
await copyProjectSidecars(cleanBoardPath)
await copyProjectSidecars(generatedBoardPath)

const combinedSvg = renderZonePlansSvg(raw, result.plans, { title: "Powerbank · optimized power polygons · TOP + BOTTOM" })
const topSvg = renderZonePlansSvg(raw, result.plans, { layers: ["TOP"], title: "Powerbank · optimized power polygons · TOP" })
const bottomSvg = renderZonePlansSvg(raw, result.plans, { layers: ["BOTTOM"], title: "Powerbank · optimized power polygons · BOTTOM" })

const metrics = {
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
    polygons: raw.polygons.length,
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
    warnings: plan.warnings,
  })),
}

await Promise.all([
  writeFile(resolve(resultDirectory, "polygon-intent.json"), JSON.stringify(program, null, 2)),
  writeFile(resolve(resultDirectory, "raw-input.json"), JSON.stringify(raw, null, 2)),
  writeFile(resolve(resultDirectory, "zone-plans.json"), JSON.stringify(result.plans, null, 2)),
  writeFile(resolve(resultDirectory, "metrics.json"), JSON.stringify(metrics, null, 2)),
  writeFile(resolve(resultDirectory, "powerbank-polygons.svg"), combinedSvg),
  writeFile(resolve(resultDirectory, "powerbank-polygons-top.svg"), topSvg),
  writeFile(resolve(resultDirectory, "powerbank-polygons-bottom.svg"), bottomSvg),
])

console.log(JSON.stringify(metrics, null, 2))
