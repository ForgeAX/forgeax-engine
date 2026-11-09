import type { TextureAsset } from '@forgeax/engine-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TextureDerivations admission and eviction. The codec is replaced by an
 * asynchronous fake so the cache's own scheduling is the only thing measured:
 * a caller retries every not-ready texture once per frame and stops asking once
 * it receives the derivative, as the residency upload loop does.
 */

const transcodes = vi.hoisted(() => ({ count: 0, gate: Promise.resolve() }));
vi.mock('@forgeax/engine-codec', () => ({
  parseKtx2: () => ({ ok: true, value: {} }),
  ktx2ChannelLanes: () => ({ channels: 'rgba' }),
  ktx2IsNative: () => false,
  ktx2NativeTexture: () => {
    throw new Error('native KTX2 is not exercised');
  },
  selectTranscodeTarget: () => 'rgba8unorm',
  transcodeBasis: () => {
    throw new Error('raw Basis is not exercised');
  },
  transcodeKtx2: async () => {
    transcodes.count++;
    await transcodes.gate;
    return { ok: true, value: { width: 4, height: 4, mips: [{ data: new Uint8Array(64) }] } };
  },
}));

const { TextureDerivations } = await import('../texture-derivation');

function source(): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    data: new Uint8Array(32),
    encoding: 'ktx2',
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
}

const nextTask = () => new Promise((resolve) => setImmediate(resolve));

/** One frame: ask for every texture still owed, then let started transcodes settle. */
async function frame(cache: InstanceType<typeof TextureDerivations>, waiting: Set<number>) {
  const asset = source();
  for (const key of [...waiting]) {
    const prepared = cache.prepare(key, 1, asset, undefined);
    if (prepared.ok) waiting.delete(key);
    else expect(prepared.error.code).toBe('asset-not-ready');
  }
  await nextTask();
}

async function framesUntilReady(count: number, limit: number): Promise<number> {
  const cache = new TextureDerivations();
  const waiting = new Set(Array.from({ length: count }, (_, key) => key));
  let frames = 0;
  while (waiting.size > 0 && frames < limit) {
    await frame(cache, waiting);
    frames++;
  }
  expect(waiting.size, `${waiting.size} textures still not ready after ${frames} frames`).toBe(0);
  return frames;
}

beforeEach(() => {
  transcodes.count = 0;
  transcodes.gate = Promise.resolve();
});

describe('TextureDerivations budget', () => {
  it('within the source budget every texture is ready on the second frame', async () => {
    expect(await framesUntilReady(200, 2)).toBe(2);
    expect(transcodes.count).toBe(200);
  });

  it.each([
    300, 726,
  ])('%i sources all become ready in bounded frames, one transcode each', async (count) => {
    const frames = await framesUntilReady(count, 2 * Math.ceil(count / 256) + 2);
    expect(frames).toBeLessThanOrEqual(2 * Math.ceil(count / 256) + 2);
    expect(transcodes.count).toBe(count);
  });

  it('never evicts in-flight work; an over-budget source waits without starting a transcode', async () => {
    const cache = new TextureDerivations();
    const asset = source();
    let release = () => {};
    transcodes.gate = new Promise((resolve) => {
      release = resolve;
    });
    for (let key = 0; key < 256; key++) cache.prepare(key, 1, asset, undefined);
    expect(cache.prepare(256, 1, asset, undefined).ok).toBe(false);
    await nextTask();
    expect(transcodes.count).toBe(256);
    for (let key = 0; key < 256; key++) expect(cache.preparing(key)).toBe(true);
    expect(cache.prepare(256, 1, asset, undefined).ok).toBe(false);
    release();
    await nextTask();
    // Settled but untaken results are owed to their callers and stay pinned.
    expect(cache.prepare(256, 1, asset, undefined).ok).toBe(false);
    for (let key = 0; key < 256; key++)
      expect(cache.prepare(key, 1, asset, undefined).ok).toBe(true);
    // Delivered entries are evictable, so the queued source now starts.
    expect(cache.prepare(256, 1, asset, undefined).ok).toBe(false);
    await nextTask();
    expect(transcodes.count).toBe(257);
    expect(cache.prepare(256, 1, asset, undefined).ok).toBe(true);
  });

  it('a delivered derivative stays cached while the budget has room', async () => {
    const cache = new TextureDerivations();
    const asset = source();
    cache.prepare(7, 1, asset, undefined);
    await cache.settled(7);
    expect(cache.prepare(7, 1, asset, undefined).ok).toBe(true);
    expect(cache.prepare(7, 1, asset, undefined).ok).toBe(true);
    expect(transcodes.count).toBe(1);
  });
});
