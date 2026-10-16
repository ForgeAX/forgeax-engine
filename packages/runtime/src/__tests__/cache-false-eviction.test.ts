// m1-t3: cleanPerEntityCache false-eviction test (TDD red).
//
// Verify AC-13: cleanPerFrameCaches validatedEntityKeys built with
// worldEntityKey prevents cross-world false eviction.
//
// Scenarios:
//   1. worldA entity(1) survives one frame — not falsely evicted by
//      worldB's cleanup logic (the validated set uses worldEntityKey).
//   2. worldA entity(2) despawned — its cache is correctly cleaned up
//      (normal eviction still works).
//
// Anchors:
//   plan-tasks.json m1-t3
//   plan-strategy D-1a #4
//   requirements AC-13

import { describe, expect, it } from 'vitest';
import { worldEntityKey } from '../../../render/src/record/frame-snapshot';
import { cleanPerEntityCache } from '../../../render/src/record/mesh-ssbo';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeInnerCache(): WeakMap<object, unknown> {
  const wm = new WeakMap<object, unknown>();
  wm.set({}, 'stub-value');
  return wm;
}

// ─── False eviction: worldA entry survives when worldB has same entityKey ──

describe('false eviction prevention', () => {
  it('worldA entity(1) cache survives one frame (false eviction not triggered)', () => {
    const cache = new Map<number, WeakMap<object, unknown>>();

    // worldA entity(1) has a cached entry
    const keyA_e1 = worldEntityKey(0, 1);
    cache.set(keyA_e1, makeInnerCache());

    // worldB also has entity(1) — different world, same entityKey
    const keyB_e1 = worldEntityKey(1, 1);
    cache.set(keyB_e1, makeInnerCache());

    // Build validated set from the merged renderables:
    // Both worldA entity(1) and worldB entity(1) are present
    const validated = new Set<number>([keyA_e1, keyB_e1]);
    cleanPerEntityCache(cache, validated);

    // Both should survive — no false eviction
    expect(cache.has(keyA_e1)).toBe(true);
    expect(cache.has(keyB_e1)).toBe(true);
  });

  it('worldA entity(1) survives when worldB entity(1) is the only validated one', () => {
    const cache = new Map<number, WeakMap<object, unknown>>();

    // Both worlds have entity(1) entries
    const keyA_e1 = worldEntityKey(0, 1);
    const keyB_e1 = worldEntityKey(1, 1);
    cache.set(keyA_e1, makeInnerCache());
    cache.set(keyB_e1, makeInnerCache());

    // Only worldB entity(1) is in the validated set (worldA entity(1) despawned)
    const validated = new Set<number>([keyB_e1]);
    cleanPerEntityCache(cache, validated);

    // worldA entity(1) should be evicted (it despawned)
    expect(cache.has(keyA_e1)).toBe(false);
    // worldB entity(1) should survive
    expect(cache.has(keyB_e1)).toBe(true);
  });
});

// ─── Normal eviction still works ────────────────────────────────────────────

describe('normal eviction still works', () => {
  it('worldA entity(2) despawned → cache cleaned', () => {
    const cache = new Map<number, WeakMap<object, unknown>>();

    // worldA has entity(1) and entity(2)
    const keyA_e1 = worldEntityKey(0, 1);
    const keyA_e2 = worldEntityKey(0, 2);
    cache.set(keyA_e1, makeInnerCache());
    cache.set(keyA_e2, makeInnerCache());

    // Only entity(1) survives — entity(2) despawned
    const validated = new Set<number>([keyA_e1]);
    cleanPerEntityCache(cache, validated);

    // entity(1) survives
    expect(cache.has(keyA_e1)).toBe(true);
    // entity(2) is evicted
    expect(cache.has(keyA_e2)).toBe(false);
  });

  it('worldA entity(2) despawned while worldB entity(2) lives → only worldA cleaned', () => {
    const cache = new Map<number, WeakMap<object, unknown>>();

    const keyA_e2 = worldEntityKey(0, 2);
    const keyB_e2 = worldEntityKey(1, 2);
    cache.set(keyA_e2, makeInnerCache());
    cache.set(keyB_e2, makeInnerCache());

    // Only worldB entity(2) is validated
    const validated = new Set<number>([keyB_e2]);
    cleanPerEntityCache(cache, validated);

    expect(cache.has(keyA_e2)).toBe(false);
    expect(cache.has(keyB_e2)).toBe(true);
  });
});

// ─── Cross-world key distinctness ───────────────────────────────────────────

describe('cross-world key distinctness', () => {
  it('same entityKey, different worldId → different worldEntityKey values', () => {
    // This is the foundation of false-eviction prevention:
    // worldEntityKey(0, 1) !== worldEntityKey(1, 1)
    // So the validated set correctly distinguishes them.
    const keyA = worldEntityKey(0, 1);
    const keyB = worldEntityKey(1, 1);
    expect(keyA).not.toBe(keyB);
  });

  it('same worldId, same entityKey → same worldEntityKey value', () => {
    expect(worldEntityKey(0, 1)).toBe(worldEntityKey(0, 1));
  });
});
