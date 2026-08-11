import { readFile, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { resolve } from "node:path"

const variants = ["baseline", "block-local-first", "skeleton-first-repair"]

for (const variant of variants) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [resolve("dist", "benchmark.js"), variant], {
      stdio: "inherit",
      env: process.env,
    })
    child.on("error", rejectPromise)
    child.on("exit", (code) => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(`${variant} exited with code ${code}`)))
  })
}

const summaries = await Promise.all(variants.map(async (variant) => (
  JSON.parse(await readFile(resolve("results", variant, "summary.json"), "utf8"))
)))

const comparison = summaries.map((summary) => ({
  variant: summary.variant,
  routedNonGroundNets: summary.routedNonGroundNets,
  totalNonGroundNets: summary.totalNonGroundNets,
  missingNonGroundNets: summary.drc.missingNonGroundNets,
  missingNonGroundItems: summary.drc.missingNonGroundItems,
  shorts: summary.drc.shorts,
  clearanceErrors: summary.drc.clearanceErrors,
  trackWidthErrors: summary.drc.trackWidthErrors,
  skewErrors: summary.drc.skewErrors,
  routingWallMs: summary.routingWallMs,
  drcWallMs: summary.drcWallMs,
  totalWallMs: summary.totalWallMs,
  peakRssMb: summary.peakRssMb,
  segments: summary.finalSegments,
  vias: summary.finalVias,
}))

await writeFile(resolve("results", "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`)
console.table(comparison)
