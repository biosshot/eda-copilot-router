#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { run } from "./core/router.js"
import { validateRoutingBoard } from "./core/validation.js"
import { compileRoutingDsl } from "./intent/builder.js"
import { compileRoutingRules } from "./intent/preflight.js"

const HELP = `copilot-router

Commands:
  doctor
  validate <routing-board.json> --dsl <routing.dsl.js>
  run <routing-board.json> --dsl <routing.dsl.js> -o <result.json>

The CLI is EDA-neutral. Import/apply/refill/DRC remain host-adapter operations.
`

function option(args: string[], ...names: string[]) {
  for (const name of names) {
    const index = args.indexOf(name)
    if (index >= 0) return args[index + 1]
  }
  return undefined
}

async function json(path: string) {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP)
    return 0
  }
  if (command === "doctor") {
    process.stdout.write(`${JSON.stringify({ node: process.version, edaAccess: "none", cwd: process.cwd() }, null, 2)}\n`)
    return 0
  }
  const boardPath = args[1]
  const dslPath = option(args, "--dsl")
  if (!boardPath || !dslPath) throw new TypeError(`${command} requires <routing-board.json> --dsl <routing.dsl.js>`)
  const boardInput = await json(boardPath)
  const validation = validateRoutingBoard(boardInput)
  if (!validation.ok || !validation.value) {
    process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`)
    return 1
  }
  const source = await readFile(resolve(dslPath), "utf8")
  if (command === "validate") {
    let program
    try { program = compileRoutingDsl(source) } catch (error) {
      process.stdout.write(`${JSON.stringify({ valid: false, diagnostics: [{
        code: "DSL_COMPILE_ERROR", severity: "error",
        message: error instanceof Error ? error.message : String(error),
      }] }, null, 2)}\n`)
      return 1
    }
    const compiled = compileRoutingRules(validation.value, program)
    const valid = !compiled.diagnostics.some((item) => item.severity === "error")
    process.stdout.write(`${JSON.stringify({ valid, program, ...compiled }, null, 2)}\n`)
    return valid ? 0 : 1
  }
  if (command !== "run") throw new TypeError(`Unknown command ${command}`)
  const outputPath = option(args, "-o", "--output")
  if (!outputPath) throw new TypeError("run requires -o <result.json>")
  const program = compileRoutingDsl(source)
  const result = await run({ board: validation.value, dsl: program })
  await writeFile(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, "utf8")
  return result.status === "error" ? 1 : 0
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
