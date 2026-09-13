import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { build } from 'esbuild'
import Clipper from 'clipper-lib'

await mkdir('.tmp', { recursive: true })
await build({ entryPoints: ['src/polygon/boundary-optimizer.ts'], outfile: '.tmp/outline-test.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const { regularizeCompactOutline, detectCompactBays } = await import('../.tmp/outline-test.mjs')
const f = JSON.parse(await readFile('tests/fixtures/compact-outline-24v.json', 'utf8'))
const scale = 1e6
const path = r => r.map(p => ({ X: Math.round(p.x * scale), Y: Math.round(p.y * scale) }))
const area = paths => paths.reduce((a,p) => a + Math.abs(Clipper.Clipper.Area(p)) / scale ** 2, 0)
function clip(subject, obstacle, type) {
  const c = new Clipper.Clipper(), result = []
  c.StrictlySimple = true
  c.AddPaths(subject, Clipper.PolyType.ptSubject, true)
  c.AddPaths(obstacle, Clipper.PolyType.ptClip, true)
  c.Execute(type, result, Clipper.PolyFillType.pftNonZero, Clipper.PolyFillType.pftNonZero)
  return result
}
const diff = (a,b) => clip(a,b,Clipper.ClipType.ctDifference)
const run = (fixture=f) => regularizeCompactOutline(fixture.original, fixture.protectedRings, fixture.obstacleRings, fixture.clearanceMm, fixture.minimumWidthMm, undefined, fixture.maximumAreaMm2)
const result = run()
assert.deepEqual(regularizeCompactOutline(f.original,f.protectedRings,f.obstacleRings,f.clearanceMm,f.minimumWidthMm,()=>false),f.original,'exhausted optional budget lost the baseline')
assert.ok(result.length <= 8, `24V still has ${result.length} corners`)
assert.deepEqual(run(), result, 'same geometry must give the same result')
const base = [path(f.original)], next = [path(result)]
assert.ok(area(next)/area(base) <= 1.25 && area(next)/area(base) >= .88)
assert.ok(area(diff(next,base))+area(diff(base,next)) <= area(base)*.35)
assert.ok(area(next) <= f.maximumAreaMm2)
const offset = new Clipper.ClipperOffset(3), forbidden = []
offset.AddPaths(f.obstacleRings.map(path), Clipper.JoinType.jtMiter, Clipper.EndType.etClosedPolygon)
offset.Execute(forbidden, f.clearanceMm * scale)
assert.ok(area(clip(base,forbidden,Clipper.ClipType.ctIntersection)) > 0, 'fixture must expose the inherited collision')
assert.ok(area(clip(next,forbidden,Clipper.ClipType.ctIntersection)) < 1e-8, 'final copper violates obstacle reserve')
const feasibleCore=diff(f.protectedRings.map(path),forbidden)
assert.equal(feasibleCore.length,1,'clearance cut disconnected the protected core')
assert.ok(area(diff(feasibleCore,next)) < 1e-8,'feasible protected copper was removed')
assert.ok(area(diff(f.protectedRings.slice(0,3).map(path),next)) < 1e-8,'target pad body was removed')
assert.ok(detectCompactBays(f.original).some(b=>b.depthMm>1))
assert.ok(!detectCompactBays(result).some(b=>b.depthMm>0.5),'a deep bay survived')
for (let i=0;i<result.length;i++) {
  const a=result[i],b=result[(i+1)%result.length],dx=Math.abs(a.x-b.x),dy=Math.abs(a.y-b.y)
  assert.ok(dx<1e-6 || dy<1e-6 || Math.abs(dx-dy)<1e-6, 'arbitrary-angle edge')
}
const rectangle = [{x:0,y:0},{x:10,y:0},{x:10,y:5},{x:0,y:5}]
assert.deepEqual(run({...f,original:rectangle}),rectangle,'already simple boundary changed')
// If every possible added region is blocked and the existing copper is all
// mandatory, simplifying a concave outline must fail closed.
const box=[{x:0,y:-20},{x:40,y:-20},{x:40,y:20},{x:0,y:20}]
assert.deepEqual(run({...f, protectedRings:[f.original], obstacleRings:[box]}),f.original)
const limited=run({...f,maximumAreaMm2:area(base)})
assert.ok(area([path(limited)]) <= area(base)+1e-8, 'board-area limit was exceeded')
// A shallow notch is closable; putting a foreign pad inside it must prevent
// that closure. A long, deep U-shaped corridor is deliberately left open.
const notch=[{x:0,y:0},{x:4,y:0},{x:4,y:1},{x:6,y:1},{x:6,y:0},{x:10,y:0},{x:10,y:6},{x:0,y:6}]
const rect=(x0,y0,x1,y1)=>[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}]
const notchFixture={...f,original:notch,protectedRings:[notch],obstacleRings:[],minimumWidthMm:.254,clearanceMm:.1,maximumAreaMm2:100}
assert.equal(run(notchFixture).length,4,'empty shallow notch was not closed')
const atBoardEdge=regularizeCompactOutline(notch,[notch],[],.1,.254,undefined,100,[],notch)
assert.equal(area(diff([path(atBoardEdge)],[path(notch)])),0,'filled outside a concave board outline')
const blocker=rect(4.3,.2,5.7,.7)
const blocked=run({...notchFixture,obstacleRings:[blocker]})
assert.equal(area(clip([path(blocked)],[path(blocker)],Clipper.ClipType.ctIntersection)),0,'closed a bay through a foreign pad')
const deep=[{x:0,y:0},{x:4,y:0},{x:4,y:9},{x:6,y:9},{x:6,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}]
const deepResult=[path(run({...notchFixture,original:deep,protectedRings:[deep]}))]
assert.equal(area(diff(deepResult,[path(deep)]))+area(diff([path(deep)],deepResult)),0,'bridged a deep U-shaped routing gap')
const longSide=deep.map(p=>({...p,x:p.x===10?100:p.x}))
assert.ok(detectCompactBays(longSide).some(b=>b.mouthMm===2 && b.depthMm===9),'long collinear sides hid the true mouth')
const longResult=[path(run({...notchFixture,original:longSide,protectedRings:[longSide],maximumAreaMm2:2000}))]
assert.equal(area(diff(longResult,[path(longSide)])),0,'generic envelope filled a deep slot')
assert.deepEqual(run({...notchFixture,protectedRings:[rect(0,0,30,6)],maximumAreaMm2:1000}),notch,'initial core restoration bypassed area budget')
assert.deepEqual(regularizeCompactOutline(f.original,f.protectedRings,[f.protectedRings[0]],0,.254,undefined,Infinity,[f.protectedRings[0]]),f.original,'trimmed a required target pad')
console.log(JSON.stringify({test:'compact-outline',beforeVertices:f.original.length,afterVertices:result.length,areaRatio:area(next)/area(base),checks:'core, obstacle reserve, shape, area budget, determinism, blocked fallback'},null,2))
