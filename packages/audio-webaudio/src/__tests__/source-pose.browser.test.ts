import { expect, it } from 'vitest';
import { WebAudioEngine } from '../web-audio-engine';
import { rms, toneBuffer } from './support-tone';

it('renders a right-side ECS play pose into the native right channel', async () => {
  const context = new OfflineAudioContext(2, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  const options = {
    loop: true,
    volume: 1,
    spatialBlend: 1,
    bus: 'sfx' as const,
    sourcePose: {
      positionX: 1,
      positionY: 0,
      positionZ: 0,
      forwardX: 0,
      forwardY: 0,
      forwardZ: -1,
    },
  };
  engine.play(1, toneBuffer(context, [440]), options);
  const output = await context.startRendering();
  expect(rms(output.getChannelData(0), 4800, 43200)).toBeLessThan(1e-5);
  expect(rms(output.getChannelData(1), 4800, 43200)).toBeCloseTo(Math.SQRT1_2 * 0.5, 4);
  engine.destroy();
});

import type { AudioSourcePose } from '@forgeax/engine-audio';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { toneWav } from './support-tone';

const pose = (x: number, z = 0): AudioSourcePose => ({
  positionX: x,
  positionY: 0,
  positionZ: z,
  forwardX: 0,
  forwardY: 0,
  forwardZ: -1,
});
const options = { loop: true, volume: 1, spatialBlend: 1, bus: 'sfx' as const };
const channels = (output: AudioBuffer, from = 0.1, to = 0.9) =>
  [0, 1].map((channel) =>
    rms(
      output.getChannelData(channel),
      Math.round(from * output.sampleRate),
      Math.round(to * output.sampleRate),
    ),
  );

it('renders inverse-distance attenuation and listener-relative left/right with a 2D falsifier', async () => {
  async function render(x: number, listenerX = 0, spatialBlend = 1) {
    const context = new OfflineAudioContext(2, 48000, 48000);
    const engine = new WebAudioEngine({ context });
    engine.setListenerPose({ ...pose(listenerX), upX: 0, upY: 1, upZ: 0 });
    engine.play(1, toneBuffer(context, [440]), { ...options, spatialBlend, sourcePose: pose(x) });
    const result = channels(await context.startRendering());
    engine.destroy();
    return result;
  }
  const near = await render(1),
    far = await render(4),
    left = await render(1, 2),
    flat = await render(100, 0, 0);
  expect((far[1] ?? 0) / (near[1] ?? 0)).toBeCloseTo(0.25, 4);
  expect(left[0]).toBeCloseTo(near[1] ?? 0, 4);
  expect(left[1]).toBeLessThan(1e-5);
  expect(flat[0]).toBeCloseTo(flat[1] ?? 0, 5);
  expect(flat[0]).toBeCloseTo(Math.SQRT1_2 * 0.5, 4);
});

it('changes native channels during playback and retains the moved panner through pause/resume', async () => {
  const context = new OfflineAudioContext(2, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  engine.play(1, toneBuffer(context, [440]), { ...options, sourcePose: pose(-1) });
  const move = context.suspend(0.25),
    pause = context.suspend(0.5),
    resume = context.suspend(0.75);
  const rendering = context.startRendering();
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
  expect(channels(output, 0.1, 0.2)[0]).toBeGreaterThan(0.35);
  expect(channels(output, 0.3, 0.45)[0]).toBeLessThan(1e-5);
  expect(channels(output, 0.3, 0.45)[1]).toBeGreaterThan(0.35);
  expect(channels(output, 0.55, 0.7)).toEqual([0, 0]);
  expect(channels(output, 0.8, 0.95)[0]).toBeGreaterThan(0.35);
  expect(channels(output, 0.8, 0.95)[1]).toBeLessThan(1e-5);
  engine.destroy();
});

it('makes source orientation audible with a directional cone and preserves the all-direction default', async () => {
  async function render(forwardZ: number, directional: boolean) {
    const context = new OfflineAudioContext(2, 48000, 48000);
    const engine = new WebAudioEngine({ context });
    engine.play(1, toneBuffer(context, [440]), {
      ...options,
      sourcePose: { ...pose(0, 1), forwardZ },
      ...(directional ? { coneInnerAngle: 30, coneOuterAngle: 60, coneOuterGain: 0.1 } : {}),
    });
    const result = channels(await context.startRendering())[0] ?? 0;
    engine.destroy();
    return result;
  }
  const toward = await render(-1, true),
    away = await render(1, true),
    omni = await render(1, false);
  expect(away / toward).toBeCloseTo(0.1, 4);
  expect(omni / toward).toBeCloseTo(1, 4);
});

it('uses the latest moved pose when native decode finishes, and fences stop/disposal', async () => {
  const context = new OfflineAudioContext(2, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const decode = engine.decode.bind(engine);
  engine.decode = async (bytes) => {
    const buffer = await decode(bytes);
    await gate;
    return buffer;
  };
  const consumer = createHostAudioConsumer(engine);
  consumer.consume({
    kind: 'play',
    entityId: 1,
    sourceKey: 'pending',
    bytes: toneWav(),
    options: { ...options, sourcePose: pose(-1) },
  });
  consumer.consume({ kind: 'set-source-pose', entityId: 1, pose: pose(1) });
  release();
  await expect.poll(() => consumer.state().activeSourceCount).toBe(1);
  const output = channels(await context.startRendering());
  expect(output[0]).toBeLessThan(1e-5);
  expect(output[1]).toBeGreaterThan(0.35);
  consumer.dispose();
  consumer.consume({ kind: 'set-source-pose', entityId: 1, pose: pose(-1) });
  expect(consumer.state().activeSourceCount).toBe(0);
});

it('rejects invalid poses without mutating a valid native panner', async () => {
  const context = new OfflineAudioContext(2, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  engine.play(1, toneBuffer(context, [440]), { ...options, sourcePose: pose(1) });
  engine.setSourcePose(1, { ...pose(-1), positionY: Number.NaN });
  expect(engine.getState().lastError?.code).toBe('control-failed');
  const output = channels(await context.startRendering());
  expect(output[0]).toBeLessThan(1e-5);
  expect(output[1]).toBeGreaterThan(0.35);
  engine.destroy();
});

it('transports a parented ECS source pose from a real Worker into native stereo output', async () => {
  const worker = new Worker(new URL('./support/audio-spatial.worker.ts', import.meta.url), {
    type: 'module',
  });
  const context = new OfflineAudioContext(2, 48000, 48000);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  const received: import('@forgeax/engine-audio').AudioIntent[] = [];
  let ready = false,
    disposed = false,
    workerError: string | undefined;
  worker.onerror = (event) => {
    workerError = event.message;
  };
  worker.onmessage = (event) => {
    if (event.data.kind === 'ready') {
      ready = true;
      return;
    }
    if (event.data.kind === 'disposed') {
      disposed = true;
      return;
    }
    received.push(event.data);
    consumer.consume(event.data);
  };
  try {
    await expect
      .poll(
        () => {
          if (workerError) throw new Error(workerError);
          return ready;
        },
        { timeout: 15000 },
      )
      .toBe(true);
    worker.postMessage({ kind: 'start', bytes: toneWav() });
    await expect.poll(() => consumer.state().activeSourceCount).toBe(1);
    expect(received[0]).toMatchObject({ kind: 'play', options: { sourcePose: { positionX: -1 } } });
    worker.postMessage({ kind: 'move' });
    await expect.poll(() => received.filter((i) => i.kind === 'set-source-pose').length).toBe(1);
    const output = channels(await context.startRendering());
    expect(output[0]).toBeLessThan(1e-5);
    expect(output[1]).toBeGreaterThan(0.35);
    worker.postMessage({ kind: 'dispose' });
    await expect.poll(() => disposed).toBe(true);
    expect(received.at(-1)).toMatchObject({ kind: 'stop' });
    expect(consumer.state().activeSourceCount).toBe(0);
  } finally {
    worker.terminate();
    consumer.dispose();
  }
});

it('changes directional gain when an admitted emitter rotates without moving', async () => {
  const context = new OfflineAudioContext(2, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  engine.play(1, toneBuffer(context, [440]), {
    ...options,
    sourcePose: pose(0, 1),
    coneInnerAngle: 30,
    coneOuterAngle: 60,
    coneOuterGain: 0.1,
  });
  const turn = context.suspend(0.5);
  const rendering = context.startRendering();
  await turn;
  engine.setSourcePose(1, { ...pose(0, 1), forwardZ: 1 });
  await context.resume();
  const output = await rendering;
  const toward = channels(output, 0.1, 0.4)[0] ?? 0;
  const away = channels(output, 0.6, 0.9)[0] ?? 0;
  expect(toward).toBeGreaterThan(0.24);
  expect(away / toward).toBeCloseTo(0.1, 4);
  engine.destroy();
});
