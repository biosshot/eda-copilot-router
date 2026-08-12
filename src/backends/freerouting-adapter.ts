import { spawn } from "node:child_process"
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"

export type FreeroutingDiagnostic = {
  code: string
  severity: "info" | "warning" | "error"
  message: string
  details?: unknown
}

export type FreeroutingStageSpec = {
  javaPath: string
  javacPath: string
  jarPath: string
  kicadPythonPath: string
  bridgePath: string
  runnerSourcePath: string
  timeoutMs: number
  remainingNets: readonly string[]
  excludedNets: readonly string[]
  maxPasses?: number
  threads?: number
  optimizerImprovementThreshold?: number
  updateStrategy?: "greedy" | "global" | "hybrid"
  itemSelectionStrategy?: "sequential" | "random" | "prioritized"
}

export type FreeroutingProcessResult = {
  stage: "remaining"
  backend: "freerouting"
  status: "completed" | "skipped" | "preflight_failed" | "process_failed"
  attempted: boolean
  inputBoard: string
  outputBoard: string
  command: string[]
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  elapsedMs: number
  peakWorkingSetMb?: number
  stdout: string
  stderr: string
  diagnostics: FreeroutingDiagnostic[]
  artifacts: Record<string, string>
  remainingNets: string[]
  excludedNets: string[]
  routerSummary?: {
    initialUnrouted?: number
    finalUnrouted?: number
    violations?: number
    finalScore?: number
    state?: string
    peakHeapMb?: number
  }
}

type CapturedProcess = {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  elapsedMs: number
  stdout: string
  stderr: string
  error?: string
}

const BOARD_SUFFIX = ".kicad_pcb"
const SIDECAR_SUFFIXES = [".kicad_pro", ".kicad_dru", ".kicad_prl"] as const
const EXACT_NET_PATTERN = /^[^\r\n\0]+$/

function diagnostic(
  code: string,
  severity: FreeroutingDiagnostic["severity"],
  message: string,
  details?: unknown,
): FreeroutingDiagnostic {
  return { code, severity, message, ...(details === undefined ? {} : { details }) }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function unique(values: readonly string[]) {
  return [...new Set(values)]
}

function commandPath(path: string) {
  return isAbsolute(path) || path.includes("/") || path.includes("\\") ? resolve(path) : path
}

function boardStem(path: string) {
  return path.toLowerCase().endsWith(BOARD_SUFFIX)
    ? path.slice(0, -BOARD_SUFFIX.length)
    : path.slice(0, -extname(path).length)
}

async function exists(path: string) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function copySidecars(sourceBoard: string, targetBoard: string) {
  for (const suffix of SIDECAR_SUFFIXES) {
    const source = `${boardStem(sourceBoard)}${suffix}`
    if (await exists(source)) await copyFile(source, `${boardStem(targetBoard)}${suffix}`)
  }
}

async function removeBoardSnapshot(board: string) {
  await rm(board, { force: true })
  await Promise.all(SIDECAR_SUFFIXES.map((suffix) => rm(`${boardStem(board)}${suffix}`, { force: true })))
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CapturedProcess> {
  const started = performance.now()
  return new Promise((resolvePromise) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let processError: string | undefined
    let settled = false
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk })
    child.stderr.on("data", (chunk: string) => { stderr += chunk })
    child.on("error", (error) => { processError = errorText(error) })
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        elapsedMs: performance.now() - started,
        stdout,
        stderr,
        ...(processError ? { error: processError } : {}),
      })
    }
    child.on("close", (code, signal) => finish(code, signal))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
  })
}

