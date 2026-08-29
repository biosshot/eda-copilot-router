import type { RoutingBoard, RoutingRules, RoutingRuleValues } from "./contracts.js"
import type {
  FanoutIntent,
  MatchedGroupIntent,
  NetPriority,
  RoutingProgram,
  ViaPreference,
} from "../intent/types.js"

export type ResolvedNetPolicy = Readonly<{
  net: string
  priority: NetPriority
  viaPreference: ViaPreference
  /** Internal ordering/scoring value. It is deliberately not authorable. */
  priorityWeight: number
  /** Internal relative penalty used by candidate grading. */
  viaPenalty: number
  protectOnSuccess: boolean
}>

export type RouteConstraintGroup = Readonly<{
  id: string
  kind: "differential" | "matched" | "critical"
  nets: readonly string[]
  constraintSignature: string
}>

/** Board-aware, backend-facing plan. Authoring objects never become KRT flags. */
export type ResolvedRoutePlan = Readonly<{
  schemaVersion: 1
  scopeNets: readonly string[]
  netPolicies: readonly ResolvedNetPolicy[]
  fanout: Readonly<{
    enabled: boolean
    targets: readonly FanoutIntent[]
  }>
  groups: readonly RouteConstraintGroup[]
  mainNets: readonly string[]
}>

const PRIORITY_WEIGHT: Readonly<Record<NetPriority, number>> = Object.freeze({
  critical: 64,
  high: 16,
  normal: 4,
  low: 1,
})

const VIA_PENALTY: Readonly<Record<ViaPreference, number>> = Object.freeze({
  auto: 1,
  avoid: 16,
  forbid: 1_000_000,
})

const priorityOrder: readonly NetPriority[] = ["low", "normal", "high", "critical"]
const viaOrder: readonly ViaPreference[] = ["auto", "avoid", "forbid"]

function stronger<T extends string>(left: T, right: T, order: readonly T[]) {
  return order.indexOf(left) >= order.indexOf(right) ? left : right
}

function ruleFor(rules: RoutingRules, net: string) {
  return rules.nets.find((entry) => entry.net === net)?.values ?? rules.default
}

function ruleSignature(values: RoutingRuleValues) {
  return JSON.stringify({
    allowedLayers: [...(values.allowedLayers ?? [])].sort(),
    minTrackWidthMm: values.minTrackWidthMm,
    preferredTrackWidthMm: values.preferredTrackWidthMm,
    clearanceMm: values.clearanceMm,
    via: values.via,
    differential: values.differential,
  })
}

function matchedSignature(group: MatchedGroupIntent, rules: RoutingRules) {
  return JSON.stringify({
    toleranceMm: group.toleranceMm,
    rules: group.nets.map((net) => ruleSignature(ruleFor(rules, net))),
  })
}

function groupBySignature(
  kind: RouteConstraintGroup["kind"],
  values: readonly Readonly<{ id: string; nets: readonly string[]; signature: string }>[] ,
) {
  const grouped = new Map<string, { ids: string[]; nets: string[] }>()
  for (const value of values) {
    const current = grouped.get(value.signature) ?? { ids: [], nets: [] }
    current.ids.push(value.id)
    current.nets.push(...value.nets)
    grouped.set(value.signature, current)
  }
  return [...grouped.entries()].map(([constraintSignature, value], index): RouteConstraintGroup => ({
    id: `${kind}:${index}:${value.ids.join("+")}`,
    kind,
    nets: [...new Set(value.nets)],
    constraintSignature,
  }))
}

export function resolveRoutePlan(
  board: RoutingBoard,
  program: RoutingProgram,
  rules: RoutingRules,
): ResolvedRoutePlan {
  const selected = new Set(program.onlyNets ?? board.nets.map((net) => net.name))
  for (const net of program.ignoreNets) selected.delete(net)
  const scopeNets = board.nets.map((net) => net.name).filter((net) => selected.has(net))

  const declared = new Map<string, { priority: NetPriority; viaPreference: ViaPreference }>()
  for (const intent of [...program.signalNets, ...program.powerNets]) {
    const current = declared.get(intent.net)
    declared.set(intent.net, {
      priority: current
        ? stronger(current.priority, intent.priority ?? "normal", priorityOrder)
        : intent.priority ?? "normal",
      viaPreference: current
        ? stronger(current.viaPreference, intent.viaPreference ?? "auto", viaOrder)
        : intent.viaPreference ?? "auto",
    })
  }
  const netPolicies = scopeNets.map((net): ResolvedNetPolicy => {
    const policy = declared.get(net) ?? { priority: "normal" as const, viaPreference: "auto" as const }
    return {
      net,
      ...policy,
      priorityWeight: PRIORITY_WEIGHT[policy.priority],
      viaPenalty: VIA_PENALTY[policy.viaPreference],
      protectOnSuccess: policy.priority === "critical",
    }
  })

  const differential = groupBySignature("differential", program.differentialPairs
    .filter((pair) => selected.has(pair.positive) && selected.has(pair.negative))
    .map((pair) => ({
      id: pair.id,
      nets: [pair.positive, pair.negative],
      signature: JSON.stringify({
        positive: ruleSignature(ruleFor(rules, pair.positive)),
        negative: ruleSignature(ruleFor(rules, pair.negative)),
        maxSkewMm: pair.maxSkewMm,
        maxUncoupledLengthMm: pair.maxUncoupledLengthMm,
      }),
    })))
  const matched = groupBySignature("matched", program.matchedGroups
    .filter((group) => group.nets.every((net) => selected.has(net)))
    .map((group) => ({ id: group.id, nets: group.nets, signature: matchedSignature(group, rules) })))
  const critical = groupBySignature("critical", netPolicies
    .filter((policy) => policy.priority === "critical")
    .map((policy) => ({
      id: policy.net,
      nets: [policy.net],
      signature: JSON.stringify({
        rule: ruleSignature(ruleFor(rules, policy.net)),
        viaPreference: policy.viaPreference,
      }),
    })))
  const preMain = new Set([...differential, ...matched, ...critical].flatMap((group) => group.nets))

  return Object.freeze({
    schemaVersion: 1 as const,
    scopeNets: Object.freeze(scopeNets),
    netPolicies: Object.freeze(netPolicies),
    fanout: Object.freeze({ enabled: program.fanouts.length > 0, targets: Object.freeze([...program.fanouts]) }),
    groups: Object.freeze([...differential, ...matched, ...critical]),
    mainNets: Object.freeze(scopeNets.filter((net) => !preMain.has(net))),
  })
}
