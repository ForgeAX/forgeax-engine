import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
import { decodeAccessor } from '../src/accessor/decode-accessor';
const baselineRef=process.env.FIDELITY_BASELINE ?? '5b929c699d8ab44fdc2633a30a5d900543072a8b';
mkdirSync('artifacts/asset-format-fidelity/accessor',{recursive:true});
const temporary=mkdtempSync(resolve('artifacts/asset-format-fidelity/accessor/baseline-'));
mkdirSync(resolve(temporary,'accessor'));
for(const file of ['accessor/decode-accessor.ts','errors.ts'])writeFileSync(resolve(temporary,file),execFileSync('git',['show',`${baselineRef}:packages/gltf/src/${file}`]));
const baseline=await import(pathToFileURL(resolve(temporary,'accessor/decode-accessor.ts')).href);
const report={baselineRef,sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtime:`Bun ${Bun.version} (${process.version})`,cpu:cpus()[0]?.model,protocol:{warmup:2,blocks:8,order:'ABBA',window:'16 samples per state'},rows:[] as unknown[]};
for(const count of [24,30000,1000000]) {
 const buffer=new Uint8Array(count*12); const data=new Float32Array(buffer.buffer);for(let i=0;i<data.length;i++)data[i]=(i%97)/97;
 const accessor={bufferView:0,count,componentType:5126,type:'VEC3'},bufferView={buffer:0,byteLength:buffer.length};
 const before=()=>baseline.decodeAccessor({accessorIndex:0,accessor,bufferView,buffer,role:'attribute'}).unwrap();
 const after=()=>decodeAccessor({accessorIndex:0,accessor,bufferViews:[bufferView],buffers:[buffer],role:'attribute'}).unwrap();
 const reference=before(),actual=after();if(actual.data.length!==reference.data.length||actual.data.some((v:number,i:number)=>v!==reference.data[i]))throw new Error('dense semantics changed');
 for(const run of [before,after])for(let i=0;i<2;i++)run();const raw=[];
 for(let block=0;block<8;block++)for(const [label,run]of [['before',before],['after',after],['after',after],['before',before]] as const){const start=performance.now(),cpuStart=process.cpuUsage();run();const cpu=process.cpuUsage(cpuStart);raw.push({block,label,wallMs:performance.now()-start,cpuMs:(cpu.user+cpu.system)/1000,rss:process.memoryUsage().rss});}
 const timing:Record<string,unknown>={};for(const label of ['before','after']){const values=raw.filter(row=>row.label===label).map(row=>row.wallMs).sort((a,b)=>a-b);timing[label]={p50:values[8],p95:values[15]};}
 report.rows.push({count,inputBytes:buffer.length,timing,raw});
}
mkdirSync('artifacts/asset-format-fidelity/accessor',{recursive:true});writeFileSync('artifacts/asset-format-fidelity/accessor/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,rows:report.rows.map((row)=>{const {raw,...summary}=row as {raw:unknown};return summary;})},null,2));

rmSync(temporary,{recursive:true,force:true});