function validateScope(spec: FreeroutingStageSpec, diagnostics: FreeroutingDiagnostic[]) {
  const remaining = unique(spec.remainingNets.map(String))
  const excluded = unique(spec.excludedNets.map(String))
  const invalid = [...remaining, ...excluded].filter((net) => !net || !EXACT_NET_PATTERN.test(net))
  if (invalid.length) diagnostics.push(diagnostic(
    "FREEROUTING_INVALID_NET_NAME",
    "error",
    "Freerouting scope requires non-empty exact net names without control characters.",
    invalid,
  ))
  const overlap = remaining.filter((net) => excluded.includes(net))
  if (overlap.length) diagnostics.push(diagnostic(
    "FREEROUTING_SCOPE_CONFLICT",
    "error",
    "A net cannot belong to both remaining and excluded scope.",
    overlap,
  ))
  if (!excluded.some((net) => net.toUpperCase() === "GND")) diagnostics.push(diagnostic(
    "FREEROUTING_GND_NOT_EXCLUDED",
    "error",
    "GND must be excluded from the ordinary Freerouting pass.",
  ))
  return { remaining, excluded }
}

function parseRouterSummary(stdout: string) {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const marker = line.indexOf("WORKFLOW_JSON_SUMMARY:")
    if (marker < 0) continue
    try {
      const summary = JSON.parse(line.slice(marker + "WORKFLOW_JSON_SUMMARY:".length).trim()) as Record<string, unknown>
      return {
        initialUnrouted: Number(summary.initial_unrouted),
        finalUnrouted: Number(summary.final_unrouted),
        violations: Number(summary.violations),
        peakHeapMb: Number(summary.peak_heap_mb),
        state: "COMPLETED",
      }
    } catch {
      break
    }
  }
  const start = stdout.match(/Auto-routing stage started[^\r\n]*for\s+(\d+)\s+unrouted items/i)
  const complete = stdout.match(/Auto-routing stage completed:[^\r\n]*started with\s+(\d+)\s+unrouted nets[^\r\n]*final score:\s*([\d.]+)\s*\((\d+)\s+unrouted and\s+(\d+)\s+violations\)/i)
  const state = stdout.match(/finished with state:\s*([A-Z_]+)/i)
  if (!start && !complete && !state) return undefined
  return {
    initialUnrouted: complete ? Number(complete[1]) : start ? Number(start[1]) : undefined,
    finalScore: complete ? Number(complete[2]) : undefined,
    finalUnrouted: complete ? Number(complete[3]) : undefined,
    violations: complete ? Number(complete[4]) : undefined,
    state: state?.[1],
  }
}

function resultFor(
  inputBoard: string,
  outputBoard: string,
  remainingNets: string[],
  excludedNets: string[],
  diagnostics: FreeroutingDiagnostic[],
): FreeroutingProcessResult {
  return {
    stage: "remaining",
    backend: "freerouting",
    status: "preflight_failed",
    attempted: false,
    inputBoard,
    outputBoard,
    command: [],
    exitCode: null,
    signal: null,
    timedOut: false,
    elapsedMs: 0,
    stdout: "",
    stderr: "",
    diagnostics,
    artifacts: {},
    remainingNets,
    excludedNets,
  }
}

