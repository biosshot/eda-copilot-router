import { readdir } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

const caseDirectoryValue = process.env.COPILOT_ROUTER_E2E_CASE_DIRECTORY
if (!caseDirectoryValue) throw new TypeError("Missing COPILOT_ROUTER_E2E_CASE_DIRECTORY")
const caseDirectory = resolve(caseDirectoryValue)
const caseName = basename(caseDirectory)
const parentName = basename(dirname(caseDirectory))
const suiteName = process.env.COPILOT_ROUTER_E2E_SUITE ?? (parentName === "e2e" ? caseName : parentName)
const fixtureDirectory = join(caseDirectory, "fixture")
const fixtureFiles = await readdir(fixtureDirectory)
const boards = fixtureFiles.filter((name) => name.endsWith(".kicad_pcb"))
const projects = fixtureFiles.filter((name) => name.endsWith(".kicad_pro"))
if (boards.length !== 1) throw new TypeError(`${caseName} fixture must contain exactly one .kicad_pcb`)
if (projects.length > 1) throw new TypeError(`${caseName} fixture must contain at most one .kicad_pro`)

process.env.COPILOT_ROUTER_E2E_SUITE = suiteName
process.env.COPILOT_ROUTER_E2E_CASE = caseName
process.env.COPILOT_ROUTER_E2E_FIXTURE_PCB = join(fixtureDirectory, boards[0])
process.env.COPILOT_ROUTER_E2E_DSL = join(caseDirectory, "routing.js")
process.env.COPILOT_ROUTER_E2E_REQUIRE_UNROUTED ??= caseName === "powerbank" ? "1" : "0"
if (projects[0]) process.env.COPILOT_ROUTER_E2E_FIXTURE_PROJECT = join(fixtureDirectory, projects[0])
else delete process.env.COPILOT_ROUTER_E2E_FIXTURE_PROJECT

await import("./run-kicad-case.mjs")
