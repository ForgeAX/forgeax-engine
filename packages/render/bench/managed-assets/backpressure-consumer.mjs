import { createRenderer } from '@forgeax/engine-runtime';
import { renderPublicationTransfers } from '@forgeax/engine-render';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { gpuCounters } from './gpu-counters.mjs';
import { backpressureFeature } from './backpressure-feature.mjs';
const counters = gpuCounters();
let renderer;
self.onmessage = async ({data}) => {
  try {
    if (data.kind === 'init') {
      renderer = (await createRenderer(data.canvas, {publicationSource:data.identity,gpuPassTiming:{retentionFrames:8},features:[backpressureFeature()]}, {shaderManifestUrl:data.manifest})).unwrap();
      self.postMessage({kind:'ready',inspection:renderer.inspect()}); return;
    }
    if (data.kind === 'reset') { counters.reset(); self.postMessage({kind:'reset'}); return; }
    if (data.kind === 'dispose') { (await renderer.dispose()).unwrap(); self.postMessage({kind:'disposed',gpu:counters.snapshot()}); return; }
    const features=[];
    const started = performance.now(), receipt = renderer.draw({publication:data.packet,onFeatureSourceSubmitted:(identity,feedback)=>features.push({identity,feedback})}).unwrap(), cpuDrawMs = performance.now()-started;
    const completed = await receipt.completed;
    if (!completed.ok) throw completed.error;
    let gpuTiming, gpuPassEnvelopeMs;
    if (receipt.presentation === 'ready' && data.measure) {
      const observation = (await renderer.observe(receipt,{include:['timings']})).unwrap();
      if (observation.timings?.status !== 'complete') throw new Error('Missing physical GPU timestamp');
      gpuTiming=observation.timings;
      gpuPassEnvelopeMs=summarizeGpuPassTimingIntervals(gpuTiming.frame.passes,gpuTiming.frame.timestampPeriodNanoseconds).unwrap().envelopeNanoseconds/1e6;
    }
    const buffers = renderPublicationTransfers(data.packet);
    self.postMessage({kind:'drawn',revision:data.packet.revision,frameId:receipt.frameId,presentation:receipt.presentation,cpuDrawMs,submitToObservedWallMs:performance.now()-started,gpuTiming,gpuPassEnvelopeMs,gpu:counters.snapshot(),buffers,features},buffers);
  } catch(error) { self.postMessage({kind:'error',message:String(error?.stack??error)}); }
};
