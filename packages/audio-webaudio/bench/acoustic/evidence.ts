import { AssetRegistry } from '@forgeax/engine/assets-runtime';
/// <reference types="vite/client" />
import { type App } from '@forgeax/engine/app';
import { createApp } from '@forgeax/engine/app/browser';
import { AcousticRegion, AcousticShapeValue, AudioListener, AudioSource, audioPlugin, createAudioIntentBackend } from '@forgeax/engine/audio';
import { createHostAudioConsumer, WebAudioEngine, webAudioPlugin } from '@forgeax/engine/audio-webaudio';
import { World, createWorldContext, type EntityHandle } from '@forgeax/engine/ecs';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePackageId } from '@forgeax/engine/pack/source';
import { Transform, GlobalTransform, scenePlugin } from '@forgeax/engine/scene';
import { Camera } from '@forgeax/engine/render';
import type { AudioClipAsset, SceneAsset } from '@forgeax/engine/types';
import { runtimeBinding, createRuntimeAssetImportTransport } from 'virtual:forgeax/pack-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(test: () => boolean) { const deadline = performance.now() + 15000; while (!test()) { if (performance.now() > deadline) throw new Error('native admission timeout'); await sleep(5); } }
const percentile = (a: number[], q: number) => [...a].sort((a,b) => a-b)[Math.ceil(a.length*q)-1] ?? 0;
const summary = (a: number[]) => ({ p50: percentile(a,.5), p95: percentile(a,.95), max: Math.max(...a) });
const heap = () => (performance as any).memory?.usedJSHeapSize ?? null;
const failures: string[] = [];
function check(ok: boolean, detail: string) { if (!ok) failures.push(detail); }
function errorRecord(error:unknown,depth=0):unknown {
  if(depth>=6)return String(error);
  if(error instanceof Error){const e=error as Error&{code?:unknown;expected?:unknown;hint?:unknown;detail?:unknown;cause?:unknown};
    return{name:e.name,message:e.message,stack:e.stack,code:e.code,expected:e.expected,hint:e.hint,detail:errorRecord(e.detail,depth+1),cause:errorRecord(e.cause,depth+1)};}
  if(Array.isArray(error))return error.map(e=>errorRecord(e,depth+1));
  if(error&&typeof error==='object')return Object.fromEntries(Object.entries(error).map(([k,v])=>[k,errorRecord(v,depth+1)]));
  return error;
}
async function checkpoint(name:string,report:unknown){await (globalThis as any).__saveAcousticEvidence?.(name,report);}
async function rhiDiagnosis(app:App) {
  if(!app.rhiCapture){await checkpoint('rhi-capture',{status:'unavailable',reason:'App recorder absent'});check(false,'RHI recorder absent');return;}
  const captured=await app.rhiCapture.captureFrame();
  if(!captured.ok){await checkpoint('rhi-capture',{status:'failed',error:errorRecord(captured.error)});check(false,'RHI capture failed');return;}
  const {decodeTape,buildFrameModel,openReplay,replayDeviceRequest}=await import('@forgeax/engine/rhi-debug');
  // Persist the original tape before any decode/replay assertion can fail.
  await checkpoint('rhi-capture',{digest:captured.value.digest,byteLength:captured.value.byteLength,
    binaryFiles:{'public-app.rhitape':[...captured.value.bytes]}});
  const decoded=decodeTape(captured.value.bytes);
  if(!decoded.ok){await checkpoint('rhi-decode',{error:errorRecord(decoded.error)});check(false,'RHI tape decode failed');return;}
  const model=buildFrameModel(decoded.value);await checkpoint('rhi-frame-model',model);
  const webgpu=await import('@forgeax/engine/rhi-webgpu');let rawDevice:GPUDevice|undefined;
  const adapter=await webgpu.requestAdapterFrom({async requestAdapter(options){
    const native=await navigator.gpu.requestAdapter(options);if(!native)return null;
    await checkpoint('rhi-adapter',{info:{vendor:native.info.vendor,architecture:native.info.architecture,device:native.info.device,description:native.info.description},features:[...native.features]});
    return{features:native.features,limits:native.limits,async requestDevice(descriptor){
      rawDevice=await native.requestDevice(descriptor);return rawDevice;}};
  }});
  if(!adapter.ok){await checkpoint('rhi-replay',{error:errorRecord(adapter.error)});check(false,'fresh RHI adapter unavailable');return;}
  try {
    const device=await adapter.value.requestDevice(replayDeviceRequest(decoded.value,adapter.value.features,adapter.value.limits));
    if(!device.ok){await checkpoint('rhi-replay',{error:errorRecord(device.error)});check(false,'fresh RHI device unavailable');return;}
    const replay=await openReplay(decoded.value,{device:device.value,createShaderModule:webgpu.createShaderModule});
    if(!replay.ok){await checkpoint('rhi-replay',{error:errorRecord(replay.error)});check(false,'fresh RHI replay failed');return;}
    try {
      const work=model.works[0];
      if(!work){await checkpoint('rhi-replay',{status:'no-work',generation:replay.value.generation,passes:model.passes,resources:model.resources});check(false,'RHI capture has no work');return;}
      const inspected=await replay.value.inspectWork(work.workIndex,['pipeline','bindings','pixels','outputs']);
      if(!inspected.ok){await checkpoint('rhi-replay',{workIndex:work.workIndex,error:errorRecord(inspected.error)});check(false,'RHI work inspection failed');return;}
      const {attachment,...facts}=inspected.value;
      await checkpoint('rhi-replay',{...facts,generation:replay.value.generation,
        ...(attachment?{attachment:{...attachment,bytes:[...attachment.bytes]},binaryFiles:{'public-app-replay.bin':[...attachment.bytes]}}:{})});
      check(replay.value.generation===1,'RHI replay must use a fresh device generation');
      check(facts.pipeline?.status==='available'&&!!facts.bindings?.length&&!!facts.resourceIds?.length,'RHI work pipeline/bindings/resources unavailable');
      check(!!attachment?.bytes.byteLength,'RHI native pixel readback missing');
    } finally {const disposed=await replay.value.dispose();if(!disposed.ok){await checkpoint('rhi-replay-dispose',{error:errorRecord(disposed.error)});check(false,'RHI replay disposal failed');}}
  } finally {rawDevice?.destroy();}
}
function wav(samples: readonly Float32Array[]) {
  const frames = samples[0]!.length, channels = samples.length, bytes = new Uint8Array(44 + frames*channels*2), view = new DataView(bytes.buffer);
  for (const [offset, word] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']] as const) for (let i=0;i<word.length;i++) bytes[offset+i]=word.charCodeAt(i);
  view.setUint32(4,bytes.length-8,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,48000,true);view.setUint32(28,48000*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);view.setUint32(40,bytes.length-44,true);
  for(let i=0;i<frames;i++)for(let c=0;c<channels;c++)view.setInt16(44+(i*channels+c)*2,Math.round(Math.max(-1,Math.min(1,samples[c]![i]!))*32767),true);
  return [...bytes];
}
function graph(engine: WebAudioEngine) {
  engine.configureBuses([{id:'master',parent:null},{id:'sfx',parent:'master'}, {id:'room',parent:'master',volume:.5,sends:[{bus:'echo',gain:0,tap:'pre-fader'}]}, {id:'echo',parent:'master'}]).unwrap();
  engine.setBusEffects('echo', context => { const convolver=context.createConvolver(); convolver.normalize=false;
    const impulse=context.createBuffer(1,14401,48000);impulse.getChannelData(0)[4800]=.6;impulse.getChannelData(0)[9600]=.3;convolver.buffer=impulse;return[convolver]; },0).unwrap();
}
function instrument(context: BaseAudioContext) {
  let created=0, peakConnections=0,connections=0;const edges=new Map<AudioNode,Set<AudioNode>>();
  for(const name of ['createGain','createBufferSource','createPanner','createConvolver','createDelay','createBiquadFilter','createAnalyser'] as const){
    const native=context[name].bind(context);(context as any)[name]=(...args:unknown[])=>{const node=(native as any)(...args) as AudioNode;created++;edges.set(node,new Set());
      const connect=node.connect.bind(node),disconnect=node.disconnect.bind(node);
      (node as any).connect=(target:AudioNode,...rest:unknown[])=>{const result=(connect as any)(target,...rest);if(!edges.get(node)!.has(target)){edges.get(node)!.add(target);connections++;}peakConnections=Math.max(peakConnections,connections);return result;};
      (node as any).disconnect=(...args:unknown[])=>{const result=(disconnect as any)(...args);if(args.length){if(edges.get(node)!.delete(args[0] as AudioNode))connections--;}else{connections-=edges.get(node)!.size;edges.get(node)!.clear();}return result;};return node;};
  }
  const read=()=>({created,peakConnections,connections});read.releaseObserver=()=>edges.clear();return read;
}
async function assetApp() {
  const context=new AudioContext({sampleRate:48000});await context.resume();const engine=new WebAudioEngine({context});graph(engine);
  const app=(await createApp(document.querySelector('#app') as HTMLCanvasElement,{...(runtimeBinding?{assetRuntimeBinding:runtimeBinding}:{}), plugins:[webAudioPlugin(engine),audioPlugin()]},
    {...forgeaxBundlerAdapter(),importTransport:createRuntimeAssetImportTransport(runtimeBinding)})).unwrap();
  if(!app.assets)throw new Error('asset provider absent');
  if(import.meta.env.DEV){if(!runtimeBinding)throw new Error('Pack binding absent');app.assets.configureRuntimeBinding(runtimeBinding);}else app.assets.configurePackIndex(new URL('/pack-index.json',location.href).href);
  const guid=AssetGuid.derive(definePackageId('01a11253-2200-7000-8000-000000000000'),'rooms');
  const sceneHandle=(await app.assets.load(AssetGuid.format(guid), 'scene')).unwrap();
  const reloaded=(await app.assets.load(AssetGuid.format(guid), 'scene')).unwrap();
  check(sceneHandle===reloaded,'saved scene identity mismatch');
  const loaded=app.assets.read(sceneHandle).unwrap();
  const clipHandle=(await app.assets.load('01a11253-2200-7000-8000-000000000001', 'audio')).unwrap();
  const clip=app.assets.read(clipHandle).unwrap();
  const root=app.assets.instantiate(sceneHandle,app.world).unwrap();
  app.assets.release(sceneHandle).unwrap();app.assets.release(reloaded).unwrap();app.assets.release(clipHandle).unwrap();
  const source=[...app.world.query({read:[AudioSource]}).unwrap()][0]!.entity;
  const listener=[...app.world.query({with:[AudioListener]}).unwrap()][0]!.entity;
  app.start().unwrap();app.pause().unwrap();const frames:number[]=[];const errors:unknown[]=[];app.onError(error=>errors.push(errorRecord(error)));
  for(let i=0;i<60;i++) {const started=performance.now(),x=i<15?3:i<45?0:3;app.world.set(source,Transform,{pos:[x,0,0]}).unwrap();app.world.set(listener,Transform,{pos:[x,0,0]}).unwrap();
    app.stepFrame(1/60).unwrap();frames.push(performance.now()-started);await sleep(20);}
  await wait(()=>engine.getState().activeSourceCount===1);
  await wait(()=>app.execution.report().frame.completed>=60);
  const result={guid:AssetGuid.format(guid),root,scene:loaded,clip:{kind:clip.kind,sourceKey:clip.sourceKey,bytes:clip.bytes?.byteLength},frames,summary:summary(frames),completed:app.execution.report().frame.completed,backend:app.renderer.inspect().capabilities.backendKind,errors,host:engine.getState()};
  check(errors.length===0,'App errors');if((globalThis as any).__acousticPhase!=='native')check(result.summary.p95<=16.67,'App frame p95 exceeds 16.67 ms');
  if(import.meta.env.FORGEAX_ENGINE_RHI_DEBUG==='1'){
    await checkpoint('public-app',result);
    try{await rhiDiagnosis(app);}catch(error){await checkpoint('rhi-capture-exception',{error:errorRecord(error)});check(false,'RHI diagnostic exception');}
  }
  await app.dispose();await context.close();return{result,clip,scene:loaded};
}
async function workerApp(guid:string,shared:boolean,clip:AudioClipAsset){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;document.body.append(canvas);
  const channel=new MessageChannel(),contexts:AudioContext[]=[],consumers:ReturnType<typeof createHostAudioConsumer>[]=[];
  const recording:Float32Array[][]=[];let generation=0;
  const blockReceipts=new WeakMap<Float32Array[],{generation:number;playbackTime:number;contextTime:number;callbackAt:number;position:number|undefined;firstFrame:number;frameCount:number;sampleRate:number}>();
  const timeline:unknown[]=[];const observe=(event:unknown)=>{timeline.push(event);if(timeline.length>512)timeline.shift();};
  const send=(command:unknown)=>{observe({stage:'control-post',command,generation,contextTime:contexts.at(-1)?.currentTime,at:performance.now()});channel.port1.postMessage(command);};
  const created=await createApp(canvas,{silenceUnhandledErrors:true,execution:{bootstrap:import.meta.env.DEV?new URL('./bootstrap.ts',import.meta.url):new URL('/assets/acoustic-bootstrap.js',location.href),bootstrapData:{guid,shared},bootstrapPort:channel.port2,
    assetCatalog:{url:new URL(import.meta.env.DEV?runtimeBinding!.catalogUrl:'/pack-index.json',location.href).href},
    workers:{engine:true,render:false,kernels:shared},
    createHostAudio(){generation++;const ownerGeneration=generation;let sourceId:number|undefined;let recorderNode:AudioWorkletNode|undefined;const context=new AudioContext({sampleRate:48000});contexts.push(context);void context.resume();const engine=new WebAudioEngine({context});graph(engine);
      // Worklet input frame receipts avoid ScriptProcessor's queued output
      // clock. Module load remains inside the original initial native wait.
      void context.audioWorklet.addModule(new URL('./recorder.worklet.js',import.meta.url).href).then(()=>{
        if(context.state==='closed')return;
        engine.setBusEffects('master',()=>{
          const recorder=recorderNode=new AudioWorkletNode(context,'acoustic-recorder',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]});
          recorder.port.onmessage=event=>{
            if(context.state==='closed')return;
            const {channels:block,firstFrame,frameCount,sampleRate}=event.data as {channels:Float32Array[];firstFrame:number;frameCount:number;sampleRate:number};
            blockReceipts.set(block,{generation:ownerGeneration,firstFrame,frameCount,sampleRate,playbackTime:firstFrame/sampleRate,contextTime:context.currentTime,callbackAt:performance.now(),position:sourceId===undefined?undefined:engine.getPlaybackPosition(sourceId)});
            recording.push(block);if(recording.length>96)recording.shift();
          };
          return[recorder];
        },1).unwrap();
      }).catch(error=>observe({stage:'recorder-module-error',generation:ownerGeneration,error:errorRecord(error),at:performance.now()}));
      const consumer=createHostAudioConsumer(engine);const consume=consumer.consume;
      consumer.consume=intent=>{if('entityId' in intent)sourceId=intent.entityId;
        const before=sourceId===undefined?undefined:engine.getPlaybackPosition(sourceId);consume(intent);
        if(intent.kind==='play'||intent.kind==='seek'||intent.kind==='set-paused'||intent.kind==='stop')
          observe({stage:'host-control',kind:intent.kind,generation:ownerGeneration,entityId:sourceId,requestedPosition:intent.kind==='seek'?intent.position:undefined,before,after:sourceId===undefined?undefined:engine.getPlaybackPosition(sourceId),contextTime:context.currentTime,at:performance.now()});
      };consumers.push(consumer);const dispose=consumer.dispose;consumer.dispose=()=>{observe({stage:'host-dispose',generation:ownerGeneration,at:performance.now(),contextTime:context.currentTime,state:context.state});recorderNode?.port.close();dispose();void context.close();};return consumer;
    }}},forgeaxBundlerAdapter());
  const app=created.unwrap();const reports:any[]=[];const slices:{name:string;channels:Float32Array[];blocks:(object|undefined)[]}[]=[];
  const workerErrors:unknown[]=[];app.onError(error=>{const detail=errorRecord(error);workerErrors.push(detail);observe({stage:'app-error',generation,at:performance.now(),error:detail,report:app.execution.report(),contexts:contexts.map(context=>({state:context.state,currentTime:context.currentTime}))});});
  let stage='initial 60 completed frames, active source and native recorder';
  // Independent native input decode for the measurement oracle, not another
  // playback cache. Public Worker seeks keep measured blocks away from the
  // fixture's silence interval without substituting a different clip.
  const rms=(samples:Float32Array)=>Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length);
  const capture=(name:string)=>{
    const blocks=recording.slice(-24),receipts=blocks.map(block=>blockReceipts.get(block));
    check(blocks.length===24&&receipts.every((receipt,index)=>receipt?.generation===generation&&receipt.frameCount===1024&&receipt.sampleRate===48000&&
      (index===0||receipt.firstFrame===receipts[index-1]!.firstFrame+1024)),`Worker ${shared}/${name} actual input-frame continuity`);
    slices.push({name,blocks:receipts,channels:[0,1].map(c=>{const samples=new Float32Array(blocks.length*1024);blocks.forEach((b,i)=>samples.set(b[c]!,i*1024));return samples;})});
  };
  try{
    const reference=await contexts[0]!.decodeAudioData(clip.bytes!.slice().buffer as ArrayBuffer);
    const referenceRms=[0,1].map(channel=>{
      const input=reference.getChannelData(channel);const direct=new Float32Array(48000),inside=new Float32Array(48000);
      for(let i=0;i<48000;i++){const n=i+14400;direct[i]=input[n]!;
        inside[i]=.5*input[n]!+.3*input[n-4800]!+.15*input[n-9600]!;}
      return{outside:rms(direct),inside:rms(inside),listenerRemoved:.5*rms(direct)};
    });
    app.start().unwrap();await wait(()=>app.execution.report().frame.completed>=60&&app.execution.report().audio.activeSourceCount===1&&recording.length>=24);reports.push(app.execution.report());
    check(app.execution.report().audio.lastError===null,`Worker ${shared} initial regional controls rejected`);
    send({fromPosition:.001});await sleep(1000);capture('outside');
    send({x:0,fromPosition:.002});await sleep(1000);capture('inside');stage='pause source';send({paused:true});await wait(()=>app.execution.report().audio.activeSourceCount===0);await sleep(300);capture('paused');
    const paused=slices.at(-1)!.channels[0]!;check(paused.slice(-4096).every(v=>Math.abs(v)<1e-5),`Worker ${shared} paused PCM silence`);
    stage='resume source';send({paused:false});await wait(()=>app.execution.report().audio.activeSourceCount===1);send({removeListener:true,fromPosition:.003});await sleep(1000);capture('listener-removed');
    send({removeRegions:true,fromPosition:.005});await sleep(1000);capture('regions-removed');
    const amplitudes=slices.filter(s=>s.name!=='paused').map(s=>({name:s.name,rms:s.channels.map(rms)}));
    for(const measured of amplitudes)for(let c=0;c<2;c++){
      const oracle=referenceRms[c]!,expected=measured.name==='outside'||measured.name==='regions-removed'?oracle.outside:measured.name==='inside'?oracle.inside:oracle.listenerRemoved;
      check(Math.abs(measured.rms[c]!/expected-1)<=.01,`Worker ${shared}/${measured.name}/channel${c} native RMS oracle`);
    }
    check(workerErrors.length===0,`Worker ${shared} unexpected errors before deliberate fault`);
    await checkpoint(`app-worker-${shared?'shared':'serial'}-controls`,{referenceRms,amplitudes,timeline:[...timeline],failures:[...failures],
      slices:slices.map(slice=>({...slice,channels:slice.channels.map(channel=>[...channel])})),
      audioFiles:Object.fromEntries(slices.map(slice=>[`worker-${shared?'shared':'serial'}-${slice.name}.wav`,wav(slice.channels)]))});
    stage='faulted engine receipt';send({poison:true});await wait(()=>app.execution.report().engine.health==='faulted');const old=consumers[0]!,oldContext=contexts[0]!;reports.push(app.execution.report());
    const beforeIdentity=app.execution.report().world.identity;(await app.execution.rebuild()).unwrap();stage='retire previous Context';await wait(()=>oldContext.state==='closed');recording.length=0;app.start().unwrap();
    stage='rebuilt 60 completed frames, active source and native recorder';
    await wait(()=>app.execution.report().audio.activeSourceCount===1&&app.execution.report().frame.completed>=60&&recording.length>=24);reports.push(app.execution.report());
    send({fromPosition:.004});await sleep(1000);capture('rebuilt-outside');
    await checkpoint(`app-worker-${shared?'shared':'serial'}-rebuilt-window`,{report:app.execution.report(),workerErrors,timeline:[...timeline],contexts:contexts.map(context=>({state:context.state,currentTime:context.currentTime})),hostStates:consumers.map(consumer=>consumer.state())});
    check(app.execution.report().engine.health==='running'&&contexts[1]!.state==='running',`Worker ${shared} rebuilt owner stopped unexpectedly`);
    check(workerErrors.length===1&&timeline.some((event:any)=>event.stage==='host-control'&&event.generation===2&&event.kind==='seek'&&Math.abs(event.requestedPosition-.004)<=1e-7),`Worker ${shared} rebuilt seek consumption and error fence`);
    const rebuiltAmplitude={name:'rebuilt-outside',rms:slices.at(-1)!.channels.map(rms)};amplitudes.push(rebuiltAmplitude);
    for(let c=0;c<2;c++)check(Math.abs(rebuiltAmplitude.rms[c]!/referenceRms[c]!.outside-1)<=.01,`Worker ${shared}/rebuilt/channel${c} native RMS oracle`);
    check(generation===2&&old.state().activeSourceCount===0&&beforeIdentity!==app.execution.report().world.identity,'Worker rebuild owner fence');
    if(shared)check(app.execution.report().kernelDispatch.usedShared,'shared kernel dispatch absent');stage='stop source';send({stop:true});await wait(()=>app.execution.report().audio.activeSourceCount===0);
    return{shared,generation,reports,slices,referenceRms,amplitudes,timeline};
  }catch(error){
    await checkpoint(`app-worker-${shared?'shared':'serial'}-failure`,{stage,timeline:[...timeline],error:errorRecord(error),report:app.execution.report(),workerErrors,generation,
      contexts:contexts.map(context=>({state:context.state,currentTime:context.currentTime,sampleRate:context.sampleRate})),
      hostStates:consumers.map(consumer=>consumer.state()),recordingBlocks:recording.length,reports,failures:[...failures],
      slices:slices.map(slice=>({...slice,channels:slice.channels.map(channel=>[...channel])})),
      audioFiles:Object.fromEntries(slices.map(slice=>[`worker-${shared?'shared':'serial'}-${slice.name}.wav`,wav(slice.channels)]))});
    throw error;
  }finally{await app.dispose();for(const context of contexts)if(context.state!=='closed')await context.close();channel.port1.close();canvas.remove();}
}
function roomWeight(x:number) { return Math.max(0,Math.min(1,(1-Math.abs(x/2))/.5)); }
interface Envelope {from:number;to:number;at:number}
const value=(e:Envelope,t:number)=>e.from+(e.to-e.from)*Math.max(0,Math.min(1,(t-e.at)/.01));
async function selectionSignal(clip:AudioClipAsset){
  const context=new OfflineAudioContext(2,48000,48000),resources=instrument(context),engine=new WebAudioEngine({context});
  engine.configureBuses([{id:'master',parent:null},{id:'sfx',parent:'master'},
    {id:'room',parent:'master',volume:.5},{id:'outside',parent:'master',volume:.8}]).unwrap();
  const consumer=createHostAudioConsumer(engine),intents:unknown[]=[];
  const backend=createAudioIntentBackend({emit:intent=>{intents.push(structuredClone(intent));consumer.consume(intent);}});
  const assets=new AssetRegistry(),world=new World({assets}),realm=await createWorldContext(world,[scenePlugin(),{name:'audio-host',provide:'audio',apply(ctx){ctx.provide('audio',backend);}},audioPlugin()]);
  const clipRef=assets.create(clip).unwrap();
  const source=world.spawn({component:Transform,data:{}},{component:AudioSource,data:{clip:clipRef,playing:true,loop:true}}).unwrap();
  // Distinct listener position: source selection must not borrow its pose.
  world.spawn({component:Transform,data:{pos:[4,0,0]}},{component:AudioListener,data:{}}).unwrap();
  const box=world.spawn({component:Transform,data:{}},{component:AcousticRegion,data:{sourceBus:'room',priority:1}}).unwrap();
  const sphere=world.spawn({component:Transform,data:{pos:[.5,0,0]}},{component:AcousticRegion,data:{shape:AcousticShapeValue.sphere,radius:1.5,sourceBus:'outside',priority:1}}).unwrap();
  const winner=world.spawn({component:Transform,data:{}},{component:AcousticRegion,data:{enabled:false,sourceBus:'room',priority:2}}).unwrap();
  world.update(1/60).unwrap();await wait(()=>consumer.state().activeSourceCount===1);
  const decoded=await context.decodeAudioData(clip.bytes!.slice().buffer as ArrayBuffer);
  // Independent known geometry: both initial weights are one, so the normalized
  // routes yield (.5+.8)/2. Later gains below follow authored dimensions and bus
  // volumes directly; they never read the production selection or emitted gain.
  const events:{time:number;gain:number;case:string}[]=[{time:0,gain:.65,case:'same-priority overlap'}];
  const controls:{time:number;gain:number;case:string;apply:()=>void}[]=[
    {time:.1,gain:.5,case:'enable higher priority',apply:()=>{world.set(winner,AcousticRegion,{enabled:true}).unwrap();}},
    {time:.2,gain:.8,case:'change sphere priority',apply:()=>{world.set(sphere,AcousticRegion,{priority:3}).unwrap();}},
    {time:.3,gain:.5,case:'remove current sphere',apply:()=>{world.despawn(sphere).unwrap();}},
    {time:.4,gain:.5,case:'remove higher-priority box',apply:()=>{world.despawn(winner).unwrap();}},
    {time:.5,gain:.8,case:'static boundary band',apply:()=>{world.set(source,Transform,{pos:[.9,0,0]}).unwrap();}},
    {time:.6,gain:1,case:'fast exit',apply:()=>{world.set(source,Transform,{pos:[4,0,0]}).unwrap();}},
    {time:.606,gain:.5,case:'fast reentry during native ramp',apply:()=>{world.set(source,Transform,{pos:[0,0,0]}).unwrap();}},
    {time:.7,gain:1,case:'remove final region',apply:()=>{world.despawn(box).unwrap();}},
  ];
  const stops=controls.map(c=>context.suspend(c.time)),rendering=context.startRendering();
  for(const [index,control]of controls.entries()){await stops[index];control.apply();world.update(1/60).unwrap();events.push({time:context.currentTime,gain:control.gain,case:control.case});await context.resume();}
  const rendered=await rendering,channels=[0,1].map(c=>rendered.getChannelData(c).slice()),oracle=channels.map(c=>new Float32Array(c.length));
  let envelope:Envelope={from:.65,to:.65,at:0},event=1,maxError=0,sumError=0,sumSignal=0;
  for(let n=0;n<48000;n++){const time=n/48000;while(event<events.length&&events[event]!.time<=time){const next=events[event++]!;envelope={from:value(envelope,next.time),to:next.gain,at:next.time};}
    for(let c=0;c<2;c++){const expected=decoded.getChannelData(c)[n]!*value(envelope,time);oracle[c]![n]=expected;const error=channels[c]![n]!-expected;maxError=Math.max(maxError,Math.abs(error));sumError+=error*error;sumSignal+=expected*expected;}}
  const error={max:maxError,relativeRms:Math.sqrt(sumError/sumSignal)};check(error.max<=2e-4&&error.relativeRms<=.01,`overlap/priority/removal PCM oracle ${JSON.stringify(error)}`);
  const beforeStop=resources();consumer.dispose();await realm.fiber.dispose();world.despawn(source).unwrap();assets.release(clipRef).unwrap();assets.dispose();const afterStop=resources();check(afterStop.connections===0,'selection native connections released');
  return{events,intents,error,resources:{beforeStop,afterStop},rawSamples:channels.map(c=>[...c]),oracle:oracle.map(c=>[...c]),
    audioFiles:{'selection.wav':wav(channels),'selection-oracle.wav':wav(oracle)}};
}
async function signal(clip:AudioClipAsset, mode:'enabled'|'off'|'zero-wet'|'send-off') {
  const context=new OfflineAudioContext(2,48000*3,48000),engine=new WebAudioEngine({context});const resources=instrument(context);graph(engine);
  const consumer=createHostAudioConsumer(engine);const intents:unknown[]=[];const backend=createAudioIntentBackend({emit:intent=>{intents.push(structuredClone(intent));consumer.consume(intent);}});
  const assets=new AssetRegistry(),world=new World({assets});const realm=await createWorldContext(world,[scenePlugin(),{name:'audio-host',provide:'audio',apply(ctx){ctx.provide('audio',backend);}},audioPlugin()]);
  const clipRef=assets.create(clip).unwrap();
  const source=world.spawn({component:Transform,data:{pos:[3,0,0]}},{component:AudioSource,data:{clip:clipRef,playing:true,loop:true}}).unwrap();
  const listener=world.spawn({component:Transform,data:{pos:[3,0,0]}},{component:AudioListener,data:{}}).unwrap();
  if(mode!=='off')world.spawn({component:Transform,data:{scale:[2,1,1]}},{component:AcousticRegion,data:{sourceBus:'room',listenerWetBus:'echo',wet:mode==='zero-wet'?0:1,listenerSendBus:'room',listenerSendTarget:'echo',sendGain:mode==='send-off'?0:.5,blendDistance:.5}}).unwrap();
  world.update(1/60).unwrap();await wait(()=>consumer.state().activeSourceCount===1);
  const decoded=await context.decodeAudioData(clip.bytes!.slice().buffer as ArrayBuffer);
  const timeline:{time:number;x:number;weight:number}[]=[{time:0,x:3,weight:0}];
  const stops=Array.from({length:179},(_,i)=>context.suspend((i+1)/60));const rendering=context.startRendering();
  for(let i=1;i<=179;i++){await stops[i-1];const x=i<30?3:i<60?3-3*(i-30)/30:i<120?0:i<150?3*(i-120)/30:3;
    world.set(source,Transform,{pos:[x,0,0]}).unwrap();world.set(listener,Transform,{pos:[x,0,0]}).unwrap();world.update(1/60).unwrap();timeline.push({time:context.currentTime,x,weight:mode==='off'?0:roomWeight(x)});await context.resume();}
  const rendered=await rendering;const channels=[rendered.getChannelData(0).slice(),rendered.getChannelData(1).slice()];
  const expected=channels.map(c=>new Float32Array(c.length)),sendSignal=channels.map(c=>new Float32Array(c.length));
  let route:Envelope={from:0,to:0,at:0},wet:Envelope={from:0,to:0,at:0},send:Envelope={from:0,to:0,at:0},event=1;
  for(let n=0;n<expected[0]!.length;n++){const t=n/48000;while(event<timeline.length&&timeline[event]!.time<=t){const row=timeline[event++]!;const w=row.weight;
      route={from:value(route,row.time),to:w,at:row.time};wet={from:value(wet,row.time),to:mode==='zero-wet'?0:w,at:row.time};send={from:value(send,row.time),to:mode==='send-off'?0:.5*w,at:row.time};}
    const r=value(route,t),w=value(wet,t),s=value(send,t);
    for(let c=0;c<2;c++){const input=decoded.getChannelData(c),sample=input[n%input.length]!,sent=sendSignal[c]!;sent[n]=sample*r*s;expected[c]![n]=sample*(1-r+.5*r)+(1-w)*sent[n]!+w*(.6*(sent[n-4800]??0)+.3*(sent[n-9600]??0));}}
  let maxError=0,sumError=0,sumSignal=0;for(let n=0;n<expected[0]!.length;n++){for(let c=0;c<2;c++){const e=channels[c]![n]!-expected[c]![n]!;maxError=Math.max(maxError,Math.abs(e));sumError+=e*e;sumSignal+=expected[c]![n]!**2;}}
  const error={max:maxError,relativeRms:Math.sqrt(sumError/sumSignal)};check(error.max<=2e-4&&error.relativeRms<=.01,`${mode} PCM oracle ${JSON.stringify(error)}`);
  const beforeStop=resources();consumer.dispose();await realm.fiber.dispose();world.despawn(source).unwrap();assets.release(clipRef).unwrap();assets.dispose();const afterStop=resources();check(consumer.state().activeSourceCount===0,`${mode} source cleanup`);check(afterStop.connections===0,`${mode} retained native connections`);
  return{mode,timeline,intents,error,resources:{beforeStop,afterStop},samples:channels,expected};
}
async function cost(clip:AudioClipAsset,round:number,count:number,regions:number,overlap:number,moving:number,enabled:boolean){
  const setupStart=performance.now();
  const context=new AudioContext({sampleRate:48000});await context.resume();const resources=instrument(context),engine=new WebAudioEngine({context});
  const contextMs=performance.now()-setupStart;
  let decodeCalls=0,decodedBytes=0;const decode=context.decodeAudioData.bind(context);context.decodeAudioData=async(buffer:ArrayBuffer)=>{decodeCalls++;const decoded=await decode(buffer);decodedBytes+=decoded.length*decoded.numberOfChannels*4;return decoded;};
  graph(engine);
  const consumer=createHostAudioConsumer(engine);let bytes=0,acoustic=0,maxBatch=0,hostMs=0,audioMs=0,worldMs=0;
  const awaitingAdmission=new Set<number>();let pendingAdmissionHighWater=0;
  const play=engine.play.bind(engine);engine.play=(entity,...args)=>{play(entity,...args);awaitingAdmission.delete(entity);};
  const backend=createAudioIntentBackend({state:()=>consumer.state(),emit:i=>{bytes+=new TextEncoder().encode(JSON.stringify(i)).length;if(i.kind==='set-acoustic-routes'||i.kind==='set-acoustic-environment')acoustic++;
    if(i.kind==='play'){awaitingAdmission.add(i.entityId);pendingAdmissionHighWater=Math.max(pendingAdmissionHighWater,awaitingAdmission.size);}
    if(i.kind==='stop')awaitingAdmission.delete(i.entityId);
    const start=performance.now();consumer.consume(i);hostMs+=performance.now()-start;}});
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;document.body.append(canvas);
  // Observe the production audio plugin's registered callback, without replacing
  // its selection or publication logic. The same observer runs in on/off cases.
  const appStart=performance.now();
  const app=(await createApp(canvas,{plugins:[{name:'audio-host',provide:'audio',inject:['world'],apply(ctx){
    const add=ctx.world.addSystem.bind(ctx.world);(ctx.world as any).addSystem=(schedule:any,descriptor:any)=>add(schedule,descriptor.name==='audio-tick'?{...descriptor,fn:(...args:any[])=>{
      const start=performance.now();try{return descriptor.fn(...args);}finally{audioMs+=performance.now()-start;}}}:descriptor);
    ctx.provide('audio',backend);return()=>{ctx.world.addSystem=add;};}},audioPlugin()]},forgeaxBundlerAdapter())).unwrap();
  const appMs=performance.now()-appStart;
  const world=app.world,errors:unknown[]=[];app.onError(e=>errors.push(errorRecord(e)));
  world.spawn({component:Transform,data:{pos:[0,0,5]}},{component:Camera,data:{fov:Math.PI/3,aspect:1}}).unwrap();
  const update=world.update.bind(world);world.update=(...args)=>{const start=performance.now();try{return update(...args);}finally{worldMs+=performance.now()-start;}};
  app.start().unwrap();app.pause().unwrap();
  const beforeHeap=heap(),coldStart=performance.now(),entities:EntityHandle[]=[],regionEntities:EntityHandle[]=[];const groups=Math.ceil(regions/overlap);
  for(let i=0;i<regions;i++)regionEntities.push(world.spawn({component:Transform,data:{pos:[Math.floor(i/overlap)*10,0,0]}},{component:AcousticRegion,data:{enabled,sourceBus:i%2?'sfx':'room',listenerWetBus:'echo',wet:1,listenerSendBus:'room',listenerSendTarget:'echo',sendGain:1,halfExtents:new Float32Array([1.5,1.5,1.5]),blendDistance:1}}).unwrap());
  const listener=world.spawn({component:Transform,data:{}},{component:AudioListener,data:{}}).unwrap();
  const shared=app.assets!.create(clip).unwrap();for(let i=0;i<count;i++)entities.push(world.spawn({component:Transform,data:{pos:[(i%groups)*10,0,0]}},{component:AudioSource,data:{clip:shared,playing:true,loop:true,volume:.01/count}}).unwrap());
  audioMs=hostMs=worldMs=0;app.stepFrame(1/60).unwrap();const initialUpdate={audioMs,hostMs,worldMs,bytes,acousticIntents:acoustic};await wait(()=>consumer.state().activeSourceCount===count&&app.execution.report().frame.completed>=1);const coldMs=performance.now()-coldStart;
  const samples:number[]=[],rawAppUpdateMs:number[]=[],rawCompletionMs:number[]=[],rawBytes:number[]=[],rawIntents:number[]=[],rawAudioMs:number[]=[],rawHostMs:number[]=[],rawWorldMs:number[]=[],rawPoseUpdateMs:number[]=[];let peakHeap=heap()??0;
  for(let frame=0;frame<304;frame++){
    // A completed receipt is required before the next measured admitted frame.
    const completed=app.execution.report().frame.completed;await wait(()=>app.execution.report().frame.completed>=frame+1);
    const beforeNodes=resources().created,startMove=performance.now();
    for(let i=0;i<Math.floor(count*moving);i++)world.set(entities[i]!,Transform,{pos:[(i%groups)*10+1.4*Math.sin((frame+i)*.07),0,0]}).unwrap();
    // Moving authored regions invalidates compiled transforms in the same cache.
    if(moving>0)for(let i=0;i<Math.floor(regions*moving);i++)world.set(regionEntities[i]!,Transform,{pos:[Math.floor(i/overlap)*10,.1*Math.sin(frame*.05),0]}).unwrap();
    if(moving>0)world.set(listener,Transform,{pos:[1.4*Math.sin(frame*.07),0,0]}).unwrap();
    const poseUpdateMs=performance.now()-startMove;bytes=acoustic=audioMs=hostMs=worldMs=0;const start=performance.now();app.stepFrame(1/60).unwrap();const appUpdateMs=performance.now()-start,ms=poseUpdateMs+appUpdateMs;
    await wait(()=>app.execution.report().frame.completed>completed);
    const completionMs=performance.now()-start;
    if(frame>=64){samples.push(ms);rawAppUpdateMs.push(appUpdateMs);rawCompletionMs.push(completionMs);rawAudioMs.push(audioMs);rawHostMs.push(hostMs);rawWorldMs.push(worldMs);rawPoseUpdateMs.push(poseUpdateMs);rawBytes.push(bytes);rawIntents.push(acoustic);maxBatch=Math.max(maxBatch,bytes);peakHeap=Math.max(peakHeap,heap()??0);
      check(resources().created===beforeNodes,`native node allocation in warm movement ${round}/${count}/${regions}/${overlap}/${moving}/${enabled}`);}
  }
  const active=consumer.state(),peakResources=resources(),completed=app.execution.report().frame.completed;
  for(const entity of [...entities,...regionEntities,listener])world.despawn(entity).unwrap();app.assets!.release(shared).unwrap();app.stepFrame(1/60).unwrap();const stopped=consumer.state();await app.dispose();consumer.dispose();await context.close();const afterResources=resources();resources.releaseObserver();(globalThis as any).gc?.();canvas.remove();
  const result={round,count,regions,overlap,moving,enabled,startup:{contextMs,appMs,scenePlayMs:coldMs},coldMs,initialUpdate,completed,samples,summary:summary(samples),frameCpuMethod:'controlled source/region/listener pose writes plus synchronous App.stepFrame; completion wait reported separately',rawAppUpdateMs,appUpdateSummary:summary(rawAppUpdateMs),rawCompletionMs,completionSummary:summary(rawCompletionMs),rawAudioMs,audioSummary:summary(rawAudioMs),rawHostMs,hostSummary:summary(rawHostMs),rawWorldMs,worldSummary:summary(rawWorldMs),rawPoseUpdateMs,rawBytes,rawIntents,maxBatch,
    cache:{encodedBytes:clip.bytes?.byteLength,decodedBytes,decodeCalls,pendingAdmissionHighWater,pendingAdmissionAfterStop:awaitingAdmission.size},publicationBytes:'UTF-8 JSON size of each actual emitted POD intent; not a native Worker wire-byte measurement',heap:{before:beforeHeap,peak:peakHeap,afterObserverRelease:heap()},native:{peak:peakResources,after:afterResources},host:{active,stopped},errors};
  check(decodeCalls===1,'one decoded shared clip per Host');check(errors.length===0,'cost App errors');check(completed>=305,'cost completed frames');check(coldMs<=250,`cold preparation ${coldMs} ms`);check(result.audioSummary.p95<=8,`Audio p95 ${result.audioSummary.p95} ms`);check(result.summary.p95<=16.67&&result.worldSummary.p95<=16.67,`full App/World p95 ${result.summary.p95}/${result.worldSummary.p95} ms`);
  check(maxBatch<=262144,`batch ${maxBatch} bytes`);check(peakResources.created<=17000,'native nodes budget');check(stopped.activeSourceCount===0&&afterResources.connections===0&&awaitingAdmission.size===0,'cost lifecycle release');if(moving===0)check(rawIntents.every(n=>n===0),'stationary acoustic intents');return result;
}
function draw(signals:any[],rows:any[]) {
  for(const id of ['path','signal','spectrum','perf']){const canvas=document.querySelector(`#${id}`) as HTMLCanvasElement,context=canvas.getContext('2d')!;context.clearRect(0,0,canvas.width,canvas.height);context.font='15px system-ui';}
  const path=(document.querySelector('#path') as HTMLCanvasElement).getContext('2d')!;path.fillStyle='#b1c5da';path.fillText('Source/listener path and independent room weight',15,20);for(const [index,color] of [[0,'#70d8ff'],[1,'#f6c970']] as const){path.strokeStyle=color;path.beginPath();(signals[0]?.timeline??[]).forEach((p:any,i:number)=>{const x=20+p.time/3*1260,y=index?150-p.weight*90:150-p.x*30;i?path.lineTo(x,y):path.moveTo(x,y);});path.stroke();}
  const canvas=(document.querySelector('#signal') as HTMLCanvasElement).getContext('2d')!;for(const [i,s]of signals.slice(0,4).entries()){canvas.fillStyle='#b1c5da';canvas.fillText(`${s.mode}: PCM error ${s.error.max.toExponential(2)}`,15,20+i*58);canvas.strokeStyle=['#70d8ff','#ff927b','#f6c970','#78d9ab'][i]!;canvas.beginPath();for(let n=0;n<s.samples[0].length;n+=60){const x=20+n/s.samples[0].length*1260,y=42+i*58-s.samples[0][n]*90;n?canvas.lineTo(x,y):canvas.moveTo(x,y);}canvas.stroke();}
  const spectrum=(document.querySelector('#spectrum') as HTMLCanvasElement).getContext('2d')!;spectrum.fillStyle='#b1c5da';spectrum.fillText('Native tail spectrum · enabled vs regions off (dB, 0–2000 Hz)',15,20);
  for(const [index,color]of [[0,'#70d8ff'],[1,'#ff927b']] as const){const samples=signals[index]?.samples[0];if(!samples)continue;spectrum.strokeStyle=color;spectrum.beginPath();for(let f=0;f<=2000;f+=10){let real=0,imag=0;for(let n=0;n<4096;n++){const sample=(samples[74400+n]??0)*(.5-.5*Math.cos(2*Math.PI*n/4095));real+=sample*Math.cos(2*Math.PI*f*n/48000);imag-=sample*Math.sin(2*Math.PI*f*n/48000);}const db=20*Math.log10(Math.max(1e-8,Math.hypot(real,imag)/4096));const x=20+f/2000*1260,y=180-Math.max(0,db+120);f?spectrum.lineTo(x,y):spectrum.moveTo(x,y);}spectrum.stroke();}
  const perf=(document.querySelector('#perf') as HTMLCanvasElement).getContext('2d')!;perf.fillStyle='#b1c5da';perf.fillText('Every scaled App workload · p95 ms (three rounds); 16.67 ms limit',15,20);perf.strokeStyle='#ff927b';perf.beginPath();perf.moveTo(20,33);perf.lineTo(1280,33);perf.stroke();
  for(const [i,row]of rows.entries()){perf.fillStyle=row.enabled?'#70d8ff':'#78d9ab';perf.fillRect(20+i/Math.max(1,rows.length-1)*1260,200-Math.min(18,row.summary.p95)*10,3,3);}
  document.querySelector('#results')!.innerHTML=rows.length?`<table><tr><th>Native World workloads (3 rounds)</th><th>CPU p50 ms</th><th>CPU p95 ms</th><th>Native nodes high</th><th>Publication bytes high</th></tr>${[false,true].map(enabled=>{const selected=rows.filter(r=>r.enabled===enabled);return`<tr><td>${enabled?'Regions enabled':'Matched regions off'}</td><td>${selected.length?Math.max(...selected.map(r=>r.summary.p50)).toFixed(3):'Not measured'}</td><td>${selected.length?Math.max(...selected.map(r=>r.summary.p95)).toFixed(3):'Not measured'}</td><td>${selected.length?Math.max(...selected.map(r=>r.native.peak.created)):'Not measured'}</td><td>${selected.length?Math.max(...selected.map(r=>r.maxBatch)):'Not measured'}</td></tr>`;}).join('')}</table>`:'Performance not measured; a separate quiet-window owner is required.';
}
(globalThis as any).__acousticEvidence={async run(){
  const phase=(globalThis as any).__acousticPhase??'all';
  if(phase==='perf'&&import.meta.env.FORGEAX_ENGINE_RHI_DEBUG==='1')
    throw new Error('prepare the separate performance site with FORGEAX_AUDIO_RHI_CAPTURE=0 before quiet admission');
  const asset=await assetApp();await checkpoint('public-app',asset.result);const signals=[];if(phase!=='perf')for(let round=0;round<3;round++)for(const mode of ['enabled','off','zero-wet','send-off'] as const){
    const s=await signal(asset.clip,mode);signals.push(s);draw(signals,[]);await checkpoint(`pcm-${round}-${mode}`,{round,mode:s.mode,timeline:s.timeline,intents:s.intents,error:s.error,resources:s.resources,rawSamples:s.samples.map(c=>[...c]),oracle:s.expected.map(c=>[...c]),audioFiles:{[`${round}-${mode}.wav`]:wav(s.samples),[`${round}-${mode}-oracle.wav`]:wav(s.expected)}});}
  const energy=(samples:Float32Array)=>{let sum=0;for(let n=74400;n<81600;n++)sum+=(samples[n]??0)**2;return sum/7200;};
  const tail=signals.map(s=>({mode:s.mode,energy:energy(s.samples[0]!)}));
  for(let round=0;round<3&&tail.length;round++){const wetEnergy=tail[round*4]!.energy;for(const negative of tail.slice(round*4+1,round*4+4))check(10*Math.log10(wetEnergy/Math.max(1e-20,negative.energy))>20,`${negative.mode} wet-tail falsifier failed`);}
  const selection=phase==='perf'?undefined:await selectionSignal(asset.clip);if(selection)await checkpoint('selection',selection);
  const workers=[];if(phase!=='perf')for(const shared of [false,true]){const worker=await workerApp(asset.result.guid,shared,asset.clip);workers.push(worker);await checkpoint(`app-worker-${shared?'shared':'serial'}`,{...worker,slices:worker.slices.map(s=>({...s,channels:s.channels.map(c=>[...c])})),audioFiles:Object.fromEntries(worker.slices.map(s=>[`worker-${shared?'shared':'serial'}-${s.name}.wav`,wav(s.channels)]))});}
  const rows=[];if(phase!=='native')for(let round=0;round<3;round++)for(const count of [32,256])for(const regions of [1,32,128])for(const overlap of [1,Math.min(8,regions),regions])for(const moving of [0,.5,1])for(const enabled of round%2?[true,false]:[false,true]){const row=await cost(asset.clip,round,count,regions,overlap,moving,enabled);rows.push(row);await checkpoint(`cost-${rows.length}`,row);}
  for(const [index,s] of signals.entries()){const audio=document.createElement('audio');audio.controls=true;audio.src=URL.createObjectURL(new Blob([new Uint8Array(wav(s.samples))],{type:'audio/wav'}));document.querySelector('#audio')!.append(`Round ${Math.floor(index/4)+1}/${s.mode}: `,audio);}
  // Awaited checkpoints already retain every float sample, oracle, intent and
  // WAV. Reference them here instead of serializing the same raw arrays and
  // encoded clips through the browser/Node boundary a second time.
  draw(signals,rows);const report={phase,status:failures.length?'fail':'pass',failures:[...new Set(failures)],userAgent:navigator.userAgent,asset:asset.result,
    selection:selection?{events:selection.events,error:selection.error,resources:selection.resources,checkpoint:'selection.json'}:undefined,
    workers:workers.map(({slices,...facts})=>({...facts,checkpoint:`app-worker-${facts.shared?'shared':'serial'}.json`,slices:slices.map(({name})=>({name,audio:`worker-${facts.shared?'shared':'serial'}-${name}.wav`}))})),
    tail,signals:signals.map(({mode,timeline,error,resources},index)=>({round:Math.floor(index/4),mode,timeline,error,resources,checkpoint:`pcm-${Math.floor(index/4)}-${mode}.json`})),rows,audioFiles:{}};
  document.querySelector('#report')!.textContent=JSON.stringify({status:report.status,failures:report.failures,App:asset.result.summary,rows:rows.length},null,2);return report;
}};
