import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pickTriangle } from '../src/pick-triangle';
import { skinScene } from '../src/__tests__/skin-scene.fixture';

// Optional fixed reference checkout: no upstream source is copied into this repo.
const reference = process.argv[2];
const three = reference === undefined ? undefined : await import(pathToFileURL(resolve(reference,'src/Three.Core.js')).href);
const samples = 150;
const percentile = (sorted: number[], q: number) => sorted[Math.floor((sorted.length-1)*q)];
function measure(call: () => unknown) {
  for(let i=0;i<30;i++) call();
  const timings=[];
  for(let i=0;i<samples;i++) { const start=performance.now();call();timings.push(performance.now()-start); }
  timings.sort((a,b)=>a-b);
  return { samples,p50Ms:percentile(timings,0.5),p95Ms:percentile(timings,0.95) };
}
const results=[];
for(const segments of [16,512,4096,16384]) {
  const scene=skinScene(segments);
  const query=()=>pickTriangle(scene.world,scene.camera,64,64,128,128);
  if(query().status !== 'hit') throw new Error('benchmark fixture must hit');
  const forgeax=measure(query);
  let referenceResult;
  if(three) {
    const geometry=new three.BufferGeometry();
    for(const [name,attribute] of Object.entries(scene.mesh.attributes)) {
      if(!ArrayBuffer.isView(attribute)) continue;
      const sizes:Record<string,number>={position:3,normal:3,uv:2,tangent:4,skinIndex:4,skinWeight:4};
      geometry.setAttribute(name,new three.BufferAttribute(attribute,sizes[name]));
    }
    geometry.setIndex(new three.BufferAttribute(scene.mesh.indices,1));
    const root=new three.Bone(), upper=new three.Bone();
    root.add(upper);upper.position.y=0.5;root.updateMatrixWorld(true);
    const skeleton=new three.Skeleton([root,upper]);
    const object=new three.SkinnedMesh(geometry,new three.MeshBasicMaterial({side:three.DoubleSide}));
    object.bind(skeleton,new three.Matrix4());object.updateMatrixWorld(true);
    const caster=new three.Raycaster(new three.Vector3(0,0,4.9),new three.Vector3(0,0,-1));
    const intersects:unknown[]=[];
    const check=()=>{object.computeBoundingSphere();object.computeBoundingBox();intersects.length=0;object.raycast(caster,intersects);return intersects.length;};
    if(check() === 0) throw new Error('Three reference fixture must hit');
    referenceResult=measure(check);
  }
  results.push({triangles:segments*2,vertices:(segments+1)*2,joints:2,forgeax,threejs:referenceResult});
}
const output={runtime:process.versions,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,scope:'one exact query; ForgeaX builds current world vertices/bounds once, Three.js recomputes posed sphere/box then raycasts; propagation excluded; static pose; no GPU readback',reference,results};
mkdirSync('artifacts/skinned-triangle-picking',{recursive:true});
writeFileSync('artifacts/skinned-triangle-picking/benchmark.json',JSON.stringify(output,null,2));
console.log(JSON.stringify(output,null,2));
