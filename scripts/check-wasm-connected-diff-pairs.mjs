import assert from 'node:assert/strict'
import { compileRoutingDsl, resolveRoutePlan } from '../package-dist/index.js'
import {
  createEasyEdaWasmBackend,
  createEasyEdaWasmWorkerEngine,
  bundledEasyEdaWasmAssets,
} from '../package-dist/backends/easyeda-wasm.js'

const empty = () => ({ tracks: [], vias: [], zones: [] })
const values = {
  clearanceMm: 0.2, edgeClearanceMm: 0.2,
  minTrackWidthMm: 0.2, preferredTrackWidthMm: 0.2,
  via: { minDiameterMm: 0.6, preferredDiameterMm: 0.6, minDrillMm: 0.3, preferredDrillMm: 0.3 },
}
const pair = { id: 'PAIR', positive: 'P', negative: 'N' }
function fixture(layer = 'TOP') {
  const board = {
    outline: [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 16 }, { x: 0, y: 16 }],
    cutouts: [], keepouts: [],
    layers: [{ name: 'TOP', index: 0, side: 'top' }, { name: 'BOTTOM', index: 31, side: 'bottom' }],
    nets: ['P', 'N', 'OTHER'].map(name => ({ name })),
    components: [], pads: [],
    rules: { default: values, nets: [], differentialPairs: [pair] },
    copper: { fixed: empty(), editable: empty() },
  }
  for (const [index, net] of ['P', 'N', 'OTHER'].entries()) {
    const y = 4 + index * 4
    const pads = [3, 9, 15, 21].map((x, i) => ({
      id: `${net}:${i}`, component: `${net}${i}`, number: '1', net,
      at: { x, y }, rotationDeg: 0, layers: ['TOP'],
      shape: { kind: 'circle', diameterMm: 1 },
    }))
    board.pads.push(...pads)
    if (net === 'OTHER') continue
    pads.slice(1).forEach((pad, i) => {
      board.copper.fixed.tracks.push({
        net, layer, widthMm: 0.2, points: [pads[i].at, pad.at],
        // Overlapping groups must merge transitively, not merely cover all IDs.
        connectedPadIds: [pads[i].id, pad.id],
      })
    })
    if (layer === 'BOTTOM') board.copper.fixed.vias.push(...pads.map(pad => ({
      net, at: pad.at, diameterMm: 0.6, drillMm: 0.3,
      fromLayer: 'TOP', toLayer: 'BOTTOM', type: 'through',
    })))
  }
  board.components = board.pads.map(pad => ({
    designator: pad.component, at: pad.at, rotationDeg: 0, side: 'top',
  }))
  return board
}

const program = compileRoutingDsl('runRouting();')
async function route(board, native = false) {
  let input
  const before = structuredClone(board)
  const engine = createEasyEdaWasmWorkerEngine(bundledEasyEdaWasmAssets())
  const result = await createEasyEdaWasmBackend({ engine: async (data, context) => {
    input = data
    return native ? engine(data, context) : { progress: 1, routabitity: 1, traces: [], vias: [] }
  } }).route({
    board, program, rules: board.rules, plan: resolveRoutePlan(board, program, board.rules),
    signal: AbortSignal.timeout(15000),
  })
  assert.deepEqual(board, before, 'routing must not mutate source copper or pair rules')
  assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics))
  return { input, result }
}
function assertDispatch(input, enabled) {
  for (const net of ['P', 'N']) assert.equal(input.nets.find(n => n.net === net).routing, enabled)
  assert.equal(Boolean(input.classes.differentialPairClasses.PAIR), enabled)
  assert.equal(input.nets.find(n => n.net === 'OTHER').routing, true)
}

for (const layer of ['TOP', 'BOTTOM']) {
  const board = fixture(layer)
  const { input, result } = await route(board, true)
  assertDispatch(input, false)
  assert.equal(input.tracks.length, board.copper.fixed.tracks.length)
  assert.equal(input.vias.length, board.copper.fixed.vias.length)
  assert.equal(Object.keys(input.components).length, board.pads.length)
  assert.equal(result.copper.tracks.filter(t => ['P', 'N'].includes(t.net)).length, 0)
  assert.equal(result.copper.vias.filter(t => ['P', 'N'].includes(t.net)).length, 0)
  assert.ok(result.copper.tracks.some(t => t.net === 'OTHER'), 'remaining nets still route')
}

for (const mode of ['one-net-open', 'disjoint-groups', 'missing-id', 'foreign-id', 'no-links', 'cleared']) {
  const board = fixture()
  if (mode === 'one-net-open') board.copper.fixed.tracks.pop()
  if (mode === 'disjoint-groups') board.copper.fixed.tracks.splice(4, 1)
  if (mode === 'missing-id') delete board.pads.find(p => p.id === 'N:3').id
  if (mode === 'foreign-id') board.copper.fixed.tracks.at(-1).connectedPadIds = ['N:2', 'P:3']
  if (mode === 'no-links') for (const t of board.copper.fixed.tracks) delete t.connectedPadIds
  if (mode === 'cleared') board.copper.fixed = empty()
  const { input } = await route(board)
  assertDispatch(input, true)
}

// Editable copper participates in connectivity but must remain in the output.
const editable = fixture()
editable.copper.editable = editable.copper.fixed
editable.copper.fixed = empty()
const { input, result } = await route(editable)
assertDispatch(input, false)
assert.deepEqual(result.copper.tracks, editable.copper.editable.tracks)
console.log('WASM connected differential pairs: native TOP/BOTTOM no-op, partial and unproven pairs retained')
