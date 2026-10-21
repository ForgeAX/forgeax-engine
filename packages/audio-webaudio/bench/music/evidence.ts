import { audioContribution } from '@forgeax/engine-audio';
import { isExecutionReport } from '@forgeax/engine/app';
import { createApp } from '@forgeax/engine/app/browser';
import { createAudioIntentBackend, loadMusicScore, type MusicPreparation, type MusicState, type MusicScore } from '@forgeax/engine/audio';
import { WebAudioEngine, createHostAudioConsumer } from '@forgeax/engine/audio-webaudio';
import { ShaderRegistry } from '@forgeax/engine/shader';
import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { pcmWav } from '../../src/__tests__/support-tone';
import { savedScore, resampledScore } from './saved-score';
import { retain, retainNativePcm } from './retain-native-pcm';

// This fixture authors only a Camera and ordinary Audio clips. Keep the real
// built-in Renderer shader entries, while omitting unused cooked material
// variants from every Engine Worker publication.
const musicShaderManifestUrl = new URL('/shaders/music-manifest.json', location.href).href;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function assert(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
async function wait(test: () => unknown, ms = 30000) {
  const end = performance.now() + ms;
  while (!test()) { if (performance.now() >= end) throw new Error('musical evidence wait deadline'); await sleep(10); }
}
let stageSequence = 0;
async function observed<T>(probe: string, stage: string, action: () => Promise<T>, budgetMs = 90000): Promise<T> {
  const id = ++stageSequence;
  const report = (globalThis as unknown as { __musicStage?: (row: unknown) => Promise<void> }).__musicStage;
  await report?.({ id, probe, stage, status: 'begin', budgetMs });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([action(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`musical evidence stage deadline: ${probe}/${stage} (${budgetMs} ms)`)), budgetMs);
    })]);
    await report?.({ id, probe, stage, status: 'complete', budgetMs });
    return result;
  } catch (error) {
    await report?.({ id, probe, stage, status: 'failed', budgetMs, failure: String(error) });
    throw error;
  } finally { clearTimeout(timer); }
}
const percentile = (raw: readonly number[], fraction: number) => [...raw].sort((a,b) => a-b)[Math.floor((raw.length-1)*fraction)] ?? 0;
const stats = (raw: readonly number[]) => ({ samples: raw.length, p50: percentile(raw, 0.5), p95: percentile(raw, 0.95), raw });
const registry = new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) });
registry.installDecoder(audioContribution.kind, audioContribution.decoder);
registry.configurePackIndex(new URL('/pack-index.json', location.href).href);
async function load(count: number, base = 2300): Promise<MusicPreparation> {
  return loadSaved(savedScore(count, base));
}
async function loadSaved(score: MusicScore, assets = registry): Promise<MusicPreparation> {
  const name = `${score.stems[0]?.clip}-${score.stems.length}.json`;
  const response = await fetch(new URL(`/scores/${name}`, location.href));
  assert(response.ok, 'ordinary saved score file must be available');
  const saved = await response.json();
  assert(JSON.stringify(saved) === JSON.stringify(score), 'saved score file differs from its authored declaration');
  const prepared = await loadMusicScore(saved, assets);
  if (!prepared.ok) throw prepared.error;
  return prepared.value;
}

async function resampled(commonPhase: boolean) {
  const rate=44100, seconds=600, bpm=137;
  const context=new OfflineAudioContext(1,rate*seconds,rate);
  const consumer=createHostAudioConsumer(new WebAudioEngine({context}));
  const score=await loadSaved(resampledScore(commonPhase));
  try {
    consumer.prepareMusic(1,score);await wait(()=>consumer.state().music?.phase==='ready');
    consumer.consume({kind:'music',command:{kind:'mix',requestId:2,epoch:consumer.state().music?.epoch??-1,
      boundary:'beat',atBeat:0,late:'reject',gains:[1,1,1,1]}});
    const admitted=consumer.state();
    const pcm=(await context.startRendering()).getChannelData(0);
    const period=240*rate/bpm, speed=Math.round(period)/period;
    const raw=[];const missing=[];let maximum=0,relativeMaximum=0;
    for(let loop=0;loop<Math.floor((seconds-0.03)*bpm/240);loop++) {
      const normalized=[];
      for(let stem=0;stem<4;stem++) {
        const offset=score.stems[stem]?.offsetSeconds??0;
        const marker=((128+stem*(commonPhase?160:128))*rate/48000-(Math.round(offset*rate)-offset*rate))/speed;
        const expectedSample=Math.round(0.02*rate+loop*period+marker);
        let actualSample=expectedSample;
        for(let sample=expectedSample-3;sample<=expectedSample+3;sample++) if((pcm[sample]??0)>(pcm[actualSample]??0))actualSample=sample;
        const amplitude=pcm[actualSample]??0,error=actualSample-expectedSample;
        raw.push({loop,stem,offset,marker,expectedSample,actualSample,amplitude,error});
        maximum=Math.max(maximum,Math.abs(error));normalized.push(actualSample-marker);
        if(!(amplitude>0.001))missing.push({loop,stem,expectedSample,actualSample,amplitude});
      }
      relativeMaximum=Math.max(relativeMaximum,Math.max(...normalized)-Math.min(...normalized));
    }
    const pass=missing.length===0&&maximum<=1&&relativeMaximum<=1+1e-7;
    const row={rate,seconds,bpm,commonPhase,score:resampledScore(commonPhase),admitted,raw,maximum,relativeMaximum,missing,pass,
      wav:Array.from(pcmWav(pass?pcm.slice(0,rate*8):pcm,rate))};
    if(!pass)await retain(`failed-resampled-${commonPhase?'common':'fractional'}-600`,row);
    assert(missing.length===0,'resampled native pulse missing');
    assert(maximum<=1&&relativeMaximum<=1+1e-7,'resampled native PCM exceeded frozen sample alignment');
    return row;
  } finally {consumer.dispose();}
}

// Independent native input decode: do not infer a browser's integer PCM
// normalization or read the transport's private adopted buffers. This oracle
// is used only for functional probes, never to prewarm cost measurements.
async function inputAmplitudes(context: BaseAudioContext, score: MusicPreparation) {
  return Promise.all(score.stems.map(async (stem,index) => {
    const clip = score.assets.read(stem.clip).unwrap();
    assert(clip.bytes, 'buffered oracle source bytes missing');
    const input = await context.decodeAudioData(clip.bytes.slice().buffer as ArrayBuffer);
    return input.getChannelData(0)[index * 32] ?? NaN;
  }));
}

