import { RetentionBudget } from '@forgeax/engine-assets-runtime/internal';
import type { TaskExecutor, TaskHandle, TextureAsset } from '@forgeax/engine-types';
import { taskAbortError } from '@forgeax/engine-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TextureDerivations admission and eviction. The transcode executor is an
 * asynchronous fake so the cache's own scheduling is the only thing measured:
 * a caller retries every not-ready texture once per frame and stops asking once
 * it receives the derivative, as the residency upload loop does.
 */

const transcodes = vi.hoisted(() => ({ count: 0, cancelled: 0, gate: Promise.resolve() }));
vi.mock('@forgeax/engine-codec', () => ({
  parseKtx2: () => ({ ok: true, value: {} }),
  ktx2ChannelLanes: () => ({ channels: 'rgba' }),
  selectTranscodeTarget: () => 'rgba8unorm',
}));

const { TextureDerivations } = await import('../texture-derivation');

const tasks: TaskExecutor = {
  submit<_I, O>(kind: string): TaskHandle<O> {
    expect(kind).toBe('ktx2.transcode');
    transcodes.count++;
    let cancel = () => false;
    const result = new Promise<O>((resolve, reject) => {
      cancel = () => {
        transcodes.cancelled++;
        reject(taskAbortError());
        return false;
      };
      void transcodes.gate.then(() =>
        resolve({
          ok: true,
          value: {
            format: 'rgba8unorm',
            width: 4,
            height: 4,
            levels: [{ width: 4, height: 4, byteLength: 64 }],
            data: new Uint8Array(64),
          },
        } as O),
      );
    });
    return { result, cancel: () => cancel() };
  },
};
const derivations = (budget = new RetentionBudget()) => new TextureDerivations(tasks, budget);
/** Transcodes the cache keeps running at once. */
const RUNNING = 8;
/** A 4x4 source capture plus its rgba8 derivative. */
const ENTRY = 32 + 64;

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
  const cache = derivations();
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
  transcodes.cancelled = 0;
  transcodes.gate = Promise.resolve();
});

function gated() {
  let release = () => {};
  transcodes.gate = new Promise((resolve) => {
    release = resolve;
  });
  return () => release();
}

