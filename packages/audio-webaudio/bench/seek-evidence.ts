import { AudioSource, audioTickSystem, createAudioIntentBackend } from '@forgeax/engine-audio';
import { World, type EntityHandle } from '@forgeax/engine-ecs';
import { WebAudioEngine } from '../src/web-audio-engine';
import { createHostAudioConsumer } from '../src/host-audio-consumer';
import { pcmWav, toneWav } from '../src/__tests__/support-tone';

const options = { loop: false, volume: 1, spatialBlend: 0, bus: 'music' as const };
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
const assert = (condition: boolean, reason: string) => { if (!condition) throw new Error(reason); };

async function signal(fixture: 'ramp' | 'tones' = 'ramp') {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  const buffer = context.createBuffer(1, 192000, 48000);
  const input = buffer.getChannelData(0);
  const sampleAt = (position: number) => fixture === 'ramp'
    ? 0.1 + position * 0.2
    : Math.sin(2 * Math.PI * (Math.floor(position) + 1) * 440 * position) * 0.25;
  for (let i = 0; i < input.length; i++) input[i] = sampleAt(i / 48000);
  engine.play(1, buffer, { ...options, fromPosition: 1 });
  const seek = context.suspend(0.25), pause = context.suspend(0.5), pausedSeek = context.suspend(0.625), resume = context.suspend(0.75);
  const rendering = context.startRendering();
  await seek;
  engine.seek(1, 2);
  const seekAt = context.currentTime;
  await context.resume();
  await pause;
  engine.setPaused(1, true);
  const pauseAt = context.currentTime;
  await context.resume();
  await pausedSeek;
  engine.seek(1, 0.5);
  await context.resume();
  await resume;
  assert(engine.getPlaybackPosition(1) === 0.5, 'paused seek position drifted');
  const resumeAt = context.currentTime;
  engine.setPaused(1, false);
  await context.resume();
  const output = (await rendering).getChannelData(0);
  let maxError = 0;
  for (let i = 0; i < output.length; i++) {
    const t = i / 48000;
    // Exclude only the existing 10 ms pause/resume gain ramps.
    if (t >= pauseAt && t < pauseAt + 0.012 || t >= resumeAt && t < resumeAt + 0.012) continue;
    const expected = t < seekAt ? sampleAt(1 + t)
      : t < pauseAt ? sampleAt(2 + t - seekAt)
      : t < resumeAt ? 0 : sampleAt(0.5 + t - resumeAt);
    maxError = Math.max(maxError, Math.abs(output[i]! - expected));
  }
  assert(maxError < 0.00001, `native seek sample error ${maxError}`);
  engine.destroy();
  if (fixture === 'ramp') {
  const canvas = document.querySelector<HTMLCanvasElement>('#wave')!;
  const draw = canvas.getContext('2d')!;
  draw.strokeStyle = '#71e4b7'; draw.beginPath();
  for (let x = 0; x < 1200; x++) {
    const y = 235 - output[Math.floor(x / 1200 * output.length)]! * 300;
    if (x === 0) draw.moveTo(x, y); else draw.lineTo(x, y);
  }
  draw.stroke(); draw.fillStyle = '#9eb2c9';
  for (const [t, label] of [[0, 'start at 1 s'], [seekAt, 'seek 2 s'], [pauseAt, 'pause'], [resumeAt, 'resume 0.5 s']] as const)
    draw.fillText(label, t * 1200 + 8, 22);
  }
  return { output, maxError, seekAt, pauseAt, resumeAt, tolerance: 0.00001 };
}

