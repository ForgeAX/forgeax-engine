import { linearChannelToSrgb } from '@forgeax/engine/types';
import { halfFloat } from '@forgeax/engine/math';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import UPNG from 'upng-js';
import { matchesSourceSrgb, sourceSrgbInterval } from './srgb-oracle.mjs';
import { decodeTape, buildFrameModel, handleAccess } from '@forgeax/engine-rhi-debug';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../artifacts/mesh-io/acceptance');
const budgets=JSON.parse(await readFile(new URL('../acceptance-budgets.json',import.meta.url),'utf8'));
const enforcePhysicalBudgets=process.env.FIDELITY_ENFORCE_PHYSICAL_BUDGET==='1';
const report=JSON.parse(await readFile(`${root}/report.json`));
const fingerprints=[];
const writePreviews=!process.env.CI;
for(const row of report.results){
 const sources=[];
 for(const mode of writePreviews ? ['live','replay','missing-draw'] : ['live']){
  const bytes=await readFile(`${root}/${row.id}/${mode}.rgba16float`);
  if(mode==='live')fingerprints.push({id:row.id,sha256:createHash('sha256').update(bytes).digest('hex')});
  if(!writePreviews)continue;
  const rgba=new Uint8Array(320*240*4);
  for(let i=0;i<rgba.length;i+=4){for(let c=0;c<3;c++){const linear=Math.min(1,Math.max(0,halfFloat.f16ToF32(bytes.readUInt16LE((i+c)*2)))); const srgb=linearChannelToSrgb(linear); rgba[i+c]=Math.round(srgb*255);}rgba[i+3]=255;}
  sources.push(rgba);
  await writeFile(`${root}/${row.id}/${mode}.png`,Buffer.from(UPNG.encode([rgba.buffer],320,240,0)));
 }
 if(writePreviews){
 const triptych=new Uint8Array(960*240*4);
 for(let y=0;y<240;y++)for(let i=0;i<3;i++)triptych.set(sources[i].subarray(y*320*4,(y+1)*320*4),(y*960+i*320)*4);
 await writeFile(`${root}/${row.id}/rhi-triptych.png`,Buffer.from(UPNG.encode([triptych.buffer],960,240,0)));
 }
 const tape=decodeTape(new Uint8Array(await readFile(`${root}/${row.id}/frame.rhitape`))).unwrap();
 const model=buildFrameModel(tape);
 const viewParents=new Map();
 for(const resource of tape.bootstrap)if(resource.create.kind==='createTextureView')viewParents.set(resource.handleId,resource.create.sourceHandleId);
 for(const event of tape.events)if(event.kind==='createTextureView')viewParents.set(event.resultHandleId,event.sourceHandleId);
 const resolved=id=>viewParents.get(id)??id;
 const initialization=[];
 for(const resource of model.unseededResources){
  const accesses=[];
  for(const [eventIndex,event] of tape.events.entries()){
   const access=handleAccess(event);
   if(access.read.some(id=>resolved(id)===resource.resourceId)&&!access.written.some(id=>resolved(id)===resource.resourceId))accesses.push({eventIndex,access:'read',kind:event.kind});
   if(access.written.some(id=>resolved(id)===resource.resourceId))accesses.push({eventIndex,access:'write',kind:event.kind});
  }
  const creation=tape.bootstrap.find(entry=>entry.handleId===resource.resourceId).create;
  let conclusion;
  if(creation.kind==='createBuffer'){
   const copies=tape.events.flatMap((event,eventIndex)=>event.kind==='copyBufferToBuffer'&&event.destinationHandleId===resource.resourceId?[{eventIndex,offset:event.destinationOffset,size:event.size}]:event.kind==='copyTextureToBuffer'&&event.destination.bufferHandleId===resource.resourceId?[{eventIndex,offset:0,size:event.destination.bytesPerRow*event.copySize.height}]:[]);
   let end=0;for(const copy of [...copies].sort((a,b)=>a.offset-b.offset)){if(copy.offset>end)throw new Error('readback initialization hole');end=Math.max(end,copy.offset+copy.size);}
   if(end>creation.desc.size||creation.desc.usage!==9||accesses.some(access=>access.access==='read'))throw new Error(`unseeded buffer is not a completely initialized readback: ${JSON.stringify({case:row.id,resource,desc:creation.desc,end,copies})}`);
   conclusion={kind:'copy-only-readback',usage:creation.desc.usage,size:creation.desc.size,copiedPrefixBytes:end,unusedTailBytes:creation.desc.size-end,gpuReadCount:0,copies};
  }else{
   const clears=tape.events.flatMap((event,eventIndex)=>{
    if(event.kind!=='beginRenderPass')return[];
    const index=event.colorAttachmentViewHandleIds.findIndex(id=>resolved(id)===resource.resourceId);
    if(index>=0&&event.desc.colorAttachments[index]?.loadOp==='clear')return[{eventIndex,kind:'color-clear',clearValue:event.desc.colorAttachments[index].clearValue}];
    if(event.depthStencilViewHandleId&&resolved(event.depthStencilViewHandleId)===resource.resourceId&&event.desc.depthStencilAttachment?.depthLoadOp==='clear')return[{eventIndex,kind:'depth-clear',depthClearValue:event.desc.depthStencilAttachment.depthClearValue,stencilLoadOp:event.desc.depthStencilAttachment.stencilLoadOp}];
    return[];
   });
   if(!clears.length)throw new Error('unseeded texture has no recorded clear');
   const firstRead=accesses.find(access=>access.access==='read');
   if(firstRead&&firstRead.eventIndex<clears[0].eventIndex)throw new Error('read before first recorded clear');
   conclusion={kind:'attachment-clear',firstClear:clears[0]};
  }
  initialization.push({...resource,conclusion,accesses});
 }
 await writeFile(`${root}/${row.id}/initialization.json`,JSON.stringify({scope:'v7 event semantics with texture-view parent resolution; unsupported bootstrap bytes remain explicit; MAP_READ/COPY_DST buffers have contiguous copied prefixes and no GPU reads, unused pooled tails are recorded; attachment clear dominates the recorded consumers',initialization},null,2)+'\n');
}
const boxes=fingerprints.filter(row=>['obj','stl','gltf','glb','draco'].includes(row.id));
if(new Set(boxes.map(row=>row.sha256)).size!==1)throw new Error('box formats diverged');
await writeFile(`${root}/pixel-comparison.json`,JSON.stringify({format:'rgba16float',width:320,height:240,comparisons:boxes.map(row=>({...row,reference:'obj',changedBytes:0})),preview:'linear HDR clamped to [0,1], converted to sRGB, alpha forced opaque; triptych left=live, middle=fresh replay, right=mesh draws removed'},null,2)+'\n');
console.log(`${report.results.length} analyzed cases, five byte-identical box routes, all unseeded initializations accounted for${writePreviews ? '; triptychs written' : ''}`);

