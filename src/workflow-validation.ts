import type { PowerRoutingValidation } from "./power-intent"

type JsonRecord = Record<string, unknown>

export type FinalDrcSummary = {
  newErrorViolations: Array<{ key: string; type: string }>
  missingNonGroundNets: string[]
  missingNonGroundItems: number
  missingRequiredGroundNets: string[]
  missingRequiredGroundItems: number
  totalUnconnectedItems: number
}

export type FinalValidation = FinalDrcSummary & {
  completed: true
  valid: boolean
  powerValidation?: PowerRoutingValidation
  powerViolationCount?: number
}

function extractNet(description: unknown) {
  return String(description ?? "").match(/\[([^\]]+)\]/)?.[1] ?? ""
}

function errorViolationIdentity(report: unknown) {
  const root = report && typeof report === "object" ? report as JsonRecord : {}
  const violations = Array.isArray(root.violations) ? root.violations : []
  return violations.flatMap((violation) => {
    if (!violation || typeof violation !== "object") return []
    const item = violation as JsonRecord
    if (item.severity !== "error") return []
    const type = typeof item.type === "string" ? item.type : "unknown"
    const subjects = (Array.isArray(item.items) ? item.items : []).map((subject) => {
      if (!subject || typeof subject !== "object") return String(subject)
      const fields = subject as JsonRecord
      if (typeof fields.uuid === "string") return fields.uuid
      return JSON.stringify({ description: fields.description, pos: fields.pos })
    }).sort()
    return [{ key: `${type}:${subjects.join("|")}`, type }]
  })
}

export function summarizeFinalDrc(
  baseline: unknown,
  final: unknown,
  options: { requiredGroundNets?: readonly string[] } = {},
): FinalDrcSummary {
  const baselineKeys = new Set(errorViolationIdentity(baseline).map((item) => item.key))
  const newErrorViolations = errorViolationIdentity(final)
    .filter((item) => !baselineKeys.has(item.key))
    .sort((left, right) => left.key.localeCompare(right.key))
  const root = final && typeof final === "object" ? final as JsonRecord : {}
  const unconnectedItems = Array.isArray(root.unconnected_items) ? root.unconnected_items : []
  const missingNets = new Set<string>()
  const missingGroundNets = new Set<string>()
  const requiredGroundNets = new Map((options.requiredGroundNets ?? [])
    .map((net) => [String(net).toUpperCase(), String(net)] as const))
  let missingNonGroundItems = 0
  let missingRequiredGroundItems = 0
  for (const entry of unconnectedItems) {
    if (!entry || typeof entry !== "object") continue
    const items = Array.isArray((entry as JsonRecord).items) ? (entry as JsonRecord).items : []
    const nets = new Set(items.map((item) => (
      item && typeof item === "object" ? extractNet((item as JsonRecord).description) : ""
    )).filter(Boolean))
    const ground = [...nets].filter((net) => requiredGroundNets.has(net.toUpperCase()))
    const nonGround = [...nets].filter((net) => !requiredGroundNets.has(net.toUpperCase()))
    const zoneOnlySelfReference = ground.length > 0
      && items.length > 0
      && items.every((item) => item && typeof item === "object"
        && String((item as JsonRecord).description ?? "").startsWith("Zone "))
      && new Set(items.map((item) => (
        item && typeof item === "object" ? String((item as JsonRecord).uuid ?? "") : ""
      )).filter(Boolean)).size <= 1
    if (ground.length && !zoneOnlySelfReference) {
      missingRequiredGroundItems += 1
      for (const net of ground) missingGroundNets.add(requiredGroundNets.get(net.toUpperCase()) ?? net)
    }
    if (nonGround.length) {
      const ordinary = nonGround.filter((net) => net.toUpperCase() !== "GND")
      if (!ordinary.length) continue
      missingNonGroundItems += 1
      for (const net of ordinary) missingNets.add(net)
    }
  }
  return {
    newErrorViolations,
    missingNonGroundNets: [...missingNets].sort(),
    missingNonGroundItems,
    missingRequiredGroundNets: [...missingGroundNets].sort(),
    missingRequiredGroundItems,
    totalUnconnectedItems: unconnectedItems.length,
  }
}

export function deriveFinalValidation(
  baseline: unknown,
  final: unknown,
  powerValidation?: PowerRoutingValidation,
  options: { requiredGroundNets?: readonly string[] } = {},
): FinalValidation {
  const summary = summarizeFinalDrc(baseline, final, options)
  return {
    completed: true,
    valid: summary.newErrorViolations.length === 0
      && summary.missingNonGroundItems === 0
      && summary.missingRequiredGroundItems === 0
      && (powerValidation?.valid ?? true),
    ...summary,
    ...(powerValidation ? {
      powerValidation,
      powerViolationCount: powerValidation.violations.length,
    } : {}),
  }
}
