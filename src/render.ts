import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  childText,
  footprintAt,
  footprintReference,
  listChildren,
  readPcb,
} from "../../kicad-copilot/src/kicad/pcb-reader"
import { atom, findChild, type SExpression } from "../../kicad-copilot/src/kicad/sexpr/ast"

type Point = { x: number; y: number }

const inputPath = resolve(process.argv[2] ?? "")
const outputPath = resolve(process.argv[3] ?? inputPath.replace(/\.kicad_pcb$/i, ".svg"))
if (!inputPath) throw new Error("Usage: node dist/render.js input.kicad_pcb [output.svg]")

function point(node: SExpression[], head: string): Point {
  const child = findChild(node, head)
  return {
    x: Number(atom(child?.[1]) ?? 0),
    y: Number(atom(child?.[2]) ?? 0),
  }
}

function number(node: SExpression[], head: string, fallback: number) {
  const value = Number(atom(findChild(node, head)?.[1]))
  return Number.isFinite(value) ? value : fallback
}

function escape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

const pcb = await readPcb(inputPath)
const segments = listChildren(pcb.root, "segment").map((segment) => ({
  start: point(segment, "start"),
  end: point(segment, "end"),
  width: number(segment, "width", 0.2),
  layer: childText(segment, "layer") ?? "F.Cu",
}))
const vias = listChildren(pcb.root, "via").map((via) => ({
  at: point(via, "at"),
  size: number(via, "size", 0.6),
}))
const footprints = listChildren(pcb.root, "footprint").map((footprint) => ({
  at: footprintAt(footprint),
  reference: footprintReference(footprint) ?? "",
}))

const points = [
  ...segments.flatMap((segment) => [segment.start, segment.end]),
  ...vias.map((via) => via.at),
  ...footprints.map((footprint) => footprint.at),
]
const xs = points.map((item) => item.x)
const ys = points.map((item) => item.y)
const minX = Math.min(...xs) - 4
const maxX = Math.max(...xs) + 4
const minY = Math.min(...ys) - 4
const maxY = Math.max(...ys) + 4
const scale = 10
const width = (maxX - minX) * scale
const height = (maxY - minY) * scale
const sx = (x: number) => (x - minX) * scale
const sy = (y: number) => (y - minY) * scale

const tracks = segments.map((segment) => {
  const front = segment.layer === "F.Cu"
  return `<line x1="${sx(segment.start.x)}" y1="${sy(segment.start.y)}" x2="${sx(segment.end.x)}" y2="${sy(segment.end.y)}" stroke="${front ? "#ff5d4a" : "#3e91ff"}" stroke-width="${Math.max(segment.width * scale, 1.5)}" stroke-linecap="round" opacity="0.88"/>`
}).join("\n")
const viaSvg = vias.map((via) => (
  `<circle cx="${sx(via.at.x)}" cy="${sy(via.at.y)}" r="${Math.max(via.size * scale / 2, 2.5)}" fill="#f7ca45" stroke="#171b23" stroke-width="1"/>`
)).join("\n")
const footprintSvg = footprints.map((footprint) => (
  `<g><circle cx="${sx(footprint.at.x)}" cy="${sy(footprint.at.y)}" r="3" fill="#d8dee9" stroke="#11151c" stroke-width="1"/><text x="${sx(footprint.at.x) + 5}" y="${sy(footprint.at.y) - 5}" font-size="11" fill="#eef2f8">${escape(footprint.reference)}</text></g>`
)).join("\n")

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#11151c"/>
<rect x="4" y="4" width="${width - 8}" height="${height - 8}" rx="12" fill="#1b222c" stroke="#667080" stroke-width="2"/>
<g>${tracks}</g>
<g>${viaSvg}</g>
<g>${footprintSvg}</g>
<g transform="translate(14,22)" font-family="Segoe UI,Arial,sans-serif" font-size="13" fill="#eef2f8">
  <rect x="-8" y="-16" width="315" height="25" rx="5" fill="#080b10" opacity="0.78"/>
  <text x="0" y="2">F.Cu</text><line x1="35" y1="-2" x2="65" y2="-2" stroke="#ff5d4a" stroke-width="4"/>
  <text x="78" y="2">B.Cu</text><line x1="115" y1="-2" x2="145" y2="-2" stroke="#3e91ff" stroke-width="4"/>
  <text x="160" y="2">via</text><circle cx="195" cy="-2" r="5" fill="#f7ca45"/>
  <text x="212" y="2">${segments.length} seg / ${vias.length} vias</text>
</g>
</svg>`

await writeFile(outputPath, svg)
console.log(JSON.stringify({ inputPath, outputPath, segments: segments.length, vias: vias.length }))
