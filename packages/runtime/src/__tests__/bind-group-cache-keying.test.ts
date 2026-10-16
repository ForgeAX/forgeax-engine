// feat-20260622-handle-to-id-allocator-elimination M2 / w4 + w5:
// TDD tests for WeakMap chain determinism, cleanup new shape, AC-08 export,
// and AC-06 two-helper existence. Replaces the old string-key dedup +
// sentinel-survival tests (buildBindGroupCacheKey / Number.isNaN / D-6 rescue).
//
// w4: chain determinism (getOrCreateFromChain — red until w7 implements it).
// w5: cleanup eviction (cleanPerEntityCache — red until w8 rewrites it)
//     + getOrCreatePerEntity existence (red until w8 implements it).

import type { BindGroup } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { BindGroupCounts } from '../../../render/src/record/frame-snapshot';
import {
  cleanPerEntityCache,
  findFromChain,
  getOrCreateFromChain,
  getOrCreatePerEntity,
} from '../../../render/src/record/mesh-ssbo';

// ─── helpers ────────────────────────────────────────────────────────────────

function h(): object {
  return {};
}

function stubBindGroup(): BindGroup {
  return {} as unknown as BindGroup;
}

function stubCounts(): BindGroupCounts {
  return { createBindGroup: 0, keys: [] };
}

function factory(): BindGroup {
  return stubBindGroup();
}

// ─── w4: WeakMap chain determinism (no id allocator, no NaN, no string key) ──
//
// The old buildBindGroupCacheKey walked a WeakMap<object,number> counter to
// produce string keys for a flat Map<string,BG>. The new design uses handle
// objects directly as WeakMap chain nodes — same object identity → same leaf,
// different objects → different leaf. No Number.isNaN rescue branch exists
// because there is no string parsing.
//
// These tests are RED until w7 implements getOrCreateFromChain (D-2 / AC-06).

describe('w4 — WeakMap chain determinism', () => {
  it('same handles + same variant produces the same BG leaf (deterministic)', () => {
    const root = new WeakMap<object, unknown>();
    const handles = [h(), h()];
    const counts = stubCounts();
    const bg1 = getOrCreateFromChain(root, handles, 'view-main', factory, counts);
    const bg2 = getOrCreateFromChain(root, handles, 'view-main', factory, counts);
    expect(bg1).toBe(bg2);
  });

  it('different handle set produces a different BG leaf', () => {
    const root = new WeakMap<object, unknown>();
    const handlesA = [h(), h()];
    const handlesB = [h(), h()];
    const counts = stubCounts();
    const bgA = getOrCreateFromChain(root, handlesA, 'view-main', factory, counts);
    const bgB = getOrCreateFromChain(root, handlesB, 'view-main', factory, counts);
    expect(bgA).not.toBe(bgB);
  });

  it('same handles + different variant produces different BG leaf', () => {
    const root = new WeakMap<object, unknown>();
    const handles = [h(), h()];
    const counts = stubCounts();
    const bgMain = getOrCreateFromChain(root, handles, 'view-main', factory, counts);
    const bgShadow = getOrCreateFromChain(root, handles, 'view-shadow', factory, counts);
    expect(bgMain).not.toBe(bgShadow);
  });

  it('chain lookup is idempotent — createBindGroup stays at 1 across N calls', () => {
    const root = new WeakMap<object, unknown>();
    const handles = [h(), h(), h(), h(), h(), h(), h()]; // 7 deep like view-main
    const counts = stubCounts();
    for (let i = 0; i < 100; i++) {
      const bg = getOrCreateFromChain(root, handles, 'view-main', factory, counts);
      expect(bg).toBeDefined();
    }
    expect(counts.createBindGroup).toBe(1);
  });
});

// ─── w5a: cleanPerEntityCache new shape (AC-02 / AC-08) ─────────────────────
//
// The old cleanPerEntityCache parsed entityKey from string keys via
// indexOf('-') + Number(slice) and used Number.isNaN(ek) to rescue
// sentinel / material-shared keys. The new design uses Map<number, WeakMap>
// where entityKey is already a number — eviction is a simple delete loop:
//   for (const ek of cache.keys())
//     if (!validatedEntityKeys.has(ek)) cache.delete(ek)
//
// No string parsing, no Number.isNaN, no indexOf / Number calls.
// cleanPerEntityCache remains an @internal export (AC-08).
//
// These tests are RED until w8 rewrites cleanPerEntityCache (RD4 / AC-02).

