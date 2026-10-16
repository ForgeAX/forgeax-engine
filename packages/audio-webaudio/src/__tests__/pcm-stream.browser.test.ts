import { createAudioIntentBackend } from '@forgeax/engine-audio';
import { expect, it, vi } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { indexPcmWave } from '../pcm-wave';
import { WebAudioEngine } from '../web-audio-engine';
import { addressedPcmWav } from './support/pcm-range-fixture';
import { toneWav } from './support-tone';

it('addresses the rounded PCM frame and joins the loop boundary in native output', async () => {
  const bytes = addressedPcmWav();
  const manifest = await indexPcmWave(bytes);
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  const position = 1.9001234;
  try {
    engine.play(
      1,
      {
        kind: 'audio',
        sourceKey: 'addressed',
        mediaType: 'audio/wav',
        stream: { ...manifest, url: `${location.origin}/__pcm/addressed.wav` },
      },
      { loop: true, fromPosition: position, volume: 1, spatialBlend: 0, bus: 'music' },
    );
    await expect.poll(() => engine.getStreamState(1)?.pcmBytes ?? 0).toBeGreaterThan(384000);
    const output = (await context.startRendering()).getChannelData(0);
    const first = output.findIndex((value) => Math.abs(value) > 0.001);
    expect(first).toBe(480); // Native clock starts the first segment 10 ms ahead.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const startFrame = Math.round(position * 48000);
    // Check the exact starting frame and both sides of the file-to-zero loop.
    for (let frame = 0; frame < 12000; frame++) {
      const expected = view.getInt16(44 + ((startFrame + frame) % 96000) * 2, true) / 32768;
      expect(Math.abs((output[first + frame] ?? 0) - expected)).toBeLessThan(1 / 32768);
    }
  } finally {
    engine.destroy();
  }
});

it('streams real Range windows with pause, seek, rate, effects, bus and cancellation', async () => {
  // The fixture is emitted by the same audio importer before Vite starts.
  const bytes = toneWav();
  const manifest = await indexPcmWave(bytes);
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.resume();
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context: ctx }));
  const requests = vi.spyOn(globalThis, 'fetch');
  const backend = createAudioIntentBackend({ emit: (intent) => consumer.consume(intent) });
  try {
    backend.configureBuses([
      { id: 'master', parent: null },
      { id: 'voice', parent: 'master' },
    ]);
    backend.play(
      1,
      {
        kind: 'audio',
        sourceKey: 'range-tone',
        mediaType: 'audio/wav',
        stream: { ...manifest, url: `${location.origin}/__pcm/resume-slow.wav` },
      },
      { loop: true, volume: 0.1, spatialBlend: 1, bus: 'voice', paused: true, fromPosition: 1.25 },
    );
    expect(consumer.engine.getPlaybackPosition(1)).toBe(1.25);
    expect(consumer.state().streaming?.pendingReads).toBe(0);
    consumer.engine.setFilters(1, (context) => [context.createBiquadFilter()]);
    const resumeRequest = requests.mock.results.length;
    backend.setPaused(1, false);
    await expect.poll(() => requests.mock.results[resumeRequest]?.type).toBe('return');
    // A real delayed response separates transport from native scheduling; neither
    // the read/test deadline nor the original native-state poll is extended.
    await requests.mock.results[resumeRequest]?.value;
    await expect.poll(() => consumer.state().activeSourceCount).toBe(1);
    await expect.poll(() => consumer.state().streaming?.pcmBytes ?? 0).toBeGreaterThan(0);
    backend.setPaused(1, true);
    const position = consumer.engine.getPlaybackPosition(1);
    expect(position).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(consumer.engine.getPlaybackPosition(1)).toBe(position);
    backend.seek(1, 1.5);
    backend.setPlaybackRate(1, 2);
    backend.setBus(1, 'master');
    const seekRequest = requests.mock.results.length;
    backend.setPaused(1, false);
    await expect.poll(() => requests.mock.results[seekRequest]?.type).toBe('return');
    await requests.mock.results[seekRequest]?.value;
    await expect.poll(() => consumer.state().activeSourceCount).toBe(1);
    expect(consumer.engine.getStreamState(1)?.error).toBeNull();
    for (let i = 0; i < 64; i++) backend.seek(1, (i % 10) / 10);
    expect(consumer.state().streaming?.pendingReads).toBeLessThanOrEqual(1);
    backend.stop(1);
    await expect.poll(() => consumer.state().streaming?.pendingReads).toBe(0);
    expect(consumer.state().streaming?.pcmBytes).toBe(0);
    expect(consumer.state().streaming?.pendingBytes).toBe(0);
    expect(consumer.state().activeSourceCount).toBe(0);
  } finally {
    requests.mockRestore();
    consumer.dispose();
    await ctx.close();
  }
});

