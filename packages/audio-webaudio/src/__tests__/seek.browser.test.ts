import { expect, it } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';
import { toneWav } from './support-tone';

const options = { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' as const };

function ramp(context: BaseAudioContext) {
  const buffer = context.createBuffer(1, 192000, 48000);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = 0.1 + (i / 48000) * 0.2;
  return buffer;
}

it('selects the audible tone segment at the requested start and seek', async () => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  const buffer = context.createBuffer(1, 144000, 48000);
  const input = buffer.getChannelData(0);
  for (let i = 0; i < input.length; i++) {
    const frequency = (Math.floor(i / 48000) + 1) * 440;
    input[i] = Math.sin((2 * Math.PI * frequency * i) / 48000) * 0.25;
  }
  engine.play(1, buffer, { ...options, fromPosition: 1 });
  const seek = context.suspend(0.5);
  const rendering = context.startRendering();
  await seek;
  engine.seek(1, 0);
  await context.resume();
  const data = (await rendering).getChannelData(0);
  const frequency = (from: number, to: number) => {
    let crossings = 0,
      first = 0,
      last = 0;
    for (let i = from + 1; i < to; i++)
      if ((data[i - 1] ?? 0) <= 0 && (data[i] ?? 0) > 0) {
        if (crossings === 0) first = i;
        last = i;
        crossings++;
      }
    // Count complete periods, avoiding a partial-window crossing bias.
    return ((crossings - 1) * 48000) / (last - first);
  };
  expect(frequency(4800, 16800)).toBeCloseTo(880, 0);
  expect(frequency(28800, 40800)).toBeCloseTo(440, 0);
  engine.destroy();
});

it('starts at clip seconds and seeks the native output while retaining the graph and rate', async () => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  engine.play(1, ramp(context), { ...options, fromPosition: 1, playbackRate: 2 });
  engine
    .setFilters(1, (ctx) => {
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      return [gain];
    })
    .unwrap();
  const analyser = engine.createAnalyser(1).unwrap();
  const suspend = context.suspend(0.25);
  const rendering = context.startRendering();
  await suspend;
  engine.seek(1, 2);
  expect(engine.getPlaybackPosition(1)).toBe(2);
  expect(engine.createAnalyser(1).unwrap()).toBe(analyser);
  expect(engine.getActiveSourceCount()).toBe(1);
  const seekTime = context.currentTime;
  await context.resume();
  const data = (await rendering).getChannelData(0);
  expect(data[4800]).toBeCloseTo((0.1 + 1.2 * 0.2) * 0.5, 5);
  expect(data[24000]).toBeCloseTo((0.1 + (2 + (0.5 - seekTime) * 2) * 0.2) * 0.5, 5);
  engine.destroy();
});

it('seeks while paused, wraps loops, rejects invalid positions, and ends one-shots at duration', async () => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  const buffer = ramp(context);
  engine.play(1, buffer, { ...options, loop: true, paused: true, fromPosition: 9 });
  expect(engine.getPlaybackPosition(1)).toBe(1);
  engine.seek(1, 6);
  expect(engine.getPlaybackPosition(1)).toBe(2);
  for (const invalid of [-1, NaN, Infinity]) engine.seek(1, invalid);
  expect(engine.getPlaybackPosition(1)).toBe(2);
  expect(engine.getActiveSourceCount()).toBe(0);
  engine.setPaused(1, false);
  engine.play(2, buffer, { ...options, paused: true, fromPosition: 1 });
  engine.seek(2, 4);
  expect(engine.getPlaybackPosition(2)).toBeUndefined();
  engine.play(3, buffer, { ...options, fromPosition: 5 });
  expect(engine.getPlaybackPosition(3)).toBeUndefined();
  engine.seek(99, 0);
  const data = (await context.startRendering()).getChannelData(0);
  expect(data[4800]).toBeCloseTo(0.1 + 2.1 * 0.2, 5);
  engine.destroy();
  expect(engine.getActiveSourceCount()).toBe(0);
});

it('transports start and paused seek from a real ECS Worker through pending native decode', async () => {
  const worker = new Worker(new URL('./support/audio-controls.worker.ts', import.meta.url), {
    type: 'module',
  });
  const context = new AudioContext();
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  const received: import('@forgeax/engine-audio').AudioIntent[] = [];
  let ready = false;
  let failure: string | undefined;
  worker.onerror = (event) => {
    failure = event.message;
  };
  worker.onmessage = (event) => {
    if (event.data.kind === 'ready') {
      ready = true;
      return;
    }
    received.push(event.data);
    consumer.consume(event.data);
  };
  try {
    await expect
      .poll(
        () => {
          if (failure) throw new Error(failure);
          return ready;
        },
        { timeout: 15000 },
      )
      .toBe(true);
    worker.postMessage({
      kind: 'start',
      bytes: toneWav(),
      controls: { paused: true, fromPosition: 0.25 },
    });
    await expect.poll(() => received.length).toBe(1);
    const play = received[0];
    if (play?.kind !== 'play') throw new Error('missing Worker play');
    const entity = play.entityId;
    await expect.poll(() => consumer.engine.getPlaybackPosition(entity)).toBe(0.25);
    worker.postMessage({ kind: 'control', controls: { fromPosition: 0.5 } });
    await expect.poll(() => consumer.engine.getPlaybackPosition(entity)).toBe(0.5);
    expect(consumer.state().activeSourceCount).toBe(0);
    await context.resume();
    worker.postMessage({ kind: 'control', controls: { paused: false } });
    await expect.poll(() => consumer.state().activeSourceCount).toBe(1);
    worker.postMessage({ kind: 'control', controls: { playing: false } });
    await expect.poll(() => consumer.engine.getPlaybackPosition(entity)).toBeUndefined();
    expect(received.map((intent) => intent.kind)).toEqual(['play', 'seek', 'set-paused', 'stop']);
  } finally {
    worker.terminate();
    consumer.dispose();
    await context.close();
  }
});

it('keeps a paused seek silent until resume at the requested clip sample', async () => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  engine.play(1, ramp(context), options);
  const pause = context.suspend(0.125),
    seek = context.suspend(0.25),
    resume = context.suspend(0.5);
  const rendering = context.startRendering();
  await pause;
  engine.setPaused(1, true);
  await context.resume();
  await seek;
  engine.seek(1, 2);
  expect(engine.getPlaybackPosition(1)).toBe(2);
  await context.resume();
  await resume;
  expect(engine.getPlaybackPosition(1)).toBe(2);
  engine.setPaused(1, false);
  const resumedAt = context.currentTime;
  await context.resume();
  const data = (await rendering).getChannelData(0);
  expect(data.slice(9600, 23040).every((sample) => sample === 0)).toBe(true);
  expect(data[28800]).toBeCloseTo(0.1 + (2 + 0.6 - resumedAt) * 0.2, 5);
  engine.destroy();
});
