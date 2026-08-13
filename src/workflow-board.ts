import { copyFile } from "node:fs/promises"
import { extname } from "node:path"
import {
  listChildren,
} from "../../kicad-copilot/src/kicad/pcb-reader"
import {
  atom,
  findChild,
  type SExpression,
} from "../../kicad-copilot/src/kicad/sexpr/ast"

export function boardStem(path: string) {
  const extension = extname(path)
  return extension ? path.slice(0, -extension.length) : path
}

export async function copyBoardSidecars(
  sourceBoard: string,
  targetBoard: string,
  exists: (path: string) => Promise<boolean>,
) {
  for (const suffix of [".kicad_pro", ".kicad_dru", ".kicad_prl"]) {
    const source = `${boardStem(sourceBoard)}${suffix}`
    if (await exists(source)) await copyFile(source, `${boardStem(targetBoard)}${suffix}`)
  }
}

function nodeNetName(root: SExpression[], node: SExpression[]) {
  const net = findChild(node, "net")
  if (!net) return ""
  if (net.length >= 3) return atom(net[2]) ?? ""
  const number = atom(net[1]) ?? ""
  if (!/^\d+$/.test(number)) return number
  return atom(listChildren(root, "net").find((entry) => atom(entry[1]) === number)?.[2]) ?? ""
}

function canonicalNode(value: SExpression, ignoredHeads: ReadonlySet<string>): unknown {
  if (!Array.isArray(value)) return { value: value.value, quoted: value.quoted }
  const head = atom(value[0]) ?? ""
  if (ignoredHeads.has(head)) return undefined
  return value.map((item) => canonicalNode(item, ignoredHeads)).filter((item) => item !== undefined)
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Exact geometry multiset for a net, ignoring only identity/lock metadata. */
export function copperGeometrySignatures(root: SExpression[], netName: string) {
  const ignored = new Set(["uuid", "tstamp", "locked"])
  return (["segment", "arc", "via"] as const).flatMap((head) => (
    listChildren(root, head)
      .filter((item) => nodeNetName(root, item) === netName)
      .map((item) => `${head}:${JSON.stringify(canonicalNode(item, ignored))}`)
  )).sort()
}

export function changedCopperGeometryNets(
  before: SExpression[],
  after: SExpression[],
  netNames: readonly string[],
) {
  return [...new Set(netNames)].filter((net) => !sameStrings(
    copperGeometrySignatures(before, net),
    copperGeometrySignatures(after, net),
  ))
}

/** Zone contract excluding refill-owned filled_polygon caches. */
export function zoneOutlineSignatures(root: SExpression[]) {
  const ignored = new Set(["filled_polygon"])
  return listChildren(root, "zone")
    .map((zone) => JSON.stringify(canonicalNode(zone, ignored)))
    .sort()
}

/** Placement custody: reference, side and exact footprint position/rotation. */
export function footprintPlacementSignatures(root: SExpression[]) {
  return listChildren(root, "footprint")
    .map((footprint) => {
      const reference = listChildren(footprint, "property")
        .find((property) => atom(property[1]) === "Reference")
      return JSON.stringify({
        reference: atom(reference?.[2]) ?? "",
        layer: atom(findChild(footprint, "layer")?.[1]) ?? "",
        at: canonicalNode(findChild(footprint, "at") ?? [], new Set()),
      })
    })
    .sort()
}

export function placementChanged(before: SExpression[], after: SExpression[]) {
  return !sameStrings(footprintPlacementSignatures(before), footprintPlacementSignatures(after))
}

export function zonesChanged(before: SExpression[], after: SExpression[]) {
  return !sameStrings(zoneOutlineSignatures(before), zoneOutlineSignatures(after))
}

export function boardCopperMetrics(root: SExpression[]) {
  const segments = listChildren(root, "segment")
  const arcs = listChildren(root, "arc")
  const vias = listChildren(root, "via")
  const segmentLength = segments.reduce((sum, segment) => {
    const start = findChild(segment, "start")
    const end = findChild(segment, "end")
    return sum + Math.hypot(
      Number(atom(end?.[1])) - Number(atom(start?.[1])),
      Number(atom(end?.[2])) - Number(atom(start?.[2])),
    )
  }, 0)
  const arcLength = arcs.reduce((sum, arc) => {
    const start = findChild(arc, "start")
    const end = findChild(arc, "end")
    const angle = Math.abs(Number(atom(findChild(arc, "angle")?.[1])) || 0) * Math.PI / 180
    const chord = Math.hypot(
      Number(atom(end?.[1])) - Number(atom(start?.[1])),
      Number(atom(end?.[2])) - Number(atom(start?.[2])),
    )
    if (!(angle > 1e-9) || chord <= 1e-9) return sum + chord
    const radius = chord / (2 * Math.sin(Math.min(Math.PI, angle) / 2))
    return sum + (Number.isFinite(radius) ? radius * angle : chord)
  }, 0)
  return {
    viaCount: vias.length,
    segmentCount: segments.length,
    arcCount: arcs.length,
    wireLengthMm: Number((segmentLength + arcLength).toFixed(6)),
  }
}
