import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,unlinkSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {solveNavigationAvoidance} from '../dist/index.mjs';
import {distribution,budgets} from './crowd.mjs';
const original=readFileSync(new URL('../dist/index.mjs',import.meta.url),'utf8');
const replaceOnce=(s,a,b)=>{assert.equal(s.split(a).length,2,a);return s.replace(a,b);};
let text=replaceOnce(original,'  const agents = [...input].sort','  const roiStart=performance.now();\n  roiPhases={buckets:0,neighbors:0,velocity:0};\n  const agents = [...input].sort');
text=replaceOnce(text,'  const output = [];\n  for (const a of agents) {','  roiPhases.buckets=performance.now()-roiStart;\n  const output = [];\n  for (const a of agents) {\n    const roiNeighborStart=performance.now();');
text=replaceOnce(text,'    neighbors.length = Math.min(neighbors.length, maxNeighbors);','    neighbors.length = Math.min(neighbors.length, maxNeighbors);\n    roiPhases.neighbors+=performance.now()-roiNeighborStart;\n    const roiVelocityStart=performance.now();');
text=replaceOnce(text,'    output.push({ id: a.id, x: bx, z: bz, neighbors: neighbors.length, saturated });','    output.push({ id: a.id, x: bx, z: bz, neighbors: neighbors.length, saturated });\n    roiPhases.velocity+=performance.now()-roiVelocityStart;');
text+='\nexport let roiPhases;\n';
const temporary=new URL('../dist/.roi-profile.mjs',import.meta.url);writeFileSync(temporary,text);
const observed=await import(temporary.href);const report={timestamp:new Date().toISOString(),node:process.version,sourceSha256:createHash('sha256').update(original).digest('hex'),observerSha256:createHash('sha256').update(text).digest('hex'),budgets,runs:[],failures:[]};
try{for(const count of [100,1000]){const side=Math.ceil(Math.sqrt(count)),input=Array.from({length:count},(_,id)=>({id,x:(id%side)*2,z:Math.floor(id/side)*2,y:.82,radius:.31,height:1.6,vx:1,vz:0,desiredX:1,desiredZ:0,maxSpeed:1})),options={neighborDistance:4,maxNeighbors:16,horizon:1.5,maxCandidates:128};const samples=[];
for(let i=0;i<220;i++){const start=performance.now(),value=solveNavigationAvoidance(input,options).unwrap(),direct=performance.now()-start;const t=performance.now(),instrumented=observed.solveNavigationAvoidance(input,options).unwrap(),full=performance.now()-t;assert.deepEqual(instrumented,value);if(i>=20)samples.push({direct,observed:full,...observed.roiPhases});}
const summaries=Object.fromEntries(['direct','observed','buckets','neighbors','velocity'].map(key=>[key,distribution(samples.map(s=>s[key]))]));report.runs.push({count,summaries,samples,observerMedianOverhead:summaries.observed.p50-summaries.direct.p50});if(count===1000&&summaries.neighbors.p95>budgets.neighbors1000Ms)report.failures.push({name:'neighbors1000',value:summaries.neighbors.p95,budget:budgets.neighbors1000Ms});}}
finally{unlinkSync(temporary);}
const output=new URL('../../../artifacts/roi-navigation/',import.meta.url);mkdirSync(output,{recursive:true});writeFileSync(new URL('neighbor-profile.json',output),JSON.stringify(report));writeFileSync(new URL('neighbor-profile-module.mjs',output),text);console.log(JSON.stringify(report.runs.map(({count,summaries,observerMedianOverhead})=>({count,summaries,observerMedianOverhead}))));if(report.failures.length)process.exitCode=1;
