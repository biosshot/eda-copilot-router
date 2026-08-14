import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

process.env.COPILOT_ROUTER_E2E_CASE_DIRECTORY = dirname(fileURLToPath(import.meta.url))
process.env.COPILOT_ROUTER_E2E_SUITE = "kicad-routing-tools"
await import("../_shared/case-entry.mjs")
