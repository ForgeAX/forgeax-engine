import { expect, it } from 'vitest';
import { WebAudioEngine } from '../web-audio-engine';

it('renders a doubled playback rate through the native signal path', async () => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  const buffer = context.createBuffer(1, 48000, 48000);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
  engine.play(1, buffer, { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx', playbackRate: 2 });
  const rendered = await context.startRendering();
  const data = rendered.getChannelData(0);
  let crossings = 0;
  for (let i = 2401; i < 26400; i++) if ((data[i - 1] ?? 0) <= 0 && (data[i] ?? 0) > 0) crossings++;
  expect(crossings * 2).toBeCloseTo(880, -1);
  engine.destroy();
});

import { createHostAudioConsumer } from '../host-audio-consumer';
import { magnitude, rms, toneBuffer, toneWav } from './support-tone';

it('integrates each rate interval, freezes paused progress, and resumes the native signal at its retained offset', async () => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  const buffer = context.createBuffer(1, 192000, 48000);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.1 + (i / 192000) * 0.8;
  engine.play(1, buffer, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx', playbackRate: 2 });
  const first = context.suspend(0.125),
    pause = context.suspend(0.25),
    resume = context.suspend(0.5);
  const rendering = context.startRendering();
  await first;
  const firstTime = context.currentTime;
  engine.setPlaybackRate(1, 0.5);
  await context.resume();
  await pause;
  const expectedPosition = firstTime * 2 + (context.currentTime - firstTime) * 0.5;
  engine.setPaused(1, true);
  engine.setPaused(1, true);
  expect(engine.getPlaybackPosition(1)).toBeCloseTo(expectedPosition, 6);
  expect(engine.getActiveSourceCount()).toBe(0);
  await context.resume();
  await resume;
  expect(engine.getPlaybackPosition(1)).toBeCloseTo(expectedPosition, 6);
  engine.setPlaybackRate(1, 1);
  engine.setPaused(1, false);
  engine.setPaused(1, false);
  expect(engine.getActiveSourceCount()).toBe(1);
  await context.resume();
  const output = (await rendering).getChannelData(0);
  expect(rms(output, 14400, 23040)).toBe(0);
  expect(output[26400]).toBeCloseTo(0.1 + (expectedPosition + 0.05) * 0.2, 2);
  engine.destroy();
});

it('applies a user biquad + gain chain to the rendered signal and removes it without double routing', async () => {
  async function render(filtered: boolean, remove: boolean) {
    const context = new OfflineAudioContext(1, 48000, 48000);
    const engine = new WebAudioEngine({ context });
    engine.play(1, toneBuffer(context, [440, 8000]), {
      loop: true,
      volume: 1,
      spatialBlend: 0,
      bus: 'sfx',
    });
    if (filtered)
      engine
        .setFilters(1, (ctx) => {
          const lowpass = ctx.createBiquadFilter();
          lowpass.type = 'lowpass';
          lowpass.frequency.value = 1000;
          lowpass.Q.value = 20 * Math.log10(Math.SQRT1_2);
          const gain = ctx.createGain();
          gain.gain.value = 0.5;
          return [lowpass, gain];
        })
        .unwrap();
    if (remove) engine.setFilters(1, () => []).unwrap();
    const output = (await context.startRendering()).getChannelData(0);
    const values = [magnitude(output, 48000, 440), magnitude(output, 48000, 8000)];
    engine.destroy();
    return values;
  }
  const dry = await render(false, false),
    wet = await render(true, false),
    restored = await render(true, true);
  expect((wet[0] ?? 0) / (dry[0] ?? 0)).toBeGreaterThan(0.45);
  expect((wet[0] ?? 0) / (dry[0] ?? 0)).toBeLessThan(0.51);
  expect(20 * Math.log10((wet[1] ?? 0) / (dry[1] ?? 0))).toBeLessThan(-40);
  expect(restored[0]).toBeCloseTo(dry[0] ?? 0, 6);
  expect(restored[1]).toBeCloseTo(dry[1] ?? 0, 6);
});

it('reads a real analyser peak, reuses its node, rejects invalid graph inputs and cleans up', async () => {
  const context = new AudioContext();
  const engine = new WebAudioEngine({ context });
  try {
    await context.resume();
    engine.play(1, toneBuffer(context, [1000]), {
      loop: true,
      volume: 0.01,
      spatialBlend: 0,
      bus: 'sfx',
    });
    const analyser = engine.createAnalyser(1, 4096).unwrap();
    expect(engine.createAnalyser(1, 4096).unwrap()).toBe(analyser);
    analyser.smoothingTimeConstant = 0;
    const data = new Float32Array(analyser.frequencyBinCount);
    await expect
      .poll(() => {
        engine.readFrequencyData(1, data).unwrap();
        let peak = 0;
        for (let i = 1; i < data.length; i++) if ((data[i] ?? 0) > (data[peak] ?? 0)) peak = i;
        return Math.abs((peak * context.sampleRate) / analyser.fftSize - 1000);
      })
      .toBeLessThan(context.sampleRate / analyser.fftSize);
    expect(engine.createAnalyser(1, 33).ok).toBe(false);
    const gain = context.createGain();
    expect(engine.setFilters(1, () => [gain, gain]).ok).toBe(false);
    const foreign = new OfflineAudioContext(1, 128, 48000);
    expect(engine.setFilters(1, () => [foreign.createGain()]).ok).toBe(false);
    engine.play(2, toneBuffer(context, [1000]), {
      loop: true,
      volume: 0,
      spatialBlend: 0,
      bus: 'sfx',
      paused: true,
    });
    expect(engine.setFilters(1, () => [engine.createAnalyser(2).unwrap()]).ok).toBe(false);
    engine.stop(2);
    expect(engine.getActiveSourceCount()).toBe(1);
    engine.setPaused(1, true);
    engine.readFrequencyData(1, data).unwrap();
    expect(data.every((value) => value === -Infinity)).toBe(true);
    expect(engine.readFrequencyData(1, new Float32Array(1)).ok).toBe(false);
    engine.setPaused(1, false);
    engine.removeAnalyser(1);
    engine.removeAnalyser(1);
    engine.stop(1);
    expect(engine.getActiveSourceCount()).toBe(0);
    expect(engine.createAnalyser(1).ok).toBe(false);
  } finally {
    engine.destroy();
    await context.close();
  }
});

it('retains the latest rate and pause while native decoding is pending, then stop fences resume', async () => {
  const context = new AudioContext();
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  try {
    consumer.consume({
      kind: 'play',
      entityId: 7,
      sourceKey: 'pending-controls',
      bytes: toneWav(),
      options: { loop: true, volume: 0.01, spatialBlend: 0, bus: 'music' },
    });
    consumer.consume({ kind: 'set-playback-rate', entityId: 7, playbackRate: 2 });
    consumer.consume({ kind: 'set-paused', entityId: 7, paused: true });
    await expect.poll(() => consumer.engine.getPlaybackPosition(7)).toBe(0);
    expect(consumer.state().activeSourceCount).toBe(0);
    consumer.consume({ kind: 'set-paused', entityId: 7, paused: false });
    await context.resume();
    await expect.poll(() => consumer.engine.getPlaybackPosition(7)).toBeGreaterThan(0.1);
    consumer.consume({ kind: 'stop', entityId: 7 });
    consumer.consume({ kind: 'set-paused', entityId: 7, paused: false });
    expect(consumer.state().activeSourceCount).toBe(0);
    expect(consumer.engine.getPlaybackPosition(7)).toBeUndefined();
  } finally {
    consumer.dispose();
    await context.close();
  }
});

it('transports ECS rate/pause controls from a real Worker to native Host playback', async () => {
  const worker = new Worker(new URL('./support/audio-controls.worker.ts', import.meta.url), {
    type: 'module',
  });
  const context = new AudioContext();
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  const received: import('@forgeax/engine-audio').AudioIntent[] = [];
  let ready = false;
  let workerError: string | undefined;
  worker.onerror = (event) => {
    workerError = event.message;
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
    await context.resume();
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
    const play = received.find((intent) => intent.kind === 'play');
    if (!play || play.kind !== 'play') throw new Error('missing worker play');
    const entity = play.entityId;
    worker.postMessage({ kind: 'control', controls: { playbackRate: 2, paused: true } });
    await expect.poll(() => consumer.state().activeSourceCount).toBe(0);
    const position = consumer.engine.getPlaybackPosition(entity) ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(consumer.engine.getPlaybackPosition(entity)).toBe(position);
    worker.postMessage({ kind: 'control', controls: { paused: false } });
    await expect.poll(() => consumer.state().activeSourceCount).toBe(1);
    worker.postMessage({ kind: 'control', controls: { playing: false } });
    await expect.poll(() => consumer.engine.getPlaybackPosition(entity)).toBeUndefined();
    expect(received.map((intent) => intent.kind)).toEqual([
      'play',
      'set-playback-rate',
      'set-paused',
      'set-paused',
      'stop',
    ]);
  } finally {
    worker.terminate();
    consumer.dispose();
    await context.close();
  }
});

it('wraps looping progress and keeps paused filter/analyser state through resume', async () => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  engine.play(1, toneBuffer(context, [440], 0.1), {
    loop: true,
    volume: 1,
    spatialBlend: 0,
    bus: 'sfx',
    playbackRate: 2,
  });
  const pause = context.suspend(0.25),
    resume = context.suspend(0.5);
  const rendering = context.startRendering();
  await pause;
  engine.setPaused(1, true);
  const position = engine.getPlaybackPosition(1) ?? 0;
  expect(position).toBeCloseTo((context.currentTime * 2) % 0.1, 6);
  engine
    .setFilters(1, (ctx) => {
      const gain = ctx.createGain();
      gain.gain.value = 0.25;
      return [gain];
    })
    .unwrap();
  const analyser = engine.createAnalyser(1).unwrap();
  await context.resume();
  await resume;
  engine.setPaused(1, false);
  expect(engine.createAnalyser(1).unwrap()).toBe(analyser);
  await context.resume();
  const output = (await rendering).getChannelData(0);
  expect(rms(output, 28800, 38400)).toBeCloseTo((0.5 * 0.25) / Math.SQRT2, 3);
  engine.destroy();
});

