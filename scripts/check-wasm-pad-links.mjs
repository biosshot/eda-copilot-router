import assert from 'node:assert/strict';
import {compileRoutingDsl,resolveRoutePlan} from '../package-dist/index.js';
import {createEasyEdaWasmBackend,createEasyEdaWasmWorkerEngine,bundledEasyEdaWasmAssets} from '../package-dist/backends/easyeda-wasm.js';
const empty={tracks:[],vias:[],zones:[]};
const values={clearanceMm:.2,edgeClearanceMm:.2,minTrackWidthMm:.2,preferredTrackWidthMm:.2,via:{minDiameterMm:.6,preferredDiameterMm:.6,minDrillMm:.3,preferredDrillMm:.3}};
const board={outline:[{x:0,y:0},{x:24,y:0},{x:24,y:14},{x:0,y:14}],cutouts:[],layers:[{name:'TOP',index:0,side:'top'},{name:'BOTTOM',index:31,side:'bottom'}],nets:[{name:'A'}],components:[],pads:[3,12,21].map((x,i)=>({id:'J'+i+':native',component:'J'+i,number:'1',net:'A',at:{x,y:7},rotationDeg:0,layers:['TOP'],shape:{kind:'circle',diameterMm:1}})),keepouts:[],rules:{default:values,nets:[]},copper:{fixed:empty,editable:empty}};
board.components=board.pads.map(p=>({designator:p.component,at:p.at,rotationDeg:0,side:'top'}));
const track=(a,b,layer='TOP')=>({net:'A',layer,widthMm:.2,points:[a,b]});
const via=x=>({net:'A',at:{x,y:7},diameterMm:.6,drillMm:.3,fromLayer:'TOP',toLayer:'BOTTOM',type:'through'});
const program=compileRoutingDsl('runRouting();');

for(const mode of ['unrouted','partial-top','complete-top','partial-bottom','complete-bottom','partial-detour','complete-detour']){
 const b=structuredClone(board);b.copper={fixed:{tracks:[],vias:[],zones:[]},editable:{tracks:[],vias:[],zones:[]}};let xs=mode.startsWith('complete')?[3,12,21]:[3,12];
 if(mode!=='unrouted'){
 const bottom=mode.endsWith('bottom');
 b.copper.fixed.tracks=xs.slice(1).map((x,i)=>track({x:xs[i],y:7},{x,y:7},bottom?'BOTTOM':'TOP'));
 if(bottom)b.copper.fixed.vias=xs.map(via);
 if(mode.endsWith('detour'))b.copper.fixed.tracks=xs.slice(1).flatMap((x,i)=>{const a=xs[i];return [track({x:a,y:7},{x:a,y:5}),track({x:a,y:5},{x,y:5}),track({x,y:5},{x,y:7})]});
 }
 if(mode!=='unrouted')b.copper.fixed.tracks[0].connectedPadIds=xs.map(x=>b.pads.find(p=>p.at.x===x).id);
 let raw,input;const engine=createEasyEdaWasmWorkerEngine(bundledEasyEdaWasmAssets());
 const r=await createEasyEdaWasmBackend({engine:async(d,c)=>{input=d;raw=await engine(d,c);return raw}}).route({board:b,program,rules:b.rules,plan:resolveRoutePlan(b,program,b.rules),signal:AbortSignal.timeout(15000)});
 assert.equal(r.status,'complete',JSON.stringify(r.diagnostics));
 assert.equal(r.copper.tracks.length,mode==='unrouted'?2:mode.startsWith('complete')?0:1);
 assert.equal(r.copper.vias.length,0);
 if(mode!=='unrouted')assert.deepEqual(input.tracks[0].pads,xs.map(x=>['routing_pad_'+b.pads.findIndex(p=>p.at.x===x),'p0']));
 console.log(mode+': native pad links preserved, no duplicate route');
}

