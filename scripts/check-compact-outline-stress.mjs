import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import C from 'clipper-lib'

await mkdir('.tmp', { recursive: true })
await build({entryPoints:['src/polygon/boundary-optimizer.ts'],outfile:'.tmp/outline-stress.mjs',bundle:true,platform:'node',format:'esm',packages:'external'})
const { regularizeCompactOutline } = await import('../.tmp/outline-stress.mjs')
const f=JSON.parse(await readFile('tests/fixtures/compact-outline-24v.json','utf8'))
const path=r=>r.map(p=>({X:Math.round(p.x*1e6),Y:Math.round(p.y*1e6)}))
const area=paths=>paths.reduce((s,p)=>s+Math.abs(C.Clipper.Area(p))/1e12,0)
function clip(s,o,t){if(!s.length)return [];const c=new C.Clipper(),r=[];c.StrictlySimple=true;c.AddPaths(s,0,true);if(o.length)c.AddPaths(o,1,true);c.Execute(t,r,1,1);return r}
const union=s=>clip(s,[],1),diff=(s,o)=>clip(s,o,2),inter=(s,o)=>clip(s,o,0)
const rect=(x0,y0,x1,y1)=>[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}]
let checked=0,changed=0,fallback=0,seed=196613
const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32)
function check(name,orig,core,obs,clearance,pads=[],interrupt=Infinity){
 let ticks=0
 const result=regularizeCompactOutline(orig,core,obs,clearance,.254,()=>++ticks<interrupt,Infinity,pads)
 checked++
 if(JSON.stringify(result)===JSON.stringify(orig)){fallback++;return}
 changed++
 const next=[path(result)],base=[path(orig)],offset=new C.ClipperOffset(3),forbidden=[]
 offset.AddPaths(union(obs.map(path)),C.JoinType.jtMiter,C.EndType.etClosedPolygon);offset.Execute(forbidden,clearance*1e6)
 const feasible=diff(union(core.map(path)),forbidden)
 const epsilon=1e-7
 assert.ok(area(diff(pads.map(path),next))<epsilon,`${name}: target pad lost`)
 assert.ok(area(diff(feasible,next))<epsilon,`${name}: core lost ${area(diff(feasible,next))} mm2`)
 assert.ok(area(inter(next,forbidden))<epsilon,`${name}: obstacle collision`)
 assert.equal(union(next).length,1,`${name}: disconnected/self-intersecting boundary`)
 assert.ok(area(next)<=area(base)*1.25+epsilon && area(next)>=area(base)*.88-epsilon,`${name}: area budget`)
 assert.ok(area(diff(next,base))+area(diff(base,next))<=area(base)*.35+epsilon,`${name}: edit budget`)
 assert.ok(result.every((a,i)=>{const b=result[(i+1)%result.length],dx=Math.abs(a.x-b.x),dy=Math.abs(a.y-b.y);return dx<2e-6||dy<2e-6||Math.abs(dx-dy)<2e-6}),`${name}: invalid edge direction`)
}
// Real geometry across position, scale, rotation, handedness and early exits.
for(const scale of [.5,1,2,5])for(let rotation=0;rotation<4;rotation++)for(const mirror of [-1,1]){
 const transform=r=>r.map(p=>{let x=p.x*scale*mirror,y=p.y*scale;for(let k=0;k<rotation;k++)[x,y]=[-y,x];return {x:x+123.125,y:y-77.75}})
 const orig=transform(f.original),core=f.protectedRings.map(transform),obs=f.obstacleRings.map(transform),pads=core.slice(0,3)
 for(const interrupt of [1,8,64,Infinity])check(`real-${scale}-${rotation}-${mirror}-${interrupt}`,orig,core,obs,f.clearanceMm*scale,pads,interrupt)
}
// Seeded notches, including obstacles in a bay and obstacles cutting a core.
for(let i=0;i<100;i++){
 const width=10+random()*30,height=4+random()*12,left=width*(.2+random()*.15),right=width*(.55+random()*.15),depth=height*(.05+random()*.8)
 const orig=[{x:0,y:0},{x:left,y:0},{x:left,y:depth},{x:right,y:depth},{x:right,y:0},{x:width,y:0},{x:width,y:height},{x:0,y:height}]
 const obs=i%3===0?[rect(left+.1,.05,right-.1,Math.max(.1,depth-.2))]:i%3===1?[rect(width*.45,depth-.1,width*.5,height+.5)]:[]
 check(`notch-${i}`,orig,[orig],obs,.05,[rect(.1,height-.4,.5,height-.1),rect(width-.5,height-.4,width-.1,height-.1)])
}
const report={checked,changed,fallback,seed:196613,checks:['required pads','feasible core','foreign clearance','single contour','angles','area','symmetric edit area','budget interruption']}
const reportDirectory=process.env.COPILOT_ROUTER_OUTLINE_REPORT_DIR ?? 'results/outline-stress'
await mkdir(reportDirectory,{recursive:true})
await writeFile(`${reportDirectory}/stress.json`,JSON.stringify(report,null,2))
console.log(JSON.stringify(report,null,2))
