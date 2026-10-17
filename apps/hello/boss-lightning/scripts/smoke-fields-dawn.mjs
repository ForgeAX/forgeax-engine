import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { loadavg, freemem } from 'node:os';
import { World } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app';
import { createProfiler, buildProfileModel } from '@forgeax/engine-profiler';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { scenePlugin } from '@forgeax/engine-scene';
import { VFX_PARTICLE_CORE_LAYOUT, vfxParticleCoreField } from '@forgeax/engine-vfx';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { attachRecorder, decodeTape, buildFrameModel, buildResourceLifecycle, openReplay, replayDeviceRequest, tapeDigest, readbackImage, toRgba8 } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { setupGpuShim } from '../../triangle/scripts/smoke-helpers.mjs';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { teardownDawnInstance } from '../../../../scripts/lib/dawn-teardown.mjs';
import { FIELD_DT, fieldCamera, populateFieldScene } from '../src/field-scene.ts';
import { trajectory, distribution, gpuIntervals } from './field-oracle.mjs';
import { isSimulationUpdate, normalizeReadbackRgba } from './smoke-diagnostics.mjs';

const unwrap = result => { if(!result.ok)throw result.error; return result.value; };
const root = resolve(import.meta.dirname,'..');
const dist = resolve(root,'dist');
const output = resolve(process.env.FORGEAX_FIELD_EVIDENCE ?? resolve(root,'artifacts/fields'));
const key = process.env.FORGEAX_FIELD_CASE ?? 'constant';
const performanceRun = key.startsWith('benchmark/');
const limit = performanceRun ? 90 : 60;
mkdirSync(output,{recursive:true});
assert(existsSync(resolve(dist,'pack-index.json')), 'Build ordinary fields Pack before GPU lease');
const originalFetch=globalThis.fetch;
globalThis.fetch=async request=>{
  const url=new URL(typeof request==='string'?request:request.url,'http://127.0.0.1');
  if(url.hostname==='127.0.0.1'){
    const file=resolve(dist,url.pathname.slice(1));
    assert(file.startsWith(dist + sep));
    if(existsSync(file))return new Response(readFileSync(file));
  }
  return originalFetch(request);
};
const manifestBytes=readFileSync(resolve(dist,'shaders/manifest.json'));
const manifest=JSON.parse(manifestBytes.toString());
const diffSha256=await new Promise((resolveHash,reject)=>{
  const hash=createHash('sha256');
  const diff=spawn('git',['diff','HEAD'],{cwd:root,stdio:['ignore','pipe','inherit']});
  diff.stdout.on('data',chunk=>hash.update(chunk));
  diff.once('error',reject);
  diff.once('close',(code,signal)=>code===0?resolveHash(hash.digest('hex')):reject(new Error(`git diff failed: ${signal??code}`)));
});
const sourceIdentity={head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),diffSha256,inputs:Object.fromEntries(['scripts/smoke-fields-dawn.mjs','scripts/field-oracle.mjs','src/field-scene.ts','src/field-guids.ts','dist/pack-index.json'].map(path=>[path,createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex')]))};
if(performanceRun){
  assert(process.env.FORGEAX_FIELD_PERF_ADMISSION,'retain a fresh measured 60-second quiet admission before this per-owner lease');
  const admissionBytes=readFileSync(process.env.FORGEAX_FIELD_PERF_ADMISSION);
  writeFileSync(resolve(output,'admission.json'),admissionBytes);
  const admission=JSON.parse(admissionBytes.toString());
  assert.equal(admission.verdict,'admitted');assert.equal(admission.key,key);
  assert.equal(admission.head,sourceIdentity.head);assert.equal(admission.diffSha256,sourceIdentity.diffSha256);
  assert(admission.durationSeconds>=60&&admission.samples.length>=60);
  assert(admission.samples.every((sample,index)=>sample.cpuPercent<=20&&sample.load1<=3&&sample.memoryPressure==='normal'&&sample.swapBytes<=(index===0?admission.initialSwapBytes:admission.samples[index-1].swapBytes)));
  const age=Date.now()-Date.parse(admission.completedAt);
  assert(age>=0&&age<=5000,'admission expired in queue/startup; retain this blocked attempt and measure a new quiet window');
}
const shim=await setupGpuShim({width:512,height:512,rerunCmd:'pnpm --filter @forgeax/hello-boss-lightning smoke:fields'});
const fieldBuffers=new Map();
const allBuffers=new Map();
const allTextures=new Map();
const allocationEvents=[];
let allocationId=0;
const allocationAccounting=()=>({...buildResourceLifecycle({bootstrap:[],events:allocationEvents}),scope:'first-probe-device-native-allocation-events'});
let liveBytes=0,highBytes=0,fieldHigh=0,fieldUploads=0,fieldUploadBytes=0,fieldUploadCpuMs=0;
const fieldUploadCalls=[];
let vfxExtractCpuMs=0;
let nativeCreate;
let simulationUpdates=0;
let instrumentedDevice;
const bufferName=label=>{
  try{
    const scoped=JSON.parse(label);
    if(Array.isArray(scoped)&&scoped.length===2&&typeof scoped[1]==='string')return scoped[1];
  }catch{}
  return label??'';
};
const instrumentDevice=device=>{
if(instrumentedDevice!==undefined)return;
instrumentedDevice=device;
if(!performanceRun){
  const entryPoints=new WeakMap();
  const createPipeline=device.createComputePipeline.bind(device);
  device.createComputePipeline=descriptor=>{const pipeline=createPipeline(descriptor);entryPoints.set(pipeline,descriptor.compute.entryPoint);return pipeline;};
  const createPipelineAsync=device.createComputePipelineAsync.bind(device);
  device.createComputePipelineAsync=async descriptor=>{const pipeline=await createPipelineAsync(descriptor);entryPoints.set(pipeline,descriptor.compute.entryPoint);return pipeline;};
  const createEncoder=device.createCommandEncoder.bind(device);
  device.createCommandEncoder=descriptor=>{
    const encoder=createEncoder(descriptor);
    const beginCompute=encoder.beginComputePass.bind(encoder);
    encoder.beginComputePass=descriptor=>{
      const pass=beginCompute(descriptor);
      let entryPoint;
      const setPipeline=pass.setPipeline.bind(pass);
      pass.setPipeline=pipeline=>{entryPoint=entryPoints.get(pipeline);setPipeline(pipeline);};
      for(const method of ['dispatchWorkgroups','dispatchWorkgroupsIndirect']){
        const dispatch=pass[method].bind(pass);
        pass[method]=(...args)=>{if(isSimulationUpdate(entryPoint))simulationUpdates++;dispatch(...args);};
      }
      return pass;
    };
    return encoder;
  };
}
nativeCreate=device.createBuffer.bind(device);
device.createBuffer=descriptor=>{
  // Post-sample counter readback is diagnostic only; the recorded workload
  // retains identical storage, dispatches, indirect draws and raster coverage.
  const name=bufferName(descriptor.label);
  const counterDiagnostic=performanceRun&&(name.endsWith('.counters')||name.endsWith('.indirect'));
  const actualDescriptor=counterDiagnostic?{...descriptor,usage:descriptor.usage|4}:descriptor;
  const buffer=nativeCreate(actualDescriptor);
  const handleId=`probe-buffer:${allocationId++}`;
  allocationEvents.push({kind:'createBuffer',handleId,desc:{...actualDescriptor}});
  const info={label:descriptor.label??'',name,size:descriptor.size,live:true};
  allBuffers.set(buffer,info);liveBytes+=info.size;highBytes=Math.max(highBytes,liveBytes);
  if(info.label.includes('.force-fields.')){fieldBuffers.set(buffer,info);fieldHigh=Math.max(fieldHigh,[...fieldBuffers.values()].filter(v=>v.live).reduce((n,v)=>n+v.size,0));}
  const destroy=buffer.destroy.bind(buffer);
  buffer.destroy=()=>{if(info.live){info.live=false;liveBytes-=info.size;allocationEvents.push({kind:'destroyBuffer',handleId});}destroy();};
  return buffer;
};
const createTexture=device.createTexture.bind(device);
device.createTexture=descriptor=>{
  const texture=createTexture(descriptor);
  const handleId=`probe-texture:${allocationId++}`;
  const size=Array.isArray(descriptor.size)?[...descriptor.size]:typeof descriptor.size==='number'?descriptor.size:{...descriptor.size};
  allocationEvents.push({kind:'createTexture',handleId,desc:{...descriptor,size}});
  const info={handleId,label:descriptor.label??'',live:true};
  allTextures.set(texture,info);
  const destroy=texture.destroy.bind(texture);
  texture.destroy=()=>{if(info.live){info.live=false;allocationEvents.push({kind:'destroyTexture',handleId});}destroy();};
  return texture;
};
const nativeWrite=device.queue.writeBuffer.bind(device.queue);
device.queue.writeBuffer=(buffer,...args)=>{
  if(!fieldBuffers.has(buffer))return nativeWrite(buffer,...args);
  const data=args[1],bytes=args[3]??data.byteLength;
  const start=performance.now();
  const result=nativeWrite(buffer,...args);
  const cpuEnqueueMs=performance.now()-start;
  fieldUploads++;fieldUploadBytes+=bytes;fieldUploadCpuMs+=cpuEnqueueMs;
  fieldUploadCalls.push({call:fieldUploads,bytes,cpuEnqueueMs});
  return result;
};
};
// Install before renderer construction so residency high water includes cold
// resources, not just field buffers allocated on the first simulation frame.
const requestAdapter=navigator.gpu.requestAdapter.bind(navigator.gpu);
navigator.gpu.requestAdapter=async(...args)=>{
  const adapter=await requestAdapter(...args);
  if(adapter===null)return adapter;
  const requestDevice=adapter.requestDevice.bind(adapter);
  adapter.requestDevice=async descriptor=>{const device=await requestDevice(descriptor);instrumentDevice(device);return device;};
  return adapter;
};
const recorder=performanceRun?undefined:unwrap(attachRecorder(webgpu));
const rhi=recorder===undefined?webgpu.rhi:Object.assign(Object.create(recorder.backend.rhi),{
  createShaderModule:recorder.backend.createShaderModule,createShaderModuleImmediate:recorder.backend.createShaderModuleImmediate,
});
const world=new World();
const host=createVfxRuntimeHost({camera:fieldCamera});
if(performanceRun){
  const extract=host.feature.extract.bind(host.feature);
  host.feature.extract=context=>{
    const start=performance.now();
    try{return extract(context);}finally{vfxExtractCpuMs+=performance.now()-start;}
  };
}
const profiler=performanceRun?createProfiler():undefined;
const constructionStart=performance.now();
const assembly=unwrap(await constructRuntimeRendererHost(shim.mockCanvas,{
  features:[host.feature],rhi,
  ...(profiler?{profiler}:{}),
  ...(recorder?{rhiInstrumentation:{resolveSurfaceDevice:recorder.backend.unwrapDeviceForSurface}}:{gpuPassTiming:{}}),
},{shaderManifestUrl:`data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`}));
const {renderer,assets}=assembly;
const device=shim.sharedDevice;
const coldRendererMs=performance.now()-constructionStart;
const app=unwrap(await createApp({ platform: createSmokePlatform({ width: 1, height: 1 }, { manual: true }), renderer,world,assets,plugins:[scenePlugin()],...(profiler?{profiler}:{})}));
const errors=[];
renderer.subscribe(event=>{if(event.kind==='error')errors.push(event.error);});
app.onError(error=>errors.push(error));
assets.configurePackIndex('/pack-index.json');
unwrap(await host.attachWorld({world,assets}));
const assetStart=performance.now();
const scene=await populateFieldScene(world,assets,key);
const coldAssetLoadMs=performance.now()-assetStart;
unwrap(app.start());unwrap(app.pause());
let receipt,updateFinished;
const nativeDraw=renderer.draw.bind(renderer);
renderer.draw=input=>{const result=nativeDraw(input);if(result.ok)receipt=result.value;return result;};
const updateWorld=world.update.bind(world);
world.update=delta=>{const result=updateWorld(delta);updateFinished=performance.now();return result;};
const samples=[];
const profileSession=profiler?unwrap(profiler.startCapture({frameLimit:limit,eventLimit:20000,detail:'nested'})):undefined;
const frames=[];
let simulationTicks=0,queueSubmissions=0;
const nativeSubmit=device.queue.submit.bind(device.queue);
device.queue.submit=commands=>{queueSubmissions++;return nativeSubmit(commands);};
const sceneEffectEmitterCount=()=>key==='shared'?2:1;
let tapeBytes;
const readNativeBuffer=async(buffer,size)=>{
  const staging=nativeCreate({size,usage:1|8});
  try{const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(buffer,0,staging,0,size);device.queue.submit([encoder.finish()]);await staging.mapAsync(1);const bytes=new Uint8Array(staging.getMappedRange()).slice();staging.unmap();return bytes;}finally{staging.destroy();}
};
const readLivePixels=async()=>{
  const size=512*512*4,staging=nativeCreate({size,usage:1|8});
  try{const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:shim.renderTarget},{buffer:staging,bytesPerRow:512*4,rowsPerImage:512},{width:512,height:512});device.queue.submit([encoder.finish()]);await staging.mapAsync(1);const bytes=new Uint8Array(staging.getMappedRange()).slice();staging.unmap();return normalizeReadbackRgba(bytes,512,512,512*4,shim.renderTarget.format);}finally{staging.destroy();}
};
try{
  for(let frame=0;frame<limit;frame++){
    const ticks=key==='shared'&&frame===10?3:1;
    const capture=recorder&&(frame===0||frame===59||(key==='shared'&&frame===10))?recorder.captureFrame():undefined;
    if(capture)unwrap(await recorder.frameBoundary());
    const priorSubmissions=queueSubmissions;
    const priorUpdates=simulationUpdates;
    const priorFieldUploads=fieldUploads,priorFieldBytes=fieldUploadBytes,priorFieldUploadCpuMs=fieldUploadCpuMs,priorExtractCpuMs=vfxExtractCpuMs;
    receipt=undefined;
    const start=performance.now();unwrap(app.stepFrame(FIELD_DT*ticks));simulationTicks+=ticks;
    assert(receipt,'App step must produce a FrameReceipt');
    const updated=updateFinished;
    const recorded=performance.now();unwrap(await receipt.completed);const completed=performance.now();
    frames.push({frame,simulationTicks,...(performanceRun?{}:{simulationUpdates:simulationUpdates-priorUpdates,expectedUpdates:sceneEffectEmitterCount()*ticks}),rendererSubmissions:queueSubmissions-priorSubmissions,...(performanceRun?{}:{feature:host.feature.inspect(),views:renderer.inspect().views})});
    if(performanceRun){
      const timing=unwrap(await renderer.observe(receipt,{include:['timings']})).timings;
      samples.push({frame,fieldUpload:{calls:fieldUploads-priorFieldUploads,bytes:fieldUploadBytes-priorFieldBytes,cpuEnqueueMs:fieldUploadCpuMs-priorFieldUploadCpuMs},vfxExtractionCpuMs:vfxExtractCpuMs-priorExtractCpuMs,startMicros:Math.floor(start*1000),cpu:{updateMs:updated-start,prepareRecordMs:recorded-updated,completionWaitMs:completed-recorded,frameMs:completed-start},timing,intervals:timing?.status==='complete'?gpuIntervals(timing.frame):null,hostLoad:{loadavg:loadavg(),freeMemory:freemem()}});
    }
    if(capture){unwrap(await recorder.frameBoundary());tapeBytes=unwrap(await capture).bytes;writeFileSync(resolve(output,`frame-${frame}.rhitape`),tapeBytes);}
  }
  assert.equal(errors.length,0,JSON.stringify(errors));
  assert.equal(app.execution.report().frame.completed,limit,'App-owned completed frame count');
  const report={key,completedFrames:limit,simulationTicks,frames,execution:app.execution.report(),adapter:shim.adapterInfo,software:shim.isFallbackAdapter,host:host.inspect(world),resources:{highBytes,fieldHigh,fieldUploads,fieldUploadBytes,fieldUploadCpuMs,fieldUploadCalls,fieldBuffers:[...fieldBuffers.values()],allocationAccounting:allocationAccounting()},source:sourceIdentity,shaderManifestSha256:createHash('sha256').update(manifestBytes).digest('hex')};
  assert(frames.every(frame=>frame.rendererSubmissions===1),'one Renderer submission per completed frame');
  if(!performanceRun)assert(frames.every(frame=>frame.simulationUpdates===frame.expectedUpdates),'one actual GPU update per emitter/intended FixedUpdate tick, independent of view cadence');
  if(performanceRun){
    const profile=unwrap(profileSession.finish());
    const profileModel=unwrap(buildProfileModel(profile));
    writeFileSync(resolve(output,'cpu-profile.json'),JSON.stringify(profile,null,2));
    report.profile=profileModel;
    assert.equal(profileModel.completeness.status,'complete');
    const phaseSamples=new Map();
    for(const record of profile.records)if(record.kind==='phase'&&record.startMicros>=samples[30].startMicros){
      const name=`${record.source}/${record.parentPhase??''}/${record.phase}`;
      if(!phaseSamples.has(name))phaseSamples.set(name,[]);
      phaseSamples.get(name).push(record.durationMicros/1000);
    }
    report.cpuPhases=Object.fromEntries([...phaseSamples].map(([name,values])=>[name,{...distribution(values),sampleCount:values.length}]));
    report.cold={rendererMs:coldRendererMs,ordinaryAssetLoadMs:coldAssetLoadMs,firstFrame:samples[0],timingScope:{fieldUpload:'CPU queue.writeBuffer call only; GPU transfer duration is not isolated',vfxExtraction:'whole VFX extraction, including field validation/packing on a cache miss; not isolated field-only cost'}};
    report.counterReadback=[];
    for(const [buffer,info] of allBuffers)if(info.live&&(info.name.endsWith('.counters')||info.name.endsWith('.indirect'))){
      const bytes=await readNativeBuffer(buffer,info.size);
      report.counterReadback.push({label:info.label,name:info.name,words:Array.from(new Uint32Array(bytes.buffer))});
    }
    const sharedCounters=report.counterReadback.filter(row=>row.name.endsWith('.counters')&&!row.name.includes('.renderer-'));
    report.activeParticles=sharedCounters.reduce((sum,row)=>sum+row.words[0],0);
    report.expectedParticles=Number(key.split('/')[1]);
    report.indirectParticles=report.counterReadback.filter(row=>row.name.endsWith('.indirect')&&row.name.includes('.renderer-')).reduce((sum,row)=>sum+row.words[1],0);
    const sampled=samples.slice(30);assert.equal(sampled.length,60);
    report.steadyFieldUpload={calls:sampled.reduce((n,s)=>n+s.fieldUpload.calls,0),bytes:sampled.reduce((n,s)=>n+s.fieldUpload.bytes,0),cpuEnqueueMs:sampled.reduce((n,s)=>n+s.fieldUpload.cpuEnqueueMs,0)};
    assert.equal(report.steadyFieldUpload.calls,0,'unchanged fields have zero uploads during all 60 steady frames');
    assert.equal(report.steadyFieldUpload.bytes,0);
    report.vfxExtractionCpuMs=distribution(sampled.map(s=>s.vfxExtractionCpuMs));
    report.samples=samples;
    report.cpu=Object.fromEntries(Object.keys(sampled[0].cpu).map(k=>[k,distribution(sampled.map(s=>s.cpu[k]))]));
    report.gpu=sampled.every(s=>s.intervals?.spans.length>0)?Object.fromEntries(['sumMs','unionMs','overlapMs','envelopeMs'].map(k=>[k,distribution(sampled.map(s=>s.intervals[k]))])):null;
    report.gpuPhases=Object.fromEntries(['simulate','project','raster'].map(phase=>{
      const intervals=sampled.map(sample=>sample.timing?.status==='complete'?gpuIntervals({...sample.timing.frame,passes:sample.timing.frame.passes.filter(pass=>pass.status==='measured'&&pass.passName.endsWith(`.${phase}`))}):null);
      const complete=intervals.every(interval=>interval?.spans.length>0);
      if(!complete)report.gpu=null;
      return [phase,complete?Object.fromEntries(['sumMs','unionMs','overlapMs','envelopeMs'].map(name=>[name,distribution(intervals.map(interval=>interval[name]))])):null];
    }));
    report.nativeOuter={available:false,reason:'ordinary renderer exposes measured pass intervals, not a native outer query'};
    // Pixel evidence is acquired after all 30+60 frames and timing samples.
    const live=await readLivePixels();
    writeFileSync(resolve(output,'live.png'),writeReferencePng(live,512,512));
    writeFileSync(resolve(output,'live.rgba'),live);
    let visiblePixels=0;
    for(let pixel=0;pixel<512*512;pixel++)if(Math.max(live[pixel*4],live[pixel*4+1],live[pixel*4+2])/255>.05)visiblePixels++;
    report.pixels={width:512,height:512,completedFrames:limit,epsilon:.05,visiblePixels};
    report.verdict=shim.isFallbackAdapter||report.gpu===null?'blocked':report.cpu.frameMs.p95<=33.34?'pass':'fail';
    writeFileSync(resolve(output,'benchmark.json'),JSON.stringify(report,null,2));
    assert.equal(report.activeParticles,report.expectedParticles,'exact active GPU capacity');
    assert.equal(report.indirectParticles,report.expectedParticles,'exact raster instance capacity');
    assert(visiblePixels>0,'actual capacity workload must have visible raster output');
    assert.equal(report.verdict,'pass', 'Frozen full-frame p95 budget or real GPU timing failed');
  }else{
    const tape=unwrap(decodeTape(tapeBytes));const model=buildFrameModel(tape);
    const update=model.works.find(w=>w.pipeline?.shaders?.some(s=>isSimulationUpdate(s.entryPoint)));assert(update);
    const particles=update.bindings.find(b=>b.binding===0);assert(particles);
    const field=update.bindings.find(b=>b.binding===17);
    assert.equal(field!==undefined,key!=='off');
    const adapter=unwrap(await webgpu.rhi.requestAdapter());
    const replayDevice=unwrap(await adapter.requestDevice(replayDeviceRequest(tape,adapter.features,adapter.limits)));
    const nativeReplayDevice=unwrap(replayDevice.nativeDevice());
    assert.notEqual(nativeReplayDevice,device,'replay must use a fresh physical device');
    let replay;
    try{
      replay=unwrap(await openReplay(tape,{device:replayDevice,createShaderModule:webgpu.createShaderModule}));
      const read=unwrap(await replay.readResourceAtWork(particles.resourceId,update.workIndex));
      writeFileSync(resolve(output,'fresh-replay-core.bin'),read.bytes);
      const before=unwrap(await replay.readResource(particles.resourceId));
      writeFileSync(resolve(output,'before-update-core.bin'),before.bytes);
      const data=new DataView(read.bytes.buffer,read.bytes.byteOffset,read.bytes.byteLength);
      const vector=(id,name)=>Array.from({length:3},(_,lane)=>data.getFloat32(id*VFX_PARTICLE_CORE_LAYOUT.stride+vfxParticleCoreField(name).offset+lane*4,true));
      const records=Array.from({length:256},(_,id)=>({id,position:vector(id,'position'),velocity:vector(id,'velocity'),expected:trajectory(key,id,simulationTicks)}));
      const maxError=Math.max(...records.flatMap(row=>['position','velocity'].flatMap(name=>row[name].map((n,i)=>Math.abs(n-row.expected[name][i])))));
      report.oracle={updates:simulationTicks,maxError,bound:2e-4,records};
      if(key==='affine-spatial') {
        const norm=row=>Math.hypot(...row.velocity);
        for(const id of [2,4]) assert.deepEqual(records[id].velocity,[0,0,0],`translated outside seed ${id} stays still`);
        assert(norm(records[0])<=2e-4,'translated field centre remains force-free within f32 bound');
        for(const id of [1,3]) assert(norm(records[id])>.01,`translated inside seed ${id} moves`);
        report.oracle.affineSpatialSupport={centreVelocity:norm(records[0]),inside:[1,3].map(id=>({id,velocity:records[id].velocity})),outside:[2,4].map(id=>({id,velocity:records[id].velocity}))};
      }
      const beforeData=new DataView(before.bytes.buffer,before.bytes.byteOffset,before.bytes.byteLength);
      const beforeError=Math.max(...records.flatMap(row=>['position','velocity'].flatMap(name=>trajectory(key,row.id,simulationTicks-1)[name].map((n,lane)=>Math.abs(n-beforeData.getFloat32(row.id*VFX_PARTICLE_CORE_LAYOUT.stride+vfxParticleCoreField(name).offset+lane*4,true))))));
      report.oracle.beforeUpdate={updates:simulationTicks-1,maxError:beforeError};
      if(key.startsWith('vortex/')){
        const circulation=records.reduce((sum,row)=>sum+row.position[0]*row.velocity[2]-row.position[2]*row.velocity[0],0);
        report.oracle.signedCirculation=circulation;
        assert(key.endsWith('/reversed')?circulation<0:circulation>0,'vortex sign falsifier');
      }
      report.capture={digest:tapeDigest(tapeBytes),workIndex:update.workIndex,bindings:update.bindings,resources:model.resources,unseededResources:model.unseededResources,freshDevice:true};
      const projection=model.works.find(work=>work.pipeline?.shaders?.some(shader=>shader.entryPoint==='forgeax_vfx_billboard_main'));
      assert(projection,'actual billboard projection must be captured');
      const projectionCore=projection.bindings.find(binding=>binding.binding===0);
      const instances=projection.bindings.find(binding=>binding.binding===6);
      const indirect=projection.bindings.find(binding=>binding.binding===4);
      assert.equal(projectionCore?.resourceId,particles.resourceId,'update and projection share the actual Core buffer');
      assert(instances?.resourceId&&indirect?.resourceId,'projection owns instance and indirect buffers');
      const draw=model.works.find(work=>work.vertexBuffers.some(vertex=>vertex.bufferHandleId===instances.resourceId)&&work.drawCall.indirectBufferHandleId===indirect.resourceId);
      assert(draw,'projected instances and indirect arguments must reach an actual draw');
      report.capture.lineage={updateWorkIndex:update.workIndex,projectionWorkIndex:projection.workIndex,drawWorkIndex:draw.workIndex,coreResource:particles.resourceId,coreStride:VFX_PARTICLE_CORE_LAYOUT.stride,instanceResource:instances.resourceId,indirectResource:indirect.resourceId,projectionBindings:projection.bindings,vertexBuffers:draw.vertexBuffers,drawCall:draw.drawCall,drawPipelineDescriptor:draw.pipeline.descriptor};
      assert(!model.unseededResources.some(resource=>resource.resourceId===particles.resourceId||resource.resourceId===field?.resourceId),'core and field bootstrap bytes must be seeded');
      if(field){const readField=unwrap(await replay.readResourceAtWork(field.resourceId,update.workIndex));writeFileSync(resolve(output,'bound-field.bin'),readField.bytes);}
      const raster=model.works.findLast(w=>w.kind.startsWith('draw'));assert(raster);
      const image=unwrap(await replay.inspectWork(raster.workIndex,['pixels'])).attachment;assert(image);
      const decoded=unwrap(readbackImage(image));const rgba=toRgba8(decoded);
      writeFileSync(resolve(output,'fresh-replay.png'),writeReferencePng(rgba,decoded.width,decoded.height));
      writeFileSync(resolve(output,'fresh-replay.rgba'),rgba);
      const live=await readLivePixels();
      writeFileSync(resolve(output,'live.png'),writeReferencePng(live,512,512));
      writeFileSync(resolve(output,'live.rgba'),live);
      const replayPixelError=rgba.reduce((max,n,i)=>Math.max(max,Math.abs(n-live[i])/255),0);
      report.pixels={width:decoded.width,height:decoded.height,format:image.format,resourceId:image.resourceId};
      report.pixels.liveReplay={maxError:replayPixelError,bound:.05};
      writeFileSync(resolve(output,'result.json'),JSON.stringify(report,null,2));
      assert(maxError<=2e-4,`independent oracle error ${maxError}`);
      assert(beforeError<=2e-4,`independent pre-update oracle error ${beforeError}`);
      assert(replayPixelError<=.05,`fresh-device replay pixels ${replayPixelError}`);
      assert.equal(fieldUploads,key==='off'?0:key==='shared'?2:1,'unchanged field uploads once per emitter generation');
    }finally{
      try{if(replay!==undefined)unwrap(await replay.dispose());}
      finally{nativeReplayDevice.destroy();}
    }
  }
  if(process.env.FORGEAX_FIELD_REPLACEMENT_INPUTS!==undefined){
    assert.equal(key,'constant','lifecycle starts from the frozen 60-frame constant workload');
    assert(recorder,'lifecycle evidence requires the real RHI recorder');
    const {runFieldLifecycle}=await import('./field-lifecycle.mjs');
    await runFieldLifecycle({app,world,assets,host,scene,recorder,device,output,readLivePixels,
      counters:()=>({simulationUpdates,fieldUploads,fieldUploadBytes,fieldLiveBytes:[...fieldBuffers.values()].filter(info=>info.live).reduce((sum,info)=>sum+info.size,0)}),
      step:async count=>{
        for(let frame=0;frame<count;frame++){
          const completedBefore=app.execution.report().frame.completed;
          const submissionsBefore=queueSubmissions;
          receipt=undefined;
          unwrap(app.stepFrame(FIELD_DT));
          assert(receipt,'each lifecycle App frame must return its actual receipt');
          unwrap(await receipt.completed);
          assert.equal(app.execution.report().frame.completed,completedBefore+1);
          assert.equal(queueSubmissions-submissionsBefore,1,'lifecycle retains one Renderer submission');
        }
      },
    });
  }
  unwrap(await host.detachWorld({world}));
  unwrap(await renderer.dispose());
  report.resources.fieldLiveAfterDispose=[...fieldBuffers.values()].filter(v=>v.live).reduce((n,v)=>n+v.size,0);
  report.resources.allocationAccountingAfterDispose=allocationAccounting();
  writeFileSync(resolve(output,'resources-retired.json'),JSON.stringify(report.resources,null,2));
  assert.equal(report.resources.fieldLiveAfterDispose,0);
  console.log(`[fields] PASS ${key}: ${limit} completed frames`);
}catch(error){
  writeFileSync(resolve(output,'failure.json'),JSON.stringify({key,error:String(error),detail:error,completedSamples:samples,frames,simulationTicks,simulationUpdates,source:sourceIdentity},null,2));
  throw error;
}finally{
  globalThis.fetch=originalFetch;
  await host.detachWorld({world});
  await app.dispose();
  await renderer.dispose();
  writeFileSync(resolve(output,'resources-retired-finally.json'),JSON.stringify({highBytes,fieldHigh,fieldUploads,fieldUploadBytes,fieldUploadCpuMs,fieldUploadCalls,fieldLiveBytes:[...fieldBuffers.values()].filter(info=>info.live).reduce((sum,info)=>sum+info.size,0),fieldBuffers:[...fieldBuffers.values()],textureLiveCount:[...allTextures.values()].filter(info=>info.live).length,allocationAccounting:allocationAccounting()},null,2));
  writeFileSync(resolve(output,'native-allocation-events.json'),JSON.stringify({scope:'first-probe-device',events:allocationEvents},null,2));
  await teardownDawnInstance([device],()=>{globalThis.navigator.gpu=null;},()=>{});
}