describe('TextureDerivations budget', () => {
  it.each([
    200, 300, 726,
  ])('%i sources all become ready in bounded frames, one transcode each', async (count) => {
    const limit = Math.ceil(count / RUNNING) + 2;
    expect(await framesUntilReady(count, limit)).toBeLessThanOrEqual(limit);
    expect(transcodes.count).toBe(count);
  });

  it('runs a bounded number of transcodes; later sources wait without a capture', async () => {
    const cache = derivations();
    const asset = source();
    const release = gated();
    for (let key = 0; key < 20; key++) cache.prepare(key, 1, asset, undefined);
    expect(transcodes.count).toBe(RUNNING);
    // A queued source is still preparing, so callers draw a placeholder rather than a miss.
    expect(cache.preparing(RUNNING)).toBe(true);
    cache.remove(RUNNING);
    expect(cache.preparing(RUNNING)).toBe(false);
    release();
    await nextTask();
    for (let key = 0; key < 20; key++) cache.prepare(key, 1, asset, undefined);
    expect(transcodes.count).toBe(2 * RUNNING);
  });

  it('never evicts in-flight work; an over-budget source waits without starting a transcode', async () => {
    const budget = new RetentionBudget(2 * ENTRY);
    const cache = derivations(budget);
    const asset = source();
    const release = gated();
    cache.prepare(0, 1, asset, undefined);
    cache.prepare(1, 1, asset, undefined);
    expect(cache.prepare(2, 1, asset, undefined).ok).toBe(false);
    expect(transcodes.count).toBe(2);
    expect(cache.preparing(2)).toBe(true);
    release();
    await nextTask();
    // Owed results stay pinned; with nothing running one source still starts.
    expect(cache.prepare(2, 1, asset, undefined).ok).toBe(false);
    expect(cache.prepare(3, 1, asset, undefined).ok).toBe(false);
    expect(transcodes.count).toBe(3);
    expect(cache.preparing(3)).toBe(true);
    await cache.settled(2);
    for (const key of [0, 1, 2]) expect(cache.prepare(key, 1, asset, undefined).ok).toBe(true);
    // Delivered entries are evictable, so the queued source now fits.
    expect(cache.prepare(3, 1, asset, undefined).ok).toBe(false);
    expect(transcodes.count).toBe(4);
    await cache.settled(3);
    expect(cache.prepare(3, 1, asset, undefined).ok).toBe(true);
    expect(budget.snapshot().bytes).toBeLessThanOrEqual(2 * ENTRY);
  });

  it('starts one source larger than the budget while nothing else runs', async () => {
    const cache = derivations(new RetentionBudget(16));
    const asset = source();
    const release = gated();
    expect(cache.prepare(0, 1, asset, undefined).ok).toBe(false);
    expect(cache.prepare(1, 1, asset, undefined).ok).toBe(false);
    expect(transcodes.count).toBe(1);
    expect(cache.preparing(1)).toBe(true);
    release();
    await cache.settled(0);
    expect(cache.prepare(0, 1, asset, undefined).ok).toBe(true);
  });

  it('idle steps never release running or owed derivatives', async () => {
    const budget = new RetentionBudget(64 * 1024 * 1024, 10);
    const cache = derivations(budget);
    const release = gated();
    cache.prepare(1, 1, source(), undefined);
    for (const now of [0, 2000, 4000]) budget.step(now);
    expect(cache.preparing(1)).toBe(true);
    release();
    await cache.settled(1);
    budget.step(6000);
    // Settled but not yet taken: still owed to its caller.
    expect(cache.prepare(1, 1, source(), undefined).ok).toBe(true);
    budget.step(8000);
    expect(cache.prepare(1, 1, source(), undefined).ok).toBe(true);
    budget.step(10000);
    budget.step(12000);
    expect(cache.preparing(1)).toBe(false);
    expect(cache.prepare(1, 1, source(), undefined).ok).toBe(false);
    expect(budget.snapshot().bytes).toBe(ENTRY);
  });

  it('a delivered derivative stays cached while the budget has room', async () => {
    const cache = derivations();
    const asset = source();
    cache.prepare(7, 1, asset, undefined);
    await cache.settled(7);
    expect(cache.prepare(7, 1, asset, undefined).ok).toBe(true);
    expect(cache.prepare(7, 1, asset, undefined).ok).toBe(true);
    expect(transcodes.count).toBe(1);
  });

  it('releases a delivered derivative once its device texture is published', async () => {
    const cache = derivations();
    const asset = source();
    cache.prepare(7, 1, asset, undefined);
    cache.release(7);
    expect(cache.preparing(7)).toBe(true);
    await cache.settled(7);
    expect(cache.prepare(7, 1, asset, undefined).ok).toBe(true);
    cache.release(7);
    expect(cache.preparing(7)).toBe(false);
    expect(cache.prepare(7, 1, asset, undefined).ok).toBe(false);
    expect(transcodes.count).toBe(2);
  });

  it('counts running work against the budget and refunds it on removal', async () => {
    const cache = derivations();
    const asset = source();
    let release = () => {};
    transcodes.gate = new Promise((resolve) => {
      release = resolve;
    });
    expect(cache.prepare(1, 1, asset, undefined).ok).toBe(false);
    expect(cache.preparing(1)).toBe(true);
    // A newer revision replaces the running source and discards its transcode.
    expect(cache.prepare(1, 2, asset, undefined).ok).toBe(false);
    expect(transcodes.cancelled).toBe(1);
    cache.remove(1);
    expect(transcodes.cancelled).toBe(2);
    release();
    await nextTask();
    expect(cache.prepare(1, 3, asset, undefined).ok).toBe(false);
    await cache.settled(1);
    expect(cache.prepare(1, 3, asset, undefined).ok).toBe(true);
    expect(transcodes.count).toBe(3);
  });

  it('rejects a derivative that cannot fit before starting it', () => {
    const cache = derivations();
    const huge: TextureAsset = {
      ...source(),
      shape: { viewDimension: '2d', extent: { width: 8192, height: 8192 } },
    };
    const prepared = cache.prepare(9, 1, huge, undefined);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.code).toBe('asset-budget-exceeded');
    expect(transcodes.count).toBe(0);
  });
});

describe('TextureDerivations in a shared retention budget', () => {
  /** A one-entry member standing in for another cache of the realm. */
  function member(budget: RetentionBudget, bytes: number) {
    let used: number | undefined = budget.tick();
    budget.add(bytes);
    budget.join({
      oldest: () => used,
      releaseOldest: () => {
        used = undefined;
        budget.add(-bytes);
      },
    });
    return { held: () => used !== undefined };
  }

  it('returns its bytes on clear', async () => {
    const budget = new RetentionBudget();
    const cache = new TextureDerivations(tasks, budget);
    cache.prepare(1, 1, source(), undefined);
    await cache.settled(1);
    expect(budget.snapshot().bytes).toBe(ENTRY);
    cache.clear();
    expect(budget.snapshot().bytes).toBe(0);
  });

  it('a derivative admission releases an older entry of another member', async () => {
    const budget = new RetentionBudget(1024);
    const other = member(budget, 1024 - 64);
    const cache = new TextureDerivations(tasks, budget);
    cache.prepare(1, 1, source(), undefined);
    await cache.settled(1);
    expect(cache.prepare(1, 1, source(), undefined).ok).toBe(true);
    expect(other.held()).toBe(false);
  });

  it('never releases owed derivatives for another member', async () => {
    const budget = new RetentionBudget();
    let release = () => {};
    transcodes.gate = new Promise((resolve) => {
      release = resolve;
    });
    const cache = new TextureDerivations(tasks, budget);
    cache.prepare(1, 1, source(), undefined);
    budget.trim();
    expect(cache.preparing(1)).toBe(true);
    release();
    await cache.settled(1);
    budget.trim();
    // Settled but not yet taken: still owed to its caller.
    expect(cache.prepare(1, 1, source(), undefined).ok).toBe(true);
    budget.trim();
    expect(cache.preparing(1)).toBe(false);
    expect(budget.snapshot().bytes).toBe(0);
  });
});