it.each([
  ['no-range.wav', 'range-unsupported'],
  ['corrupt.wav', 'integrity-failed'],
  ['oversized.wav', 'range-oversized'],
] as const)('reports %s without full decoding or retry', async (suffix, reason) => {
  const manifest = await indexPcmWave(toneWav());
  const ctx = new AudioContext({ sampleRate: 48000 });
  const engine = new WebAudioEngine({ context: ctx });
  // Spies delegate to the real browser APIs; no response or decoder is replaced.
  const requests = vi.spyOn(globalThis, 'fetch');
  const decoding = vi.spyOn(ctx, 'decodeAudioData');
  try {
    engine.play(
      1,
      {
        kind: 'audio',
        sourceKey: suffix,
        mediaType: 'audio/wav',
        stream: { ...manifest, url: `${location.origin}/__pcm/${suffix}` },
      },
      { loop: false, volume: 0.1, spatialBlend: 0, bus: 'music' },
    );
    expect(requests.mock.results[0]?.type).toBe('return');
    // Observe failure publication after real HTTP headers arrive. Network latency
    // stays bounded by the unchanged test deadline and the player's read timeout.
    await requests.mock.results[0]?.value;
    await expect.poll(() => engine.getStreamState(1)?.error?.detail).toMatchObject({ reason });
    expect(engine.getStreamState(1)?.status).toBe('failed');
    expect(requests).toHaveBeenCalledTimes(1);
    expect(decoding).not.toHaveBeenCalled();
    expect(engine.getActiveSourceCount()).toBe(0);
    engine.stop(1);
  } finally {
    engine.destroy();
    await ctx.close();
    requests.mockRestore();
    decoding.mockRestore();
  }
});

it('fences delayed windows across stop, publication replacement, disposal and byte exhaustion', async () => {
  const manifest = await indexPcmWave(toneWav());
  const context = new AudioContext({ sampleRate: 48000 });
  await context.resume();
  const engine = new WebAudioEngine({ context });
  const consumer = createHostAudioConsumer(engine);
  const backend = createAudioIntentBackend({ emit: (intent) => consumer.consume(intent) });
  const requests = vi.spyOn(globalThis, 'fetch');
  const clip = (suffix: string) => ({
    kind: 'audio' as const,
    sourceKey: 'delayed',
    mediaType: 'audio/wav' as const,
    stream: { ...manifest, url: `${location.origin}/__pcm/${suffix}` },
  });
  const options = { loop: true, volume: 0.1, spatialBlend: 0, bus: 'music' };
  try {
    backend.play(1, clip('slow.wav'), options);
    expect(consumer.state().streaming?.pendingReads).toBe(1);
    backend.stop(1);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(consumer.state().activeSourceCount).toBe(0);
    expect(consumer.state().streaming?.pendingBytes).toBe(0);
    backend.play(1, clip('slow.wav'), options);
    const nextRequest = requests.mock.results.length;
    backend.play(2, clip('tone.wav'), options);
    expect(requests.mock.results[nextRequest]?.type).toBe('return');
    await requests.mock.results[nextRequest]?.value;
    await expect.poll(() => consumer.state().activeSourceCount).toBe(1);
    expect(engine.getStreamState(1)).toBeUndefined();
    consumer.dispose();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(engine.getActiveSourceCount()).toBe(0);
    expect(engine.streamingBytes).toBe(0);
    expect(engine.getState().contextState).toBe('closed');
  } finally {
    consumer.dispose();
    await context.close();
    requests.mockRestore();
  }

  const limitedContext = new AudioContext();
  const limited = new WebAudioEngine({ context: limitedContext });
  limited.setStreamBudget(4096, () => 0);
  try {
    limited.play(1, clip('tone.wav'), options);
    expect(limited.getStreamState(1)?.error?.detail).toMatchObject({ reason: 'budget-exceeded' });
    expect(limited.getState().streaming?.pendingReads).toBe(0);
    limited.stop(1);
    expect(limited.getState().streaming?.pendingBytes).toBe(0);
  } finally {
    limited.destroy();
    await limitedContext.close();
  }
});

it('requires fresh admission after the stream index exceeds the initial budget', async () => {
  const manifest = await indexPcmWave(toneWav());
  const context = new AudioContext({ sampleRate: 48000 });
  await context.resume();
  const engine = new WebAudioEngine({ context });
  const requests = vi.spyOn(globalThis, 'fetch');
  const clip = {
    kind: 'audio' as const,
    sourceKey: 'index-admission',
    mediaType: 'audio/wav' as const,
    stream: { ...manifest, url: `${location.origin}/__pcm/tone.wav` },
  };
  const options = { loop: true, volume: 0.1, spatialBlend: 0, bus: 'music' };
  try {
    engine.setStreamBudget(1, () => 0);
    engine.play(1, clip, options);
    expect(engine.getStreamState(1)?.error?.detail).toMatchObject({ reason: 'budget-exceeded' });
    // Enough for the first read only if the rejected index is silently omitted.
    engine.setStreamBudget(480000, () => 0);
    engine.seek(1, 0);
    engine.setPaused(1, true);
    engine.setPaused(1, false);
    engine.setPlaybackRate(1, 2);
    expect(engine.getStreamState(1)?.status).toBe('failed');
    expect(engine.getState().streaming?.pendingReads).toBe(0);
    expect(engine.streamingBytes).toBe(0);
    expect(requests).not.toHaveBeenCalled();
    engine.setStreamBudget(2 * 1024 * 1024, () => 0);
    engine.play(1, clip, options);
    expect(requests.mock.results[0]?.type).toBe('return');
    await requests.mock.results[0]?.value;
    await expect.poll(() => engine.getActiveSourceCount()).toBe(1);
    engine.setPaused(1, true);
    await expect.poll(() => engine.getState().streaming?.pendingReads).toBe(0);
    expect(engine.getState().streaming?.pendingBytes).toBe(JSON.stringify(clip.stream).length * 2);
    engine.stop(1);
    expect(engine.streamingBytes).toBe(0);
  } finally {
    requests.mockRestore();
    engine.destroy();
    await context.close();
  }
});
