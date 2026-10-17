import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import R from '../pkg/rapier.mjs';

const [mode,input,output,snapshot]=process.argv.slice(2);
assert(['xyz','regions','load'].includes(mode)&&input&&output&&snapshot);
const hash=value=>createHash('sha256').update(value).digest('hex');
const start=performance.now();await R.init();const initMs=performance.now()-start;
global.gc?.();const memoryBefore=process.memoryUsage();let world;
const result={mode,initMs,memoryBefore,nativeProvenance:JSON.parse(await readFile(new URL('../pkg/provenance.json',import.meta.url)))};
if(mode==='load'){
 const began=performance.now();let compressed=await readFile(snapshot),raw=gunzipSync(compressed);
 const decoded=performance.now();result.rawBytes=raw.byteLength;result.gzipBytes=compressed.byteLength;result.digest=hash(raw);
 world=R.World.restoreSnapshot(raw);const restored=performance.now();
 raw=null;compressed=null;world.step();result.loadToStepMs=performance.now()-began;result.readDecodeMs=decoded-began;result.restoreMs=restored-decoded;
}else{
 const began=performance.now(),source=JSON.parse(await readFile(input));result.sourceMs=performance.now()-began;
 world=new R.World({x:0,y:-9.81,z:0});let inputBytes=0,cells=0,coordinateMs=0,createMs=0;const checks=[];
 for(const p of source.parts){
  const before=performance.now(),origin=[0,1,2].map(a=>Math.min(...p.regions.map(r=>r[a])));
  const count=p.regions.reduce((n,r)=>n+(r[3]-r[0])*(r[4]-r[1])*(r[5]-r[2]),0);cells+=count;
  let values;
  if(mode==='regions')values=Int32Array.from(p.regions.flatMap(r=>r.map((v,i)=>v-origin[i%3])));
  else{
   values=new Int32Array(count*3);let at=0;
   for(const r of p.regions)for(let x=r[0];x<r[3];x++)for(let y=r[1];y<r[4];y++)for(let z=r[2];z<r[5];z++){
    values[at++]=x-origin[0];values[at++]=y-origin[1];values[at++]=z-origin[2];
   }
   assert.equal(at,values.length);
  }
  coordinateMs+=performance.now()-before;inputBytes+=values.byteLength;
  const t=performance.now(),body=world.createRigidBody(R.RigidBodyDesc.fixed());
  const descriptor=(mode==='regions'?R.ColliderDesc.voxelRegions(values,{x:.1,y:.1,z:.1}):R.ColliderDesc.voxels(values,{x:.1,y:.1,z:.1}))
   .setTranslation(...origin.map(v=>v/10)).setMassProperties(0,{x:0,y:0,z:0},{x:0,y:0,z:0},{x:0,y:0,z:0,w:1});
  const collider=world.createCollider(descriptor,body);collider.clearShapeCache();createMs+=performance.now()-t;
  const r=p.regions[0];checks.push({handle:collider.handle,point:{x:(r[0]+.5)/10,y:(r[1]+.5)/10,z:(r[2]+.5)/10}});
 }
 world.step();result.buildToStepMs=performance.now()-began;Object.assign(result,{inputBytes,cells,coordinateMs,createMs});
 for(const check of checks)assert(world.getCollider(check.handle).containsPoint(check.point));result.queryChecks=checks.length;
 const t=performance.now(),raw=world.takeSnapshot();result.serializeMs=performance.now()-t;
 const z=performance.now(),compressed=gzipSync(raw,{level:1});result.compressMs=performance.now()-z;
 await writeFile(snapshot,compressed);assert.equal(hash(gunzipSync(await readFile(snapshot))),hash(raw));
 result.rawBytes=raw.byteLength;result.gzipBytes=compressed.byteLength;result.digest=hash(raw);
}
result.bodies=world.bodies.len();result.colliders=world.colliders.len();
global.gc?.();result.memoryReady=process.memoryUsage();result.maxRssKiB=process.resourceUsage().maxRSS;
world.free();await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({mode,buildMs:result.buildToStepMs,loadMs:result.loadToStepMs,inputBytes:result.inputBytes,gzipBytes:result.gzipBytes,maxRssKiB:result.maxRssKiB}));
