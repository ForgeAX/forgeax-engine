import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExtrusionGeometry, createProfileSweepGeometry, meshFromInterleaved } from '../dist/index.mjs';

const reference=process.argv[2];
if(!reference) throw new Error('Usage: node packages/geometry/bench/advanced-modeling.mjs <pinned-threejs-checkout> [output]');
const {Shape,Path,Vector2,Vector3,ExtrudeGeometry,CatmullRomCurve3}=await import(pathToFileURL(resolve(reference,'src/Three.js')).href);
const rectangle=(size)=>[{x:-size,y:-size},{x:size,y:-size},{x:size,y:size},{x:-size,y:size}];
const circle=(size,n)=>Array.from({length:n},(_,i)=>({x:Math.cos(i/n*Math.PI*2)*size,y:Math.sin(i/n*Math.PI*2)*size}));
function threeShape(contour,holes) {
  const shape=new Shape(contour.map(p=>new Vector2(p.x,p.y)));
  shape.holes=holes.map(loop=>new Path(loop.map(p=>new Vector2(p.x,p.y))));return shape;
}
function prepared(geometry) {
  const p=geometry.getAttribute('position'),n=geometry.getAttribute('normal'),uv=geometry.getAttribute('uv');
  const vertices=new Float32Array(p.count*8);
  for(let i=0;i<p.count;i++) vertices.set([p.getX(i),p.getY(i),p.getZ(i),n.getX(i),n.getY(i),n.getZ(i),uv.getX(i),uv.getY(i)],i*8);
  const result=meshFromInterleaved(vertices,geometry.index ? new Uint32Array(geometry.index.array) : Uint32Array.from({length:p.count},(_,i)=>i)).unwrap();
  geometry.dispose();return result;
}
function measure(run) {
  for(let i=0;i<10;i++) run();
  const times=[];let mesh;
  for(let i=0;i<100;i++) {const start=performance.now();mesh=run();times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);
  return {medianMs:times[50],p95Ms:times[95],vertices:mesh.vertices.length/12,triangles:mesh.indices.length/3,
    interleavedAndIndexBytes:mesh.vertices.byteLength+mesh.indices.byteLength};
}
function volume(mesh) {
  const p=mesh.attributes.position,idx=mesh.indices;let sum=0;
  for(let i=0;i<idx.length;i+=3) {
    const a=idx[i]*3,b=idx[i+1]*3,c=idx[i+2]*3;
    sum+=(p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])+p[a+1]*(p[b+2]*p[c]-p[b]*p[c+2])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]))/6;
  }return sum;
}
const cases=[];
for(const [name,contour,holes,b,segments] of [
  ['square-hole',rectangle(2),[rectangle(1)],0,1],
  ['rounded-hole',rectangle(2),[rectangle(1)],.25,8],
  ['128-point-hole',circle(2,128),[circle(1,64)],.15,4],
]) {
  const shape=threeShape(contour,holes),depth=2;
  const engine=()=>createExtrusionGeometry(contour,depth,{holes,bevelSize:b,bevelSegments:segments}).unwrap();
  const three=()=>{
    const geometry=new ExtrudeGeometry(shape,{depth:depth-2*b,bevelEnabled:b>0,bevelSize:b,bevelThickness:b,bevelOffset:-b,bevelSegments:segments,steps:1});
    geometry.translate(0,0,-(depth-2*b)/2);return prepared(geometry);
  };
  const a=volume(engine()),c=volume(three());assert.ok(Math.abs(a-c)<1e-4,`${name}: volume mismatch ${a} ${c}`);
  cases.push({name,engine:measure(engine),threePrepared:measure(three),volume:{engine:a,three:c}});
}
for(const steps of [64,256]) {
  const contour=rectangle(.15),curve=new CatmullRomCurve3([new Vector3(-2,0,0),new Vector3(-1,1,.5),new Vector3(1,-1,.5),new Vector3(2,0,0)]);
  const path=curve.getSpacedPoints(steps).map(p=>[p.x,p.y,p.z]);
  const shape=threeShape(contour,[]);
  cases.push({name:`rectangular-sweep-${steps}`,engine:measure(()=>createProfileSweepGeometry({contour},path).unwrap()),
    threePrepared:measure(()=>prepared(new ExtrudeGeometry(shape,{extrudePath:curve,steps,bevelEnabled:false})))});
}
const report={node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,warmup:10,samples:100,
  comparison:'Both produce canonical MeshAsset including tangent and bounds; Three curve sampling/frame construction included; ForgeaX receives the same pre-sampled points. Strict domain validation is included. Not GPU/UE performance.',cases};
const output=process.argv[3] ?? 'artifacts/advanced-modeling/cpu-benchmark.json';mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
