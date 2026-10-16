import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { cpus,platform,arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { bakeNavigationMesh } from '../../import/dist/navigation-bake.mjs';
import { createNavigationMesh,solveNavigationAvoidance } from '../dist/index.mjs';
import { settings,box } from './fixtures.mjs';
import { runCrowd,distribution,budgets } from './crowd.mjs';
const output=new URL('../../../artifacts/roi-navigation/',import.meta.url);mkdirSync(output,{recursive:true});
const geometryFor=(size)=>{const width={small:12,medium:80,large:180}[size],n={small:0,medium:49,large:500}[size],columns=size==='medium'?7:25;return {width,geometry:[box(width,.2,width,0,-.1,0),...Array.from({length:n},(_,i)=>box(1,3,1,(i%columns-columns/2)*6,1.5,(Math.floor(i/columns)-(size==='medium'?3:10))*6))]};};
async function bakeCase(size){const {width,geometry}=geometryFor(size),start=performance.now(),asset=(await bakeNavigationMesh({geometry,settings:{...settings,radius:.35}})).unwrap();return {asset,geometry,width,time:performance.now()-start};}
if(process.argv[2]==='--cold'){const size=process.argv[3],result=await bakeCase(size);console.log(JSON.stringify({size,time:result.time,polygons:result.asset.polygons.length,triangles:result.geometry.length*12,memory:process.memoryUsage()}));process.exit(0);}
const report={timestamp:new Date().toISOString(),hardware:{cpu:cpus()[0].model,platform:platform(),arch:arch(),node:process.version},budgets,runtimeHashes:Object.fromEntries(['navigation','physics','physics-rapier3d','ecs','scene','import'].map(p=>[p,createHash('sha256').update(readFileSync(new URL(`../../${p}/dist/index.mjs`,import.meta.url))).digest('hex')])),bakes:[],crowds:[],solver:[],failures:[]};
const check=(name,value,budget)=>{if(value>budget)report.failures.push({name,value,budget});};
for(const size of ['small','medium','large']){
 const cold=Array.from({length:3},()=>JSON.parse(execFileSync(process.execPath,[new URL(import.meta.url).pathname,'--cold',size],{encoding:'utf8'})));
 const warm=[];let result;for(let i=0;i<7;i++){result=await bakeCase(size);if(i>0)warm.push(result.time);}
 const mesh=createNavigationMesh(result.asset).unwrap(),queries=[];
 for(let i=0;i<120;i++){const t=performance.now(),r=mesh.findPath([-result.width*.4,0,result.width*.4],[result.width*.4,0,result.width*.4],{maxProjection:.3}).unwrap();if(i>=20)queries.push(performance.now()-t);assert.equal(r.points.at(-3),Math.fround(result.width*.4));}
 const budget=budgets[`bake${size[0].toUpperCase()+size.slice(1)}Ms`];check(`bake-${size}`,Math.max(...cold.map(v=>v.time),...warm),budget);check(`query-${size}`,distribution(queries).p95,budgets.queryP95Ms);
 report.bakes.push({size,width:result.width,triangles:result.geometry.length*12,polygons:result.asset.polygons.length,cold,warm:{...distribution(warm),samples:warm},queries:{...distribution(queries),samples:queries},serializedBytes:Buffer.byteLength(JSON.stringify(result.asset)),memory:process.memoryUsage()});console.log('bake',size,JSON.stringify(report.bakes.at(-1).warm));
}
for(const count of [100,1000]){
 const side=Math.ceil(Math.sqrt(count)),starts=Array.from({length:count},(_,i)=>[(i%side-side/2)*2,(Math.floor(i/side)-side/2)*2]),goals=starts.map(([x,z])=>[x+5,0,z]);
 const input=starts.map(([x,z],id)=>({id,x,z,y:.82,radius:.31,height:1.6,vx:1,vz:0,desiredX:1,desiredZ:0,maxSpeed:1})),samples=[];
 for(let i=0;i<220;i++){const t=performance.now();const r=solveNavigationAvoidance(input,{neighborDistance:4,maxNeighbors:16,horizon:1.5,maxCandidates:128}).unwrap();if(i>=20)samples.push(performance.now()-t);assert.ok(r.every(v=>!v.saturated&&Math.hypot(v.x,v.z)<=1.00001));}
 report.solver.push({count,...distribution(samples),samples});if(count===1000)check('solver1000',distribution(samples).p95,budgets.solver1000Ms);
 for(let repeat=0;repeat<3;repeat++){
  const r=await runCrowd({name:`crowd-${count}-${repeat}`,geometry:[box(90,.2,90,0,-.1,0)],starts,goals,frames:400,trace:false});check(r.name,r.fullWorld.p95,budgets[`world${count}Ms`]);if(r.arrived!==count||r.blocked!==0)report.failures.push({name:r.name,arrived:r.arrived,blocked:r.blocked});delete r.asset;delete r.geometry;delete r.trajectories;report.crowds.push(r);console.log(r.name,r.fullWorld.p95,r.arrived,r.blocked);writeFileSync(new URL('performance.json',output),JSON.stringify(report));
 }
 const observed=await runCrowd({name:`stages-${count}`,geometry:[box(90,.2,90,0,-.1,0)],starts,goals,frames:180,trace:false,instrument:true});delete observed.asset;delete observed.geometry;delete observed.trajectories;report.crowds.push(observed);
}
writeFileSync(new URL('performance.json',output),JSON.stringify(report));console.log('FAILURES',JSON.stringify(report.failures));if(report.failures.length)process.exitCode=1;
