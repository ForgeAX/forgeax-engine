import { createApp } from '@forgeax/engine-app/browser';
import { cases, dimensions } from './cases.mjs';
import { gpuCounters } from './gpu-counters.mjs';
const diagnostic = __MANAGED_ASSETS_GPU_DIAGNOSTIC__;
const counters = diagnostic ? gpuCounters() : undefined;
const query = new URL(location.href).searchParams;
const config = cases.find(item => item.id === query.get('case'));
if (!config) throw new Error('Unknown fixed asset benchmark case');
const mode = query.get('mode') ?? 'default';
const channelName = `managed-assets-${crypto.randomUUID()}`;
const broadcast = new BroadcastChannel(channelName), message = new MessageChannel();
const canvas = document.createElement('canvas'); canvas.width = dimensions.width; canvas.height = dimensions.height; document.body.append(canvas);
const failures = [];
globalThis.assetBenchmarkProgress = { stage: 'startup' };
broadcast.addEventListener('message', event => {
  if (event.data.kind === 'benchmark-error') failures.push(event.data.error);
  if (event.data.kind === 'benchmark-progress') globalThis.assetBenchmarkProgress = event.data;
});
let readyFrames = 0;
canvas.addEventListener('forgeax:frame-completed', event => { if (event.detail.presentation === 'ready') readyFrames++; });
const wait = async predicate => { const started = performance.now(); while (!predicate()) { if (failures.length) throw new Error(JSON.stringify(failures)); if (performance.now() - started > 240000) throw new Error('Benchmark wait timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } };
const nextMessage = (target, kind) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { target.removeEventListener('message', receive); reject(new Error(`Timed out waiting for ${kind}`)); }, 1800000);
  const receive = event => { if (event.data.kind === 'benchmark-error' || event.data.kind === kind) { clearTimeout(timer); target.removeEventListener('message', receive); event.data.kind === 'benchmark-error' ? reject(new Error(event.data.error)) : resolve(event.data); } };
  target.addEventListener('message', receive); target.start?.();
});
try {
  if (config.kind === 'backpressure') {
    if (!diagnostic) throw new Error('Backpressure uses its explicit GPU diagnostic carrier; completion-only admission is not qualified');
    const {createBackpressureBenchmark}=await import('./backpressure.mjs');
    globalThis.assetBenchmark=await createBackpressureBenchmark(canvas,config,mode);
  } else {
  const completionPreflight = diagnostic ? undefined : nextMessage(broadcast, 'completion-preflight');
  const app = (await createApp(canvas, { execution: { ...(mode === 'worker' ? { workers: { engine: true, render: true } } : {}), bootstrap: new URL('./bootstrap.js', import.meta.url), bootstrapData: { ...config, channel: channelName, diagnostic }, bootstrapPort: message.port2, ...(diagnostic ? { diagnostics: { gpuPassTiming: { retentionFrames: 8 } } } : {}), startupTimeoutMs: 240000 } }, { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href })).unwrap();
  app.onError(error => failures.push(error)); app.start().unwrap();
  await wait(() => readyFrames >= dimensions.warmupFrames || failures.length > 0);
  if (failures.length) throw new Error(JSON.stringify(failures));
  const preflight = await completionPreflight;
  let paused;
  const pause = async () => {
    if (!paused) {
      app.pause().unwrap();
      // The split Host's FrameCreditLedger issues one monotonically numbered
      // source frame per submitted credit. Simulation completion may precede
      // Render completion, so both native owners must retire that final frame.
      const sourceFrameId = app.execution.report().frame.submitted;
      paused = wait(() => {
        const report = app.execution.report();
        return report.frame.inFlight === 0 &&
          (!report.render || report.render.completedFrame >= sourceFrameId);
      }).then(() => sourceFrameId);
    }
    return { sourceFrameId: await paused, execution: app.execution.report(), readyFrames };
  };
  let prepared = false;
  const prepareWindow = async () => {
    if (prepared) return;
    const ready = nextMessage(broadcast, 'renderer-window-ready');
    broadcast.postMessage({ kind: 'begin-window' });
    await ready;
    prepared = true;
  };
  globalThis.assetBenchmark = {
    phase: 'warmed', config, mode, execution: app.execution.report(), readyFrames,
    pause,
    prepareWindow,
    async probe(value) {
      const response = nextMessage(message.port1, 'probe-ready');
      message.port1.postMessage({ kind: 'probe', value }); const adopted = await response;
      const before = readyFrames; await wait(() => readyFrames >= before + dimensions.warmupFrames);
      if (failures.length) throw new Error(JSON.stringify(failures));
      return { value, readyFrames, adopted };
    },
    async run() {
      globalThis.assetBenchmarkProgress = { stage: 'begin-window' };
      await prepareWindow();
      const window = nextMessage(broadcast, 'renderer-window');
      const completedWindow = nextMessage(broadcast, 'renderer-window-complete');
      counters?.reset();
      const hostStart = performance.now(), frameTimes = [];
      const completed = event => { if (event.detail.presentation === 'ready') {
        const now=performance.now(),started=counters?.frameStarted(event.detail.frameId);
        frameTimes.push({ hostMs: now - hostStart, frameId: event.detail.frameId, ...(started===undefined?{}:{wholeFrameMs:now-started}) });
      } };
      canvas.addEventListener('forgeax:frame-completed', completed);
      globalThis.assetBenchmarkDiagnosticWindow?.begin();
      message.port1.postMessage('run');
      const completedIds = new Set((await completedWindow).hostFrameIds);
      await wait(() => frameTimes.filter(frame => completedIds.has(frame.frameId)).length >= dimensions.measuredFrames);
      globalThis.assetBenchmarkDiagnosticWindow?.end();
      broadcast.postMessage({ kind: 'read-window' });
      const result = await window;
      const settledReady = nextMessage(message.port1, 'settled-ready');
      const sourceResult = nextMessage(message.port1, 'source-result'); message.port1.postMessage('stop'); const source = await sourceResult;
      const ids = new Set(result.samples.map(sample => sample.hostFrameId));
      globalThis.assetBenchmarkProgress = { stage: 'host-completions', samples: result.samples.length, hostFrames: frameTimes.length, firstHostId: frameTimes[0]?.frameId, firstSampleId: result.samples[0]?.hostFrameId };
      await wait(() => frameTimes.filter(frame => ids.has(frame.frameId)).length >= dimensions.measuredFrames);
      canvas.removeEventListener('forgeax:frame-completed', completed);
      const settled = await settledReady;
      if (settled.step !== source.step || settled.sourceStats.version !== source.sourceStats.version) throw new Error('Final asset source acknowledgment does not match committed version');
      if (config.kind === 'transform') {
        if (settled.sourceStats.authoredWrites !== source.sourceStats.authoredWrites) throw new Error('Final Transform acknowledgment differs from authored writes');
        let offset, previous = -1;
        for (const sample of result.samples) {
          const stats = sample.sourceStats;
          if (stats.liveEntities !== config.count || stats.changedPerWrite !== config.writes || stats.sourceLayout.meshRows !== config.count || stats.sourceLayout.meshTables !== (config.tables ?? 1)) throw new Error('Transform workload source population differs');
          const currentOffset = stats.authoredWrites - sample.step * config.writes;
          if (offset !== undefined && offset !== currentOffset) throw new Error('Transform source writes were skipped or duplicated');
          if (stats.authoredWrites < previous) throw new Error('Transform source write order regressed');
          offset = currentOffset; previous = stats.authoredWrites;
        }
        if (source.sourceStats.authoredWrites < dimensions.measuredFrames * config.writes) throw new Error('Incomplete Transform source writes');
      }
      const finalBefore = readyFrames; await wait(() => readyFrames >= finalBefore + 2);
      if (ids.size !== dimensions.measuredFrames) throw new Error(`Expected ${dimensions.measuredFrames} distinct completed frames, got ${ids.size}`);
      if (result.errors.length || failures.length) throw new Error(JSON.stringify([...result.errors, ...failures]));
      const steps = new Set(result.samples.map(sample => sample.step));
      const measured = { config, mode, dimensions, observation:{gpuPassTiming:diagnostic,gpuCounters:diagnostic,completion:'FrameReceipt.completed'}, preflight, execution: app.execution.report(), hostRoundTripMs: performance.now() - hostStart, frameTimes: frameTimes.filter(frame => ids.has(frame.frameId)), source, settled, hostTransport:counters?.snapshot(), distinctSourceSteps: steps.size, coalescedSourceSteps: Math.max(...steps) - Math.min(...steps) + 1 - steps.size, ...result };
      return { ...measured, quiescence: await pause() };
    },
    async dispose() { await app.dispose(); message.port1.close(); broadcast.close(); },
  };
  }
} catch (error) { globalThis.assetBenchmarkFailure = String(error?.stack ?? error); document.body.textContent = globalThis.assetBenchmarkFailure; }
