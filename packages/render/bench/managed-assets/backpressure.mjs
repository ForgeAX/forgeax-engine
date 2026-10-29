import { World } from '@forgeax/engine-ecs';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, createRenderPublisher, renderPublicationAssetTransfers, renderPublicationTransfers } from '@forgeax/engine-render';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { createRenderer } from '@forgeax/engine-runtime';
import { createPublicationAssets } from '@forgeax/engine-runtime/internal/renderer-host';
import { registerPropagateTransforms } from '@forgeax/engine-scene';
import { createAssetAdapter } from 'managed-assets-adapter';
import { createWorkload } from './workload.mjs';
import { gpuCounters } from './gpu-counters.mjs';
import { dimensions } from './cases.mjs';
import { backpressureFeature } from './backpressure-feature.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,Math.max(0,ms)));
export async function createBackpressureBenchmark(canvas,config,mode){
  const manifest=new URL('/shaders/manifest.json',location.href).href;
  const assets=await createPublicationAssets({shaderManifestUrl:manifest}),world=new World({assets});
  registerPropagateTransforms(world);
  for(const component of [Camera,DirectionalLight,MeshFilter,MeshRenderer])world.components.register(component).unwrap();
  const adapter=createAssetAdapter(world,assets),workload=createWorkload(world,adapter,config),consumers=[],counters=gpuCounters();
  let lastUpdate=performance.now(),step=0,commitMs=0,running=false,producerTimer,producerError;
  for(let i=0;i<config.renderers;i++){
    const target=i===0?canvas:document.createElement('canvas');target.width=dimensions.width;target.height=dimensions.height;if(i)document.body.append(target);
    if(mode==='worker'){
      const worker=new Worker(new URL('./backpressure-consumer.mjs',import.meta.url),{type:'module'});
      const request=(data,transfer=[])=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(`Backpressure Worker timed out: ${data.kind}`)),60000);
        worker.onmessage=event=>{clearTimeout(timer);event.data.kind==='error'?reject(new Error(event.data.message)):resolve(event.data);};
        worker.onerror=error=>{clearTimeout(timer);reject(error);};worker.postMessage(data,transfer);
      });
      const identity={source:`managed-backpressure-${i}`,epoch:1},offscreen=target.transferControlToOffscreen();
      const ready=await request({kind:'init',canvas:offscreen,identity,manifest},[offscreen]);
      let adopted;
      const feature=backpressureFeature(()=>({step,commitMs,state:workload.state()}),feedback=>{adopted=feedback;});
      const publisher=createRenderPublisher(world,assets,identity,ready.inspection.capabilities,[feature]);
      consumers.push({initial:ready.inspection,async reset(){await request({kind:'reset'});},async draw(measure){
        const start=performance.now(),candidate=publisher.prepare(performance.now()/1000).unwrap(),preparationCpuMs=performance.now()-start;
        const columns=renderPublicationTransfers(candidate.message),assetBuffers=renderPublicationAssetTransfers(candidate.message);
        const transferBytes=[...columns,...assetBuffers].reduce((sum,buffer)=>sum+buffer.byteLength,0);
        const pending=request({kind:'draw',packet:candidate.message,measure},[...columns,...assetBuffers]);candidate.accept();
        const result=await pending;publisher.acknowledgeFeatures(result.revision,result.features).unwrap();publisher.recycle(result.revision,result.buffers).unwrap();
        return {...result,buffers:undefined,features:undefined,preparationCpuMs,transferBytes,adopted};
      },async dispose(){publisher.dispose();await request({kind:'dispose'});worker.terminate();}});
    }else{
      let adopted;
      const feature=backpressureFeature(()=>({step,commitMs,state:workload.state()}),feedback=>{adopted=feedback;});
      const renderer=(await createRenderer(target,{gpuPassTiming:{retentionFrames:8},features:[feature]},{shaderManifestUrl:manifest})).unwrap(),lease=renderer.attach(world).unwrap();
      consumers.push({initial:renderer.inspect(),async reset(){counters.reset();},async draw(measure){
        const start=performance.now(),receipt=renderer.draw({leases:[lease],camera:{lease},environment:{lease}}).unwrap(),cpuDrawMs=performance.now()-start;
        const complete=await receipt.completed;if(!complete.ok)throw complete.error;
        let gpuTiming,gpuPassEnvelopeMs;
        if(measure&&receipt.presentation==='ready'){
          const observation=(await renderer.observe(receipt,{include:['timings']})).unwrap();if(observation.timings?.status!=='complete')throw new Error('Missing physical GPU timestamp');
          gpuTiming=observation.timings;gpuPassEnvelopeMs=summarizeGpuPassTimingIntervals(gpuTiming.frame.passes,gpuTiming.frame.timestampPeriodNanoseconds).unwrap().envelopeNanoseconds/1e6;
        }
        return {frameId:receipt.frameId,presentation:receipt.presentation,cpuDrawMs,submitToObservedWallMs:performance.now()-start,gpuTiming,gpuPassEnvelopeMs,gpu:counters.snapshot(),adopted};
      },async dispose(){(await renderer.dispose()).unwrap();}});
    }
  }
  const producers=[];
  let drawing=Promise.resolve([]);
  const update=()=>{const now=performance.now();world.update((now-lastUpdate)/1000).unwrap();lastUpdate=now;};
  const draw=async measure=>{update();drawing=Promise.all(consumers.map(consumer=>consumer.draw(measure)));return drawing;};
  const pauseConsumers=async()=>{
    running=false;clearTimeout(producerTimer);
    const frames=await drawing;
    return {carrier:'native-renderer-consumers',sourceStep:step,completedFrames:frames.map(frame=>({frameId:frame.frameId,presentation:frame.presentation}))};
  };
  const ready=async count=>{let completed=0;for(let attempts=0;completed<count;attempts++){if(attempts>count+300)throw new Error('Backpressure warmup readiness failed');const frames=await draw(false);if(frames.every(frame=>frame.presentation==='ready'))completed++;}};
  for(let i=0;i<dimensions.warmupFrames;i++){workload.write(++step);await draw(false);}
  await ready(dimensions.warmupFrames);
  return {config,mode,execution:{carrier:'native-renderer-consumers',placement:mode==='worker'?'host-world/render-workers':'host-world/local-renderers',renderers:config.renderers,actualProfiles:consumers.map(consumer=>consumer.initial.profile)},
    pause:pauseConsumers,
    async probe(value){workload.write(value,true);await ready(8);return{value,sourceStats:workload.state()};},
    async run(){
      const samples=[],frameTimes=[],start=performance.now();let target=start;producers.length=0;step=0;producerError=undefined;
      const acknowledged=consumers.map(()=>0);
      await Promise.all(consumers.map(consumer=>consumer.reset()));
      running=true;
      const produce=()=>{if(!running)return;try{const began=performance.now();workload.write(++step);commitMs=performance.now();producers.push({step,atMs:commitMs-start,assetCpuMs:commitMs-began,state:workload.state()});target+=1000/config.producerHz;producerTimer=setTimeout(produce,Math.max(0,target-performance.now()));}catch(error){producerError=error;running=false;}};produce();
      let next=start,completed=0,pause;
      try {
      while(completed<dimensions.measuredFrames){
        if(producerError)throw producerError;
        if(completed===100&&pause===undefined){const began=performance.now(),before=workload.state();await sleep(config.pauseMs);pause={startedMs:began-start,elapsedMs:performance.now()-began,before,after:workload.state()};next=performance.now();}
        await sleep(next-performance.now());next+=1000/config.consumerHz;
        const capturedStep=step,capturedCommit=commitMs,capturedState=workload.state(),frames=await draw(true),now=performance.now();
        if(!frames.every(frame=>frame.presentation==='ready'))throw new Error('Warmed consumer became pending during ordinary value edits');
        for(let consumer=0;consumer<frames.length;consumer++){
          const frame=frames[consumer];
          if(frame.adopted?.step!==capturedStep||frame.adopted.state.version!==capturedState.version)throw new Error('Consumer did not acknowledge captured asset version');
          const oldest=producers[acknowledged[consumer]];
          samples.push({...frame,consumer,cycle:completed,step:capturedStep,sourceStats:capturedState,commitToAckMs:now-capturedCommit,oldestPendingAgeMs:oldest?now-start-oldest.atMs:0,coalescedSteps:Math.max(0,capturedStep-acknowledged[consumer]-1)});
          acknowledged[consumer]=capturedStep;
        }
        frameTimes.push({frameId:completed,hostMs:now-start});completed++;
      }
      } finally {running=false;clearTimeout(producerTimer);}
      running=false;clearTimeout(producerTimer);const final=workload.state();await ready(8);
      const finalFrames=await draw(false);
      for(const frame of finalFrames)if(frame.adopted?.step!==step||frame.adopted.state.version!==final.version)throw new Error('Final backpressure state was not adopted');
      const measured={config,mode,dimensions,samples,frameTimes,source:{step,final,producerSamples:producers},pause,hostRoundTripMs:performance.now()-start,completedPerConsumer:completed,finalState:workload.state(),finalAdopted:finalFrames.map(frame=>frame.adopted)};
      return {...measured,quiescence:await pauseConsumers()};
    },
    async dispose(){running=false;clearTimeout(producerTimer);for(const consumer of consumers)await consumer.dispose();adapter.dispose();},
  };
}