export async function runFreeroutingRemaining(
  inputBoard: string,
  outputBoard: string,
  spec: FreeroutingStageSpec,
  artifactsDirectory: string,
): Promise<FreeroutingProcessResult> {
  const started = performance.now()
  const normalizedInput = resolve(inputBoard)
  const normalizedOutput = resolve(outputBoard)
  const artifacts = resolve(artifactsDirectory)
  const diagnostics: FreeroutingDiagnostic[] = []
  const scope = validateScope(spec, diagnostics)
  const result = resultFor(normalizedInput, normalizedOutput, scope.remaining, scope.excluded, diagnostics)

  try {
    await mkdir(artifacts, { recursive: true })
    if (normalizedInput.toLowerCase() === normalizedOutput.toLowerCase()) diagnostics.push(diagnostic(
      "FREEROUTING_INPUT_OUTPUT_COLLISION",
      "error",
      "Freerouting output must not overwrite its input artifact.",
    ))
    for (const [label, path] of [
      ["input board", normalizedInput],
      ["Freerouting JAR", resolve(spec.jarPath)],
      ["KiCad bridge", resolve(spec.bridgePath)],
      ["scoped Freerouting runner", resolve(spec.runnerSourcePath)],
      ["KiCad Python", commandPath(spec.kicadPythonPath)],
    ] as const) {
      if (!(await exists(path))) diagnostics.push(diagnostic(
        "FREEROUTING_DEPENDENCY_MISSING",
        "error",
        `${label} was not found.`,
        { path },
      ))
    }
    if (!spec.javaPath.trim() || !spec.javacPath.trim()) diagnostics.push(diagnostic(
      "FREEROUTING_INVALID_CONFIG", "error", "javaPath and javacPath must not be empty.",
    ))
    if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) diagnostics.push(diagnostic(
      "FREEROUTING_INVALID_CONFIG", "error", "timeoutMs must be positive.",
    ))
    if (spec.maxPasses !== undefined && (!Number.isInteger(spec.maxPasses) || spec.maxPasses <= 0)) diagnostics.push(diagnostic(
      "FREEROUTING_INVALID_CONFIG", "error", "maxPasses must be a positive integer.",
    ))
    if (spec.threads !== undefined && (!Number.isInteger(spec.threads) || spec.threads <= 0)) diagnostics.push(diagnostic(
      "FREEROUTING_INVALID_CONFIG", "error", "threads must be a positive integer.",
    ))
    if (!scope.remaining.length) {
      await copyFile(normalizedInput, normalizedOutput)
      await copySidecars(normalizedInput, normalizedOutput)
      result.status = "skipped"
      result.outputBoard = normalizedOutput
      result.elapsedMs = performance.now() - started
      return result
    }
    if (diagnostics.some((item) => item.severity === "error")) {
      result.elapsedMs = performance.now() - started
      await writeJson(join(artifacts, "freerouting-remaining-result.json"), result)
      return result
    }

    const exportBoard = join(artifacts, "freerouting-export.kicad_pcb")
    const dsn = join(artifacts, "freerouting-input.dsn")
    const ses = join(artifacts, "freerouting-output.ses")
    const exportManifest = join(artifacts, "freerouting-export.json")
    const importManifest = join(artifacts, "freerouting-import.json")
    const runnerClasses = join(artifacts, "freerouting-runner-classes")
    const userData = join(artifacts, "freerouting-user-data")
    result.artifacts = { exportBoard, dsn, ses, exportManifest, importManifest, runnerClasses, userData }
    // Stable artifact names are convenient for inspection, but stale output
    // from an earlier run must never satisfy an exists() gate after a failure.
    await removeBoardSnapshot(normalizedOutput)
    await removeBoardSnapshot(exportBoard)
    await Promise.all([dsn, ses, exportManifest, importManifest].map((path) => rm(path, { force: true })))

    const bridgeExportArgs = [
      resolve(spec.bridgePath), "export",
      "--input", normalizedInput,
      "--output-board", exportBoard,
      "--dsn", dsn,
      "--manifest", exportManifest,
      ...scope.excluded.flatMap((net) => ["--exclude-net", net]),
      ...scope.remaining.flatMap((net) => ["--route-net", net]),
    ]
    const exported = await runProcess(
      commandPath(spec.kicadPythonPath),
      bridgeExportArgs,
      artifacts,
      spec.timeoutMs,
    )
    await writeFile(join(artifacts, "freerouting-export.stdout.log"), exported.stdout)
    await writeFile(join(artifacts, "freerouting-export.stderr.log"), exported.stderr)
    if (exported.error || exported.timedOut || exported.exitCode !== 0 || !(await exists(dsn))) {
      diagnostics.push(diagnostic(
        "FREEROUTING_EXPORT_FAILED",
        "error",
        "KiCad did not produce a usable DSN artifact.",
        { ...exported, stdout: undefined, stderr: undefined },
      ))
      result.status = "process_failed"
      result.elapsedMs = performance.now() - started
      await writeJson(join(artifacts, "freerouting-remaining-result.json"), result)
      return result
    }

    let exportDetails: Record<string, unknown> = {}
    try { exportDetails = JSON.parse(await readFile(exportManifest, "utf8")) as Record<string, unknown> } catch {}
    const ignoredClasses = Array.isArray(exportDetails.ignored_classes)
      ? exportDetails.ignored_classes.map(String)
      : []
    const exportedRouteNets = Array.isArray(exportDetails.routed_nets)
      ? exportDetails.routed_nets.map(String).sort()
      : []
    const expectedRouteNets = [...scope.remaining].sort()
    if (!ignoredClasses.length || JSON.stringify(exportedRouteNets) !== JSON.stringify(expectedRouteNets)) {
      diagnostics.push(diagnostic(
        "FREEROUTING_SCOPE_EXPORT_FAILED",
        "error",
        "The DSN bridge did not preserve the exact route/ignore scope.",
        { exportedRouteNets, expectedRouteNets, ignoredClasses },
      ))
      result.status = "process_failed"
      result.elapsedMs = performance.now() - started
      await writeJson(join(artifacts, "freerouting-remaining-result.json"), result)
      return result
    }

    await mkdir(runnerClasses, { recursive: true })
    const compilerArgs = [
      "-cp", resolve(spec.jarPath),
      "-d", runnerClasses,
      resolve(spec.runnerSourcePath),
    ]
    const compiled = await runProcess(commandPath(spec.javacPath), compilerArgs, artifacts, spec.timeoutMs)
    await writeFile(join(artifacts, "freerouting-runner-compile.stdout.log"), compiled.stdout)
    await writeFile(join(artifacts, "freerouting-runner-compile.stderr.log"), compiled.stderr)
    const runnerClass = join(
      runnerClasses,
      "app", "freerouting", "workflow", "ScopedFreeroutingRunner.class",
    )
    if (compiled.error || compiled.timedOut || compiled.exitCode !== 0 || !(await exists(runnerClass))) {
      diagnostics.push(diagnostic(
        "FREEROUTING_RUNNER_COMPILE_FAILED",
        "error",
        "The scoped Freerouting runner could not be compiled against the selected JAR.",
        { ...compiled, stdout: undefined, stderr: undefined, runnerClass },
      ))
      result.status = "process_failed"
      result.elapsedMs = performance.now() - started
      await writeJson(join(artifacts, "freerouting-remaining-result.json"), result)
      return result
    }

    // The upstream -inc option is parsed but not applied by the headless 2.3
    // scheduler. The tiny runner sets NetClass.is_ignored_by_autorouter after
    // DSN load and disables the unscoped fanout pre-pass, then delegates to the
    // stock BatchAutorouter/BatchOptimizer.
    const args = [
      "-cp", `${runnerClasses}${delimiter}${resolve(spec.jarPath)}`,
      "app.freerouting.workflow.ScopedFreeroutingRunner",
      "--input", dsn,
      "--output", ses,
      ...ignoredClasses.flatMap((name) => ["--ignore-class", name]),
    ]
    if (spec.maxPasses !== undefined) {
      args.push("--max-passes", String(spec.maxPasses))
      args.push("--optimizer-max-passes", String(spec.maxPasses))
    }
    if (spec.threads !== undefined) args.push("--threads", String(spec.threads))
    if (spec.optimizerImprovementThreshold !== undefined) {
      args.push("--optimizer-threshold", String(spec.optimizerImprovementThreshold / 100))
    }
    if (spec.updateStrategy) args.push("--update-strategy", spec.updateStrategy)
    if (spec.itemSelectionStrategy) args.push("--item-strategy", spec.itemSelectionStrategy)
    result.command = [commandPath(spec.javaPath), ...args]
    result.attempted = true
    await writeJson(join(artifacts, "freerouting-remaining-invocation.json"), {
      command: result.command,
      remainingNets: scope.remaining,
      excludedNets: scope.excluded,
      ignoredClasses,
    })

    const routed = await runProcess(commandPath(spec.javaPath), args, artifacts, spec.timeoutMs)
    result.exitCode = routed.exitCode
    result.signal = routed.signal
    result.timedOut = routed.timedOut
    result.stdout = routed.stdout
    result.stderr = routed.stderr
    result.routerSummary = parseRouterSummary(routed.stdout)
    await writeFile(join(artifacts, "freerouting-remaining.stdout.log"), routed.stdout)
    await writeFile(join(artifacts, "freerouting-remaining.stderr.log"), routed.stderr)
    if (routed.error) diagnostics.push(diagnostic("FREEROUTING_PROCESS_START_FAILED", "error", routed.error))
    if (routed.timedOut) diagnostics.push(diagnostic("FREEROUTING_TIMEOUT", "error", `Freerouting exceeded ${spec.timeoutMs} ms.`))
    if (routed.exitCode !== 0) diagnostics.push(diagnostic(
      "FREEROUTING_NONZERO_EXIT", "error", `Freerouting exited with code ${String(routed.exitCode)}.`,
    ))
    if (!(await exists(ses))) diagnostics.push(diagnostic(
      "FREEROUTING_SESSION_MISSING", "error", "Freerouting did not create a SES artifact.",
    ))
    if (result.routerSummary?.finalUnrouted) diagnostics.push(diagnostic(
      "FREEROUTING_UNROUTED_ITEMS",
      "warning",
      `Freerouting reports ${result.routerSummary.finalUnrouted} unrouted item(s); native final connectivity remains authoritative.`,
      result.routerSummary,
    ))
    if (result.routerSummary?.violations) diagnostics.push(diagnostic(
      "FREEROUTING_INTERNAL_VIOLATIONS",
      "warning",
      `Freerouting reports ${result.routerSummary.violations} internal violation(s); native KiCad DRC remains authoritative.`,
      result.routerSummary,
    ))

    if (!diagnostics.some((item) => item.severity === "error")) {
      const bridgeImportArgs = [
        resolve(spec.bridgePath), "import",
        "--input", exportBoard,
        "--ses", ses,
        "--output-board", normalizedOutput,
        "--manifest", importManifest,
      ]
      const imported = await runProcess(
        commandPath(spec.kicadPythonPath),
        bridgeImportArgs,
        artifacts,
        spec.timeoutMs,
      )
      await writeFile(join(artifacts, "freerouting-import.stdout.log"), imported.stdout)
      await writeFile(join(artifacts, "freerouting-import.stderr.log"), imported.stderr)
      if (imported.error || imported.timedOut || imported.exitCode !== 0 || !(await exists(normalizedOutput))) diagnostics.push(diagnostic(
        "FREEROUTING_IMPORT_FAILED",
        "error",
        "KiCad could not import the Freerouting SES artifact.",
        { ...imported, stdout: undefined, stderr: undefined },
      ))
      else await copySidecars(normalizedInput, normalizedOutput)
    }

    result.status = diagnostics.some((item) => item.severity === "error") ? "process_failed" : "completed"
    result.elapsedMs = performance.now() - started
    const serializable = {
      ...result,
      stdout: result.stdout ? `<stored in ${join(artifacts, "freerouting-remaining.stdout.log")}>` : "",
      stderr: result.stderr ? `<stored in ${join(artifacts, "freerouting-remaining.stderr.log")}>` : "",
    }
    await writeJson(join(artifacts, "freerouting-remaining-result.json"), serializable)
    return result
  } catch (error) {
    diagnostics.push(diagnostic(
      "FREEROUTING_ADAPTER_FAILURE",
      "error",
      `Unexpected Freerouting adapter failure was captured: ${errorText(error)}`,
    ))
    result.status = result.attempted ? "process_failed" : "preflight_failed"
    result.elapsedMs = performance.now() - started
    await writeJson(join(artifacts, "freerouting-remaining-result.json"), result).catch(() => undefined)
    return result
  }
}
