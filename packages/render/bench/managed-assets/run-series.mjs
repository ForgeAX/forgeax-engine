import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { cases, dimensions } from './cases.mjs';
import { budgets } from './budgets.mjs';
import { summarize, metrics } from './summarize.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const [phase,baselineArg,currentArg,outputArg,...options]=process.argv.slice(2);
if(!['calibration','compare','paired'].includes(phase)||!outputArg)throw new Error('run-series.mjs calibration|compare|paired baseline current output [case-regex] [--profile full|core]');
let profile='core',filter;
for(let index=0;index<options.length;index++){
  const option=options[index];
  if(option==='--profile')profile=options[++index];
  else if(option.startsWith('--profile='))profile=option.slice('--profile='.length);
  else if(!option.startsWith('--')&&filter===undefined)filter=option;
  else throw new Error(`Unknown series option: ${option}`);
}
if(profile!=='core')throw new Error(`Unsupported series profile: ${profile}; series admits completion-only core windows. Use explicit run-case diagnostic phases for heap, GC or backpressure.`);
const profileCases=['static-10000','shared-10000','mesh-1000000-changed-64'].map(id=>{
  const config=cases.find(candidate=>candidate.id===id);
  if(!config)throw new Error(`Missing core benchmark case: ${id}`);
  return config;
});
const sampling='measure-lean';
const heapEvidence='not-collected';
const selected=profileCases.filter(config=>!filter||new RegExp(filter).test(config.id));
if(selected.length===0)throw new Error('No benchmark cases selected');
const baseline=resolve(baselineArg),current=resolve(currentArg),output=resolve(outputArg);
await mkdir(output,{recursive:true});
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const exists=async file=>{try{await access(file);return true;}catch{return false;}};
const baselineIdentity=await read(join(baseline,'build-identity.json'));
const currentIdentity=await read(join(current,'build-identity.json'));
for(const identity of [baselineIdentity,currentIdentity])if(identity.observation?.gpuPassTiming!==false||identity.observation?.gpuCounters!==false)
  throw new Error('Series requires explicit completion-only artifacts; legacy GPU-timing captures are diagnostic only');
if(!baselineIdentity.carrierSha256||baselineIdentity.carrierSha256!==currentIdentity.carrierSha256)throw new Error('A/B carrier inputs differ');