async function offline(count: number, seconds = 56, disabled = false) {
  const context = new OfflineAudioContext(1, 48000 * seconds, 48000);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  const backend = createAudioIntentBackend({ emit: intent => consumer.consume(structuredClone(intent)), state: () => consumer.state() });
  try {
    const score = await load(count);
    const input = await inputAmplitudes(context, score);
    consumer.prepareMusic(1, score);
    await wait(() => backend.getState().music?.phase === 'ready');
    const epoch = backend.getState().music?.epoch ?? -1;
    const plan = Array.from({ length: 101 }, (_, index) => ({ requestId: index + 2, beat: index,
      gains: Array.from({ length: count }, (_, stem) => disabled && stem === count - 1 ? 0 : (index % 2 ? 0.5 : 1)) }));
    for (const row of plan) backend.music({ kind: 'mix', requestId: row.requestId, epoch,
      gains: row.gains, boundary: 'beat', atBeat: row.beat, late: 'reject' });
    const admitted = backend.getState();
    assert(admitted.music?.pending === 101, 'all 101 sample-oracle transitions must be admitted');
    const pcm = (await context.startRendering()).getChannelData(0);
    const raw = []; const missing = []; let maxError = 0;
    for (let beat = 0; beat < Math.floor((seconds - 0.02) * 2); beat++) for (let stem = 0; stem < count; stem++) {
      const expectedSample = 960 + beat * 24000 + stem * 32;
      const weight = (plan[Math.min(beat,100)]?.gains[stem] ?? 0);
      const expectedAmplitude = (input[stem] ?? NaN) * weight;
      const actualAmplitude = pcm[expectedSample] ?? 0;
      let actualSample = expectedSample;
      if (weight > 0) {
        actualSample = -1;
        for (let delta = -2; delta <= 2; delta++) if (Math.abs((pcm[expectedSample + delta] ?? 0) - expectedAmplitude) < 1e-6) { actualSample = expectedSample + delta; break; }
        if(actualSample < 0)missing.push({stem,beat,expectedAmplitude,actualAmplitude});
      }
      const error = weight ? actualSample - expectedSample : Math.abs(actualAmplitude);
      maxError = Math.max(maxError, Math.abs(error));
      raw.push({ beat, stem, expectedSample, actualSample, expectedAmplitude, actualAmplitude, error });
    }
    const pass=missing.length===0&&maxError<=1;
    const window = pcm.slice(0,48000*8);
    const row={count,seconds,disabled,maxError,raw,input,admitted,missing,pass,
      wav:Array.from(pcmWav(pass?window:pcm)),waveform:Array.from(window.filter((_,i)=>i%160===0))};
    if(!pass)await retain(`failed-signal-${count}-${seconds}-${disabled?'disabled':'enabled'}`,row);
    assert(missing.length===0,`missing native pulses: ${JSON.stringify(missing.slice(0,4))}`);
    assert(maxError <= 1, 'absolute sample alignment exceeded frozen one-sample limit');
    return row;
  } finally { consumer.dispose(); }
}

async function performanceRound(stems: number, pending: number, round: number) {
  const context = new AudioContext({ sampleRate: 48000 }); await context.resume();
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  let traffic = 0;
  const backend = createAudioIntentBackend({ emit: intent => { traffic += JSON.stringify(intent, (_, value) => value instanceof Uint8Array ? { bytes: value.byteLength } : value).length;
    consumer.consume(structuredClone(intent)); }, state: () => consumer.state() });
  let id = 0;
  try {
    const coldAt = performance.now();
    const freshAssets = new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) });
freshAssets.installDecoder(audioContribution.kind, audioContribution.decoder);
    freshAssets.configurePackIndex(new URL('/pack-index.json', location.href).href);
    const score = await loadSaved(savedScore(stems), freshAssets);
    const catalogMs = performance.now() - coldAt;
    const hostPreparedBytes = score.stems.reduce((sum, stem) => sum + (score.assets.read(stem.clip).unwrap().bytes?.byteLength ?? 0), 0);
    const decodeAt = performance.now(); consumer.prepareMusic(++id, score);
    await wait(() => backend.getState().music?.phase === 'ready');
    const decodeMs = performance.now() - decodeAt;
    const coldMs = performance.now()-coldAt;
    const epoch = backend.getState().music?.epoch ?? -1;
    const schedule: number[] = [], cancel: number[] = [];
    // Future commands avoid audible benchmarks and cannot expire while sampling.
    for (let batch = -5; batch < 20; batch++) {
      const handles = [];
      for (let command = 0; command < pending; command++) {
        const requestId = ++id; handles.push(requestId);
        const start = performance.now();
        backend.music({ kind: 'mix', requestId, epoch, atBeat: 100 + command,
          gains: Array.from({ length: stems }, (_, stem) => (command + stem) % 2 ? 0.25 : 0.75), boundary: 'beat', late: 'reject' });
        if (batch >= 0) schedule.push(performance.now()-start);
      }
      assert(backend.getState().music?.pending === pending, 'capacity workload was not fully admitted');
      // Exercise tail, oldest and middle cancellation, retaining the same frozen budget.
      const cancellationOrder = batch % 3 === 0 ? handles.reverse() : batch % 3 === 1 ? handles : (() => {
        const pending = [...handles], ordered = [];
        while (pending.length) ordered.push(pending.splice(Math.floor(pending.length/2),1)[0]);
        return ordered;
      })();
      for (const requestId of cancellationOrder) {
        const start = performance.now(); backend.music({ kind: 'cancel', requestId: ++id, epoch, cancelRequestId: requestId });
        if (batch >= 0) cancel.push(performance.now()-start);
      }
      assert(backend.getState().music?.pending === 0, 'cancel left pending native work');
      await sleep(0);
    }
    const highWater = consumer.state(); backend.destroy(); const released = consumer.state();
    assert(released.activeSourceCount === 0 && released.cache?.sources === 0 && released.music?.pending === 0, 'destroy did not release resources');
    const scheduled = stats(schedule), cancelled = stats(cancel);
    return { stems, pending, round, coldMs, catalogMs, decodeMs,
      coldScope: 'fresh Catalog and Host caches; browser HTTP and OS caches may be warm',
      schedule: scheduled, cancel: cancelled, traffic, hostPreparedBytes, highWater, released,
      pass: coldMs <= 1000 && scheduled.p95 <= 2 && cancelled.p95 <= 2 };
  } finally { consumer.dispose(); await context.close(); }
}

