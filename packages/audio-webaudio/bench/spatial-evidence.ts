import {
  AudioSource,
  type AudioIntent,
  type AudioSourcePose,
  audioTickSystem,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import { World } from '@forgeax/engine-ecs';
import { GlobalTransform } from '@forgeax/engine-scene';
import { WebAudioEngine } from '../src/web-audio-engine';
import { createHostAudioConsumer } from '../src/host-audio-consumer';
import { rms, toneBuffer } from '../src/__tests__/support-tone';

const options = { loop: true, volume: 1, spatialBlend: 1, bus: 'sfx' as const };
const pose = (x: number, z = 0): AudioSourcePose => ({
  positionX: x,
  positionY: 0,
  positionZ: z,
  forwardX: 0,
  forwardY: 0,
  forwardZ: -1,
});
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
const energy = (output: AudioBuffer, channel: number, from = 0.1, to = 0.9) =>
  rms(output.getChannelData(channel), Math.round(from * 48000), Math.round(to * 48000));
function stereoWav(buffer: AudioBuffer): number[] {
  const bytes = new Uint8Array(44 + buffer.length * 4),
    view = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const)
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 192000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, buffer.length * 4, true);
  for (let i = 0; i < buffer.length; i++)
    for (let channel = 0; channel < 2; channel++)
      view.setInt16(
        44 + i * 4 + channel * 2,
        Math.round(Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i] ?? 0)) * 32767),
        true,
      );
  return [...bytes];
}
async function signal(x: number, z = 0, forwardZ = -1, cone = false, spatialBlend = 1) {
  const context = new OfflineAudioContext(2, 48000, 48000),
    engine = new WebAudioEngine({ context });
  engine.play(1, toneBuffer(context, [440]), {
    ...options,
    spatialBlend,
    sourcePose: { ...pose(x, z), forwardZ },
    ...(cone ? { coneInnerAngle: 30, coneOuterAngle: 60, coneOuterGain: 0.1 } : {}),
  });
  const output = await context.startRendering();
  engine.destroy();
  return { left: energy(output, 0), right: energy(output, 1) };
}
async function motion() {
  const context = new OfflineAudioContext(2, 48000, 48000),
    engine = new WebAudioEngine({ context });
  engine.play(1, toneBuffer(context, [440]), { ...options, sourcePose: pose(-1) });
  const move = context.suspend(0.25),
    pause = context.suspend(0.5),
    resume = context.suspend(0.75),
    rendering = context.startRendering();
  await move;
  engine.setSourcePose(1, pose(1));
  await context.resume();
  await pause;
  engine.setPaused(1, true);
  engine.setSourcePose(1, pose(-1));
  await context.resume();
  await resume;
  engine.setPaused(1, false);
  await context.resume();
  const output = await rendering;
  engine.destroy();
  return output;
}
async function cpu(count: number, mode: '2D' | 'static' | 'moving') {
  const context = new AudioContext();
  await context.resume();
  const engine = new WebAudioEngine({ context }),
    consumer = createHostAudioConsumer(engine);
  let panners = 0,
    sourceNodes = 0,
    poseIntents = 0;
  const createPanner = context.createPanner.bind(context),
    createSource = context.createBufferSource.bind(context);
  context.createPanner = () => {
    panners++;
    return createPanner();
  };
  context.createBufferSource = () => {
    sourceNodes++;
    return createSource();
  };
  const buffer = toneBuffer(context, [440]);
  engine.decode = async () => buffer;
  const world = new World(),
    clip = world.allocSharedRef('AudioClipAsset', {
      kind: 'audio',
      sourceKey: 'cpu',
      bytes: Uint8Array.of(1),
    });
  const entities = Array.from({ length: count }, () =>
    world
      .spawn(
        {
          component: AudioSource,
          data: {
            clip,
            playing: true,
            loop: true,
            volume: 0.0001,
            spatialBlend: mode === '2D' ? 0 : 1,
          },
        },
        { component: GlobalTransform, data: {} },
      )
      .unwrap(),
  );
  const emit = (intent: AudioIntent) => {
    if (intent.kind === 'set-source-pose') poseIntents++;
    consumer.consume(intent);
  };
  const backend = createAudioIntentBackend({ emit });
  audioTickSystem(world, backend);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  if (consumer.state().activeSourceCount !== count) throw new Error('sources not admitted');
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1]),
    raw: number[] = [];
  const nodesBefore = { panners, sourceNodes };
  poseIntents = 0;
  for (let frame = 0; frame < 304; frame++) {
    if (mode === 'moving') {
      matrix[12] = frame % 2 === 0 ? 1 : -1;
      for (const entity of entities) world.set(entity, GlobalTransform, { world: matrix }).unwrap();
    }
    const start = performance.now();
    audioTickSystem(world, backend);
    const elapsed = performance.now() - start;
    if (frame >= 64) raw.push(elapsed);
  }
  const expectedIntents = mode === 'moving' ? count * 304 : 0;
  if (
    poseIntents !== expectedIntents ||
    panners !== nodesBefore.panners ||
    sourceNodes !== nodesBefore.sourceNodes
  )
    throw new Error('pose emission or native node reuse falsifier failed');
  const row = {
    count,
    mode,
    p50Ms: percentile(raw, 0.5),
    p95Ms: percentile(raw, 0.95),
    p99Ms: percentile(raw, 0.99),
    poseIntents,
    panners,
    sourceNodes,
    newNodesDuringUpdates: 0,
    raw,
  };
  consumer.dispose();
  if (engine.getActiveSourceCount() !== 0) throw new Error('cleanup failed');
  await context.close();
  return row;
}
function table(id: string, headers: string[], rows: (string | number)[][]) {
  const node = document.getElementById(id);
  if (!node) throw new Error(id);
  node.innerHTML = `<tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((row) => `<tr>${row.map((v) => `<td>${v}</td>`).join('')}</tr>`).join('')}`;
}
function draw(output: AudioBuffer) {
  const canvas = document.getElementById('motion') as HTMLCanvasElement | null,
    ctx = canvas?.getContext('2d');
  if (!ctx) throw new Error('canvas');
  for (const [channel, color] of [
    [0, '#6dcff6'],
    [1, '#ffb976'],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 50; i++) {
      const x = 40 + (i / 49) * 1120,
        y = 180 - energy(output, channel, i * 0.02, (i + 1) * 0.02) * 400;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(channel === 0 ? 'Left channel' : 'Right channel', 40 + channel * 240, 25);
  }
  ctx.fillStyle = '#aebfd3';
  for (let i = 0; i < 5; i++) ctx.fillText(`${i * 0.25} s`, 40 + i * 280, 210);
}
async function run() {
  const signals = {
    right: await signal(1),
    left: await signal(-1),
    far: await signal(4),
    toward: await signal(0, 1, -1, true),
    away: await signal(0, 1, 1, true),
    flat: await signal(100, 0, -1, false, 0),
  };
  const output = await motion();
  draw(output);
  const checks = {
    right: signals.right.left < 1e-5 && signals.right.right > 0.35,
    left: signals.left.right < 1e-5 && signals.left.left > 0.35,
    distance: Math.abs(signals.far.right / signals.right.right - 0.25) < 1e-4,
    cone: Math.abs(signals.away.left / signals.toward.left - 0.1) < 1e-4,
    twoD: Math.abs(signals.flat.left - signals.flat.right) < 1e-5,
    motion: energy(output, 0, 0.3, 0.45) < 1e-5 && energy(output, 1, 0.3, 0.45) > 0.35,
    pause: energy(output, 0, 0.55, 0.7) === 0 && energy(output, 1, 0.55, 0.7) === 0,
    resume: energy(output, 0, 0.8, 0.95) > 0.35 && energy(output, 1, 0.8, 0.95) < 1e-5,
  };
  const rows = [];
  for (const count of [1, 32, 128])
    for (const mode of ['2D', 'static', 'moving'] as const) rows.push(await cpu(count, mode));
  table(
    'signals',
    ['Case', 'Left RMS', 'Right RMS'],
    Object.entries(signals).map(([key, value]) => [
      key,
      value.left.toFixed(6),
      value.right.toFixed(6),
    ]),
  );
  table(
    'performance',
    ['Sources', 'Mode', 'P50 ms', 'P95 ms', 'P99 ms', 'Pose intents'],
    rows.map((r) => [
      r.count,
      r.mode,
      r.p50Ms.toFixed(3),
      r.p95Ms.toFixed(3),
      r.p99Ms.toFixed(3),
      r.poseIntents,
    ]),
  );
  const summary = document.getElementById('summary');
  if (summary) {
    summary.textContent = Object.values(checks).every(Boolean)
      ? 'PASS · all native signal and lifecycle falsifiers satisfied'
      : 'FAIL · preserve negative evidence';
    summary.className = 'pass';
  }
  const cleanup = document.getElementById('cleanup');
  if (cleanup)
    cleanup.textContent =
      'Zero new native nodes during pose updates; every workload stopped all sources and closed its borrowed live context.';
  if (!Object.values(checks).every(Boolean)) throw new Error(JSON.stringify(checks));
  return {
    status: 'PASS',
    signals,
    checks,
    rows,
    sampleRate: 48000,
    warmupTicks: 64,
    measuredTicks: 240,
    audioFiles: { 'moving-source.wav': stereoWav(output) },
  };
}
(globalThis as unknown as { __audioEvidence: { run: typeof run } }).__audioEvidence = { run };