async function workload(sourceCount: number, mode: 'active' | 'paused' | 'unchanged') {
  const context = new AudioContext();
  await context.resume();
  const engine = new WebAudioEngine({ context });
  const consumer = createHostAudioConsumer(engine);
  const world = new World();
  let createdSources = 0, createdGains = 0, decodes = 0, intents = 0;
  const sourceFactory = context.createBufferSource.bind(context), gainFactory = context.createGain.bind(context), decode = engine.decode.bind(engine);
  context.createBufferSource = () => { createdSources++; return sourceFactory(); };
  context.createGain = () => { createdGains++; return gainFactory(); };
  engine.decode = bytes => { decodes++; return decode(bytes); };
  const backend = createAudioIntentBackend({ emit: intent => { intents++; consumer.consume(intent); } });
  const clip = world.allocSharedRef('AudioClipAsset', { kind: 'audio', sourceKey: 'seek-bench', bytes: toneWav() });
  const entities: EntityHandle[] = [];
  try {
    for (let i = 0; i < sourceCount; i++) entities.push(world.spawn({ component: AudioSource, data: {
      clip, playing: true, paused: mode === 'paused', loop: true, volume: 0.0001,
    } }).unwrap());
    audioTickSystem(world, backend);
    const deadline = performance.now() + 10000;
    while (engine.getPlaybackPosition(entities.at(-1)! as number) === undefined) {
      assert(performance.now() < deadline, 'decode admission timed out');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const times: number[] = [];
    const before = { sources: createdSources, gains: createdGains, decodes, intents };
    for (let batch = -20; batch < 120; batch++) {
      const start = performance.now();
      if (mode !== 'unchanged') for (const entity of entities)
        world.set(entity, AudioSource, { fromPosition: batch % 2 === 0 ? 0.25 : 0.5 }).unwrap();
      audioTickSystem(world, backend);
      if (batch >= 0) times.push(performance.now() - start);
      // Allow the native control thread to retire old one-shot nodes.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const delta = { sources: createdSources - before.sources, gains: createdGains - before.gains, decodes: decodes - before.decodes, intents: intents - before.intents };
    assert(delta.gains === 0 && delta.decodes === 0, 'seek rebuilt gains or decoded again');
    assert(delta.sources === (mode === 'active' ? sourceCount * 140 : 0), 'source allocation invariant');
    assert(delta.intents === (mode === 'unchanged' ? 0 : sourceCount * 140), 'intent edge invariant');
    for (const entity of entities) world.despawn(entity).unwrap();
    audioTickSystem(world, backend);
    const cleanup = { active: engine.getActiveSourceCount(), retained: entities.filter(entity => engine.getPlaybackPosition(entity as number) !== undefined).length };
    assert(cleanup.active === 0 && cleanup.retained === 0, 'despawn leaked sources');
    return { sourceCount, mode, warmupBatches: 20, measuredBatches: 120, cpuMs: { p50: percentile(times, 0.5), p95: percentile(times, 0.95), p99: percentile(times, 0.99) }, rawMs: times, delta, cleanup };
  } finally { backend.destroy(); await context.close(); }
}

async function run() {
  const rendered = await signal();
  const audible = await signal('tones');
  const rows = [];
  for (const sourceCount of [1, 32, 128, 256]) for (const mode of ['unchanged', 'paused', 'active'] as const)
    rows.push(await workload(sourceCount, mode));
  const nativeBaseline = [];
  for (const sourceCount of [1, 32, 128, 256]) nativeBaseline.push(await nativeRestart(sourceCount));
  const budgetMs = 1000 / 60;
  const budgetPass = rows.every(row => row.cpuMs.p95 < budgetMs);
  document.querySelector('#signal')!.textContent = `PASS · maximum sample error ${rendered.maxError.toExponential(3)} (limit ${rendered.tolerance})`;
  document.querySelector('#performance')!.innerHTML = '<tr><th>Sources / mode</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>New sources (140 batches)</th></tr>' + rows.map(row => `<tr><td>${row.sourceCount} / ${row.mode}</td><td>${row.cpuMs.p50.toFixed(3)}</td><td>${row.cpuMs.p95.toFixed(3)}</td><td>${row.cpuMs.p99.toFixed(3)}</td><td>${row.delta.sources}</td></tr>`).join('');
  document.querySelector('#cleanup')!.textContent = `${budgetPass ? 'PASS' : 'FAIL'} · p95 batch budget ${budgetMs.toFixed(3)} ms · cleanup and node allocation invariants PASS`;
  document.querySelector('#summary')!.textContent = `${navigator.userAgent} · ${new Date().toISOString()}`;
  return { status: budgetPass ? 'pass' : 'performance-fail', budgetMs, rows, nativeBaseline, sampleRate: 48000,
    signal: { ...rendered, output: undefined }, audible: { ...audible, output: undefined }, userAgent: navigator.userAgent,
    audioFiles: { 'seek-pause-resume.wav': Array.from(pcmWav(rendered.output)),
      'seek-tone-markers.wav': Array.from(pcmWav(audible.output)) } };
}

// Diagnostic lower bound: identical one-shot replacement on native Web Audio,
// without ECS scanning or intent transport. Never substitute this for workload().
async function nativeRestart(sourceCount: number) {
  const context = new AudioContext();
  await context.resume();
  const buffer = await context.decodeAudioData(toneWav().buffer as ArrayBuffer);
  const master = context.createGain(), sfx = context.createGain(), music = context.createGain();
  master.connect(context.destination); sfx.connect(master); music.connect(master);
  const gains: GainNode[] = [], sources: AudioBufferSourceNode[] = [], rawMs: number[] = [];
  const startSource = (gain: GainNode, offset: number) => {
    const node = context.createBufferSource();
    node.buffer = buffer; node.loop = true; node.playbackRate.value = 1;
    node.connect(gain); node.start(0, offset);
    return node;
  };
  try {
    for (let i = 0; i < sourceCount; i++) {
      const gain = context.createGain(); gain.gain.value = 0.0001; gain.connect(music);
      gains.push(gain); sources.push(startSource(gain, 0));
    }
    for (let batch = -20; batch < 120; batch++) {
      const start = performance.now();
      for (let i = 0; i < sourceCount; i++) {
        sources[i]!.stop(); sources[i]!.disconnect();
        sources[i] = startSource(gains[i]!, batch % 2 === 0 ? 0.25 : 0.5);
      }
      if (batch >= 0) rawMs.push(performance.now() - start);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { sourceCount, cpuMs: { p50: percentile(rawMs, 0.5), p95: percentile(rawMs, 0.95), p99: percentile(rawMs, 0.99) }, rawMs };
  } finally {
    for (const source of sources) { source.stop(); source.disconnect(); }
    for (const gain of gains) gain.disconnect();
    sfx.disconnect(); music.disconnect(); master.disconnect();
    await context.close();
  }
}
Object.assign(globalThis, { __audioEvidence: { run } });