interface Capture { readonly context: AudioContext; readonly onsets: { sample: number; amplitude: number }[]; readonly pcm: { sample: number; pcm: Float32Array }[]; readonly flush: () => Promise<void>; pcmStartSample?: number }
async function recorder(context: AudioContext, engine: WebAudioEngine, seconds = 10): Promise<Capture> {
  let resolveFlush: (() => void) | undefined;
  let flushPromise: Promise<void> | undefined;
  let node: AudioWorkletNode | undefined;
  const capture: Capture = { context, onsets: [], pcm: [], flush: () => {
    if (flushPromise) return flushPromise;
    flushPromise = new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { resolveFlush = undefined; reject(new Error('native PCM recorder flush deadline')); }, 10000);
      resolveFlush = () => { clearTimeout(timer); accept(); };
      node?.port.postMessage({ flush: true });
    });
    return flushPromise;
  } };
  await observed('recorder', 'audioWorklet.addModule', () => context.audioWorklet.addModule(new URL('./recorder.worklet.js', import.meta.url).href));
  const result = engine.setBusEffects('master', native => {
    node = new AudioWorkletNode(native as AudioContext, 'musical-output-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { seconds } });
    node.port.onmessage = event => { capture.onsets.push(...(event.data.onsets ?? [])); if (event.data.captureStart >= 0) capture.pcmStartSample = event.data.captureStart;
      if (event.data.pcm) capture.pcm.push({ sample: event.data.sample, pcm: event.data.pcm });
      if (event.data.flushComplete) { const resolve = resolveFlush; resolveFlush = undefined; resolve?.(); } };
    return [node];
  });
  if (!result.ok) throw result.error;
  return capture;
}
function capturePcm(capture: Capture, seconds = 10): Float32Array {
  const frames = new Float32Array(Math.round(capture.context.sampleRate * seconds));
  for (const row of capture.pcm) frames.set(row.pcm.subarray(0, Math.max(0, frames.length-row.sample)), row.sample);
  return frames;
}
function captureWav(capture: Capture, requireRecordedSignal = false): number[] {
  const wav = pcmWav(capturePcm(capture),capture.context.sampleRate);
  if (requireRecordedSignal && capture.onsets.length > 0 && !wav.subarray(44).some(sample => sample !== 0))
    throw new Error(`native PCM recorder retained ${capture.onsets.length} thresholded onsets but the WAV contains only zero samples`);
  return Array.from(wav);
}
async function app(tier: string, count: number, delayFrames: number, falsifier = false, traceProgress = false, traceRhiCapture = false) {
  const probe = `app-${tier}-${count}-${delayFrames}-${falsifier?'immediate':'quantized'}`;
  const score = await observed(probe, 'ordinary-score-load', () => load(count), 30000);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64; document.body.append(canvas);
  const channel = new MessageChannel(); let consumer: ReturnType<typeof createHostAudioConsumer> | undefined;
  let inspectAudioState: (() => unknown) | undefined;
  const captures: Capture[] = []; const contexts: AudioContext[] = [];
  const contextCloseTasks = new Map<AudioContext, Promise<void>>();
  const closeContext = (context: AudioContext) => {
    let task = contextCloseTasks.get(context);
    if (!task) {
      task = context.close();
      contextCloseTasks.set(context, task);
      // The App's synchronous Host dispose path requests closure; the finalizer
      // awaits this same promise and retains any rejection as the gate result.
      void task.catch(() => {});
    }
    return task;
  };
  let captureReady: Promise<unknown> = Promise.resolve();
  let inputForEvidence: number[] | undefined;
  const feedback: MusicState[] = [];
  const componentIdentities: { transform: boolean }[] = [];
  const commandTrace: Record<string,unknown>[] = [], deadline: Record<string,unknown>[] = [];
  let musicIntentCount = 0, musicIntentBytes = 0;
  const immediate: { immediateStem: number; submittedFrame: number; hostReceivedAt?: number }[] = [];
  const ordinaryPlayIntents: { entityId: number; sourceKey: string; contextTime: number; observedFrames: number }[] = [];
  let hostConsumeMs = 0, hostStateMs = 0;
  const hostAudioFrames: { frame: number; consumeMs: number; stateMs: number; totalMs: number }[] = [];
  let pcmMismatchEvidence: Record<string, unknown> | undefined;
  const startup = (stage: string, detail: Record<string, unknown> = {}) => {
    const save = (globalThis as unknown as { __musicStartup?: (row: unknown) => Promise<void> }).__musicStartup;
    void save?.({ probe, stage, ...detail }).catch(error => console.error('startup receipt failure', error));
  };
  channel.port1.onmessage = event => { if (event.data.music) {
      feedback.push(event.data.music);
      if (traceProgress && (event.data.frame === 1 || event.data.frame % 60 === 0))
        startup('music-feedback', { frame: event.data.frame, state: event.data.music });
      // Native Host calls are measured in every mode. Local execution reports
      // currently have no performance series. Include diagnostic state reads
      // between frame feedback messages, conservatively charging their cost.
      hostAudioFrames.push({ frame: event.data.frame, consumeMs: hostConsumeMs,
        stateMs: hostStateMs, totalMs: hostConsumeMs + hostStateMs });
      hostConsumeMs = hostStateMs = 0;
    }
    if (event.data.startup) startup(event.data.startup);
    if (event.data.componentIdentity) componentIdentities.push(event.data.componentIdentity);
    if (event.data.commandTrace) commandTrace.push({...event.data.commandTrace,hostReceivedAt:contexts.at(-1)?.currentTime});
    if (event.data.immediateStem !== undefined)
      immediate.push({ ...event.data, hostReceivedAt: contexts.at(-1)?.currentTime }); };
  const createAt = performance.now();
  let preparedAppContext: AudioContext | undefined;
  const created = await observed(probe, 'createApp', async () => {
    // Verify the one native transport clock is advancing before the App schedules audio.
    const context = new AudioContext({ sampleRate: 48000 });
    preparedAppContext = context;
    contexts.push(context);
    await context.resume();
    await observed(probe, 'audio-context-ready', () => wait(() => context.state === 'running' && context.currentTime > 0, 90000), 90000);
    startup('audio-context-ready', { state: context.state, currentTime: context.currentTime });
    return createApp(canvas, { silenceUnhandledErrors: true, execution: {
    bootstrap: new URL('/assets/music-bootstrap.js', location.href), bootstrapData: { count, shared: tier === 'shared', falsifier }, bootstrapPort: channel.port2,
    assetCatalog: { url: new URL('/pack-index.json', location.href).href },
    workers: { engine: tier !== 'main-serial', render: false, kernels: tier === 'shared' }, startupTimeoutMs: 90000, frameTimeoutMs: 30000,
    ...(traceRhiCapture ? { diagnostics: { rhiCapture: true } } : {}),
    createHostAudio() {
      startup('host-audio-factory');
      const prewarmedContext = preparedAppContext;
      // App rebuild calls this factory again after disposing the old Host Context.
      const context = prewarmedContext ?? new AudioContext({ sampleRate: 48000 });
      if (prewarmedContext) preparedAppContext = undefined;
      else contexts.push(context);
      const contextReady = prewarmedContext ? Promise.resolve() : context.resume().then(async () => {
        await observed(probe, 'audio-context-ready', () => wait(() => context.state === 'running' && context.currentTime > 0, 90000), 90000);
        startup('audio-context-ready', { state: context.state, currentTime: context.currentTime });
      });
      const engine = new WebAudioEngine({ context }); const current = createHostAudioConsumer(engine); consumer = current;
      const consume = current.consume, state = current.state;
      inspectAudioState = state;
      current.consume = intent => { const at = performance.now(); try {
          if (falsifier && intent.kind === 'play') ordinaryPlayIntents.push({ entityId: intent.entityId,
            sourceKey: intent.sourceKey, contextTime: context.currentTime, observedFrames: hostAudioFrames.length });
          if (intent.kind === 'music') { musicIntentCount++; musicIntentBytes += JSON.stringify(intent).length;
            commandTrace.push({stage:'host-consume',nativeTime:context.currentTime,command:intent.command}); }
          consume(intent); }
        finally { hostConsumeMs += performance.now() - at; } };
      current.state = () => { const at = performance.now(); try { return state(); }
        finally { hostStateMs += performance.now() - at; } };
      current.prepareMusic(1, score);
      captureReady = Promise.all([contextReady, recorder(context, engine)]).then(([, value]) => captures.push(value));
      // Keep startup rejection observed until the normal capture-ready await.
      void captureReady.catch(() => {});
      const dispose = current.dispose; current.dispose = () => { dispose(); void closeContext(context); };
      return current;
    },
  } }, { shaderManifestUrl: musicShaderManifestUrl });
  }).catch(async error => {
    consumer?.dispose();channel.port1.close();canvas.remove();
    for(const context of contexts)await closeContext(context);
    throw error;
  });
  if (!created.ok) {
    consumer?.dispose();channel.port1.close();canvas.remove();
    for(const context of contexts)await closeContext(context);
    throw created.error;
  }
  const createMs = performance.now() - createAt;
  const running = created.value;
  try {
    await observed(probe, 'capture-ready', () => captureReady);
    const input = await observed(probe, 'native-input-decode', () => inputAmplitudes(contexts[0] as AudioContext, score), 30000);
    inputForEvidence = input;
    const startAt = performance.now(); running.start().unwrap();
    const progressTimer = traceProgress ? setInterval(() => {
      try { startup('execution-progress', { report: running.execution.report(), audio: inspectAudioState?.(),
        feedbackFrames: hostAudioFrames.length, musicIntentCount, currentTime: contexts.at(-1)?.currentTime }); }
      catch(error) { startup('execution-progress-error', { failure: String(error) }); }
    }, 5000) : undefined;
    try {
      await observed(probe, 'first-applied-receipt', () => wait(() => falsifier ? immediate.length === count : feedback.some(state => state.receipts.some(receipt => receipt.requestId === 2 && receipt.status === 'applied')), 90000));
    } finally { if (progressTimer !== undefined) clearInterval(progressTimer); }
    await observed(probe, 'first60-and-native-PCM', () => wait(() => running.execution.report().frame.completed >= 60 && hostAudioFrames.length >= 60 && (captures[0]?.onsets.length ?? 0) >= count * 2, 90000));
    const first60Ms = performance.now() - startAt;
    let rhiCapture: { digest: string; bytes: number } | undefined;
    if (traceRhiCapture) {
      rhiCapture = await observed(probe, 'rhi-debug-capture', async () => {
        assert(running.remoteEval !== undefined, 'Worker RHI capture requires the existing App inspection channel');
        const captured = await running.remoteEval(
          'const result = await rhiCapture.captureFrame(); if (!result.ok) throw result.error; return { digest: result.value.digest, bytes: result.value.bytes };',
        ) as { digest?: unknown; bytes?: unknown };
        assert(typeof captured?.digest === 'string', 'RHI capture must return the retained tape digest');
        assert(captured.bytes instanceof Uint8Array, 'RHI capture inspection must retain v7 tape bytes');
        const tapeBuffer = new ArrayBuffer(captured.bytes.byteLength);
        new Uint8Array(tapeBuffer).set(captured.bytes);
        const url = URL.createObjectURL(new Blob([tapeBuffer], { type: 'application/x-forgeax-rhitape' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'music-app.rhitape';
        document.body.append(anchor); anchor.click(); anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { digest: captured.digest, bytes: captured.bytes.byteLength };
      }, 90000);
    }
    assert(componentIdentities.length > 0 && componentIdentities.every(row => row.transform), 'native App Scene identity must reach the Host');
    const initial = running.execution.report(); assert(isExecutionReport(initial), 'App report contract');
    if (tier === 'shared') assert(initial.kernelDispatch.usedShared, 'shared mode must execute its real kernel');
    if (falsifier) {
      if (captures[0]) await observed(probe, 'native-pcm-flush', () => captures[0]!.flush(), 10000);
      const onsets = captures[0]?.onsets ?? [];
      const relative = Array.from({ length: count }, (_, stem) => {
        const expectedAmplitude = (input[stem] ?? NaN) * 0.1;
        const actual = onsets.find(row => Math.abs(row.amplitude - expectedAmplitude) < 1e-6);
        assert(actual, `immediate source ${stem} missing in real App PCM`);
        return { stem, actualSample: actual.sample, relativeOnset: actual.sample - stem * 32 };
      });
      const spread = Math.max(...relative.map(row => row.relativeOnset)) - Math.min(...relative.map(row => row.relativeOnset));
      assert(spread > 1, 'ordinary Update immediate-play falsifier failed to reject misalignment');
      return { tier, count, delayFrames, falsifier, immediate, initial, input, relative, spread, onsets, hostAudioFrames,
        ordinaryPlayIntents, componentIdentities, commandTrace, createMs, first60Ms, musicIntentCount, musicIntentBytes,
        pcmStartSample: captures[0]?.pcmStartSample, rhiCapture,
        wav: captures[0] ? captureWav(captures[0], true) : [], pass: true };
    }
    const origin = initial.audio.music?.receipts.find(receipt => receipt.requestId === 1)?.targetTime;
    assert(origin !== undefined, 'ready receipt must identify this native musical origin');
    const context = captures[0]?.context;
    assert(context, 'App native PCM recorder missing');
    const deadlineBeat = Math.ceil((context.currentTime - origin) * 2) + 2;
    const deadlineTarget = origin + deadlineBeat * 0.5;
    await observed(probe, 'app-early-window', () => wait(() => context.currentTime >= deadlineTarget - 0.12), 30000);
    deadline.push({ side:'early', targetBeat:deadlineBeat, targetTime:deadlineTarget, sentAt:context.currentTime, delayFrames });
    channel.port1.postMessage({ delayFrames, command: { kind:'mix', boundary:'beat', atBeat:deadlineBeat, late:'reject', gains:Array.from({length:count},()=>0.15) } });
    await observed(probe, 'app-early-receipt', () => wait(() => feedback.at(-1)?.receipts.some(receipt => receipt.requestId === 3)), 30000);
    const earlyReceipt = feedback.at(-1)?.receipts.find(receipt => receipt.requestId === 3);
    const earlyHost = [...commandTrace].reverse().find(row => row.stage === 'host-consume' &&
      (row.command as {requestId?:number}|undefined)?.requestId === 3);
    const hostConsumedAt = Number(earlyHost?.nativeTime);
    assert(earlyReceipt && Number.isFinite(hostConsumedAt), 'early request must retain its Host receipt and consume-time clock sample');
    const requiredLead = 0.02 - 0.5 / context.sampleRate;
    const arrivedWithMargin = deadlineTarget >= hostConsumedAt + requiredLead;
    const admittedEarly = earlyReceipt.status === 'scheduled' || earlyReceipt.status === 'applied';
    if (arrivedWithMargin)
      assert(admittedEarly, 'early request with the unchanged native scheduling margin must be admitted');
    else
      assert(earlyReceipt.status === 'rejected' && earlyReceipt.failure?.code === 'missed-boundary',
        'early request that reaches the Host inside the unchanged 20 ms margin must be explicitly rejected');
    Object.assign(deadline[deadline.length - 1], { hostConsumedAt, nativeLeadMs:(deadlineTarget-hostConsumedAt)*1000,
      requiredLeadMs:requiredLead*1000, outcome:admittedEarly?'admitted':'missed-boundary', receipt:earlyReceipt });
    await observed(probe, 'app-late-window', () => wait(() => context.currentTime >= deadlineTarget - 0.015), 30000);
    deadline.push({ side:'late', targetBeat:deadlineBeat, targetTime:deadlineTarget, sentAt:context.currentTime, delayFrames });
    channel.port1.postMessage({ delayFrames, command: { kind:'mix', boundary:'beat', atBeat:deadlineBeat, late:'reject', gains:Array.from({length:count},()=>0.3) } });
    await observed(probe, 'app-late-receipt', () => wait(() => feedback.at(-1)?.receipts.some(receipt => receipt.requestId === 4)), 30000);
    assert(feedback.at(-1)?.receipts.find(receipt => receipt.requestId === 4)?.failure?.code === 'missed-boundary', 'late delayed request must reject');
    channel.port1.postMessage({ delayFrames, command: { kind:'mix', boundary:'beat', atBeat:deadlineBeat, late:'next-boundary', gains:Array.from({length:count},()=>0.1) } });
    await observed(probe, 'app-deferred-receipt', () => wait(() => feedback.at(-1)?.receipts.some(receipt => receipt.requestId === 5 && receipt.status === 'applied'), 30000), 30000);
    assert(feedback.at(-1)?.receipts.find(receipt => receipt.requestId === 5)?.deferred, 'late request must explicitly defer');
    channel.port1.postMessage({ delayFrames, command: { kind: 'mix', boundary: 'bar', late: 'next-boundary', gains: Array.from({ length: count }, (_,index)=> index === count-1 ? 0.2 : 0) } });
    await observed(probe, 'app-bar-receipt', () => wait(() => feedback.at(-1)?.receipts.some(receipt => receipt.requestId === 6 && receipt.status === 'applied'), 30000), 30000);
    await observed(probe, 'app-envelope-settle', () => sleep(650), 10000);
    const after = running.execution.report(); const last = feedback.at(-1);
    const onsets = captures[0]?.onsets ?? [];
    const first = initial.audio.music?.receipts.find(receipt => receipt.requestId === 2)?.targetTime;
    assert(first !== undefined, 'Host scheduling receipt must reach App');
    const target = Math.round(first*48000);
    const firstBeat = initial.audio.music?.receipts.find(receipt => receipt.requestId === 2)?.targetBeat;
    assert(firstBeat !== undefined && Number.isInteger(firstBeat) && firstBeat >= 1 && Math.abs(target - Math.round((origin + firstBeat*0.5)*48000))<=1, 'initial beat target disagrees with independent tempo/origin oracle');
    const relative = Array.from({ length: count },(_,stem)=>{
      const expectedSample = target+stem*32;
      const actual = onsets.find(row=>Math.abs(row.sample-expectedSample)<=1);
      assert(actual, `App PCM lacks stem ${stem}`);
      return { stem, targetSample: expectedSample, actualSample: actual.sample, relativeOnset: actual.sample-stem*32 };
    });
    assert(Math.max(...relative.map(row=>row.relativeOnset))-Math.min(...relative.map(row=>row.relativeOnset))<=1, 'App native stem alignment');
    const envelopes = [];
    const envelopeRequests = admittedEarly ? [[3,0.15],[5,0.1],[6,0.2]] as const : [[5,0.1],[6,0.2]] as const;
    for (const [requestId, weight] of envelopeRequests) {
      const receipt = last?.receipts.find(row=>row.requestId===requestId);
      assert(receipt?.targetBeat !== undefined && receipt.targetTime !== undefined, 'admitted envelope receipt missing');
      if(requestId===6) assert(receipt.targetBeat%4===0,'bar must use four authored quarter-note beats');
      const independent = Math.round((origin+receipt.targetBeat*0.5)*48000);
      assert(Math.abs(Math.round(receipt.targetTime*48000)-independent)<=1,'envelope time disagrees with independent tempo/origin');
      for(let stem=0;stem<count;stem++) {
        const expectedSample=independent+stem*32;
        const expectedAmplitude=(input[stem] ?? NaN)*(requestId===6 && stem!==count-1?0:weight);
        const actual=onsets.find(row=>Math.abs(row.sample-expectedSample)<=1);
        const envelopeMatches = expectedAmplitude===0 ? !actual : actual && Math.abs(actual.amplitude-expectedAmplitude)<1e-6;
        if (!envelopeMatches && captures[0]) {
          const captured = capturePcm(captures[0]);
          const captureStart = captures[0].pcmStartSample;
          const center = captureStart === undefined ? -1 : expectedSample - captureStart;
          const from = center < 0 ? 0 : Math.max(0, center - 256);
          const to = center < 0 ? 0 : Math.min(captured.length, center + 257);
          pcmMismatchEvidence = {
            requestId,
            stem,
            expectedSample,
            expectedAmplitude,
            onset: actual,
            captureStartSample: captureStart,
            pcmWindowStartSample: captureStart === undefined ? undefined : captureStart + from,
            pcmWindow: Array.from(captured.subarray(from, to)),
            pcmChunks: captures[0].pcm.map(row => ({ sample: row.sample, frames: row.pcm.length })),
            nearbyOnsets: onsets.filter(row => Math.abs(row.sample - expectedSample) <= 512),
          };
        }
        assert(envelopeMatches,'native PCM does not match the admitted complete envelope');
        envelopes.push({requestId,stem,expectedSample,actualSample:actual?.sample,expectedAmplitude,actualAmplitude:actual?.amplitude??0});
      }
    }
    if (captures[0]) await observed(probe, 'native-pcm-flush', () => captures[0]!.flush(), 10000);
    const rebuild: Record<string,unknown> = {};
    if (tier !== 'main-serial' && delayFrames === 3 && count === 4) {
      const old = consumer; channel.port1.postMessage({ poison: true });
      await observed(probe, 'app-rebuild-fault', () => wait(() => running.execution.report().engine.health === 'faulted', 30000), 30000);
      const beforeIdentity = running.execution.report().world.identity;
      const rebuilt = await observed(probe, 'rebuild', () => running.execution.rebuild()); if (!rebuilt.ok) throw rebuilt.error;
      await observed(probe, 'rebuilt-capture-ready', () => captureReady);
      const frameBaseline = running.execution.report().frame.completed, feedbackBaseline = hostAudioFrames.length;
      feedback.length = 0; running.start().unwrap();
      const freshCapture = captures.at(-1);
      assert(freshCapture && freshCapture !== captures[0], 'rebuild must own fresh native capture');
      await observed(probe, 'rebuilt60-and-native-PCM', () => wait(() =>
        running.execution.report().frame.completed >= frameBaseline + 60 && hostAudioFrames.length >= feedbackBaseline + 60 &&
        feedback.some(state => state.receipts.some(receipt => receipt.requestId === 2 && receipt.status === 'applied')) && freshCapture.onsets.length >= count * 2, 90000));
      await observed(probe, 'rebuilt-pcm-flush', () => freshCapture.flush(), 10000);
      const freshReport = running.execution.report(), freshState = feedback.at(-1);
      if (tier === 'shared') assert(freshReport.kernelDispatch.usedShared, 'rebuilt shared mode must execute real shared kernel');
      const freshOrigin = freshState?.receipts.find(receipt => receipt.requestId === 1)?.targetTime;
      const freshReceipt = freshState?.receipts.find(receipt => receipt.requestId === 2);
      assert(freshOrigin !== undefined && freshReceipt?.targetBeat !== undefined && freshReceipt.targetTime !== undefined, 'rebuilt musical origin/receipt missing');
      const freshTarget = Math.round((freshOrigin + freshReceipt.targetBeat * 0.5) * freshCapture.context.sampleRate);
      assert(Math.abs(Math.round(freshReceipt.targetTime * freshCapture.context.sampleRate) - freshTarget) <= 1, 'rebuilt target disagrees with independent tempo/origin');
      const freshRaw = Array.from({length:count}, (_, stem) => {
        const expectedSample = freshTarget + stem * 32;
        const actual = freshCapture.onsets.find(row => Math.abs(row.sample - expectedSample) <= 1);
        assert(actual && Math.abs(actual.amplitude - (input[stem] ?? NaN) * 0.1) < 1e-6, 'rebuilt native PCM stem missing or wrong gain');
        return {stem, expectedSample, actualSample:actual.sample, amplitude:actual.amplitude, error:actual.sample-expectedSample};
      });
      await retain(`rebuilt-${tier}-${count}-${delayFrames}`, {frameBaseline, feedbackBaseline, freshReport, freshState, raw:freshRaw, onsets:freshCapture.onsets,
        pcmStartSample:freshCapture.pcmStartSample, wav:captureWav(freshCapture, true)});
      Object.assign(rebuild, {frameBaseline, newCompletedFrames:freshReport.frame.completed-frameBaseline, newHostFeedback:hostAudioFrames.length-feedbackBaseline,
        freshReport, freshState, raw:freshRaw, pcmArtifact:`rebuilt-${tier}-${count}-${delayFrames}.wav`});
      assert(old?.state().activeSourceCount === 0 && contexts[0]?.state === 'closed' && running.execution.report().world.identity !== beforeIdentity, 'rebuild retained old musical owner');
      Object.assign(rebuild,{ old: old?.state(), contextState: contexts[0]?.state, beforeIdentity, afterIdentity: running.execution.report().world.identity });
    }
    const hostAudioCost = stats(hostAudioFrames.map(row => row.totalMs));
    return { tier, count, delayFrames, initial, after, last, input, relative, onsets, deadline, envelopes, rebuild, hostAudioFrames, hostAudioCost, wav: captures[0] ? captureWav(captures[0], true) : [],
      componentIdentities, commandTrace, createMs, first60Ms, musicIntentCount, musicIntentBytes,
      pcmStartSample: captures[0]?.pcmStartSample, rhiCapture,
      pass: hostAudioCost.p95 <= 4 && (tier === 'main-serial' || (after.performance.hostAudioMs?.p95 ?? Infinity) <= 4) };
  } catch(error) {
    await retain(`failed-app-${tier}-${count}-${delayFrames}-${falsifier?'immediate':'quantized'}`,{
      failure:String(error),report:running.execution.report(),input:inputForEvidence,feedback,hostAudioFrames,
      immediate, ordinaryPlayIntents, contextTime:contexts.at(-1)?.currentTime,
      componentIdentities, commandTrace, deadline, createMs, musicIntentCount, musicIntentBytes,
      contextStates:contexts.map(context=>context.state),onsets:captures[0]?.onsets,
      pcmStartSample:captures[0]?.pcmStartSample,pcmMismatchEvidence,wav:captures[0]?captureWav(captures[0]):[]});
    throw error;
  } finally {
    try { const disposed = await observed(probe, 'dispose', () => running.dispose(), 10000); if (!disposed.ok) throw disposed.error; }
    finally {
      channel.port1.close(); canvas.remove();
      for (const context of contexts)
        await observed(probe, 'app-context-close', () => closeContext(context), 10000);
    }
  }
}

async function audible(disabled = false) {
  const context = new OfflineAudioContext(1, 48000 * 12, 48000);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  const backend = createAudioIntentBackend({ emit: intent => consumer.consume(structuredClone(intent)), state: () => consumer.state() });
  try {
    consumer.prepareMusic(1, await load(4, 2400));
    await wait(() => backend.getState().music?.phase === 'ready');
    const epoch = backend.getState().music?.epoch ?? -1;
    const layers = [[1,1,1,disabled?0:1], [1,0,0,0], [1,1,0.6,disabled?0:0.8], [0,0,0,0]];
    layers.forEach((gains,index) => backend.music({ kind:'mix', requestId:index+2,epoch,gains,boundary:'bar',atBeat:index*4,late:'reject',fadeBeats:index?1:0 }));
    const admitted = consumer.state();
    const pcm = (await context.startRendering()).getChannelData(0);
    const rms = Math.sqrt(pcm.reduce((sum,value) => sum+value*value,0)/pcm.length);
    const peak = pcm.reduce((maximum,value)=>Math.max(maximum,Math.abs(value)),0);
    return { disabled, rms, peak, admitted, wav:Array.from(pcmWav(pcm)), waveform:Array.from({length:2400},(_,index)=>pcm[index*240]??0) };
  } finally { consumer.dispose(); }
}

async function realtime() {
  const context = new AudioContext({ sampleRate: 48000 });
  await context.resume();
  const engine = new WebAudioEngine({ context });
  const consumer = createHostAudioConsumer(engine);
  const backend = createAudioIntentBackend({ emit: intent => consumer.consume(structuredClone(intent)), state: () => consumer.state() });
  try {
    const capture = await recorder(context, engine, 600);
    const score = await load(4);
    const input = await inputAmplitudes(context, score);
    consumer.prepareMusic(1, score);
    await wait(() => backend.getState().music?.phase === 'ready');
    const epoch = backend.getState().music?.epoch ?? -1;
    for (let beat = 1; beat <= 101; beat++) backend.music({ kind: 'mix', requestId: beat+1,
      epoch, boundary: 'beat', atBeat: beat, late: 'reject', gains: Array.from({ length: 4 }, () => beat % 2 ? 0.5 : 1) });
    const admitted = consumer.state();
    const first = admitted.music?.receipts.find(row => row.requestId === 2)?.targetTime;
    assert(first !== undefined && admitted.music?.pending === 101, 'realtime complete command queue admission');
    const observations = [];
    while (context.currentTime < first + 600) {
      await sleep(1000);
      const state = consumer.state();
      observations.push({ contextTime: context.currentTime, state });
      document.querySelector('#status')!.textContent = `Real AudioContext: ${(context.currentTime-first).toFixed(1)} / 600 seconds`;
    }
    await observed('realtime-600', 'complete-PCM-transfer', () => wait(() => capture.pcm.reduce((sum, row) => sum + row.pcm.length, 0) === 48000 * 600, 30000), 30000);
    let capturedFrames = 0;
    for (const row of capture.pcm) { assert(row.sample === capturedFrames, 'native PCM contains missing or overlapping chunk'); capturedFrames += row.pcm.length; }
    assert(capturedFrames === 48000 * 600 && capture.pcmStartSample !== undefined, 'native PCM must contain all 600 audio seconds');
    await observed('realtime-600', 'complete-PCM-export', () => retainNativePcm('realtime-600-native-output', capture, 600, retain), 30000);
    await retain('realtime-600-native-output',{admitted,observations,onsets:capture.onsets,capturedFrames,
      captureRanges:capture.pcm.map(row=>({sample:row.sample,frames:row.pcm.length})),
      pcmStartSample:capture.pcmStartSample,pcmFrames:48000*600,format:'IEEE float32 WAV'});
    // AudioWorklet currentFrame is independent of transport metadata and World time.
    const target = Math.round(first * 48000), raw = [];
    let maximum = 0;
    for (let beat = 0; beat < 1200; beat++) for (let stem = 0; stem < 4; stem++) {
      const expectedSample = target + beat * 24000 + stem * 32;
      const weight = Math.min(beat + 1, 101) % 2 ? 0.5 : 1;
      const expectedAmplitude = (input[stem] ?? NaN)*weight;
      const found = capture.onsets.find(row => Math.abs(row.sample-expectedSample)<=1 && Math.abs(row.amplitude-expectedAmplitude)<1e-6);
      assert(found, `realtime missing independent PCM pulse at beat ${beat}, stem ${stem}`);
      const error = found.sample-expectedSample; maximum = Math.max(maximum,Math.abs(error));
      raw.push({ beat, stem, expectedSample, actualSample: found.sample, expectedAmplitude, actualAmplitude: found.amplitude, error });
    }
    const before = consumer.state(); consumer.dispose(); await context.close();
    const released = consumer.state();
    assert(released.activeSourceCount === 0 && released.cache?.sources === 0 && released.music?.pending === 0, 'realtime release');
    return { seconds: 600, raw, input, maxSampleError: maximum, observations, admitted, before, released, baseLatency: context.baseLatency, outputLatency: context.outputLatency,
      pcmStartSample: capture.pcmStartSample, pcmFrames:capturedFrames, pcmArtifact:'realtime-600-native-output.wav', pass: maximum <= 1 };
  } finally { consumer.dispose(); if (context.state !== 'closed') await context.close(); }
}


async function run(short = false, effectsOnly = false) {
  const signals: Awaited<ReturnType<typeof offline>>[] = [];
  for (const count of [1,4,16]) { const row = await offline(count); signals.push(row); await retain(`signal-${count}`, row); };
  const disabled = await offline(4,56,true); await retain("disabled", disabled);
  assert(signals[1]?.raw.some(row=>row.stem===3 && row.actualAmplitude>0) && disabled.raw.every(row=>row.stem!==3 || row.actualAmplitude===0), 'disabled stem falsifier ineffective');
  const listening = [await audible(), await audible(true)];
  assert(Math.abs((listening[0]?.rms??0)-(listening[1]?.rms??0)) > 0.001, 'audible disabled-layer falsifier');
  for (const [index,row] of listening.entries()) {
    const player = document.createElement('audio'); player.controls=true;
    player.src=URL.createObjectURL(new Blob([new Uint8Array(row.wav)],{type:'audio/wav'}));
    await retain(`listening-${index?'B-disabled-melody':'A-full'}`,row);
    const label=document.createElement('p');label.textContent=index?'B: melody disabled':'A: four layers / next-bar replacement / one-beat fades';
    document.body.append(label,player);
  }
  const long = await offline(4,600); await retain("offline-600", long);
  const resampling=[];
  for(const commonPhase of [false,true]) {const row=await resampled(commonPhase);resampling.push(row);await retain(`resampled-${commonPhase?'common':'fractional'}-600`,row);}
  const rows = [];
  if (!effectsOnly) for (let round=0;round<5;round++) for (const stems of round%2?[16,4,1]:[1,4,16]) for (const pending of round%2?[128,32,1]:[1,32,128]) { const row = await performanceRound(stems,pending,round); rows.push(row); await retain(`performance-${stems}-${pending}-${round}`, row); }
  const failures: {probe:string;failure:string}[] = [];
  const apps = [];
  if (!short) for (const tier of ['main-serial','engine-worker','shared']) for(const count of [1,4,16]) for(const delay of [0,1,3]) { try {
    const row = await app(tier,count,delay);
    await retain(`app-${tier}-${count}-${delay}`, row);
    apps.push(row);
  }
    catch(error) {failures.push({probe:`app-${tier}-${count}-${delay}`,failure:String(error)});} }
  const immediate = [];
  if (!short) for (const tier of ['main-serial','engine-worker','shared']) {
    try {const row = await app(tier, 4, 3, true); await retain(`immediate-${tier}`, row); immediate.push(row);}
    catch(error) {failures.push({probe:`immediate-${tier}`,failure:String(error)});}
  }
  let live: Awaited<ReturnType<typeof realtime>> | undefined;
  if(!short) try {live=await realtime();await retain("realtime-600",live);}
  catch(error){failures.push({probe:"realtime-600",failure:String(error)});}
  const pass = failures.length===0 && (short || (apps.length===27 && immediate.length===3 && live?.pass===true))
    && rows.every(row=>row.pass) && apps.every(row=>row.pass);
  document.querySelector('#status')!.textContent = `${pass?'PASS':'FAIL'}: native onset / 101 transitions / 600 audio seconds / shared public consumer`;
  document.querySelector('#metrics')!.innerHTML = '<tr><th>Stems / pending / round</th><th>Cold ms</th><th>Schedule p50 / p95 ms</th><th>Cancel p50 / p95 ms</th></tr>'+rows.map(row=>`<tr><td>${row.stems} / ${row.pending} / ${row.round}</td><td>${row.coldMs.toFixed(2)}</td><td>${row.schedule.p50.toFixed(3)} / ${row.schedule.p95.toFixed(3)}</td><td>${row.cancel.p50.toFixed(3)} / ${row.cancel.p95.toFixed(3)}</td></tr>`).join('');
  const canvas = document.querySelector<HTMLCanvasElement>('#wave');
  if(canvas) { const draw=canvas.getContext('2d'); if(draw) { draw.strokeStyle='#69dfb0';draw.beginPath();signals[1]?.waveform.forEach((value,index)=>{ const x=index/(signals[1]?.waveform.length??1)*1400,y=230-value*400;if(index)draw.lineTo(x,y);else draw.moveTo(x,y); });draw.stroke(); } }
  document.querySelector('#summary')!.textContent = JSON.stringify({ userAgent:navigator.userAgent, maxSampleError:Math.max(...signals.map(row=>row.maxError)), longSeconds:long.seconds, apps:apps.map(row=>({tier:row.tier,count:row.count,delay:row.delayFrames,pass:row.pass})) },null,2);
  return { pass, acceptanceComplete: pass && !short && !effectsOnly,
    scope: effectsOnly ? 'functional diagnostics; performance matrix not sampled' : short ? 'short diagnostics; App/realtime absent' : 'complete frozen workload',
    userAgent:navigator.userAgent, signals, disabled, listening, long, resampling, live, rows, apps, immediate, failures };
}
// An additional installed-SDK consumer witness; the complete workspace workload
// above still owns all performance rounds, App combinations and 600-second PCM.
async function runInstalledSdk() {
  const signal=await offline(4), disabled=await offline(4,56,true);
  await retain('sdk-offline-four',signal); await retain('sdk-disabled-stem',disabled);
  assert(disabled.raw.filter(row=>row.stem===3).every(row=>row.actualAmplitude===0),'installed disabled stem falsifier');
  const apps=[], immediate=[];
  for(const tier of ['main-serial','engine-worker','shared']) {
    const row=await app(tier,4,3);await retain(`sdk-app-${tier}`,row);apps.push(row);
    const negative=await app(tier,4,3,true);await retain(`sdk-immediate-${tier}`,negative);immediate.push(negative);
  }
  return {pass:apps.every(row=>row.pass),scope:'installed public SDK ordinary music resource/App witness; complete acceptance is separate',signal,disabled,apps,immediate};
}
(globalThis as any).__musicEvidence = { run, runInstalledSdk, app };
