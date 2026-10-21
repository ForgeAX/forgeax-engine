import { Update } from '@forgeax/engine-ecs';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { ok } from '@forgeax/engine-types';
import { createAssetAdapter } from 'managed-assets-adapter';
import { dimensions } from './cases.mjs';
import { gpuCounters } from './gpu-counters.mjs';
import { observeBenchmarkReceipt } from './receipt-observation.mjs';
import { createWorkload } from './workload.mjs';

export default function bootstrap(config) {
  const counters = config.diagnostic ? gpuCounters() : undefined, channel = new BroadcastChannel(config.channel);
  const samples = [], acknowledgments = [], errors = [], sourceSamples = [];
  let step = 0, assetCpuMs, worldCpuMs, running = false, phase = 'warmup', commitMs = 0;
  let sourceStats, sourceFrame, port, updateCount = config.diagnostic ? 0 : undefined;
  let completedWindow;
  const fail = error => {
    const detail = error instanceof Error ? error.stack : JSON.stringify(error, (_key, value) => typeof value === 'bigint' ? String(value) : value);
    errors.push(detail);
    channel.postMessage({ kind: 'benchmark-error', error: detail });
  };
  const feature = {
    identity: 'managed-assets.benchmark',
    extract() { return ok({ step, phase, assetCpuMs, worldCpuMs, commitMs, sourceStats, updateCount }); },
    plan(frame) { sourceFrame = frame; return ok({ work: [{ scope: 'frame', resources: [], passes: [] }], sourceFeedback: { step: frame.step, phase: frame.phase } }); },
    onSourceFrameSubmitted(frame, feedback) {
      if (frame.step !== feedback.step || frame.phase !== feedback.phase) throw new Error('Asset source acknowledgment mismatch');
      if (frame.phase === 'measure' && acknowledgments.length < 2048) acknowledgments.push({ step: frame.step, commitToAckMs: config.diagnostic ? performance.now() - frame.commitMs : undefined, sourceStats: frame.sourceStats });
      else if (frame.phase.startsWith('probe:')) port?.postMessage({ kind: 'probe-ready', phase: frame.phase, step: frame.step, sourceStats: frame.sourceStats });
      else if (frame.phase === 'settled') port?.postMessage({ kind: 'settled-ready', step: frame.step, sourceStats: frame.sourceStats });
    },
  };
  return {
    features: [feature],
    configureRenderer(renderer) {
      const draw = renderer.draw.bind(renderer), pending = new Set();
      // Capture only small actual device/profile facts before scene warmup.
      const { profile, capabilities, limits } = renderer.inspect();
      const initialInspection = { profile, capabilities, limits };
      const sourceFrameIds = new Map();
      globalThis.addEventListener('message', event => {
        if (event.data?.kind === 'draw' && event.data.publication) {
          sourceFrameIds.set(event.data.publication.revision, event.data.frameId);
          while (sourceFrameIds.size > 16) sourceFrameIds.delete(sourceFrameIds.keys().next().value);
        }
      }, { capture: true });
      let collecting = false, inspectionBefore, timingPreflight;
      renderer.subscribe(event => { if (event.kind === 'error') fail(event.error); });
      renderer.draw = request => {
        const started = config.diagnostic ? performance.now() : undefined, drawn = draw(request), cpuDrawMs = started === undefined ? undefined : performance.now() - started;
        if (!drawn.ok) { fail(drawn.error); return drawn; }
        const receipt = drawn.value, frame = sourceFrame;
        if (!config.diagnostic && timingPreflight === undefined && receipt.presentation === 'ready') {
          // One real preflight during warmup proves that omitted timing options
          // stayed omitted. No observer is added to the measured window.
          timingPreflight = renderer.observe(receipt, { include: ['timings'] }).then(observed => {
            if (!observed.ok) throw observed.error;
            const timings = observed.value.timings;
            if (timings?.status !== 'unavailable' || timings.reason?.code !== 'gpu-timing-not-enabled')
              throw new Error('Completion carrier unexpectedly enabled GPU timestamps');
            channel.postMessage({ kind: 'completion-preflight', frameId: receipt.frameId, status: timings.status, code: timings.reason.code });
          }).catch(fail);
        }
        if (frame?.phase !== 'measure' || receipt.presentation !== 'ready' || samples.length + pending.size >= dimensions.measuredFrames) return drawn;
        if (!collecting) throw new Error('Renderer window must begin before source writes');
        const gpu = counters?.snapshot();
        const task = observeBenchmarkReceipt(renderer, receipt, config.diagnostic).then(timingObservation => {
          const timing = timingObservation?.frame;
          const coverage = timing === undefined ? undefined : summarizeGpuPassTimingIntervals(timing.passes, timing.timestampPeriodNanoseconds).unwrap();
          const hostFrameId = request.publication ? sourceFrameIds.get(request.publication.revision) : receipt.frameId;
          if (request.publication) sourceFrameIds.delete(request.publication.revision);
          if (hostFrameId === undefined) throw new Error(`Missing native publication-to-Host frame mapping: ${JSON.stringify({revision:request.publication?.revision,pending:[...sourceFrameIds],updateCount:frame.updateCount,receiptFrame:receipt.frameId})}`);
          samples.push({ step: frame.step, updateCount: frame.updateCount, frameId: receipt.frameId, hostFrameId, deviceGeneration: receipt.deviceGeneration, assetCpuMs: frame.assetCpuMs, worldCpuMs: frame.worldCpuMs, cpuDrawMs, submitToObservedWallMs: started === undefined ? undefined : performance.now() - started, gpuPassEnvelopeMs: coverage === undefined ? undefined : coverage.envelopeNanoseconds / 1e6, gpuTiming: timingObservation, sourceStats: frame.sourceStats, gpu });
          if (samples.length % 60 === 0) channel.postMessage({ kind: 'benchmark-progress', samples: samples.length, pending: pending.size, step: frame.step });
        }).catch(fail).finally(() => {
          pending.delete(task);
          if (samples.length === dimensions.measuredFrames && !completedWindow) {
            completedWindow = true;
            channel.postMessage({ kind: 'renderer-window-complete', hostFrameIds: samples.map(sample => sample.hostFrameId) });
          }
        });
        pending.add(task); return drawn;
      };
      channel.addEventListener('message', event => {
        if (event.data.kind === 'read-window') {
          if (!completedWindow) throw new Error('Renderer results requested before completion');
          channel.postMessage({ kind: 'renderer-window', samples, errors, before: inspectionBefore, after: config.diagnostic ? renderer.inspect() : undefined, gpu: counters?.snapshot(), profile: inspectionBefore.profile });
        }
        if (event.data.kind === 'begin-window') {
        if (pending.size) throw new Error('Previous benchmark window still has pending observations');
        samples.length = 0; errors.length = 0; completedWindow = false;
        counters?.reset(); inspectionBefore = config.diagnostic ? renderer.inspect() : initialInspection; collecting = true; channel.postMessage({kind:'renderer-window-ready'});
      } });
      const dispose = renderer.dispose.bind(renderer);
      renderer.dispose = () => { channel.close(); return dispose(); };
    },
    plugins: [{ name: 'managed-assets.benchmark-source', inject: ['world', 'assets', 'executionBootstrapHost'], apply(ctx) {
      const world = ctx.world, adapter = createAssetAdapter(world, ctx.assets), workload = createWorkload(world, adapter, config);
      const update = world.update.bind(world);
      let updateStarted = 0, updateFinished = 0;
      if (config.diagnostic) world.update = (...args) => { updateStarted = performance.now(); const result = update(...args); updateFinished = performance.now(); worldCpuMs = updateFinished - updateStarted; updateCount++; return result; };
      if(config.diagnostic && typeof document==='undefined'){
        const post=globalThis.postMessage;
        globalThis.postMessage=function(message,...rest){
          if(message?.kind==='simulation-complete'&&phase==='measure'&&sourceSamples.length<2048){
            const now=performance.now();
            sourceSamples.push({step,updateCount,frameId:message.frameId,assetCpuMs,worldCpuMs,sourceTaskCpuMs:now-updateStarted,sourcePublicationCpuMs:now-updateFinished});
          }
          return post.call(this,message,...rest);
        };
      }
      const write = (next, force = false) => {
        const started = config.diagnostic ? performance.now() : undefined; workload.write(next, force); assetCpuMs = started === undefined ? undefined : performance.now() - started;
        commitMs = config.diagnostic ? performance.now() : undefined; sourceStats = {...workload.state(), transport: counters?.snapshot()}; step = next;
      };
      let warmupWrites = 0;
      world.addSystem(Update, { name: 'managed-assets.benchmark-writer', queries: [], fn() {
        if (phase === 'warmup' && config.writes && warmupWrites < dimensions.warmupFrames) {
          write(step + 1); warmupWrites++;
        } else if (running) write(step + 1);
      } }).unwrap();
      sourceStats = workload.state();
      port = ctx.executionBootstrapHost.port;
      port.onmessage = event => {
        if (event.data === 'run') { step = 0; counters?.reset(); running = true; phase = 'measure'; acknowledgments.length = 0; sourceSamples.length = 0; port.postMessage({ kind: 'running' }); }
        else if (event.data === 'stop') { running = false; phase = 'settled'; port.postMessage({ kind: 'source-result', step, sourceStats, warmupWrites, acknowledgments, samples:sourceSamples, transport:counters?.snapshot() }); }
        else if (event.data?.kind === 'probe') { running = false; phase = `probe:${event.data.value}`; write(event.data.value, true); }
      };
      port.start();
      return () => { world.removeSystem(Update, 'managed-assets.benchmark-writer').unwrap(); channel.close(); };
    } }],
  };
}
