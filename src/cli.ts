#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import {
  routePcb,
  validatePcbSnapshotV1,
} from "./core/index.js"
import { validateRoutingIntentV2 } from "./intent/index.js"
import type { RouterBackendAdapter } from "./adapters/contracts.js"

type ParsedCommand = Readonly<{
  command?: string
  positionals: readonly string[]
  options: Readonly<Record<string, string | boolean>>
}>

const HELP = `copilot-router - EDA-neutral PCB routing core

Usage:
  copilot-router validate <snapshot.json> [--intent <intent.json>]
  copilot-router route <snapshot.json> --intent <intent.json> --backend <module> --output <result.json>
  copilot-router doctor [--backend <module>]

The backend module must export a RouterBackendAdapter as "default" or "backend".
Paths are resolved from the current working directory. The CLI never starts or
contacts KiCad, EasyEDA, or another EDA.
`

function parseArgs(argv: readonly string[]): ParsedCommand {
  const command = argv[0]
  const positionals: string[] = []
  const options: Record<string, string | boolean> = {}
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }
    const [rawName, inlineValue] = token.slice(2).split("=", 2)
    if (!rawName) throw new Error(`Invalid option: ${token}`)
    if (inlineValue !== undefined) {
      options[rawName] = inlineValue
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      options[rawName] = next
      index += 1
    } else {
      options[rawName] = true
    }
  }
  return { command, positionals, options }
}

function optionString(options: ParsedCommand["options"], name: string): string | undefined {
  const value = options[name]
  return typeof value === "string" ? value : undefined
}

function requiredOption(options: ParsedCommand["options"], name: string): string {
  const value = optionString(options, name)
  if (value === undefined) throw new Error(`Missing required option --${name}`)
  return value
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8"))
}

async function loadBackend(specifier: string): Promise<RouterBackendAdapter> {
  const isPath = specifier.startsWith(".") || specifier.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(specifier)
  const resolvedSpecifier = isPath
    ? pathToFileURL(resolve(specifier)).href
    : pathToFileURL(createRequire(resolve("package.json")).resolve(specifier)).href
  const module = await import(resolvedSpecifier) as {
    default?: unknown
    backend?: unknown
  }
  const candidate = module.default ?? module.backend
  if (
    typeof candidate !== "object" || candidate === null ||
    typeof (candidate as { route?: unknown }).route !== "function"
  ) {
    throw new Error(`Backend module ${JSON.stringify(specifier)} exports neither a valid default nor backend adapter`)
  }
  return candidate as RouterBackendAdapter
}

function printDiagnostics(result: { valid: boolean; diagnostics: readonly unknown[] }): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.valid) process.exitCode = 2
}

function validationSucceeded(result: { valid?: boolean; ok?: boolean }): boolean {
  return result.valid ?? result.ok ?? false
}

async function validateCommand(command: ParsedCommand): Promise<void> {
  const snapshotPath = command.positionals[0]
  if (snapshotPath === undefined) throw new Error("validate requires <snapshot.json>")
  const snapshotResult = validatePcbSnapshotV1(await readJson(snapshotPath))
  const intentPath = optionString(command.options, "intent")
  const intentResult = intentPath === undefined
    ? undefined
    : validateRoutingIntentV2(await readJson(intentPath))
  const diagnostics = [
    ...snapshotResult.diagnostics,
    ...(intentResult?.diagnostics ?? []),
  ]
  printDiagnostics({
    valid: validationSucceeded(snapshotResult) && (intentResult === undefined || validationSucceeded(intentResult)),
    diagnostics,
  })
}

async function routeCommand(command: ParsedCommand): Promise<void> {
  const snapshotPath = command.positionals[0]
  if (snapshotPath === undefined) throw new Error("route requires <snapshot.json>")
  const snapshotInput = await readJson(snapshotPath)
  const intentInput = await readJson(requiredOption(command.options, "intent"))
  const snapshotResult = validatePcbSnapshotV1(snapshotInput)
  const intentResult = validateRoutingIntentV2(intentInput)
  if (!validationSucceeded(snapshotResult) || !validationSucceeded(intentResult)) {
    printDiagnostics({
      valid: false,
      diagnostics: [...snapshotResult.diagnostics, ...intentResult.diagnostics],
    })
    return
  }

  const backend = await loadBackend(requiredOption(command.options, "backend"))
  const result = await routePcb({
    snapshot: snapshotResult.value!,
    intent: intentInput,
    backend,
  })
  const output = resolve(requiredOption(command.options, "output"))
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8")
  process.stdout.write(`${output}\n`)
  if (result.patch.coreStatus === "error") process.exitCode = 2
}

async function doctorCommand(command: ParsedCommand): Promise<void> {
  const report: Record<string, unknown> = {
    ok: true,
    package: "@easyeda-copilot/router",
    node: process.version,
    minimumNode: "20",
    edaAccess: "none",
  }
  const backendSpecifier = optionString(command.options, "backend")
  if (backendSpecifier !== undefined) {
    const backend = await loadBackend(backendSpecifier)
    report.backend = {
      id: backend.id,
      version: backend.version,
      capabilities: backend.capabilities,
    }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2))
  if (command.command === undefined || command.command === "help" || command.options.help === true) {
    process.stdout.write(HELP)
    return
  }
  if (command.command === "validate") return validateCommand(command)
  if (command.command === "route") return routeCommand(command)
  if (command.command === "doctor") return doctorCommand(command)
  throw new Error(`Unknown command ${JSON.stringify(command.command)}\n\n${HELP}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`copilot-router: ${message}\n`)
  process.exitCode = 1
})

