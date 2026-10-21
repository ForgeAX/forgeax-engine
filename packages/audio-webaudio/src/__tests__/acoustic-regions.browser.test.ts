import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  AcousticRegion,
  AudioListener,
  AudioSource,
  audioContribution,
  audioTickSystem,
  createAcousticRegionSystem,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import { World } from '@forgeax/engine-ecs';
import { GlobalTransform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';
import { pcmWav } from './support-tone';

const matrix = (x = 0) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);

it('refuses invalid and out-of-range bus/send gains without changing accepted PCM', async () => {
  const context = new OfflineAudioContext(1, 12000, 48000);
  const engine = new WebAudioEngine({ context });
  expect(engine.configureBuses([{ id: 'master', parent: null, volume: 1e100 }])).toMatchObject({
    ok: false,
    error: { code: 'control-failed' },
  });
  expect(
    engine.configureBuses([
      { id: 'master', parent: null },
      { id: 'sfx', parent: 'master', sends: [{ bus: 'master', gain: 1e100, tap: 'pre-fader' }] },
    ]),
  ).toMatchObject({ ok: false, error: { code: 'control-failed' } });
  engine
    .configureBuses([
      { id: 'master', parent: null },
      { id: 'sfx', parent: 'master', sends: [{ bus: 'room', gain: 0.2, tap: 'pre-fader' }] },
      { id: 'room', parent: 'master' },
    ])
    .unwrap();
  const buffer = context.createBuffer(1, 12000, 48000);
  buffer.getChannelData(0).fill(0.1);
  engine.play(1, buffer, { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' });
  expect(() => engine.setBusVolume('sfx', 1e100)).not.toThrow();
  expect(engine.getState().lastError?.code).toBe('control-failed');
  expect(() => engine.setBusSendGain('sfx', 'room', 1e100)).not.toThrow();
  expect(engine.getState().lastError?.code).toBe('control-failed');
  expect(() =>
    engine.setAcousticEnvironment([
      { bus: 'sfx', sends: [{ target: 'room', gain: { weight: 1, value: 1e100 } }] },
    ]),
  ).not.toThrow();
  expect(engine.getState().lastError?.code).toBe('control-failed');
  expect(() => engine.setBusSendGain('sfx', 'room', null as unknown as number)).not.toThrow();
  expect(() => engine.setBusSendGain('sfx', 'room', true as unknown as number)).not.toThrow();
  const samples = (await context.startRendering()).getChannelData(0);
  expect(samples[4800]).toBeCloseTo(0.12, 5);
  engine.destroy();
});

it('starts each native send ramp at its control time, after a gap and during an interrupted ramp', async () => {
  const context = new OfflineAudioContext(1, 24000, 48000);
  const engine = new WebAudioEngine({ context });
  engine
    .configureBuses([
      { id: 'master', parent: null },
      { id: 'sfx', parent: 'master', sends: [{ bus: 'room', gain: 0, tap: 'pre-fader' }] },
      { id: 'room', parent: 'master' },
    ])
    .unwrap();
  const buffer = context.createBuffer(1, 24000, 48000);
  buffer.getChannelData(0).fill(0.1);
  engine.play(1, buffer, { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' });
  const controls = [
    [0.25, 0.5],
    [0.28, 0],
    [0.286, 1],
  ] as const;
  const stops = controls.map(([time]) => context.suspend(time));
  const rendering = context.startRendering();
  const events: { time: number; from: number; to: number }[] = [];
  let previous = { time: 0, from: 0, to: 0 };
  for (const [index, [, to]] of controls.entries()) {
    await stops[index];
    const time = context.currentTime;
    const from =
      previous.from +
      (previous.to - previous.from) * Math.max(0, Math.min(1, (time - previous.time) / 0.01));
    previous = { time, from, to };
    events.push(previous);
    engine.setBusSendGain('sfx', 'room', previous.to);
    await context.resume();
  }
  const samples = (await rendering).getChannelData(0);
  let event = 0,
    envelope = { time: 0, from: 0, to: 0 },
    maxError = 0;
  for (const [frame, sample] of samples.entries()) {
    const time = frame / 48000;
    let next = events[event];
    while (next && next.time <= time) {
      envelope = next;
      event++;
      next = events[event];
    }
    const send =
      envelope.from +
      (envelope.to - envelope.from) * Math.max(0, Math.min(1, (time - envelope.time) / 0.01));
    maxError = Math.max(maxError, Math.abs(sample - 0.1 * (1 + send)));
  }
  expect(maxError).toBeLessThanOrEqual(2e-4);
  engine.destroy();
});

it('crossfades native route samples, holds silence during pause, and restores the updated explicit bus', async () => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  engine
    .configureBuses([
      { id: 'master', parent: null },
      { id: 'sfx', parent: 'master' },
      { id: 'music', parent: 'master', volume: 0.5 },
      { id: 'room', parent: 'master', volume: 0.25 },
    ])
    .unwrap();
  const consumer = createHostAudioConsumer(engine);
  const backend = createAudioIntentBackend({ emit: (i) => consumer.consume(structuredClone(i)) });
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const world = new World({ assets });
  const clip = assets
    .create({
      kind: 'audio',
      mediaType: 'audio/wav',
      sourceKey: 'native-acoustic',
      bytes: pcmWav(new Float32Array(48000).fill(0.1)),
    })
    .unwrap();
  const source = world
    .spawn(
      { component: AudioSource, data: { clip, playing: true, loop: true } },
      { component: GlobalTransform, data: { world: matrix(4) } },
    )
    .unwrap();
  const region = world
    .spawn(
      { component: AcousticRegion, data: { sourceBus: 'room' } },
      { component: GlobalTransform, data: { world: matrix() } },
    )
    .unwrap();
  const system = createAcousticRegionSystem();
  const tick = () => {
    audioTickSystem(world, backend);
    system.update(world, backend).unwrap();
  };
  tick();
  const decodeDeadline = performance.now() + 5000;
  while (!consumer.state().activeSourceCount) {
    if (performance.now() > decodeDeadline) throw new Error('native decode did not admit source');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const enter = context.suspend(0.25),
    pause = context.suspend(0.5),
    exit = context.suspend(0.75);
  const rendering = context.startRendering();
  await enter;
  world.set(source, GlobalTransform, { world: matrix() }).unwrap();
  tick();
  engine.setBus(source, 'music'); // Explicit edits during auto routing remain the fallback authority.
  await context.resume();
  await pause;
  engine.setPaused(source, true);
  await context.resume();
  await exit;
  world.despawn(region).unwrap();
  tick();
  engine.setPaused(source, false);
  await context.resume();
  const samples = (await rendering).getChannelData(0);
  expect(samples[4800]).toBeCloseTo(0.1, 4);
  expect(samples[18000]).toBeCloseTo(0.025, 4);
  expect(samples[30000]).toBeCloseTo(0, 5);
  expect(samples[42000]).toBeCloseTo(0.05, 4);
  consumer.dispose();
  expect(consumer.state().activeSourceCount).toBe(0);
});

it('blends listener environment into existing wet/send parameters and keeps the latest manual values', async () => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  engine
    .configureBuses([
      { id: 'master', parent: null },
      { id: 'sfx', parent: 'master', sends: [{ bus: 'room', gain: 0, tap: 'pre-fader' }] },
      { id: 'room', parent: 'master' },
    ])
    .unwrap();
  engine
    .setBusEffects(
      'room',
      (ctx) => {
        const gain = ctx.createGain();
        gain.gain.value = 0.5;
        return [gain];
      },
      1,
    )
    .unwrap();
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const world = new World({ assets });
  const listener = world
    .spawn(
      { component: AudioListener, data: {} },
      { component: GlobalTransform, data: { world: matrix(4) } },
    )
    .unwrap();
  const region = world
    .spawn(
      {
        component: AcousticRegion,
        data: {
          listenerWetBus: 'room',
          wet: 1,
          listenerSendBus: 'sfx',
          listenerSendTarget: 'room',
          sendGain: 0.5,
        },
      },
      { component: GlobalTransform, data: { world: matrix() } },
    )
    .unwrap();
  const backend = createAudioIntentBackend({
    emit: (i) => {
      if (i.kind === 'set-acoustic-environment') engine.setAcousticEnvironment(i.environment);
    },
  });
  const system = createAcousticRegionSystem();
  const buffer = context.createBuffer(1, 48000, 48000);
  buffer.getChannelData(0).fill(0.1);
  engine.play(1, buffer, { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' });
  system.update(world, backend).unwrap();
  const enter = context.suspend(0.25),
    leave = context.suspend(0.5),
    remove = context.suspend(0.75);
  const rendering = context.startRendering();
  await enter;
  world.set(listener, GlobalTransform, { world: matrix() }).unwrap();
  system.update(world, backend).unwrap();
  engine.setBusSendGain('sfx', 'room', 0.2);
  engine.setBusWet('room', 0.5);
  await context.resume();
  await leave;
  world.removeComponent(listener, AudioListener).unwrap();
  system.update(world, backend).unwrap();
  await context.resume();
  await remove;
  engine.setAcousticEnvironment([{ bus: 'missing', sends: [] }]);
  world.despawn(region).unwrap();
  system.update(world, backend).unwrap();
  await context.resume();
  const samples = (await rendering).getChannelData(0);
  expect(samples[4800]).toBeCloseTo(0.1, 5);
  expect(samples[18000]).toBeCloseTo(0.125, 5);
  expect(samples[30000]).toBeCloseTo(0.115, 5);
  expect(samples[42000]).toBeCloseTo(0.115, 5);
  engine.destroy();
});

it('retires acoustic taps when the caller closes the existing native Context', async () => {
  const context = new AudioContext();
  await context.resume();
  const engine = new WebAudioEngine({ context });
  engine
    .configureBuses([
      { id: 'master', parent: null },
      { id: 'sfx', parent: 'master' },
      { id: 'room', parent: 'master' },
    ])
    .unwrap();
  const buffer = context.createBuffer(1, 48000, 48000);
  engine.play(1, buffer, { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' });
  engine.setAcousticRoutes(1, { fallback: 0, buses: [{ bus: 'room', gain: 1 }] }).unwrap();
  expect(engine.getActiveSourceCount()).toBe(1);
  await context.close();
  await expect.poll(() => engine.getActiveSourceCount()).toBe(0);
  expect(engine.setAcousticRoutes(1, { fallback: 1, buses: [] }).ok).toBe(false);
  expect(engine.listener).toBeUndefined();
  engine.play(2, buffer, { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' });
  expect(engine.getState()).toMatchObject({ contextState: 'closed', activeSourceCount: 0 });
  engine.destroy();
});

it('fences real pending decode and routing controls when the Host consumer is disposed', async () => {
  const context = new AudioContext();
  const engine = new WebAudioEngine({ context });
  engine
    .configureBuses([
      { id: 'master', parent: null },
      { id: 'sfx', parent: 'master' },
      { id: 'room', parent: 'master' },
    ])
    .unwrap();
  const consumer = createHostAudioConsumer(engine);
  consumer.consume({
    asset: { owner: 'pending-acoustic', handle: 1, revision: 1 },
    kind: 'play',
    entityId: 8,
    sourceKey: 'pending-acoustic',
    bytes: pcmWav(new Float32Array(48000 * 3).fill(0.1)),
    options: { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' },
  });
  expect(consumer.state().activeSourceCount).toBe(0);
  consumer.consume({
    kind: 'set-acoustic-routes',
    entityId: 8,
    routes: { fallback: 0, buses: [{ bus: 'room', gain: 1 }] },
  });
  consumer.consume({
    kind: 'set-acoustic-routes',
    entityId: 8,
    routes: { fallback: 1, buses: [] },
  });
  consumer.dispose();
  await context.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(consumer.state()).toMatchObject({ contextState: 'closed', activeSourceCount: 0 });
  expect(engine.listener).toBeUndefined();
});

it('records real native input frames without changing their stereo samples', async () => {
  const context = new OfflineAudioContext(2, 12288, 48000);
  await context.audioWorklet.addModule(
    new URL('../../bench/acoustic/recorder.worklet.js', import.meta.url).href,
  );
  const recorder = new AudioWorkletNode(context, 'acoustic-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const blocks: {
    channels: Float32Array[];
    firstFrame: number;
    frameCount: number;
    sampleRate: number;
  }[] = [];
  let finish = () => {};
  const complete = new Promise<void>((resolve) => {
    finish = resolve;
  });
  recorder.port.onmessage = (event) => {
    blocks.push(event.data);
    if (blocks.length === 12) finish();
  };
  const buffer = context.createBuffer(2, 12288, 48000);
  for (let channel = 0; channel < 2; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let frame = 0; frame < samples.length; frame++)
      samples[frame] = 0.1 * Math.sin((2 * Math.PI * (440 + channel * 220) * frame) / 48000);
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(recorder);
  recorder.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  await complete;
  for (const [index, block] of blocks.entries()) {
    expect(block.firstFrame).toBe(index * 1024);
    expect(block.frameCount).toBe(1024);
    expect(block.sampleRate).toBe(48000);
    for (let channel = 0; channel < 2; channel++) {
      const actual = rendered.getChannelData(channel);
      const input = buffer.getChannelData(channel);
      const recorded = block.channels[channel];
      if (recorded === undefined) throw new Error('native recorder dropped a stereo channel');
      let recordedError = 0,
        outputError = 0;
      for (let frame = 0; frame < 1024; frame++) {
        const position = block.firstFrame + frame;
        const sample = recorded[frame],
          expected = input[position],
          output = actual[position];
        if (sample === undefined || expected === undefined || output === undefined)
          throw new Error('native recorder frame is outside the input/rendered buffer');
        recordedError = Math.max(recordedError, Math.abs(sample - expected));
        outputError = Math.max(outputError, Math.abs(output - expected));
      }
      expect(recordedError).toBeLessThanOrEqual(2e-7);
      expect(outputError).toBeLessThanOrEqual(2e-7);
    }
  }
  recorder.port.close();
  source.disconnect();
  recorder.disconnect();
});
