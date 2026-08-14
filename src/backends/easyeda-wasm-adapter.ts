import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { extname, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { Worker } from "node:worker_threads"
import { pcbNetNames, readPcb } from "../../../kicad-copilot/src/kicad/pcb-reader"
import { parsePcbSource, serializePcb } from "../../../kicad-copilot/src/kicad/pcb-writer"
import {
  applyRouterResult,
  buildRouterInput,
  type RouterResult,
  type RouterInput,
} from "../internal/legacy-kicad-wasm-adapter"
import type { PcbRoutingRules } from "../../../kicad-copilot/src/pcb/router-rules"
import type { FilledCopperPadGroup } from "../filled-copper-proxy"

type Diagnostic = {
  code: string
  severity: "info" | "warning" | "error"
  message: string
  details?: unknown
}

export type EasyEdaWasmStageSpec = {
  timeoutMs: number
  remainingNets: string[]
  excludedNets: string[]
  routeLayers: string[]
  rules: PcbRoutingRules
  clearanceMarginMm?: number
  /** Exact native filled copper was materialized as locked same-net tracks. */
  filledCopperProxy?: boolean
  filledCopperPadGroups?: FilledCopperPadGroup[]
}

export type EasyEdaWasmProcessResult = {
  backend: "easyeda-wasm"
  status: "completed" | "failed" | "skipped"
  attempted: boolean
  inputBoard: string
  outputBoard: string
  elapsedMs: number
  exitCode: number | null
  diagnostics: Diagnostic[]
  routerSummary?: {
    progress: number
    routability: number | null
    traces: number
    vias: number
    segments: number
    addedVias: number
    peakRssMb: number
  }
  artifacts: Record<string, string>
}

function diagnostic(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  details?: unknown,
): Diagnostic {
  return { code, severity, message, ...(details === undefined ? {} : { details }) }
}

function boardStem(path: string) {
  return path.slice(0, -extname(path).length)
}

async function copySidecars(sourceBoard: string, targetBoard: string) {
  for (const suffix of [".kicad_pro", ".kicad_dru", ".kicad_prl"]) {
    const source = `${boardStem(sourceBoard)}${suffix}`
    try {
      await copyFile(source, `${boardStem(targetBoard)}${suffix}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

function samePath(left: string, right: string) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

function configureHardGeometry(input: RouterInput, clearanceMarginMm: number) {
  const rules = input.rules as Record<string, Record<string, unknown>>
  for (const entries of Object.values(rules.trackWidths ?? {})) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue
      const item = entry as Record<string, unknown>
      const widths = item.trackWidth
      if (!Array.isArray(widths)) continue
      const desired = Number(widths[1] ?? widths[0])
      if (Number.isFinite(desired) && desired > 0) item.trackWidth = [desired, desired, desired]
    }
  }
  for (const entries of Object.values(rules.differentialPairs ?? {})) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue
      const item = entry as Record<string, unknown>
      const widths = item.width
      if (!Array.isArray(widths)) continue
      const desired = Number(widths[1] ?? widths[0])
      if (Number.isFinite(desired) && desired > 0) item.width = [desired, desired, desired]
    }
  }
  if (!(clearanceMarginMm > 0)) return
  for (const entries of Object.values(rules.safeClearances ?? {})) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue
      const values = entry as Record<string, unknown>
      for (const key of Object.keys(values)) {
        if (key === "layers") continue
        const value = Number(values[key])
        if (Number.isFinite(value)) values[key] = value + clearanceMarginMm
      }
    }
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const routerWorkerWrapper = String.raw`
void (async () => {
  const fs = await import("node:fs");
  const { parentPort, workerData } = await import("node:worker_threads");
  const { pathToFileURL } = await import("node:url");
  globalThis.self = globalThis;
  self.location = {
    href: pathToFileURL(workerData.workerPath).href,
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
      return new Response(wasmBytes, { status: 200, headers: { "content-type": "application/wasm" } });
    }
    if (!nativeFetch) throw new Error("No fetch implementation for " + href);
    return nativeFetch(url, options);
  };
  await import(pathToFileURL(workerData.workerPath).href);
})().catch((error) => {
  queueMicrotask(() => { throw error; });
});
`

function messageText(value: unknown) {
  if (typeof value === "string") return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

function runEasyEdaRouter(input: unknown, timeoutMs: number): Promise<RouterResult> {
  const assets = resolve("dist", "autorouter")
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(routerWorkerWrapper, {
      eval: true,
      workerData: {
        workerPath: resolve(assets, "pcbRouterWorker.js"),
        wasmPath: resolve(assets, "PCBRouter-YFDILLBW-YFDILLBW.wasm"),
      },
    })
    let settled = false
    let lastResult: RouterResult | undefined
    const finish = (error?: Error, result?: RouterResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate().catch(() => undefined)
      if (error) rejectPromise(error)
      else resolvePromise(result ?? {})
    }
    const timer = setTimeout(() => finish(new Error(`EasyEDA WASM timeout after ${timeoutMs}ms`)), timeoutMs)
    worker.on("message", (message) => {
      if (message?.topic === "pcb/routerResult") {
        lastResult = message.message as RouterResult
        if (Number(lastResult?.progress ?? 0) >= 1) finish(undefined, lastResult)
      } else if (message?.topic === "pcb/routerInterrupt") {
        finish(new Error(messageText(message.message?.message ?? message.message ?? "router interrupted")))
      }
    })
    worker.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))))
    worker.on("exit", (code) => {
      if (settled) return
      if (lastResult) finish(undefined, lastResult)
      else finish(new Error(`EasyEDA WASM exited without result${code ? ` (${code})` : ""}`))
    })
    worker.postMessage({
      topic: "pangolin/autoRouting_wasm",
      type: "publish",
      message: { json: input, options: {} },
    })
  })
}

export async function runEasyEdaWasmRemaining(
  inputBoard: string,
  outputBoard: string,
  spec: EasyEdaWasmStageSpec,
  artifactsDirectory: string,
): Promise<EasyEdaWasmProcessResult> {
  const started = performance.now()
  const input = resolve(inputBoard)
  const output = resolve(outputBoard)
  const artifacts = resolve(artifactsDirectory, "easyeda-wasm-remaining")
  const artifactPaths = {
    input: resolve(artifacts, "router-input.json"),
    rawResult: resolve(artifacts, "router-result-raw.json"),
    filteredResult: resolve(artifacts, "router-result.json"),
    summary: resolve(artifacts, "router-summary.json"),
  }
  const diagnostics: Diagnostic[] = []
  let attempted = false
  let rssTimer: NodeJS.Timeout | undefined
  let peakRss = process.memoryUsage().rss

  try {
    await mkdir(artifacts, { recursive: true })
    if (samePath(input, output)) {
      return {
        backend: "easyeda-wasm", status: "skipped", attempted: false,
        inputBoard: input, outputBoard: output, elapsedMs: performance.now() - started,
        exitCode: null,
        diagnostics: [diagnostic("EASYEDA_WASM_INPUT_OUTPUT_COLLISION", "error", "EasyEDA WASM output must not overwrite its input artifact.")],
        artifacts: artifactPaths,
      }
    }
    const remaining = [...new Set(spec.remainingNets.map(String).filter(Boolean))]
    const excluded = new Set(spec.excludedNets.map(String).filter(Boolean))
    const overlap = remaining.filter((net) => excluded.has(net))
    if (overlap.length) throw new Error(`Nets assigned to both remaining and excluded scopes: ${overlap.join(", ")}`)
    if (!remaining.length) throw new Error("EasyEDA WASM remaining scope is empty")
    if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) throw new Error("EasyEDA WASM timeout must be positive")

    const document = await readPcb(input)
    const boardNets = new Set(pcbNetNames(document.root))
    const unknown = [...remaining, ...excluded].filter((net) => !boardNets.has(net))
    if (unknown.length) throw new Error(`Unknown nets in EasyEDA WASM scope: ${[...new Set(unknown)].join(", ")}`)
    const uncovered = [...boardNets].filter((net) => !remaining.includes(net) && !excluded.has(net))
    if (uncovered.length) throw new Error(`Nets missing from exact EasyEDA WASM scope: ${uncovered.join(", ")}`)

    await copyFile(input, output)
    await copySidecars(input, output)
    const exported = buildRouterInput(document.root, {
      routeLayers: spec.routeLayers,
      ignoreNets: [...excluded],
      speedFirst: false,
      designRules: spec.rules,
    })
    const redundantPads = new Set((spec.filledCopperPadGroups ?? []).flatMap((group) =>
      group.redundantPads.map((pad) => `${pad.component}\u0000${pad.padNumber}`)))
    if (redundantPads.size) {
      for (const [componentName, componentValue] of Object.entries(exported.input.components)) {
        if (!componentValue || typeof componentValue !== "object") continue
        const component = componentValue as Record<string, unknown>
        const nets = component.nets && typeof component.nets === "object"
          ? component.nets as Record<string, unknown>
          : {}
        const pinName = component.pinName && typeof component.pinName === "object"
          ? component.pinName as Record<string, unknown>
          : {}
        for (const [pin, padNumber] of Object.entries(pinName)) {
          if (!redundantPads.has(`${componentName}\u0000${String(padNumber)}`)) continue
          delete nets[pin]
          delete pinName[pin]
        }
      }
      diagnostics.push(diagnostic(
        "EASYEDA_WASM_FILLED_COPPER_TERMINALS_COLLAPSED",
        "info",
        `Collapsed ${redundantPads.size} redundant pad terminal(s) already connected by native filled copper.`,
      ))
    }
    configureHardGeometry(exported.input, Number(spec.clearanceMarginMm ?? 0))
    await writeFile(artifactPaths.input, `${JSON.stringify(exported.input, null, 2)}\n`)

    attempted = true
    rssTimer = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
    }, 25)
    const rawResult = await runEasyEdaRouter(exported.input, spec.timeoutMs)
    clearInterval(rssTimer)
    rssTimer = undefined
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    await writeFile(artifactPaths.rawResult, `${JSON.stringify(rawResult, null, 2)}\n`)

    const result: RouterResult = structuredClone(rawResult)
    const allowed = new Set(remaining)
    result.traces = (result.traces ?? []).filter((trace) => allowed.has(trace.net))
    result.vias = (result.vias ?? []).filter((via) => allowed.has(via.net))
    await writeFile(artifactPaths.filteredResult, `${JSON.stringify(result, null, 2)}\n`)

    const candidate = parsePcbSource(await readFile(output, "utf8"))
    const applied = applyRouterResult(candidate, document.version, result, exported.transform, spec.routeLayers)
    await writeFile(output, serializePcb(candidate))
    const summary = {
      progress: Number(rawResult.progress ?? 0),
      routability: Number.isFinite(Number(rawResult.routabitity)) ? Number(rawResult.routabitity) : null,
      traces: result.traces?.length ?? 0,
      vias: result.vias?.length ?? 0,
      segments: applied.segments,
      addedVias: applied.vias,
      peakRssMb: peakRss / 1024 / 1024,
    }
    if (summary.progress < 1) diagnostics.push(diagnostic(
      "EASYEDA_WASM_INCOMPLETE", "error", "EasyEDA WASM stopped before reporting complete progress.", summary,
    ))
    if (summary.routability !== null && summary.routability < 1) diagnostics.push(diagnostic(
      "EASYEDA_WASM_PARTIAL_ROUTABILITY", "error", "EasyEDA WASM left unrouted connectivity.", summary,
    ))
    if (!spec.filledCopperProxy && document.root.some((item) => Array.isArray(item) && String((item[0] as { value?: string })?.value) === "zone")) {
      diagnostics.push(diagnostic(
        "EASYEDA_WASM_ZONE_OBSTACLE_UNSUPPORTED",
        "warning",
        "The current KiCad exporter preserves zone outlines but does not expose filled-zone copper to the WASM maze. Native refill and final validation are authoritative.",
      ))
    }
    await writeFile(artifactPaths.summary, `${JSON.stringify({ summary, diagnostics }, null, 2)}\n`)
    return {
      backend: "easyeda-wasm",
      status: diagnostics.some((item) => item.severity === "error") ? "failed" : "completed",
      attempted,
      inputBoard: input,
      outputBoard: output,
      elapsedMs: performance.now() - started,
      exitCode: 0,
      diagnostics,
      routerSummary: summary,
      artifacts: artifactPaths,
    }
  } catch (error) {
    if (rssTimer) clearInterval(rssTimer)
    diagnostics.push(diagnostic("EASYEDA_WASM_FAILED", "error", errorText(error)))
    try {
      if (!samePath(input, output)) {
        await copyFile(input, output)
        await copySidecars(input, output)
      }
      await mkdir(artifacts, { recursive: true })
      await writeFile(artifactPaths.summary, `${JSON.stringify({ diagnostics }, null, 2)}\n`)
    } catch {}
    return {
      backend: "easyeda-wasm",
      status: attempted ? "failed" : "skipped",
      attempted,
      inputBoard: input,
      outputBoard: output,
      elapsedMs: performance.now() - started,
      exitCode: attempted ? 1 : null,
      diagnostics,
      artifacts: artifactPaths,
    }
  }
}
