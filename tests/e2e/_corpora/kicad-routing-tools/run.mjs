import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const e2eDirectory = resolve(testDirectory, "../..")
const routerDirectory = resolve(testDirectory, "../../../..")
const manifest = JSON.parse(await readFile(join(testDirectory, "manifest.json"), "utf8"))

function usage() {
  return [
    "KiCadRoutingTools corpus E2E",
    "",
    "Usage:",
    "  npm run e2e:krt-corpus -- --list",
    "  npm run e2e:krt-corpus -- --case cap_chain [--profile balanced] [--max-candidates 1]",
    "  npm run e2e:krt-corpus -- --all [--profile balanced] [--max-candidates 1]",
    "",
    "No case runs by default. There is no internal timeout; Ctrl+C is forwarded as AbortSignal.",
  ].join("\n")
}

function parseArguments(argv) {
  const options = { profile: manifest.defaultProfile, maxCandidates: 1, cases: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (argument === "--case" && value) options.cases.push(value), index += 1
    else if (argument === "--all") options.all = true
    else if (argument === "--list") options.list = true
    else if (argument === "--profile" && value) options.profile = value, index += 1
    else if (argument === "--max-candidates" && value) options.maxCandidates = Number(value), index += 1
    else if (argument === "--run-id" && value) options.runId = value, index += 1
    else if (argument === "--help") options.help = true
    else throw new TypeError(`Unknown or incomplete argument: ${argument}`)
  }
  if (options.all && options.cases.length) throw new TypeError("Use either --all or --case, not both")
  if (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1 || options.maxCandidates > 32) {
    throw new TypeError("--max-candidates must be an integer from 1 to 32")
  }
  return options
}

function resolveCase(id) {
  const entry = manifest.cases.find((candidate) => candidate.id === id)
  if (!entry) throw new TypeError(`Unknown case ${id}; use --list`)
  return entry
}

async function runCase(entry, options, signal) {
  const arguments_ = [join(e2eDirectory, entry.directory, "run.mjs"), "--profile", options.profile, "--max-candidates", String(options.maxCandidates)]
  if (options.runId) arguments_.push("--run-id", options.runId)

  console.log(`\n[corpus] ${entry.id}: ${entry.focus}`)
  if (entry.knownImportGap) console.log(`[corpus] known adapter gap: ${entry.knownImportGap}`)
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, arguments_, {
      cwd: routerDirectory,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
      signal,
    })
    child.once("error", reject)
    child.once("close", (code, childSignal) => resolveResult({ code, signal: childSignal }))
  })
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) return console.log(usage())
  if (options.list) {
    for (const entry of manifest.cases) {
      console.log(`${entry.id.padEnd(34)} ${entry.focus}${entry.knownImportGap ? " [known import gap]" : ""}`)
    }
    return
  }
  if (!options.all && !options.cases.length) throw new TypeError(`Select --case or --all.\n\n${usage()}`)

  const selected = options.all ? manifest.cases : options.cases.map(resolveCase)
  const controller = new AbortController()
  const abort = (name) => controller.abort(new Error(`Received ${name}`))
  const onInterrupt = () => abort("SIGINT")
  const onTerminate = () => abort("SIGTERM")
  process.once("SIGINT", onInterrupt)
  process.once("SIGTERM", onTerminate)
  const failures = []
  try {
    for (const entry of selected) {
      const result = await runCase(entry, options, controller.signal)
      if (result.code !== 0) failures.push({ case: entry.id, ...result })
      if (controller.signal.aborted) break
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt)
    process.removeListener("SIGTERM", onTerminate)
  }
  if (failures.length) throw new Error(`Corpus failures: ${JSON.stringify(failures)}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