describe('w5a — cleanPerEntityCache new shape (AC-02, AC-08)', () => {
  it('deletes entityKeys not in the validated set', () => {
    const bg1 = stubBindGroup();
    const bg2 = stubBindGroup();
    const inner1 = new WeakMap<object, BindGroup>();
    inner1.set(h(), bg1);
    const inner2 = new WeakMap<object, BindGroup>();
    inner2.set(h(), bg2);
    const cache = new Map<number, WeakMap<object, BindGroup>>();
    cache.set(123, inner1);
    cache.set(456, inner2);

    const validated = new Set<number>([123]);

    cleanPerEntityCache(cache, validated);

    expect(cache.has(123)).toBe(true); // validated -> kept
    expect(cache.has(456)).toBe(false); // stale -> deleted
  });

  it('deletes all entityKeys when validated set is empty', () => {
    const inner = new WeakMap<object, BindGroup>();
    inner.set(h(), stubBindGroup());
    const cache = new Map<number, WeakMap<object, BindGroup>>();
    cache.set(42, inner);

    cleanPerEntityCache(cache, new Set());

    expect(cache.size).toBe(0);
  });

  it('keeps all entityKeys when all are validated', () => {
    const inner1 = new WeakMap<object, BindGroup>();
    inner1.set(h(), stubBindGroup());
    const inner2 = new WeakMap<object, BindGroup>();
    inner2.set(h(), stubBindGroup());
    const cache = new Map<number, WeakMap<object, BindGroup>>();
    cache.set(1, inner1);
    cache.set(2, inner2);

    const validated = new Set<number>([1, 2]);
    cleanPerEntityCache(cache, validated);

    expect(cache.size).toBe(2);
    expect(cache.has(1)).toBe(true);
    expect(cache.has(2)).toBe(true);
  });

  it('has no string parsing, no Number.isNaN, no Number calls in function body', () => {
    // AC-02: the function body must not contain indexOf, Number, or Number.isNaN.
    const fnSrc = cleanPerEntityCache.toString();
    expect(fnSrc).not.toContain('indexOf');
    expect(fnSrc).not.toContain('Number.isNaN');
    expect(fnSrc).not.toContain('Number(');
  });
});

// ─── w5b: getOrCreatePerEntity existence (AC-06) ────────────────────────────
//
// The new per-entity helper `getOrCreatePerEntity` takes an outer
// Map<string|number, WeakMap<...>> and an outerKey, then walks the
// inner WeakMap chain. No branch-on-cache-type inside a single generic
// helper (AC-06: two distinct helpers exist, no unified one).
//
// These tests are RED until w8 implements getOrCreatePerEntity (D-2 / AC-06).

describe('w5b — getOrCreatePerEntity existence and behavior (AC-06)', () => {
  it('getOrCreatePerEntity is a distinct named export (no branch-on-cache-type)', () => {
    // AC-06: Two named helpers exist, no unified generic helper with
    // branch-on-cache-type. These imports would fail at load time if either
    // symbol is missing (the file-level import already validates this).
    expect(typeof getOrCreateFromChain).toBe('function');
    expect(typeof getOrCreatePerEntity).toBe('function');
  });

  it('getOrCreatePerEntity with outerKey=number hits same leaf on second call', () => {
    const outer = new Map<number, WeakMap<object, unknown>>();
    const handles = [h(), h()];
    const counts = stubCounts();
    const bg1 = getOrCreatePerEntity(outer, 42, handles, 'material', factory, counts);
    const bg2 = getOrCreatePerEntity(outer, 42, handles, 'material', factory, counts);
    expect(bg1).toBe(bg2);
    expect(counts.createBindGroup).toBe(1);
  });

  it('getOrCreatePerEntity with outerKey=string hits same leaf on second call', () => {
    // material-shared uses string outerKey (shaderId) — OQ-1 / D-1.
    const outer = new Map<string, WeakMap<object, unknown>>();
    const handles = [h(), h()];
    const counts = stubCounts();
    const bg1 = getOrCreatePerEntity(
      outer,
      'pbr-standard',
      handles,
      'material-shared',
      factory,
      counts,
    );
    const bg2 = getOrCreatePerEntity(
      outer,
      'pbr-standard',
      handles,
      'material-shared',
      factory,
      counts,
    );
    expect(bg1).toBe(bg2);
    expect(counts.createBindGroup).toBe(1);
  });

  it('getOrCreatePerEntity: different outerKey produces different leaf', () => {
    const outer = new Map<number, WeakMap<object, unknown>>();
    const handles = [h(), h()];
    const counts = stubCounts();
    const bgA = getOrCreatePerEntity(outer, 1, handles, 'material', factory, counts);
    const bgB = getOrCreatePerEntity(outer, 2, handles, 'material', factory, counts);
    expect(bgA).not.toBe(bgB);
  });
});

