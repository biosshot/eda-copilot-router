import assert from 'node:assert/strict'
import { compileRoutingDsl, compileRoutingRules, materializeRoutingStackup, resolveRoutePlan, validateRoutingCopper } from '../package-dist/index.js'
import { createEasyEdaWasmBackend, createBundledEasyEdaWasmBackend } from '../package-dist/backends/easyeda-wasm.js'
import { partitionHybridRoute, createHybridBackend } from '../package-dist/backends/hybrid.js'
import { planKrtOrdinaryBatches, krtPostEasyReservedNets, createKrtBackend } from '../package-dist/backends/krt.js'
const empty = { tracks: [], vias: [], zones: [] }
const values = { clearanceMm: .2, edgeClearanceMm: .2, minTrackWidthMm: .127, preferredTrackWidthMm: .2,
  via: { minDiameterMm: .5, preferredDiameterMm: .6, minDrillMm: .25, preferredDrillMm: .3 } }
const board = { outline: [{x:0,y:0},{x:20,y:0},{x:20,y:10},{x:0,y:10}], cutouts: [],
  layers: [{name:'TOP',index:0,side:'top'},{name:'BOTTOM',index:31,side:'bottom'}],
  nets: [{name:'A'}], components: [],
  pads: [2,18].map((x,i)=>({component:'J'+i,number:'1',net:'A',at:{x,y:5},rotationDeg:0,layers:['TOP'],shape:{kind:'circle',diameterMm:1}})),
  keepouts: [], rules: {default:values,nets:[]}, copper: {fixed:empty,editable:empty} }
board.components = board.pads.map(p=>({designator:p.component,at:p.at,rotationDeg:0,side:'top'}))
const layers = ['TOP','INNER_1','INNER_2','BOTTOM'].flatMap((name,i)=>[
  ...(i?[{kind:'dielectric',thicknessMm:.4,relativePermittivity:4.2}]:[]),
  {kind:'copper',name,thicknessOz:1,...(i===1?{disableRouting:true}:{})}])
