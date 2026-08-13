import type { RoutingDiagnostic } from "../core/contracts.js"
import type { RoutingProgram } from "./types.js"

export type ProgramValidation = Readonly<{
  valid: boolean
  diagnostics: readonly RoutingDiagnostic[]
}>

function error(code: string, message: string, path?: string): RoutingDiagnostic {
  return { code, severity: "error", message, ...(path ? { path } : {}) }
}

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

export function validateRoutingProgram(program: RoutingProgram): ProgramValidation {
  const diagnostics: RoutingDiagnostic[] = []
  if (!program || typeof program !== "object") {
    return { valid: false, diagnostics: [error("DSL_PROGRAM_REQUIRED", "Routing program is required.")] }
  }
  if (!["apply-drc", "route", "all"].includes(program.operation)) {
    diagnostics.push(error("DSL_TERMINAL_REQUIRED", "Routing program requires one terminal command.", "operation"))
  }
  const ids = new Set<string>()
  for (const [index, pair] of (program.differentialPairs ?? []).entries()) {
    if (ids.has(pair.id)) diagnostics.push(error("DSL_DUPLICATE_ID", `Duplicate special rule id ${pair.id}.`, `differentialPairs[${index}].id`))
    ids.add(pair.id)
    if (pair.positive === pair.negative) diagnostics.push(error("DSL_DIFF_PAIR_SAME_NET", `${pair.id} uses the same net twice.`))
    if (pair.via?.diameterMm !== undefined && pair.via?.drillMm !== undefined
      && pair.via.drillMm >= pair.via.diameterMm) {
      diagnostics.push(error("DSL_VIA_CONFLICT", `${pair.id} via drill must be smaller than its diameter.`))
    }
  }
  for (const [index, group] of (program.matchedGroups ?? []).entries()) {
    if (ids.has(group.id)) diagnostics.push(error("DSL_DUPLICATE_ID", `Duplicate special rule id ${group.id}.`, `matchedGroups[${index}].id`))
    ids.add(group.id)
    if (new Set(group.nets).size !== group.nets.length) diagnostics.push(error("DSL_MATCHED_GROUP_DUPLICATE_NET", `${group.id} contains duplicate nets.`))
  }
  for (const [index, power] of (program.powerNets ?? []).entries()) {
    if (!positive(power.maxCurrentA) && !positive(power.minTrackWidthMm)) {
      diagnostics.push(error("DSL_POWER_REQUIREMENT_MISSING", `${power.net} needs maxCurrentA or minTrackWidthMm.`, `powerNets[${index}]`))
    }
    if (power.maxTrackWidthMm !== undefined && power.maxTrackWidthMm > 10) {
      diagnostics.push(error("DSL_MAX_WIDTH_LIMIT", "maxTrackWidthMm may not exceed 10 mm.", `powerNets[${index}].maxTrackWidthMm`))
    }
    if (power.minTrackWidthMm !== undefined && power.maxTrackWidthMm !== undefined
      && power.minTrackWidthMm > power.maxTrackWidthMm) {
      diagnostics.push(error("DSL_RULE_CONFLICT", `${power.net} minimum width exceeds its maximum width.`))
    }
  }
  for (const net of [...(program.powerNets ?? []), ...(program.signalNets ?? []), ...(program.differentialPairs ?? [])]) {
    if (net.via?.diameterMm !== undefined && net.via?.drillMm !== undefined
      && net.via.drillMm >= net.via.diameterMm) diagnostics.push(error(
      "DSL_VIA_CONFLICT", "Via drill must be smaller than its diameter.",
    ))
  }
  return { valid: !diagnostics.some((item) => item.severity === "error"), diagnostics }
}
