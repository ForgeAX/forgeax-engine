import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const native = resolve(root,'packages/fbx/src/native');
const destination = resolve(root,'artifacts/asset-format-fidelity/fbx'); mkdirSync(destination,{recursive:true});
const baselineRef = process.env.FIDELITY_BASELINE ?? '5b929c699d8ab44fdc2633a30a5d900543072a8b';
const temp = mkdtempSync(resolve(tmpdir(),'fbx-fidelity-'));
const run=(program,args)=>execFileSync(program,args,{cwd:root,maxBuffer:128*1024*1024,timeout:180000});
run('cc',['-O3',resolve(root,'packages/fbx/scripts/animation-oracle.c'),resolve(native,'ufbx.c'),'-lm','-o',resolve(temp,'oracle')]);
writeFileSync(resolve(temp,'baseline.c'),run('git',['show',`${baselineRef}:packages/fbx/src/native/bridge.c`]));
run('emcc',['-O3','-s','WASM=1','-s',"EXPORTED_FUNCTIONS=['_parseFbxWasm','_getResultPtr','_getResultLen','_freeResult','_malloc','_free']",'-s',"EXPORTED_RUNTIME_METHODS=['HEAPU8','UTF8ToString']",'-s','ALLOW_MEMORY_GROWTH=1','-s','MODULARIZE=1','-s','EXPORT_ES6=1','-s','ENVIRONMENT=web,node','-s','FILESYSTEM=0','-s','STACK_SIZE=1048576','-lm','-I',native,resolve(native,'ufbx.c'),resolve(temp,'baseline.c'),'-o',resolve(temp,'baseline.mjs')]);
const before = await (await import(pathToFileURL(resolve(temp,'baseline.mjs')).href)).default();
const {parseAnimationClips}=await import(pathToFileURL(resolve(root,'packages/fbx/dist/index.mjs')).href);
const after = await (await import(pathToFileURL(resolve(root,'packages/fbx/pkg/fbx-wasm.mjs')).href)).default();
const parse=(mod,bytes)=>{const ptr=mod._malloc(bytes.length);mod.HEAPU8.set(bytes,ptr);try {const nativeStart=performance.now();mod._parseFbxWasm(ptr,bytes.length);const nativeMs=performance.now()-nativeStart;const decodeStart=performance.now();const text=mod.UTF8ToString(mod._getResultPtr());const value=JSON.parse(text);const decodeMs=performance.now()-decodeStart;if(value.error)throw new Error(JSON.stringify(value.error));return {value,jsonBytes:Buffer.byteLength(text),wasmBytes:mod.HEAPU8.byteLength,nativeMs,decodeMs};}finally{mod._freeResult();mod._free(ptr);}};
function sample(ch,time,rotation) {
 const times=ch.keyTimes, values=ch.keyValues, width=rotation?4:3; let lo=0; while(lo+1<times.length && times[lo+1]<=time)lo++;
 const hi=Math.min(lo+1,times.length-1), alpha=hi===lo?0:Math.max(0,Math.min(1,(time-times[lo])/(times[hi]-times[lo])));
 const a=values.slice(lo*width,(lo+1)*width),b=values.slice(hi*width,(hi+1)*width);
 if(!rotation)return a.map((v,c)=>v+(b[c]-v)*alpha);
 let dot=a.reduce((sum,v,c)=>sum+v*b[c],0); if(dot<0){dot=-dot;for(let c=0;c<4;c++)b[c]*=-1;}
 const angle=Math.acos(Math.min(1,dot)),s=Math.sin(angle); const v=dot>0.9995?a.map((v,c)=>v+(b[c]-v)*alpha):a.map((v,c)=>(Math.sin((1-alpha)*angle)*v+Math.sin(alpha*angle)*b[c])/s);const n=Math.hypot(...v);return v.map(x=>x/n);
}
function errors(doc,oracle) {const maxima={translation:0,rotationDeg:0,scale:0}, rawErrors={translation:[],rotationDeg:[],scale:[]};let count=0; for(const clip of doc.clips??[]){const ref=oracle.find(row=>row.name===clip.name);if(!ref)throw new Error(`oracle lacks ${clip.name}`);for(const ch of clip.channels){const node=ref.nodes.find(row=>row.path===ch.targetNode);if(!node)throw new Error(`oracle lacks ${ch.targetNode}`);for(const row of node.samples){const actual=sample(ch,row[0],ch.property==='rotation');const offset=ch.property==='translation'?1:ch.property==='rotation'?4:8;const expected=row.slice(offset,offset+actual.length);if(ch.property==='rotation'){const dot=Math.abs(actual.reduce((sum,v,c)=>sum+v*expected[c],0));const error=2*Math.acos(Math.min(1,dot))*180/Math.PI;rawErrors.rotationDeg.push(error);maxima.rotationDeg=Math.max(maxima.rotationDeg,error);}else {const error=Math.hypot(...actual.map((v,c)=>v-expected[c]));rawErrors[ch.property].push(error);maxima[ch.property]=Math.max(maxima[ch.property],error);}count++;}}}const p95={};for(const [key,values]of Object.entries(rawErrors)){values.sort((a,b)=>a-b);p95[key]=values[Math.max(0,Math.ceil(values.length*.95)-1)]??0;}return {maxima,p95,sampleCount:count};}
// Hash the published timeline at its actual runtime precision, before quaternion normalization.
function timeline(doc) {
 const hash=createHash('sha256'); let keyCount=0,channelCount=0;
 for(const clip of doc.clips??[]) {hash.update(JSON.stringify([clip.name,clip.duration]));for(const channel of clip.channels) {channelCount++;keyCount+=channel.keyTimes.length;hash.update(JSON.stringify([channel.targetNode,channel.property]));for(const values of [channel.keyTimes,channel.keyValues]) {const data=Float32Array.from(values);hash.update(String(data.length));hash.update(new Uint8Array(data.buffer));}}}
 return {sha256:hash.digest('hex'),keyCount,channelCount};
}
function publication(doc) {
 const text=JSON.stringify(parseAnimationClips(doc),(_key,value)=>ArrayBuffer.isView(value)?Array.from(value):value);
 return {animationPodJsonBytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};
}
const inputs=process.argv.slice(2); if(!inputs.length) throw new Error('Provide original FBX source paths');
const report={baselineRef,sourceHead:run('git',['rev-parse','HEAD']).toString().trim(),runtime:process.version,cpu:cpus()[0].model,thresholds:{translation:1e-3,rotationDeg:0.1,scale:1e-4},protocol:{warmup:2,blocks:8,order:'ABBA',oracleSamples:1001,oracle:'ufbx_evaluate_transform on original source at non-key times; Euclidean source-local TRS translation/scale and unit-quaternion angle; both selected native producers pass through the current Float32/JSON bridge; baseline is pinned by baselineRef; historical baseline excludes its additional 30 Hz TS loss'},rows:[]};
for (const path of inputs) {
 const bytes=new Uint8Array(readFileSync(path)),oracle=JSON.parse(run(resolve(temp,'oracle'),[resolve(path),'1001']).toString());
 const reference=parse(before,bytes),candidate=parse(after,bytes);const raw=[];
 for(const mod of [before,after])for(let i=0;i<2;i++)parse(mod,bytes);
 for(let block=0;block<8;block++)for(const [label,mod]of [['before',before],['after',after],['after',after],['before',before]]){const start=performance.now(),cpuStart=process.cpuUsage();const result=parse(mod,bytes);const cpu=process.cpuUsage(cpuStart);raw.push({block,label,cpuMs:(cpu.user+cpu.system)/1000,ms:performance.now()-start,jsonBytes:result.jsonBytes,wasmBytes:result.wasmBytes,nativeMs:result.nativeMs,decodeMs:result.decodeMs,rss:process.memoryUsage().rss});}
 const timing={};for(const label of ['before','after']){const times=raw.filter(row=>row.label===label).map(row=>row.ms).sort((a,b)=>a-b);timing[label]={p50:times[Math.ceil(times.length*.5)-1],p95:times[15]};}
 const cooked=(doc)=>{const loaded=JSON.parse(JSON.stringify(parseAnimationClips(doc),(_key,value)=>ArrayBuffer.isView(value)?Array.from(value):value));return {clips:loaded.map((clip,index)=>({...clip,channels:clip.channels.map((channel,c)=>({targetNode:doc.clips[index].channels[c].targetNode,property:channel.property,keyTimes:channel.sampler.input,keyValues:channel.sampler.output}))}))};};
 const beforeError=errors(cooked(reference.value),oracle),afterError=errors(cooked(candidate.value),oracle);
 const row={path,inputBytes:bytes.length,raw,timing,before:{jsonBytes:reference.jsonBytes,wasmBytes:reference.wasmBytes,timeline:timeline(reference.value),publication:publication(reference.value),...beforeError},after:{jsonBytes:candidate.jsonBytes,wasmBytes:candidate.wasmBytes,timeline:timeline(candidate.value),publication:publication(candidate.value),...afterError},keys:(candidate.value.clips??[]).map(c=>({name:c.name,channels:c.channels.length,keyCount:c.channels.reduce((sum,ch)=>sum+ch.keyTimes.length,0)}))};report.rows.push(row);
 writeFileSync(resolve(destination,`oracle-${report.rows.length}.json`),JSON.stringify(oracle));
}
writeFileSync(resolve(destination,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,rows:report.rows.map(({raw,...row})=>row)},null,2));
if(report.rows.some(row=>Object.entries(report.thresholds).some(([key,epsilon])=>row.after.maxima[key]>epsilon)))process.exitCode=1;
