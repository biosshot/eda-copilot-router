import { copyFile, mkdir, readFile } from "node:fs/promises"
import { basename, dirname, extname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!["--input", "--result", "--output", "--router"].includes(key) || !value) {
      throw new TypeError("Usage: --input copilot-router-input.json --result routing-result.json --output routed.kicad_pcb [--router DIR]")
    }
    values[key.slice(2)] = value
  }
  if (!values.input || !values.result || !values.output) throw new TypeError("--input, --result and --output are required")
  return values
}

const args = parseArgs(process.argv.slice(2))
const routerDirectory = resolve(args.router ?? process.cwd())
const input = JSON.parse(await readFile(resolve(args.input), "utf8"))
const result = JSON.parse(await readFile(resolve(args.result), "utf8"))
if (!result.copper || !result.rules) throw new TypeError("routing-result.json has no copper/rules payload")

const output = resolve(args.output)
const outputDirectory = dirname(output)
await mkdir(outputDirectory, { recursive: true })
const codec = await import(pathToFileURL(join(routerDirectory, "package-dist", "backends", "krt-codec.js")))
const api = await import(pathToFileURL(join(routerDirectory, "package-dist", "index.js")))
const physicalStackup = api.materializeRoutingStackup(input.board, input.dsl?.stack).stackup
const board = {
  ...input.board,
  ...(physicalStackup ? { stackup: physicalStackup } : {}),
  rules: result.rules,
  copper: {
    fixed: input.board.copper.fixed,
    editable: result.copper,
  },
}
const generated = await codec.writeKrtBoard({ board, rules: result.rules }, outputDirectory)
const stem = basename(output, extname(output))
const projectOutput = join(outputDirectory, `${stem}.kicad_pro`)
await Promise.all([
  copyFile(generated.inputBoard, output),
  copyFile(generated.inputProject, projectOutput),
])
console.log(JSON.stringify({ board: output, project: projectOutput }, null, 2))