const dsl = 'stack('+JSON.stringify({layers})+'); runRouting();'
const program = compileRoutingDsl(dsl)
const materialized = materializeRoutingStackup(board,program.stack)
assert.equal(materialized.layers.length,4)
assert.equal(materialized.stackup.layers.filter(x=>x.kind==='copper').length,4)
const compiled = compileRoutingRules(board,program)
assert.deepEqual(compiled.diagnostics.filter(x=>x.severity==='error'),[])
assert.deepEqual(compiled.effective.nets[0].values.allowedLayers,['TOP','INNER_2','BOTTOM'])
const request = {board:materialized,program,rules:compiled.effective,plan:resolveRoutePlan(materialized,program,compiled.effective)}
assert.deepEqual(partitionHybridRoute(request).krtNets,[])
assert.deepEqual(krtPostEasyReservedNets(request),[])
const batches = planKrtOrdinaryBatches(request,['A'],false)
assert.ok(batches.length)
assert.ok(batches.every(x=>JSON.stringify(x.layers)===JSON.stringify(['F.Cu','In2.Cu','B.Cu'])))
let captured
const wasm = createEasyEdaWasmBackend({routeLayers:['TOP','INNER_1','INNER_2','BOTTOM'],async engine(input){ captured=input;return {progress:1,routabitity:1,traces:[],vias:[]} }})
await wasm.route(request)
assert.deepEqual(captured.layers.route,[1,16,2])
assert.deepEqual(captured.layers.notRoute,[15])
assert.throws(()=>compileRoutingDsl(dsl.replace('"disableRouting":true','"disableRouting":"true"')),/boolean/)
const conflict = compileRoutingDsl(dsl.replace('runRouting()', 'signalNet("A", { allowedLayers: ["INNER_1"] }); runRouting()'))
assert.ok(compileRoutingRules(board,conflict).diagnostics.some(x=>x.code==='DSL_NO_ROUTING_LAYERS'))
const allOff = {...materialized,layers:materialized.layers.map(x=>({...x,disableRouting:true}))}
assert.ok(compileRoutingRules(allOff,compileRoutingDsl('runRouting()')).diagnostics.some(x=>x.code==='DSL_NO_ROUTING_LAYERS'))
assert.equal((await createKrtBackend().route({...request,board:allOff})).status,'error')
let called=false
await createEasyEdaWasmBackend({async engine(){called=true;throw Error('must not run')}}).route({...request,board:allOff})
assert.equal(called,false)
const track={id:'new',net:'A',layer:'INNER_1',widthMm:.2,points:[{x:2,y:5},{x:18,y:5}]}
assert.ok(validateRoutingCopper({...empty,tracks:[track]},materialized).diagnostics.some(x=>x.code==='ROUTING_DISABLED_LAYER'))
const existing={...materialized,copper:{fixed:empty,editable:{...empty,tracks:[track]}}}
assert.equal(validateRoutingCopper(existing.copper.editable,existing).ok,true)
assert.equal(validateRoutingCopper({...empty,tracks:[{...track,points:[{x:2,y:5},{x:19,y:5}]}]},existing).ok,false)
const badWasm = createEasyEdaWasmBackend({async engine(){return {progress:1,routabitity:1,traces:[{id:'bad',layer:15,net:'A',width:.2,path:[[-8,0],[8,0]]}],vias:[]}}})
const rejected=await badWasm.route(request)
assert.equal(rejected.status,'partial')
assert.equal(rejected.copper.tracks.length,0)
const plane={net:'A',layers:['INNER_1'],outline:{outer:board.outline},clearanceMm:.2,minThicknessMm:.2}
assert.equal(validateRoutingCopper({...empty,zones:[plane]},materialized).ok,true)
assert.equal(validateRoutingCopper({...empty,vias:[{net:'A',at:{x:10,y:5},diameterMm:.6,drillMm:.3,fromLayer:'TOP',toLayer:'BOTTOM'}]},materialized).ok,true)
console.log('Disabled routing layers: DSL, physical stack, conflicts, WASM input/output, KRT batches, Hybrid custody, preserved copper, planes and vias: ok')

if (process.argv.includes('--real-wasm')) {
  const live = await createBundledEasyEdaWasmBackend().route({...request,signal:AbortSignal.timeout(20000)})
  assert.ok(!live.diagnostics.some(x=>x.code==='EASYEDA_WASM_ROUTE_FAILED'),JSON.stringify(live.diagnostics))
  assert.ok(live.copper.tracks.length > 0,'Real WASM must create tracks')
  assert.ok(live.copper.tracks.every(x=>x.layer!=='INNER_1'))
  console.log('Real bundled WASM on four physical layers with INNER_1 disabled: '+live.status)
}

const fallbackStages=[]
const fallback = createHybridBackend({}, {
  easyeda: {id:'easyeda',capabilities:{supported:[]},async preflight(){return []},async route(){fallbackStages.push('easyeda');throw Error('fixture')}},
  krt: {id:'krt',capabilities:{supported:[]},async preflight(){return []},async route(input){
    fallbackStages.push('krt')
    assert.equal(input.board.layers.length,4)
    assert.ok(planKrtOrdinaryBatches(input,['A'],false).every(x=>!x.layers.includes('In1.Cu')))
    return {status:'complete',copper:empty,diagnostics:[],metrics:{openNetCount:0}}
  }}
})
await fallback.route(request)
assert.deepEqual(fallbackStages,['easyeda','krt'])
console.log('Hybrid runtime fallback retains global disabled-layer policy: ok')

if (process.argv.includes('--real-krt')) {
  const result=await createKrtBackend().route({...request,signal:AbortSignal.timeout(45000)})
  assert.equal(result.status,'complete',JSON.stringify(result.diagnostics))
  assert.ok(result.copper.tracks.length>0)
  assert.ok(result.copper.tracks.every(x=>x.layer!=='INNER_1'))
  console.log('Real KRT on four physical layers with INNER_1 disabled: complete')
}
