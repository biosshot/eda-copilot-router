import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const routerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const corpusDirectory = join(routerDirectory, "tests/e2e/_corpora/easyeda-hybrid")
const manifest = JSON.parse(await readFile(join(corpusDirectory, "manifest.json"), "utf8"))

function sourceRoot(argv) {
  const index = argv.indexOf("--source-root")
  if (index < 0 || !argv[index + 1]) {
    throw new TypeError("Usage: node scripts/import-easyeda-hybrid-corpus.mjs --source-root <copilot-router artifact root>")
  }
  return resolve(argv[index + 1])
}

const round = (diameterMm, plated = true) => ({ shape: "round", diameterMm, plated })
const slot = (diameterMm, totalLengthMm, plated = true) => ({
  shape: "slot", diameterMm,
  slotLengthMm: Number((totalLengthMm - diameterMm).toFixed(12)),
  plated,
})

function historicalHole(footprint, padNumber) {
  switch (footprint) {
    case "Screw-Hole-M2": return round(2, false)
    case "FREEPADFOOTPRINT": return round(3.2, false)
    case "SW-TH_SS12D07VG4": return ["4", "5"].includes(padNumber) ? slot(0.6, 1.4) : round(1)
    case "SW-TH_EC11XXXXXXXX": return ["6", "7"].includes(padNumber) ? slot(1, 1.6) : round(1.2)
    case "CONN-TH_2P-P2.00_BOSSIE_BX-PH2.0-2PZZ":
    case "CONN-TH_B2B-PH-K-S":
    case "CONN-TH_B4B-PH-K-S":
    case "CONN-TH_B6B-PH-K-S": return round(0.8)
    case "CONN-TH_P5.08_KF128-5.08-2P": return round(1.2)
    case "CONN-TH_15P-L38.5-W2.4-P2.54":
    case "HDR-TH_3P-P2.54-V-M":
    case "HDR-TH_6P-P2.54-V-M-R2-C3-S2.54-1":
    case "HDR-TH_10P-P2.54-V-M": return round(1)
    case "TYPE-C-SMD_20009-UCAF001-X":
    case "TYPE-C-SMD_SBC-160S1A-20-S412":
    case "USB-C-SMD_TYPE-C16PIN":
    case "USB-C_SMD-TYPE-C-31-M-12_1": return slot(0.6, 1)
    default: return undefined
  }
}

const source = sourceRoot(process.argv.slice(2))
for (const item of manifest.cases) {
  const capture = join(source, `pcb-dsl-${item.id}`)
  const [routerText, easyText] = await Promise.all([
    readFile(join(capture, "copilot-router-input.json"), "utf8"),
    readFile(join(capture, "easyeda-routing-input.json"), "utf8"),
  ])
  const input = JSON.parse(routerText)
  const easyeda = JSON.parse(easyText)
  const lookup = new Map()
  for (const [component, value] of Object.entries(easyeda.components ?? {})) {
    const footprintName = String(value.footprint ?? "")
    const footprint = easyeda.footprints?.[footprintName]
    for (const [padKey, pad] of Object.entries(footprint?.pads ?? {})) {
      lookup.set(`${component}:${padKey}`, { footprint: footprintName, pad })
    }
  }
  const overrides = []
  input.board.pads = input.board.pads.map(pad => {
    if (pad.hole || pad.layers.length < 2) return pad
    const sourcePad = lookup.get(pad.id)
    if (!sourcePad) throw new Error(`${item.id}: no EasyEDA source pad for ${pad.id}`)
    const hole = historicalHole(sourcePad.footprint, String(pad.number))
    if (!hole) throw new Error(`${item.id}: no historical hole rule for ${sourcePad.footprint} ${pad.id}`)
    const normalized = { ...hole, plated: hole.plated && Boolean(pad.net) }
    overrides.push({ pad: pad.id, footprint: sourcePad.footprint, hole: normalized })
    return { ...pad, hole: normalized }
  })
  if (input.dsl && "quality" in input.dsl) delete input.dsl.quality
  if (overrides.length !== item.expectedHolePads) {
    throw new Error(`${item.id}: expected ${item.expectedHolePads} hole pads, got ${overrides.length}`)
  }
  const target = join(corpusDirectory, "fixture", item.id)
  await mkdir(target, { recursive: true })
  await Promise.all([
    writeFile(join(target, "input.json"), `${JSON.stringify(input, null, 2)}\n`),
    writeFile(join(target, "hole-overrides.json"), `${JSON.stringify({
      source: "historical-footprint-normalization",
      fabricationAuthoritative: false,
      pads: overrides,
    }, null, 2)}\n`),
    copyFile(join(capture, "routing.dsl.js"), join(target, "routing.dsl.js")),
  ])
  process.stdout.write(`${item.id}: ${overrides.length} hole pads\n`)
}