// ─── w20: HDRP shadow-instances cross-function producer/consumer pair (D-4) ──
//
// recordShadowPass writes the shadow-instances BG at render-system-record.ts
// :3438 via getOrCreatePerEntity(instancesBgPerEntity, entityKey,
// [instBuffer], 'shadow-instances', ...). The HDRP main pass reads it back at
// :3825 NOT through the helper, but with a manual two-step lookup:
//   instancesBgPerEntity.get(entityKey)?.get(instBuffer) as Map<string, BG>
//   leaf?.get('shadow-instances')
// If the read end used a different outerKey or handle than the write end, the
// lookup would miss, the main pass would `continue`, and instanced shadows
// would silently vanish. HDRP shadow pass has no dawn smoke and the HDRP
// browser tests only assert BGL slots / gbuffer formats (not shadow-instance
// draws), so this invariant is otherwise untested (research OQ-2). These tests
// fixate the D-4 contract: the manual read shape must find the helper write.

describe('w20 — HDRP shadow-instances cross-function read finds helper write (D-4)', () => {
  const SHADOW_INSTANCES_VARIANT = 'shadow-instances';

  // Mirrors the :3825 read end: two WeakMap hops + variant leaf lookup.
  function readShadowInstancesBg(
    outer: Map<number, WeakMap<object, unknown>>,
    entityKey: number,
    instBuffer: object,
  ): BindGroup | undefined {
    return findFromChain(
      outer.get(entityKey) ?? new WeakMap<object, unknown>(),
      [instBuffer],
      SHADOW_INSTANCES_VARIANT,
    );
  }

  it('read end finds the leaf the write end stored under the same (entityKey, instBuffer)', () => {
    const outer = new Map<number, WeakMap<object, unknown>>();
    const entityKey = 7;
    const instBuffer = h(); // the shared instance buffer handle (single-handle chain)
    const counts = stubCounts();

    // Write end (:3438): recordShadowPass populates the per-entity leaf.
    const written = getOrCreatePerEntity(
      outer,
      entityKey,
      [instBuffer],
      SHADOW_INSTANCES_VARIANT,
      factory,
      counts,
    );

    // Read end (:3825): HDRP main pass resolves it with the same pair.
    const read = readShadowInstancesBg(outer, entityKey, instBuffer);

    expect(read).toBeDefined();
    expect(read).toBe(written);
    expect(counts.createBindGroup).toBe(1); // single create, then a hit on read
  });

  it('read end misses when the entityKey differs (per-entity isolation)', () => {
    const outer = new Map<number, WeakMap<object, unknown>>();
    const instBuffer = h();
    const counts = stubCounts();

    getOrCreatePerEntity(outer, 7, [instBuffer], SHADOW_INSTANCES_VARIANT, factory, counts);

    // Different entity, same buffer handle -> no outer-Map entry -> miss.
    expect(readShadowInstancesBg(outer, 8, instBuffer)).toBeUndefined();
  });

  it('read end misses when the instance buffer handle differs (chain identity)', () => {
    const outer = new Map<number, WeakMap<object, unknown>>();
    const entityKey = 7;
    const counts = stubCounts();

    getOrCreatePerEntity(outer, entityKey, [h()], SHADOW_INSTANCES_VARIANT, factory, counts);

    // Same entity, a fresh (grown) instance buffer object -> inner WeakMap miss.
    expect(readShadowInstancesBg(outer, entityKey, h())).toBeUndefined();
  });
});
