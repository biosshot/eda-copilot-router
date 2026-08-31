import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { run } from "../../../../package-dist/index.js"
import { createHybridBackend } from "../../../../package-dist/backends/hybrid.js"
import { createKrtBackend } from "../../../../package-dist/backends/krt.js"
import { writeKrtBoard } from "../../../../package-dist/backends/krt-codec.js"

const corpusDirectory = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(corpusDirectory, "manifest.json"), "utf8"))
const requested = process.argv.slice(2)
const selected = requested.includes("--all")
  ? manifest.cases
  : requested.length
    ? manifest.cases.filter(item => requested.includes(item.id))
    : manifest.cases.filter(item => item.tier === "stable")
if (!selected.length) throw new Error("No EasyEDA hybrid corpus cases selected; pass --all or one or more case ids.")
const unknown = requested.filter(value => value !== "--all" && !manifest.cases.some(item => item.id === value))
if (unknown.length) throw new Error(`Unknown EasyEDA hybrid corpus case(s): ${unknown.join(", ")}`)

const resultsDirectory = join(corpusDirectory, "results")
await mkdir(resultsDirectory, { recursive: true })
const summary = []

function collectExpectationFailures(item, result, elapsedMs) {
  const expect = item.expect ?? {}
  const details = result.metrics?.details ?? {}
  const specialReports = Array.isArray(details.special)
    ? details.special
    : details.special
      ? [details.special]
      : []
  const matchedVerifiedNets = [...new Set(specialReports.flatMap(report => report.matched_verified_nets ?? []))]
  const differentialVerifiedNets = [...new Set(specialReports.flatMap(report => report.diff_verified_nets ?? []))]
  const failures = []
  if (result.status === "error") failures.push("router returned status=error")
  if ((result.metrics?.openNetCount ?? Number.POSITIVE_INFINITY) > expect.maxOpenNetCount) {
    failures.push(`openNetCount ${result.metrics?.openNetCount ?? "missing"} > ${expect.maxOpenNetCount}`)
  }
  if (elapsedMs > expect.maxElapsedMs) {
    failures.push(`elapsedMs ${Math.round(elapsedMs)} > ${expect.maxElapsedMs}`)
  }
  if (expect.maxFinalDrcViolationCount !== undefined
      && (details.finalDrc?.drcViolationCount ?? Number.POSITIVE_INFINITY) > expect.maxFinalDrcViolationCount) {
    failures.push(`final DRC ${details.finalDrc?.drcViolationCount ?? "missing"} > ${expect.maxFinalDrcViolationCount}`)
  }
  if (expect.minMatchedVerifiedNetCount !== undefined
      && matchedVerifiedNets.length < expect.minMatchedVerifiedNetCount) {
    failures.push(`matched verified nets ${matchedVerifiedNets.length} < ${expect.minMatchedVerifiedNetCount}`)
  }
  for (const [property, actual] of [
    ["requiredVerifiedImpedanceNets", details.impedance?.verifiedNets],
    ["requiredVerifiedDifferentialNets", differentialVerifiedNets],
  ]) {
    const missing = (expect[property] ?? []).filter(net => !new Set(actual ?? []).has(net))
    if (missing.length) failures.push(`${property} missing ${missing.join(", ")}`)
  }
  if (expect.hybridMode !== undefined && details.hybrid?.mode !== expect.hybridMode) {
    failures.push(`hybrid mode ${details.hybrid?.mode ?? "missing"} != ${expect.hybridMode}`)
  }
  return failures
}

for (const item of selected) {
  const caseDirectory = join(resultsDirectory, item.id)
  await mkdir(caseDirectory, { recursive: true })
  const startedAt = performance.now()
  try {
    const input = JSON.parse(await readFile(join(corpusDirectory, "fixture", item.id, "input.json"), "utf8"))
    const backendOptions = {
      artifactsDirectory: join(caseDirectory, "krt"),
      keepArtifacts: true,
    }
    const backend = item.workflow === "krt"
      ? createKrtBackend(backendOptions)
      : createHybridBackend({ krt: backendOptions })
    const timeoutMs = Number(process.env.COPILOT_ROUTER_E2E_TIMEOUT_MS ?? 900_000)
    const result = await run({ ...input, backend, signal: AbortSignal.timeout(timeoutMs) })
    const elapsedMs = performance.now() - startedAt
    await writeFile(join(caseDirectory, "routing-result.json"), `${JSON.stringify(result, null, 2)}\n`)
    if (result.copper) {
      const outputBoard = {
        ...input.board,
        ...(result.stackup?.effective ? { stackup: result.stackup.effective } : {}),
        rules: result.rules,
        copper: { fixed: input.board.copper.fixed, editable: result.copper },
      }
      const kicadDirectory = join(caseDirectory, "kicad")
      await mkdir(kicadDirectory, { recursive: true })
      const generated = await writeKrtBoard({ board: outputBoard, rules: result.rules }, kicadDirectory)
      await Promise.all([
        copyFile(generated.inputBoard, join(caseDirectory, `routed-${item.id}.kicad_pcb`)),
        copyFile(generated.inputProject, join(caseDirectory, `routed-${item.id}.kicad_pro`)),
      ])
    }
    const expectationFailures = collectExpectationFailures(item, result, elapsedMs)
    const row = {
      id: item.id,
      workflow: item.workflow,
      status: result.status,
      elapsedMs,
      openNetCount: result.metrics?.openNetCount ?? null,
      openNets: result.metrics?.openNets ?? [],
      trackCount: result.copper?.tracks.length ?? 0,
      viaCount: result.copper?.vias.length ?? 0,
      diagnosticErrors: result.diagnostics.filter(diagnostic => diagnostic.severity === "error").length,
      expectationsMet: expectationFailures.length === 0,
      ...(expectationFailures.length ? { expectationFailures } : {}),
    }
    summary.push(row)
    process.stdout.write(`${JSON.stringify(row)}\n`)
    if (expectationFailures.length) process.exitCode = 1
  } catch (error) {
    const row = {
      id: item.id,
      workflow: item.workflow,
      status: "runner-error",
      elapsedMs: performance.now() - startedAt,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }
    summary.push(row)
    await writeFile(join(caseDirectory, "runner-error.json"), `${JSON.stringify(row, null, 2)}\n`)
    process.stderr.write(`${JSON.stringify(row)}\n`)
    process.exitCode = 1
  }
}
await writeFile(join(resultsDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
