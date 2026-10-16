import { afterEach, expect, it, vi } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';

function silentWav(): Uint8Array {
  const bytes = new Uint8Array(1644);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, 1600, true);
  return bytes;
}

afterEach(() => vi.restoreAllMocks());
it('applies pre-play bus control and latest pending volume through native decoding and gains', async () => {
  const gains = vi.spyOn(AudioContext.prototype, 'createGain');
  const consumer = createHostAudioConsumer();
  try {
    consumer.consume({ kind: 'set-bus-volume', bus: 'sfx', volume: 0.4 });
    consumer.consume({ kind: 'set-bus-mute', bus: 'sfx', muted: true });
    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'silence',
      bytes: silentWav(),
      options: { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' },
    });
    consumer.consume({ kind: 'set-volume', entityId: 1, volume: 0.5 });
    consumer.consume({ kind: 'set-volume', entityId: 1, volume: 0.25 });
    await expect.poll(() => consumer.state().activeSourceCount).toBe(1);
    expect(gains.mock.results[8]?.value.gain.value).toBe(0);
    expect(gains.mock.results[15]?.value.gain.value).toBe(0.25);
    consumer.consume({ kind: 'stop', entityId: 1 });
    expect(consumer.state().activeSourceCount).toBe(0);
  } finally {
    consumer.dispose();
  }
});

it('retires consumer publications and active native sources when its supplied Context closes', async () => {
  const context = new AudioContext();
  const engine = new WebAudioEngine({ context });
  const destroy = vi.spyOn(engine, 'destroy');
  const decode = vi.spyOn(engine, 'decode');
  const consumer = createHostAudioConsumer(engine);
  try {
    consumer.consume({
      kind: 'play',
      entityId: 21,
      sourceKey: 'closed-publication',
      bytes: silentWav(),
      options: { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' },
    });
    await expect.poll(() => consumer.state().activeSourceCount).toBe(1);
    await context.close();
    expect(consumer.state().activeSourceCount).toBe(0);
    expect(destroy).toHaveBeenCalledTimes(1);
    consumer.consume({
      kind: 'play',
      entityId: 22,
      sourceKey: 'after-close',
      bytes: silentWav(),
      options: { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' },
    });
    await Promise.resolve();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(consumer.state().contextState).toBe('closed');
    expect(consumer.state().activeSourceCount).toBe(0);
    consumer.dispose();
    expect(destroy).toHaveBeenCalledTimes(1);
  } finally {
    consumer.dispose();
    if (context.state !== 'closed') await context.close();
  }
});

it('fences a real native decode publication still pending when the supplied Context closes', async () => {
  const context = new AudioContext();
  const engine = new WebAudioEngine({ context });
  const nativeDecode = engine.decode.bind(engine);
  const destroy = vi.spyOn(engine, 'destroy');
  const nodes = vi.spyOn(context, 'createBufferSource');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let nativeDecoded!: () => void;
  const decoded = new Promise<void>((resolve) => {
    nativeDecoded = resolve;
  });
  const decode = vi.spyOn(engine, 'decode').mockImplementation(async (bytes) => {
    // Decode the actual WAV through the supplied native Context, then hold only
    // adoption so close occurs before this real buffer reaches the consumer.
    const buffer = await nativeDecode(bytes);
    nativeDecoded();
    await held;
    return buffer;
  });
  const consumer = createHostAudioConsumer(engine);
  try {
    consumer.consume({
      kind: 'play',
      entityId: 31,
      sourceKey: 'pending-close',
      bytes: silentWav(),
      options: { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' },
    });
    await decoded;
    await context.close();
    const closed = consumer.state();
    expect(closed.contextState).toBe('closed');
    expect(closed.cache?.bytesHighWater).toBeGreaterThanOrEqual(silentWav().byteLength);
    expect(destroy).toHaveBeenCalledTimes(1);
    release();
    await decode.mock.results[0]?.value;
    await Promise.resolve();
    await Promise.resolve();
    expect(nodes).not.toHaveBeenCalled();
    expect(consumer.state().activeSourceCount).toBe(0);
    expect(consumer.state().lastError).toBeNull();
    consumer.consume({
      kind: 'play',
      entityId: 32,
      sourceKey: 'new-after-close',
      bytes: silentWav(),
      options: { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' },
    });
    expect(decode).toHaveBeenCalledTimes(1);
  } finally {
    release();
    consumer.dispose();
    if (context.state !== 'closed') await context.close();
  }
});
