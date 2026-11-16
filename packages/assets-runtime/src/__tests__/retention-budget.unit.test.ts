import { createHash } from 'node:crypto';
import { encodeAssetBundle } from '@forgeax/engine-pack/bundle';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { BundleStore } from '../internal/bundle-store';
import { RetentionBudget } from '../internal/retention-budget';
import { defined } from './assert-defined';

const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function bundleRead(store: BundleStore<string>, name: string, size: number) {
  const packed = encodeAssetBundle([new Uint8Array(size).fill(1), Uint8Array.of(2)]);
  return store.read({
    url: `https://game.test/bundles/${name}.bin`,
    range: { ...defined(packed.windows[1]), bundleDigest: hash(packed.bytes) },
    fetch: async () => ok(packed.bytes.slice()),
    finish: async (bytes) => ok(bytes),
    reuse: async (copy) => ok(copy),
    invalid: (reason) => reason,
  });
}

/** A member holding entries of `bytes` each, used in the order given. */
function member(budget: RetentionBudget, bytes: number) {
  const entries: number[] = [];
  const m = {
    oldest: () => entries[0],
    releaseOldest: () => {
      entries.shift();
      budget.add(-bytes);
    },
    use: () => {
      entries.push(budget.tick());
      budget.add(bytes);
      budget.settle(entries.at(-1));
    },
    held: () => entries.length,
  };
  budget.join(m);
  return m;
}

describe('RetentionBudget', () => {
  it('defaults to one small budget per realm', () => {
    expect(new RetentionBudget().maxBytes).toBe(64 * 1024 * 1024);
  });

  it('releases the least recently used entries across caches down to its margin', async () => {
    const budget = new RetentionBudget(64);
    const bundles = new BundleStore<string>(budget);
    const other = member(budget, 16);
    other.use();
    // The Bundle keeps its unread 24-byte entry resident.
    await bundleRead(bundles, 'map', 24);
    other.use();
    expect(budget.snapshot().bytes).toBe(56);
    // Crossing 64 releases the oldest entry, which is not the Bundle.
    other.use();
    expect(other.held()).toBe(2);
    expect(bundles.snapshot()).toEqual({ bundles: 1, bytes: 24 });
    // Next the Bundle is the least recently used entry.
    other.use();
    expect(other.held()).toBe(3);
    expect(bundles.snapshot()).toEqual({ bundles: 0, bytes: 0 });
    expect(budget.snapshot()).toMatchObject({ bytes: 48, releases: 2 });
  });

  it('frees a margin below a small budget so the next admissions do not release', () => {
    const budget = new RetentionBudget(160);
    const cache = member(budget, 16);
    for (let i = 0; i < 11; i++) cache.use();
    // 176 bytes crossed 160; release continues until at most 150 remain.
    expect(budget.snapshot()).toMatchObject({ bytes: 144, peak: 176, releases: 2 });
    cache.use();
    expect(budget.snapshot()).toMatchObject({ bytes: 160, releases: 2 });
  });

  it('keeps a just-admitted Bundle even when it alone exceeds the budget', async () => {
    const budget = new RetentionBudget(8);
    const bundles = new BundleStore<string>(budget);
    await bundleRead(bundles, 'big', 32);
    expect(bundles.snapshot()).toEqual({ bundles: 1, bytes: 32 });
    bundles.trim();
    expect(budget.snapshot().bytes).toBe(0);
  });

  it('trim releases every member entry; a member that left is not asked', () => {
    const budget = new RetentionBudget(1024);
    const kept = member(budget, 16);
    const left = member(budget, 16);
    kept.use();
    left.use();
    budget.leave(left);
    budget.trim();
    expect(kept.held()).toBe(0);
    expect(left.held()).toBe(1);
  });
});

describe('RetentionBudget idle release', () => {
  it('releases one idle entry per step, oldest first, and keeps recent ones', () => {
    const budget = new RetentionBudget(1024, 10_000);
    const cache = member(budget, 16);
    budget.step(0);
    cache.use();
    cache.use();
    budget.step(1_000);
    cache.use();
    budget.step(2_000);
    // Nothing has been idle for 10 s yet.
    budget.step(10_000);
    expect(cache.held()).toBe(3);
    // The two entries used before 1 s are idle by 11 s; one goes per step.
    budget.step(11_000);
    expect(cache.held()).toBe(2);
    budget.step(11_500); // Within one step interval: nothing happens.
    expect(cache.held()).toBe(2);
    budget.step(12_000);
    expect(cache.held()).toBe(1);
    // The entry used by 2 s is idle too; it waits for the next step.
    budget.step(13_000);
    expect(cache.held()).toBe(0);
    expect(budget.snapshot().bytes).toBe(0);
  });

  it('an entry used again is no longer idle', () => {
    const budget = new RetentionBudget(1024, 10_000);
    const cache = member(budget, 16);
    cache.use();
    budget.step(0);
    cache.releaseOldest();
    cache.use();
    budget.step(5_000);
    budget.step(10_000);
    expect(cache.held()).toBe(1);
    budget.step(15_000);
    expect(cache.held()).toBe(0);
  });

  it('never releases an entry its member does not offer', () => {
    const budget = new RetentionBudget(1024, 10_000);
    let releases = 0;
    budget.join({ oldest: () => undefined, releaseOldest: () => releases++ });
    for (let now = 0; now <= 60_000; now += 1_000) budget.step(now);
    budget.trim();
    expect(releases).toBe(0);
  });

  it('releases an idle resident Bundle', async () => {
    const budget = new RetentionBudget(1024, 10_000);
    const bundles = new BundleStore<string>(budget);
    budget.step(0);
    await bundleRead(bundles, 'map', 24);
    budget.step(1_000);
    budget.step(10_000);
    expect(bundles.snapshot()).toEqual({ bundles: 1, bytes: 24 });
    budget.step(11_000);
    expect(bundles.snapshot()).toEqual({ bundles: 0, bytes: 0 });
    expect(budget.snapshot().bytes).toBe(0);
  });
});
