import { expect, it } from 'vitest';
import { WebAudioEngine } from '../web-audio-engine';

it('rejects duplicate effect nodes and retains the accepted native output graph', async () => {
  const context = new OfflineAudioContext(1, 4800, 48000);
  const engine = new WebAudioEngine({ context });
  const buffer = context.createBuffer(1, 4800, 48000);
  buffer.getChannelData(0).fill(0.1);
  engine.play(1, buffer, { loop: false, volume: 1, spatialBlend: 0, bus: 'music' });
  const duplicate = context.createGain();
  expect(engine.setBusEffects('music', () => [duplicate, duplicate]).ok).toBe(false);
  const samples = (await context.startRendering()).getChannelData(0);
  expect(samples[2400]).toBeCloseTo(0.1, 5);
  engine.destroy();
});

it('renders pre/post-fader sends, shared wet effects, mute and rejects feedback atomically', async () => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  const buses = [
    { id: 'master', parent: null },
    {
      id: 'voice',
      parent: 'master',
      volume: 0.25,
      sends: [{ bus: 'room', gain: 0.5, tap: 'pre-fader' as const }],
    },
    { id: 'room', parent: 'master' },
  ];
  expect(engine.configureBuses(buses).ok).toBe(true);
  let builds = 0;
  expect(
    engine.setBusEffects(
      'room',
      (ctx) => {
        builds++;
        const gain = ctx.createGain();
        gain.gain.value = 0.5;
        return [gain];
      },
      1,
    ).ok,
  ).toBe(true);
  const buffer = context.createBuffer(1, 48000, 48000);
  buffer.getChannelData(0).fill(0.1);
  for (let id = 1; id <= 2; id++)
    engine.play(id, buffer, {
      loop: true,
      volume: 1,
      spatialBlend: 0,
      bus: 'voice',
    });
  expect(builds).toBe(1);
  expect(engine.configureBuses([...buses.slice(0, 2), { id: 'room', parent: 'voice' }]).ok).toBe(
    false,
  );
  const muted = context.suspend(0.25);
  const resumed = context.suspend(0.5);
  const rendered = context.startRendering();
  await muted;
  engine.setBusMute('voice', true);
  await context.resume();
  await resumed;
  engine.setBusMute('voice', false);
  await context.resume();
  const samples = (await rendered).getChannelData(0);
  expect(samples[4800]).toBeCloseTo(0.1, 5);
  expect(samples[18000]).toBeCloseTo(0, 5);
  expect(samples[36000]).toBeCloseTo(0.1, 5);
  engine.destroy();
});

it('applies declared defaults on existing IDs and preserves explicit controls on valid replacement', async () => {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  const graph = (volume: number) => [
    { id: 'master', parent: null },
    { id: 'music', parent: 'master', volume },
  ];
  expect(engine.configureBuses(graph(0.5)).ok).toBe(true);
  const buffer = context.createBuffer(1, 48000, 48000);
  buffer.getChannelData(0).fill(0.1);
  engine.play(1, buffer, { loop: true, volume: 1, spatialBlend: 0, bus: 'music' });
  const suspended = context.suspend(0.25);
  const rendered = context.startRendering();
  await suspended;
  engine.setBusVolume('music', 0.25);
  expect(engine.configureBuses(graph(0.8)).ok).toBe(true);
  await context.resume();
  const samples = (await rendered).getChannelData(0);
  expect(samples[4800]).toBeCloseTo(0.05, 5);
  expect(samples[36000]).toBeCloseTo(0.025, 5);
  engine.destroy();
});