it('mutes retained effect tails during pause and restores the latest source volume on resume', async () => {
  const context = new OfflineAudioContext(1, 60000, 48000);
  const engine = new WebAudioEngine({ context });
  engine.play(1, toneBuffer(context, [440]), {
    loop: true,
    volume: 1,
    spatialBlend: 0,
    bus: 'sfx',
  });
  engine
    .setFilters(1, (ctx) => {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.2;
      return [delay];
    })
    .unwrap();
  const pause = context.suspend(0.25),
    volume = context.suspend(0.65),
    resume = context.suspend(0.75);
  const rendering = context.startRendering();
  await pause;
  engine.setPaused(1, true);
  await context.resume();
  await volume;
  engine.setVolume(1, 0.25);
  await context.resume();
  await resume;
  engine.setPaused(1, false);
  await context.resume();
  const output = (await rendering).getChannelData(0);
  const pausedRms = rms(output, 16800, 28800);
  const resumedRms = rms(output, 48000, 57600);
  expect(pausedRms).toBeLessThan(1e-6);
  expect(resumedRms).toBeCloseTo(0.125 / Math.SQRT2, 3);
  // biome-ignore lint/suspicious/noConsole: bounded native signal evidence.
  console.log(
    JSON.stringify({
      kind: 'audio-delay-pause',
      pausedRms,
      resumedRms,
      expectedResumedRms: 0.125 / Math.SQRT2,
    }),
  );
  engine.destroy();
});