// Source numeric oracles operate on linear HDR, before preview conversion.
const hdr = new Map();
for (const row of report.results) {
 const bytes=await readFile(`${root}/${row.id}/live.rgba16float`),control=await readFile(`${root}/${row.id}/missing-draw.rgba16float`);
 const values=new Float32Array(320*240*4),mask=[];
 for(let pixel=0;pixel<320*240;pixel++){
  let changed=false;for(let c=0;c<4;c++){const i=pixel*4+c;values[i]=halfFloat.f16ToF32(bytes.readUInt16LE(i*2));if(c<3&&Math.abs(values[i]-halfFloat.f16ToF32(control.readUInt16LE(i*2)))>budgets.linearHdrChannelAbsoluteError)changed=true;}
  if(changed)mask.push(pixel);
 }
 const xs=mask.map(i=>i%320),ys=mask.map(i=>Math.floor(i/320));
 const bounds=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
 hdr.set(row.id,{bytes,values,mask,bounds});
}
const proof=[];
const requireCase=id=>{const row=hdr.get(id);if(!row)throw new Error(`missing ${id}`);return row;};
const compare=(a,b)=>{const x=requireCase(a).bytes,y=requireCase(b).bytes;if(!x.equals(y))throw new Error(`${a}/${b} differ`);proof.push({oracle:'byte identity',a,b,changedBytes:0});};
compare('unlit-dark','unlit-light');compare('unlit-dark','unlit-color');
for(const [id,expected]of [['unlit-dark',[.2,.6,.1]],['emissive-1',[.08,.03,.02]],['emissive-5',[.4,.15,.1]]]){
 const row=requireCase(id);let maxError=0;for(const pixel of row.mask)for(let c=0;c<3;c++)maxError=Math.max(maxError,Math.abs(row.values[pixel*4+c]-expected[c]));
 if(!row.mask.length||maxError>budgets.linearHdrChannelAbsoluteError)throw new Error(`${id} source HDR oracle failed: ${maxError}`);
 proof.push({id,oracle:'authored linear RGB',expected,maxError,foregroundPixels:row.mask.length,bounds:row.bounds});
}
const focal=120/Math.tan(1.1/2),perspective=[160-.8*focal/3,120-.6*focal/3,160+.8*focal/3-1,120+.6*focal/3-1];
for(const [id,expected]of [['unlit-dark',perspective],['camera-ortho',[160-.8/1.4*160,30,160+.8/1.4*160-1,209]],['unlit-skin',perspective.map((v,i)=>i%2===0?v+.15*focal/3:v)]]){
 const row=requireCase(id),error=Math.max(...row.bounds.map((value,i)=>Math.abs(value-expected[i])));
 if(error>budgets.projectedEdgePixelError)throw new Error(`${id} source projection failed ${JSON.stringify({actual:row.bounds,expected,error})}`);
 proof.push({id,oracle:'source projection, pixel-centre edge coverage',expected,actual:row.bounds,maxPixelError:error});
}
const texture=requireCase('unlit-texture'),srgb=value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4;
const sourceCorners=[[255,40,20],[40,80,255],[20,220,60],[240,200,30]];
const expectedCorners=sourceCorners.map(rgb=>rgb.map(v=>srgb(v/255)));
const samples=[[134,140],[185,140],[134,100],[185,100]];
for(let i=0;i<samples.length;i++){
 const [x,y]=samples[i],actual=Array.from(texture.values.subarray((y*320+x)*4,(y*320+x)*4+3)),expected=expectedCorners[i];
 const intervals=sourceCorners[i].map(byte=>sourceSrgbInterval(byte,budgets.linearHdrChannelAbsoluteError));
 const error=Math.max(...actual.map((v,c)=>Math.abs(v-expected[c])));if(!matchesSourceSrgb(actual,sourceCorners[i],budgets.linearHdrChannelAbsoluteError))throw new Error(`source texture UV/color mismatch ${JSON.stringify({x,y,actual,expected,intervals,error})}`);
 proof.push({id:'unlit-texture',oracle:'source texture quadrant and native sRGB decode precision',pixel:[x,y],actual,expected,intervals,maxError:error,srgbConversionUlp:.5,linearHdrBudget:budgets.linearHdrChannelAbsoluteError});
}
const performanceRows=[];
for(const row of report.results){
 if(enforcePhysicalBudgets && row.completedFrames!==61)throw new Error(`${row.id} physical qualification requires the full 61-frame profile`);
 const frames=JSON.parse(await readFile(`${root}/${row.id}/timings.json`)),gpu=[],statuses={};
 for(const sample of frames.filter(sample=>sample.frame>=10)){
  const observation=sample.observation.timings;statuses[observation?.status??'absent']=(statuses[observation?.status??'absent']??0)+1;
  if(!observation?.frame)continue;const passes=observation.frame.passes.filter(pass=>pass.status==='measured');if(!passes.length)continue;
  if(observation.status!=='complete'||passes.length!==observation.frame.executedPassCount)continue;
  gpu.push(summarizeGpuPassTimingIntervals(observation.frame.passes, observation.frame.timestampPeriodNanoseconds).unwrap().envelopeNanoseconds/1e6);
 }
 gpu.sort((a,b)=>a-b);const entry={id:row.id,frameWallMs:row.frameWallMs,gpuMarkerEnvelopeMs:gpu.length?{p50:gpu[Math.floor((gpu.length-1)*.5)],p95:gpu[Math.ceil(gpu.length*.95)-1],samples:gpu.length}:null,statuses,scope:'marker envelope of measured passes; complete only when timing observation is complete; never sum overlapping passes'};
 performanceRows.push(entry);
 if(enforcePhysicalBudgets && gpu.length!==row.sampleCount)throw new Error(`${row.id} missing complete native GPU timing intervals`);
 if(enforcePhysicalBudgets && row.frameWallMs.p95>budgets.steadyFrameWallP95Ms)throw new Error(`${row.id} small-fixture wall p95 exceeds declared 60Hz budget`);
 if(enforcePhysicalBudgets && entry.gpuMarkerEnvelopeMs?.p95>budgets.gpuEnvelopeP95Ms)throw new Error(`${row.id} small-fixture GPU marker envelope exceeds declared 4ms budget`);
}
await writeFile(`${root}/fidelity-analysis.json`,JSON.stringify({sourceHead:report.sourceHead,proof,performanceRows,physicalBudgetsApplied:enforcePhysicalBudgets,budgets},null,2)+'\n');
console.log('source material, source cameras, real texture and bounded frame timing oracles passed');
