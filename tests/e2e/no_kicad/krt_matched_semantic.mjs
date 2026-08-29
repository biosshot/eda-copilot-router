import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const routerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const router = await import(pathToFileURL(resolve(routerDirectory, "package-dist/index.js")))

const rule = {
  clearanceMm: 0.2,
  edgeClearanceMm: 0.2,
  minTrackWidthMm: 0.127,
  preferredTrackWidthMm: 0.25,
  via: {
    minDiameterMm: 0.6,
    preferredDiameterMm: 0.8,
    minDrillMm: 0.3,
    preferredDrillMm: 0.4,
  },
}
const emptyCopper = { tracks: [], vias: [], zones: [] }
const netRows = [
  ["OK_A", 5],
  ["OK_B", 9],
  ["BAD_A", 15],
  ["BAD_B", 20],
]
const allRows = [...netRows, ["ROUTE", 27]]
const board = {
  outline: [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 32 }, { x: 0, y: 32 }],
  cutouts: [],
  layers: [
    { name: "TOP", index: 0, side: "top" },
    { name: "BOTTOM", index: 31, side: "bottom" },
  ],
  nets: allRows.map(([name]) => ({ name })),
  components: [
    { designator: "J1", at: { x: 5, y: 12 }, rotationDeg: 0, side: "top" },
    { designator: "J2", at: { x: 15, y: 12 }, rotationDeg: 0, side: "top" },
  ],
  pads: allRows.flatMap(([net, y], index) => ([
    { component: "J1", number: String(index + 1), net, at: { x: 5, y }, rotationDeg: 0, layers: ["TOP"], shape: { kind: "circle", diameterMm: 1 } },
    { component: "J2", number: String(index + 1), net, at: { x: 15, y }, rotationDeg: 0, layers: ["TOP"], shape: { kind: "circle", diameterMm: 1 } },
  ])),
  keepouts: [],
  rules: { default: rule, nets: [] },
  copper: {
    fixed: emptyCopper,
    editable: {
      tracks: [
        { net: "OK_A", layer: "TOP", widthMm: 0.25, points: [{ x: 5, y: 5 }, { x: 15, y: 5 }] },
        { net: "OK_B", layer: "TOP", widthMm: 0.25, points: [{ x: 5, y: 9 }, { x: 15, y: 9 }] },
        { net: "BAD_A", layer: "TOP", widthMm: 0.25, points: [{ x: 5, y: 15 }, { x: 15, y: 15 }] },
        { net: "BAD_B", layer: "TOP", widthMm: 0.25, points: [{ x: 5, y: 20 }, { x: 10, y: 23 }, { x: 15, y: 20 }] },
      ],
      vias: [],
      zones: [],
    },
  },
}

const artifacts = await mkdtemp(join(tmpdir(), "copilot-router-matched-semantic-"))
try {
  const result = await router.run({
    board,
    backend: router.createKrtBackend({ artifactsDirectory: artifacts, keepArtifacts: true }),
    dsl: `
      matchedGroup("good", { nets: ["OK_A", "OK_B"], toleranceMm: 0.1 })
      matchedGroup("bad", { nets: ["BAD_A", "BAD_B"], toleranceMm: 0.1 })
      runRouting()
    `,
  })
  assert.equal(result.status, "partial", JSON.stringify(result.diagnostics))
  assert.deepEqual(result.metrics?.openNets, [], "connected unmatched copper must remain a useful partial checkpoint")
  const summary = result.metrics?.details?.special
  assert.ok(summary && !Array.isArray(summary), JSON.stringify({
    diagnostics: result.diagnostics,
    metrics: result.metrics,
  }))
  assert.equal(summary.matched_group_audits.length, 2)
  const good = summary.matched_group_audits.find((group) => group.nets.includes("OK_A"))
  const bad = summary.matched_group_audits.find((group) => group.nets.includes("BAD_A"))
  assert.equal(good.verified, true)
  assert.ok(good.spreadMm <= 0.1)
  assert.equal(bad.verified, false)
  assert.ok(bad.spreadMm > 0.1)
  assert.ok(bad.reasons.includes("outside-tolerance"))
  assert.deepEqual([...summary.matched_verified_nets].sort(), ["OK_A", "OK_B"])
  assert.deepEqual([...result.metrics.details.protectedNets].sort(), ["OK_A", "OK_B"],
    "one unmatched group must not veto protection of an independently verified sibling group")
  assert.ok(result.copper.tracks.some((track) => track.net === "BAD_B"),
    "unmatched but connected copper must still be promoted under partial-result philosophy")
  assert.ok(result.diagnostics.some((item) => (
    item.code === "KRT_MATCHED_GROUP_VERIFIED" && item.details?.nets?.includes("OK_A")
  )))
  assert.ok(result.diagnostics.some((item) => (
    item.code === "KRT_LENGTH_MATCH_INCOMPLETE" && item.details?.nets?.includes("BAD_A")
  )))

  const paths = await readdir(artifacts, { recursive: true })
  const auditPath = paths.find((path) => path.endsWith("krt-special-matched-groups.json"))
  assert.ok(auditPath, "per-group real-copper measurements must remain inspectable")
  const artifact = JSON.parse(await readFile(join(artifacts, auditPath), "utf8"))
  assert.equal(artifact.groups.length, 2)
  assert.equal(artifact.groups.filter((group) => group.verified).length, 1)

  const overlapResult = await router.run({
    board,
    backend: router.createKrtBackend({ artifactsDirectory: join(artifacts, "mixed-overlap"), keepArtifacts: true }),
    dsl: `
      diffPair("mixed-pair", { positive: "OK_A", negative: "OK_B", gapMm: 0.25 })
      matchedGroup("mixed", { nets: ["OK_A", "OK_B", "BAD_A"], toleranceMm: 0.1 })
      runRouting()
    `,
  })
  assert.ok(overlapResult.diagnostics.some((item) => item.code === "CAPABILITY_MISMATCH"),
    "a mixed diff/ordinary group must retain an explicit native capability verdict")
  const overlapSpecial = overlapResult.metrics?.details?.special
  const overlapSummaries = Array.isArray(overlapSpecial) ? overlapSpecial : [overlapSpecial]
  const overlapAudits = overlapSummaries
    .filter(Boolean)
    .flatMap((summary) => summary.matched_group_audits ?? [])
  assert.ok(overlapAudits.every((group) => !group.nets.includes("BAD_A") || (
    !group.verified && group.reasons.includes("capability-mismatch")
  )), "mixed diff/ordinary copper must never enter the verified matched ledger")
  assert.ok(!(overlapResult.metrics?.details?.protectedNets ?? []).includes("BAD_A"),
    "the ordinary member of an unrepresentable mixed group must remain unprotected")
} finally {
  if (!process.env.KEEP_KRT_E2E_ARTIFACTS) await rm(artifacts, { recursive: true, force: true })
  else console.error(`KRT_E2E_ARTIFACTS=${artifacts}`)
}

console.log("managed KRT matched-group semantic audit: ok")
