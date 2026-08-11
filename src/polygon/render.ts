import type { ZonePlan } from "./engine"
import { ringsFromRawPad } from "./engine"
import type { PcbLayerName, PcbPoint, RawPcb } from "./raw-pcb"

const escapeXml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")

function pathData(rings: PcbPoint[][]) {
  return rings
    .filter((ring) => ring.length >= 3)
    .map((ring) => `M ${ring.map((point) => `${point.x} ${point.y}`).join(" L ")} Z`)
    .join(" ")
}

const layerColor = (layer: PcbLayerName) => layer === "TOP" ? "#ff5d4a" : layer === "BOTTOM" ? "#3e91ff" : "#ad7bff"

export function renderZonePlansSvg(
  pcb: RawPcb,
  plans: ZonePlan[],
  options: { layers?: PcbLayerName[]; title?: string } = {},
) {
  const board = pcb.board?.polygon ?? []
  if (board.length < 3) throw new Error("cannot render RawPcb without board outline")
  const layers = new Set(options.layers ?? ["TOP", "BOTTOM"])
  const visiblePlans = plans.filter((plan) => layers.has(plan.layer) && plan.boundary)
  const margin = 3
  const xs = board.map((point) => point.x)
  const ys = board.map((point) => point.y)
  const left = Math.min(...xs) - margin
  const right = Math.max(...xs) + margin
  const top = Math.min(...ys) - margin
  const bottom = Math.max(...ys) + margin
  const width = right - left
  const height = bottom - top

  const boundaries = visiblePlans.map((plan) => {
    const d = pathData([plan.boundary!])
    const ready = plan.status === "ready"
    const color = ready ? layerColor(plan.layer) : plan.status === "error" ? "#ff2d55" : "#ffb020"
    const title = ready
      ? `${plan.net} ${plan.layer} ${plan.intent.mode}`
      : `${plan.status.toUpperCase()} ${plan.net}: ${plan.reason}`
    return `<path d="${d}" fill="${color}" fill-opacity="${ready ? 0.34 : 0.08}" stroke="${color}" stroke-width="${ready ? 0.12 : 0.22}" ${ready ? "" : 'stroke-dasharray="0.7 0.45"'}><title>${escapeXml(title)}</title></path>`
  }).join("\n")

  const pads = pcb.pads
    .filter((pad) => pad.layer === "MULTI" || layers.has(pad.layer))
    .map((pad) => {
      const d = pathData(ringsFromRawPad(pad))
      const targeted = plans.some((plan) => plan.targetPads.some((target) =>
        (target.id && target.id === pad.id)
        || (target.component === pad.component && target.padNumber === pad.padNumber && target.x === pad.x && target.y === pad.y)))
      const fill = targeted ? "#f7ca45" : "#d8dee9"
      const owner = pad.component ? `${pad.component}/` : ""
      return d ? `<path d="${d}" fill="${fill}" fill-opacity="0.9" stroke="#242b35" stroke-width="0.05"><title>${escapeXml(pad.net || "NPTH")} ${escapeXml(owner + pad.padNumber)}</title></path>` : ""
    })
    .join("\n")

  const title = options.title ?? "Native EDA zone boundary plans"
  const readyCount = visiblePlans.filter((plan) => plan.status === "ready").length
  const skippedCount = visiblePlans.filter((plan) => plan.status === "skipped").length
  const errorCount = visiblePlans.filter((plan) => plan.status === "error").length
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${Math.round(1200 * height / width)}" viewBox="${left} ${top} ${width} ${height}">
<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="#11151c"/>
<path d="${pathData([board])}" fill="#1b222c" stroke="#d8dee9" stroke-width="0.12"/>
<g>${boundaries}</g>
<g>${pads}</g>
<g font-family="Segoe UI,Arial,sans-serif" font-size="1.25" fill="#ffffff">
  <rect x="${left + 1}" y="${top + 0.7}" width="${Math.min(width - 2, 62)}" height="2.3" rx="0.4" fill="#080b10" fill-opacity="0.82"/>
  <text x="${left + 1.8}" y="${top + 2.25}">${escapeXml(title)} · ${readyCount} ready · ${skippedCount} skipped · ${errorCount} errors</text>
</g>
</svg>`
}
