import { audioContribution } from '@forgeax/engine-audio';
import { isExecutionReport } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { runtimeBinding, createRuntimeAssetImportTransport } from 'virtual:forgeax/pack-runtime';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AudioSource, audioTickSystem, createAudioIntentBackend } from '@forgeax/engine-audio';
import { World } from '@forgeax/engine-ecs';
import { createHostAudioConsumer } from '../../src/host-audio-consumer';
import { WebAudioEngine } from '../../src/web-audio-engine';
import { pcmWav, rms, magnitude, toneBuffer } from '../../src/__tests__/support-tone';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate: () => boolean, timeout = 15000) {
  const start = performance.now();
  while (!predicate()) { if (performance.now() - start > timeout) throw new Error(`native audio timeout: ${JSON.stringify(consumer.state())}`); await sleep(10); }
}
const guid = (minutes: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(minutes).padStart(12, '0')}`;
let registry: AssetRegistry, engine: WebAudioEngine, consumer: ReturnType<typeof createHostAudioConsumer>;
let context: AudioContext;
let backend: ReturnType<typeof createAudioIntentBackend>;
let recording: Float32Array[] = [];
let firstOutputAt: number | undefined;
let worker: Worker | undefined;
let entity: number;
let world: World | undefined;
const report: Record<string, unknown> = {};
const output = document.querySelector('#results')!;
const capture = () => {
  engine.setBusEffects('master', ctx => {
    context = ctx as AudioContext;
    const recorder = (ctx as AudioContext).createScriptProcessor(1024, 1, 1);
    recorder.onaudioprocess = event => {
      const input = event.inputBuffer.getChannelData(0);
      event.outputBuffer.getChannelData(0).set(input);
      recording.push(input.slice());
      if (firstOutputAt === undefined && rms(input, 0, input.length) > 0.001) firstOutputAt = performance.now();
      if (recording.length > 1024) recording.shift();
    };
    return [recorder];
  });
};
async function control(values: Record<string, unknown>) {
  if (worker) { worker.postMessage({ kind: 'control', controls: values }); await sleep(40); }
  else if (world) {
    for (const row of world.query({ read: [AudioSource] }).unwrap()) world.set(row.entity, AudioSource, values as never).unwrap();
    audioTickSystem(world, backend);
  }
}
(globalThis as any).__streamEvidence = {
  async start(minutes: number, tier = 'main-serial', count = 1) {
    registry = new AssetRegistry({ shaderRegistry: {} as never, importTransport: createRuntimeAssetImportTransport(), runtimeBinding: runtimeBinding });
registry.installDecoder(audioContribution.kind, audioContribution.decoder);
    registry.configurePackIndex((globalThis as any).__audioCatalog);
    const before = performance.now();
    const loaded = await registry.load(guid(minutes), 'audio');
    if (!loaded.ok) throw loaded.error;
    context = new AudioContext({ sampleRate: 48000 }); await context.resume();
    engine = new WebAudioEngine({ context }); consumer = createHostAudioConsumer(engine);
    backend = createAudioIntentBackend({ emit: intent => consumer.consume(intent) });
    backend.configureBuses([{ id: 'master', parent: null }, { id: 'music', parent: 'master', volume: 0.5,
      sends: [{ bus: 'room', gain: 0.25, tap: 'pre-fader' }] }, { id: 'room', parent: 'master' }]);
    capture(); recording = [];
    engine.setBusEffects('room', ctx => { const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1000; return [filter]; }, 0.5);
    firstOutputAt = undefined;
    const started = performance.now();
    if (tier === 'ecs-worker') {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => { if (event.data.kind === 'entity') entity = event.data.entity; else consumer.consume(event.data); };
      worker.postMessage({ kind: 'start', clip: registry.read(loaded.value).unwrap(), count });
    } else {
      world = new World({ assets: registry });
      const clip = loaded.value;
      for (let i = 0; i < count; i++) {
        entity = world.spawn({ component: AudioSource, data: { clip, playing: true, loop: true, volume: 0.25 / count, bus: 'music' } }).unwrap() as number;
      }
      audioTickSystem(world, backend);
    }
    registry.release(loaded.value).unwrap();
    await wait(() => consumer.state().activeSourceCount === count);
    await wait(() => recording.some(samples => rms(samples, 0, samples.length) > 0.001));
    report.start = { minutes, tier, count, assetMs: started - before, firstOutputMs: (firstOutputAt ?? performance.now()) - started, allVoicesMs: performance.now() - started,
      totalMs: (firstOutputAt ?? performance.now()) - before, userAgent: navigator.userAgent };
    output.textContent = JSON.stringify(report, null, 2);
    return report.start;
  },
  async app(tier: string, count = 1, mixed = false) {
    const expectedSources = count * (mixed ? 2 : 1);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64; document.body.append(canvas);
    const channel = new MessageChannel(); let factories = 0;
    const contexts: AudioContext[] = [];
    const created = await createApp(canvas, { silenceUnhandledErrors: true, execution: {
      bootstrap: new URL('./app-bootstrap.ts', import.meta.url), bootstrapData: { guid: guid(60), count, shared: tier === 'shared', ...(mixed ? { shortGuid: guid(901) } : {}) },
      bootstrapPort: channel.port2, assetCatalog: { url: new URL(runtimeBinding.catalogUrl, location.href).href, expectedScope: runtimeBinding, runtimeBinding: { ...runtimeBinding, catalogUrl: new URL(runtimeBinding.catalogUrl, location.href).href, importUrlBase: new URL(runtimeBinding.importUrlBase, location.href).href, packageUrlBase: new URL(runtimeBinding.packageUrlBase, location.href).href } },
      workers: { engine: tier !== 'main-serial', render: false, kernels: tier === 'shared' },
      startupTimeoutMs: 90000, frameTimeoutMs: 30000,
      createHostAudio() {
        factories++; context = new AudioContext({ sampleRate: 48000 }); contexts.push(context);
        void context.resume(); engine = new WebAudioEngine({ context }); consumer = createHostAudioConsumer(engine);
        engine.configureBuses([{ id: 'master', parent: null }, { id: 'music', parent: 'master' }, { id: 'room', parent: 'master' }]);
        engine.setBusEffects('room', ctx => { const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1000; return [filter]; }, 0.5);
        capture();
        // This fixture supplies a borrowed context; its factory owns native close.
        const ownedContext = context;
        const dispose = consumer.dispose;
        consumer.dispose = () => {
          dispose();
          if (ownedContext.state !== 'closed') void ownedContext.close();
        };
        return consumer;
      },
    } });
    if (!created.ok) throw created.error;
    const app = created.value;
    const result: Record<string, unknown> = {};
    try {
      recording = []; app.start().unwrap();
      await wait(() => app.execution.report().audio.activeSourceCount === expectedSources && recording.some(samples => rms(samples, 0, samples.length) > 0.001), 30000);
      await wait(() => app.execution.report().frame.completed >= 60, 90000);
      const before = app.execution.report();
      if (!isExecutionReport(before) || (tier === 'shared' && !before.kernelDispatch.usedShared)) throw new Error('execution/audio report invalid');
      const initialWav = this.wav();
      if (mixed && (initialWav.hz440 < 0.002 || initialWav.hz660 < 0.002))
        throw new Error(`mixed native output lacks a source tone: ${JSON.stringify({ hz440: initialWav.hz440, hz660: initialWav.hz660 })}`);
      channel.port1.postMessage({ paused: true }); await wait(() => app.execution.report().audio.activeSourceCount === 0);
      channel.port1.postMessage({ paused: false, fromPosition: 3599.5, playbackRate: 2 });
      await wait(() => app.execution.report().audio.activeSourceCount === expectedSources);
      if (tier === 'main-serial') {
        Object.assign(result, { tier, count: expectedSources, mixed, factories, before, rebuildSupported: false, initialWav, wav: this.wav() });
        return result;
      }
      const old = consumer;
      const oldContext = context;
      channel.port1.postMessage({ poison: true });
      await wait(() => app.execution.report().engine.health === 'faulted', 30000);
      const fault = app.execution.report();
      const rebuilt = await app.execution.rebuild(); if (!rebuilt.ok) throw rebuilt.error;
      await wait(() => oldContext.state === 'closed');
      recording = [];
      app.start().unwrap();
      // Spectrum analysis needs its complete 0.2 to 0.8 second native sample window.
      await wait(() => app.execution.report().audio.activeSourceCount === expectedSources && recording.reduce((sum, samples) => sum + samples.length, 0) >= Math.round(context.sampleRate * 0.8) && recording.some(samples => rms(samples, 0, samples.length) > 0.001));
      const after = app.execution.report();
      if (factories !== 2 || old.state().activeSourceCount !== 0 || before.world.identity === after.world.identity) throw new Error('audio rebuild did not fence old owner');
      const rebuiltWav = this.wav();
      if (mixed && (rebuiltWav.hz440 < 0.002 || rebuiltWav.hz660 < 0.002))
        throw new Error(`rebuilt mixed output lacks a source tone: ${JSON.stringify({ frames: rebuiltWav.frames, rms: rebuiltWav.rms, hz440: rebuiltWav.hz440, hz660: rebuiltWav.hz660, audio: after.audio, frame: after.frame, context: context.state })}`);
      Object.assign(result, { tier, count: expectedSources, mixed, factories, before, fault, after, oldAudio: old.state(), oldNativeContext: oldContext.state, initialWav, wav: rebuiltWav }); return result;
    } finally { await app.dispose(); result.disposedAudio = consumer.state(); for (const ctx of contexts) if (ctx.state !== 'closed') await ctx.close(); channel.port1.close(); canvas.remove(); }
  },
  async gatedStart() {
    registry = new AssetRegistry({ shaderRegistry: {} as never, importTransport: createRuntimeAssetImportTransport(), runtimeBinding: runtimeBinding });
registry.installDecoder(audioContribution.kind, audioContribution.decoder);
    registry.configurePackIndex((globalThis as any).__audioCatalog);
    const clip = (await registry.load(guid(60), 'audio')).unwrap();
    engine = new WebAudioEngine(); consumer = createHostAudioConsumer(engine); recording = []; capture();
    backend = createAudioIntentBackend({ emit: intent => consumer.consume(intent) });
    backend.play(1, registry, clip, { loop: true, volume: 0.1, spatialBlend: 0, bus: 'music' });
    registry.release(clip).unwrap();
    await sleep(250); return { audio: consumer.state(), recordedBlocks: recording.length, sampleRate: context.sampleRate };
  },
  gatedStop() { consumer.consume({ kind: 'stop', entityId: 1 }); return consumer.state(); },
  gatedSample() { return { audio: consumer.state(), nonzero: recording.some(samples => rms(samples, 0, samples.length) > 0.001) }; },
  gatedDispose() { consumer.dispose(); registry.dispose(); return consumer.state(); },
  async fullDecode(minutes: number) {
    const registry = new AssetRegistry({ shaderRegistry: {} as never, importTransport: createRuntimeAssetImportTransport(), runtimeBinding: runtimeBinding });
registry.installDecoder(audioContribution.kind, audioContribution.decoder);
    registry.configurePackIndex((globalThis as any).__audioCatalog);
    const clip = (await registry.load(guid(minutes), 'audio')).unwrap();
    const loaded = registry.read(clip).unwrap();
    registry.dispose();
    if (!loaded.stream) throw new Error('baseline stream missing');
    context = new AudioContext({ sampleRate: 48000 });
    const start = performance.now();
    const encoded = await (await fetch(loaded.stream.url, { cache: 'no-store' })).arrayBuffer();
    const buffer = await context.decodeAudioData(encoded.slice(0));
    (globalThis as any).__baselineBuffer = buffer;
    (globalThis as any).__baselineEncoded = encoded;
    return { minutes, encodedBytes: encoded.byteLength, pcmBytes: buffer.length * buffer.numberOfChannels * 4, decodeAndFetchMs: performance.now() - start };
  },
  async stopBaseline() {
    (globalThis as any).__baselineBuffer = undefined; (globalThis as any).__baselineEncoded = undefined; await context.close();
  },
  async signals() {
    const rows = [];
    for (const variant of ['pre', 'post', 'no-send', 'no-effect', 'dry']) {
      const ctx = new OfflineAudioContext(1, 48000, 48000);
      const native = new WebAudioEngine({ context: ctx });
      native.configureBuses([{ id: 'master', parent: null }, { id: 'voice', parent: 'master', volume: 0.25,
        ...(variant === 'no-send' ? {} : { sends: [{ bus: 'room', gain: 0.5, tap: variant === 'post' ? 'post-fader' : 'pre-fader' }] }) },
        { id: 'room', parent: 'master' }]);
      let builds = 0;
      if (variant !== 'no-effect') native.setBusEffects('room', context => {
        builds++; const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1000; return [filter];
      }, variant === 'dry' ? 0 : 1);
      const buffer = toneBuffer(ctx, [440, 8000], 1);
      for (let id = 1; id <= 8; id++) native.play(id, buffer, { volume: 1 / 8, loop: false, spatialBlend: 0, bus: 'voice' });
      const samples = (await ctx.startRendering()).getChannelData(0);
      rows.push({ variant, builds, rms: rms(samples, 9600, 38400), hz440: magnitude(samples, 48000, 440),
        hz8000: magnitude(samples, 48000, 8000), bytes: [...pcmWav(samples)] });
      native.destroy();
    }
    return rows;
  },
  sample() { return { at: performance.now(), audio: consumer.state(), source: engine.getStreamState(entity) }; },
  async hot(count: number) {
    const latencies = [];
    for (let i = 0; i < 3; i++) {
      await control({ playing: false }); await wait(() => consumer.state().activeSourceCount === 0);
      recording = []; firstOutputAt = undefined;
      const start = performance.now(); await control({ playing: true, paused: false, fromPosition: 0, playbackRate: 1 });
      await wait(() => consumer.state().activeSourceCount === count && recording.some(samples => rms(samples, 0, samples.length) > 0.001));
      latencies.push({ firstOutputMs: (firstOutputAt ?? performance.now()) - start, allVoicesMs: performance.now() - start });
    }
    return latencies;
  },
  async seeks(minutes: number) {
    const rows = [];
    for (const fraction of [0.25, 0.75, 0.02, 0.95, 0.4, 0.6, 0.8, 0.1]) {
      const position = minutes * 60 * fraction, started = performance.now();
      await control({ fromPosition: position });
      await wait(() => engine.getStreamState(entity)?.pendingSeek === false && engine.getStreamState(entity)?.status === 'playing');
      const actual = engine.getPlaybackPosition(entity)!;
      rows.push({ position, actual, latencyMs: performance.now() - started, positionErrorSeconds: actual - position });
    }
    await control({ paused: true });
    const pausedAt = engine.getPlaybackPosition(entity); await sleep(250);
    const pauseDrift = engine.getPlaybackPosition(entity)! - pausedAt!;
    await control({ fromPosition: minutes * 60 - 0.25, playbackRate: 2 });
    await control({ paused: false }); await sleep(1000);
    report.controls = { seeks: rows, pauseDrift, loopPosition: engine.getPlaybackPosition(entity), state: engine.getStreamState(entity) };
    return report.controls;
  },
  async stop() {
    await control({ playing: false });
    if (world) for (const row of world.query({ read: [AudioSource] }).unwrap()) world.set(row.entity, AudioSource, { playing: false }).unwrap();
    if (world) audioTickSystem(world, backend);
    await sleep(150);
    const stopped = consumer.state();
    consumer.dispose(); worker?.terminate(); worker = undefined; await context.close(); registry.dispose(); world = undefined;
    return stopped;
  },
  wav() {
    const size = recording.reduce((sum, input) => sum + input.length, 0), samples = new Float32Array(size);
    let offset = 0; for (const chunk of recording) { samples.set(chunk, offset); offset += chunk.length; }
    return { bytes: [...pcmWav(samples, context.sampleRate)], frames: size, rms: rms(samples, 0, samples.length),
      hz440: magnitude(samples, 48000, 440), hz660: magnitude(samples, 48000, 660), hz8000: magnitude(samples, 48000, 8000) };
  },
};

// Start outside CDP evaluation: Playwright evaluate itself carries user activation.
if (new URL(location.href).searchParams.has('autoplay')) {
  (globalThis as any).__audioCatalog = runtimeBinding.catalogUrl;
  void (globalThis as any).__streamEvidence.gatedStart().then((value: unknown) => { (globalThis as any).__gatedBefore = value; });
}
