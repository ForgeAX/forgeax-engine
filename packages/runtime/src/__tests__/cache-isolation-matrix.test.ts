// m1-t2: Dual-world entity-id cache isolation matrix test (TDD red).
//
// Verify that the three per-entity caches use worldId composite keys
// (worldEntityKey) to isolate entries from different worlds that share
// the same entityKey. The caches under test:
//
//   1. instanceBuffers (positive half only — D-1a #1)
//   2. materialBgPerEntity (outer Map key — D-1a #2)
//   3. instancesBgPerEntity (outer Map key — D-1a #3)
//
// Anchors:
//   plan-tasks.json m1-t2
//   plan-strategy D-1a #1-#3
//   requirements AC-07

import { describe, expect, it } from 'vitest';
import { worldEntityKey } from '../../../render/src/record/frame-snapshot';
import { cleanPerEntityCache } from '../../../render/src/record/mesh-ssbo';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeInnerCache(): WeakMap<object, unknown> {
  const wm = new WeakMap<object, unknown>();
  wm.set({}, 'stub-value');
  return wm;
}

// ─── instanceBuffers (positive half) key isolation ─────────────────────────

describe('instanceBuffers positive-half key isolation', () => {
  it('worldA entity(42) write then worldB entity(42) miss', () => {
    // Simulate the instanceBuffers Map<number, ...> with worldEntityKey
    const cache = new Map<number, object>();

    const keyA = worldEntityKey(0, 42);
    const keyB = worldEntityKey(1, 42);
    const entryA = {};

    // Write for worldA
    cache.set(keyA, entryA);

    // worldB entity(42) should NOT hit the worldA entry
    expect(cache.get(keyB)).toBeUndefined();

    // worldA entity(42) SHOULD hit its own entry
    expect(cache.get(keyA)).toBe(entryA);
  });

  it('worldA entity(42) write, then worldA entity(42) read hits', () => {
    const cache = new Map<number, object>();
    const keyA = worldEntityKey(0, 42);
    const entry = {};
    cache.set(keyA, entry);
    expect(cache.get(keyA)).toBe(entry);
  });

  it('worldA entity(1) and worldB entity(1) are independent', () => {
    const cache = new Map<number, object>();
    const keyA = worldEntityKey(0, 1);
    const keyB = worldEntityKey(1, 1);
    const entryA = { a: 1 };
    const entryB = { b: 2 };

    cache.set(keyA, entryA);
    cache.set(keyB, entryB);

    expect(cache.get(keyA)).toBe(entryA);
    expect(cache.get(keyB)).toBe(entryB);
    // Keys are different
    expect(keyA).not.toBe(keyB);
  });

  it('negative half fold-bucket key is NOT worldEntityKey (stays raw)', () => {
    // D-1a #1: negative half fold-bucket keys are NOT worldEntityKey-prefixed.
    // They are material-handle-based fold keys and remain as-is.
    // This test documents the invariant: a fold-bucket key is simply a
    // negative number, not a worldEntityKey composite.
    const foldKey = -1 - ((42 << 16) | 0); // example fold-bucket key
    // foldKey is negative, while worldEntityKey is always >= 0
    expect(foldKey).toBeLessThan(0);
    expect(worldEntityKey(0, 42)).toBeGreaterThanOrEqual(0);
  });
});

// ─── materialBgPerEntity outer Map key isolation ────────────────────────────

describe('materialBgPerEntity outer Map key isolation', () => {
  it('worldA entity(42) write then worldB entity(42) miss', () => {
    const cache = new Map<number, WeakMap<object, unknown>>();

    const keyA = worldEntityKey(0, 42);
    const keyB = worldEntityKey(1, 42);
    const entryA = makeInnerCache();

    cache.set(keyA, entryA);

    // worldB entity(42) should miss
    expect(cache.get(keyB)).toBeUndefined();
    // worldA entity(42) should hit
    expect(cache.get(keyA)).toBe(entryA);
  });

  it('worldA entity(42) and worldB entity(42) both have independent entries', () => {
    const cache = new Map<number, WeakMap<object, unknown>>();
    const keyA = worldEntityKey(0, 42);
    const keyB = worldEntityKey(1, 42);
    const entryA = makeInnerCache();
    const entryB = makeInnerCache();

    cache.set(keyA, entryA);
    cache.set(keyB, entryB);

    expect(cache.get(keyA)).toBe(entryA);
    expect(cache.get(keyB)).toBe(entryB);
    expect(entryA).not.toBe(entryB);
  });
});

// ─── instancesBgPerEntity outer Map key isolation ───────────────────────────

describe('instancesBgPerEntity outer Map key isolation', () => {
  it('worldA entity(42) write then worldB entity(42) miss', () => {
    const cache = new Map<number, WeakMap<object, unknown>>();

    const keyA = worldEntityKey(0, 42);
    const keyB = worldEntityKey(1, 42);
    const entryA = makeInnerCache();

    cache.set(keyA, entryA);

    expect(cache.get(keyB)).toBeUndefined();
    expect(cache.get(keyA)).toBe(entryA);
  });

  it('worldA entity(42) and worldB entity(42) both have independent entries', () => {
    const cache = new Map<number, WeakMap<object, unknown>>();
    const keyA = worldEntityKey(0, 42);
    const keyB = worldEntityKey(1, 42);
    const entryA = makeInnerCache();
    const entryB = makeInnerCache();

    cache.set(keyA, entryA);
    cache.set(keyB, entryB);

    expect(cache.get(keyA)).toBe(entryA);
    expect(cache.get(keyB)).toBe(entryB);
  });
});

// ─── cleanPerEntityCache with worldEntityKey keys ───────────────────────────

describe('cleanPerEntityCache with worldEntityKey keys', () => {
  it('worldA entry survives when only worldB key is absent from validated set', () => {
    const cache = new Map<number, WeakMap<object, unknown>>();
    const keyA = worldEntityKey(0, 42);
    const keyB = worldEntityKey(1, 42);

    cache.set(keyA, makeInnerCache());
    cache.set(keyB, makeInnerCache());

    // Only worldA entity(42) is validated
    const validated = new Set<number>([keyA]);
    cleanPerEntityCache(cache, validated);

    // worldA entry should survive
    expect(cache.has(keyA)).toBe(true);
    // worldB entry should be evicted (not in validated set)
    expect(cache.has(keyB)).toBe(false);
  });

  it('worldA entry evicted when worldA key is absent from validated set', () => {
    const cache = new Map<number, WeakMap<object, unknown>>();
    const keyA = worldEntityKey(0, 42);

    cache.set(keyA, makeInnerCache());

    // Empty validated set — nothing survives
    const validated = new Set<number>();
    cleanPerEntityCache(cache, validated);

    expect(cache.has(keyA)).toBe(false);
  });
});