const probeFiles=['run-case.mjs','heap-probe.mjs','heap-profile-transport.mjs','post-window-evidence.mjs','write-heap.mjs','pixels.mjs','budgets.mjs','cases.mjs','summarize.mjs','run-series.mjs'];
const probeHash=createHash('sha256');
for(const file of probeFiles)probeHash.update(file).update(await readFile(join(here,file)));
const contract={browserMode:'headless',observation:baselineIdentity.observation,currentObservation:currentIdentity.observation,currentArtifact:currentIdentity.artifactSha256,profile,sampling,dimensions,cases:profileCases,budgets,baselineArtifact:baselineIdentity.artifactSha256,probeSha256:probeHash.digest('hex')};
const frozenFile=join(output,'contract.json');
if(await exists(frozenFile)){
  if(JSON.stringify((await read(frozenFile)).contract)!==JSON.stringify(contract))throw new Error('Frozen contract differs; use a new report directory and recalibrate');
}else await writeFile(frozenFile,JSON.stringify({frozenAt:new Date().toISOString(),contract},null,2),{flag:'wx'});
const index={phase,observation:contract.observation,profile,sampling,heapEvidence,startedAt:new Date().toISOString(),profileComplete:false,cases:profileCases.flatMap(config=>['default','worker'].map(mode=>({key:`${config.id}/${mode}`,status:'pending'})))};
const run=async(config,mode,group,arm,slot,windowPhase)=>{
  const file=join(output,`${windowPhase}.${config.id}.${mode}.g${group}.${slot}-${arm}.json`);
  if(!(await exists(file))){
    const stream=createWriteStream(file+'.log');
    // Neither pipe owns the shared log. Wait for both child streams to close,
    // then flush once; otherwise an early stdout EOF discards stderr evidence.
    const flushed=finished(stream).then(()=>undefined,error=>error);
    let code;
    try {
      code=await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[join(here,'run-case.mjs'),arm==='A'?baseline:current,config.id,mode,file,sampling],{stdio:['ignore','pipe','pipe'],env:{...process.env,CI:'1',FORGEAX_BROWSER_HEADLESS:'1',HEADLESS:'1'}});
        child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
        stream.on('error',()=>{child.stdout.resume();child.stderr.resume();});
        child.on('error',reject);child.on('close',resolve);
      });
    } finally {
      stream.end();
      const error=await flushed;
      if(error)throw error;
    }
    if(code!==0)throw new Error(`Window failed (${code}): ${file}.log`);
  }
  const result=await read(file);
  if(result.measurementRunner?.browserMode!=='headless')throw new Error(`Window browser mode differs: ${file}`);
  const expectedIdentity=arm==='A'?baselineIdentity:currentIdentity;
  if(result.identity?.artifactSha256!==expectedIdentity.artifactSha256||result.artifactVerification?.before!=='complete'||result.artifactVerification?.after!=='complete'||result.artifactVerification?.digest!==expectedIdentity.artifactSha256)
    throw new Error(`Window artifact evidence differs: ${file}`);
  if(result.measurementRunner?.gpuPassTiming!==false||result.observation?.gpuPassTiming!==false||result.observation?.gpuCounters!==false||result.preflight?.code!=='gpu-timing-not-enabled'||result.preflight.status!=='unavailable'||result.samples.some(sample=>sample.gpuTiming!==undefined||sample.gpuPassEnvelopeMs!==undefined||sample.gpu!==undefined)||result.measurementRunner.diagnosticOnly!==false)
    throw new Error(`Window observation differs: ${file}`);
  if(result.failures.length||result.samples.length!==dimensions.measuredFrames*(config.renderers??1))throw new Error(`Incomplete window: ${file}`);
  if(!result.quiescence||result.teardown!=='complete')throw new Error(`Missing post-window quiescence or teardown: ${file}`);
  if(result.phase!==sampling)throw new Error(`Window sampling differs: ${file}`);
  const summary={profile,sampling,heapEvidence,...summarize(result)};
  await writeFile(file+'.summary.json',JSON.stringify(summary));
  console.log(JSON.stringify({phase:windowPhase,profile,sampling,case:config.id,mode,group,arm,slot,file}));
  return {file,summary,metrics:metrics(summary)};
};
const noiseFile=join(output,'noise.json');
let noise=await exists(noiseFile)?await read(noiseFile):{frozenAt:null,contractSha256:createHash('sha256').update(JSON.stringify(contract)).digest('hex'),cases:{}};
if(phase==='compare'&&!noise.frozenAt)throw new Error('Baseline A/A noise must be frozen before candidate timing');
if(phase==='compare'&&profileCases.some(config=>['default','worker'].some(mode=>!noise.cases[`${config.id}/${mode}`]?.radius)))throw new Error('Every baseline A/A case in this profile must complete before candidate timing');
const saveNoise=async()=>{
  noise.frozenAt=profileCases.every(config=>['default','worker'].every(mode=>noise.cases[`${config.id}/${mode}`]?.radius))?new Date().toISOString():null;
  await writeFile(noiseFile,JSON.stringify(noise,null,2));
};
const saveIndex=async()=>{
  index.profileComplete=profileCases.every(config=>['default','worker'].every(mode=>index.cases.some(entry=>entry.key===`${config.id}/${mode}`&&entry.status==='complete')));
  await writeFile(join(output,phase+'-index.json'),JSON.stringify(index,null,2));
};
await saveIndex();
for(const config of selected)for(const mode of ['default','worker']){
  const key=`${config.id}/${mode}`;
  let entry=index.cases.find(value=>value.key===key);
  if(!entry){entry={key,status:'pending'};index.cases.push(entry);}
  let windowPhase=phase;
  try{
   for(windowPhase of phase==='paired'?['calibration','compare']:[phase]){
    const pairs=[];
    if(windowPhase==='compare'&&!noise.cases[key]?.radius)throw new Error('No complete A/A noise for this case');
    for(let group=0;group<dimensions.groups;group++){
      const order=windowPhase==='calibration'?['A','A']:group%2===0?['A','B']:['B','A'];
      const windows=[];
      for(const [slot,arm] of order.entries())windows.push(await run(config,mode,group,arm,slot,windowPhase));
      pairs.push(windowPhase==='compare'&&order[0]==='B'?windows.reverse():windows);
    }
    if(windowPhase==='calibration'){
      const radius={};
      for(const [a,b] of pairs)for(const field of Object.keys(a.metrics))if(Number.isFinite(b.metrics[field]))radius[field]=Math.max(radius[field]??0,Math.abs(b.metrics[field]-a.metrics[field]));
      noise.cases[key]={frozenAt:new Date().toISOString(),radius,pairs:pairs.map(pair=>pair.map(window=>window.file))};
      await saveNoise();
      if(phase==='paired'){
        entry.status='calibrated';
        await saveIndex();
        continue;
      }
    }
    const differences={};
    if(windowPhase==='compare')for(const field of Object.keys(pairs[0][0].metrics)){
      const deltas=pairs.map(([a,b])=>b.metrics[field]-a.metrics[field]);
      if(deltas.some(value=>!Number.isFinite(value)))continue;
      const median=[...deltas].sort((a,b)=>a-b)[1],radius=noise.cases[key].radius[field];
      differences[field]={pairedDeltas:deltas,median,radius,classification:radius===undefined?'unavailable':median>radius?'regression':median< -radius?'improvement':'within-noise'};
    }
    Object.assign(entry,{status:'complete',pairs:pairs.map(pair=>pair.map(window=>({file:window.file,metrics:window.metrics}))),...(windowPhase==='compare'?{differences}:{})});
   }
  }catch(error){entry.status='failed';entry.error=String(error);if(windowPhase==='calibration'){noise.cases[key]={error:String(error)};await saveNoise();}console.error(JSON.stringify({key,error:String(error)}));}
  await saveIndex();
}
if(phase==='calibration')await saveNoise();
console.log(JSON.stringify({phase,profile,sampling,heapEvidence,profileComplete:index.profileComplete,complete:index.cases.filter(item=>item.status==='complete').length,failed:index.cases.filter(item=>item.status==='failed').length,pending:index.cases.filter(item=>item.status!=='complete'&&item.status!=='failed').length,output}));
if(index.cases.some(item=>item.status==='failed'))process.exitCode=1;
