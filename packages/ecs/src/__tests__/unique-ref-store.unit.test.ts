// feat-20260614-ecs-managed-lifecycle-ssot M1 t-w1: store-unit tests for
// UniqueRefStore.release order + throw-safety + slot reuse.
//
// These tests drive UniqueRefStore directly (no World) per research
// Finding 1.5: the regression repro path is achievable with a spy callback,
// no Rapier / World fixture required. Verifies AC-01, AC-02, AC-06, AC-07
// (requirements §3.1, §5).
//
// TDD red -> green:
//   - (a) order assertion + (b) throw-safety: red before w2, green after w2.
//   - (c) slot reuse: green after w7 (M3 deletes the gen-255 retirement that
//     would otherwise force nextSlot to grow during 1000 iters on a single
//     slot). Documented inline so reviewer can correlate the carryover.

import { handleGeneration, handleSlot, pack, unwrapHandle } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { UniqueRefStaleError } from '../errors';
import { UniqueRefStore } from '../unique-ref-store';

describe('UniqueRefStore release ordering + throw-safety (feat-20260614 M1)', () => {
  it('AC-01: retires payload and generation before cleanup can re-enter', () => {
    const store = new UniqueRefStore();
    const onRelease = vi.fn((_payload: { id: number }) => {
      expect(store._liveCount()).toBe(0);
      expect(store.isLive(handle)).toBe(false);
      expect(store.resolve(handle)).toMatchObject({
        ok: false,
        error: { code: 'unique-ref-stale' },
      });
      const next = store.alloc('Test', { id: 8 });
      expect(handleSlot(next)).toBe(handleSlot(handle));
      expect(handleGeneration(next)).toBe(handleGeneration(handle) + 1);
      expect(store.release(handle)).toMatchObject({
        ok: false,
        error: { code: 'unique-ref-stale' },
      });
      store.release(next).unwrap();
    });
    const handle = store.alloc('Test', { id: 7 }, onRelease);
    expect(store.release(handle).ok).toBe(true);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(store._liveCount()).toBe(0);
  });

  it('AC-02 + AC-06: throwing onRelease re-throws once; second release returns Stale (gen incremented, M4)', () => {
    const store = new UniqueRefStore();
    const onRelease = vi.fn((_payload: { id: number }) => {
      throw new Error('intentional cleanup failure');
    });

    const handle = store.alloc('Test', { id: 9 }, onRelease);

    // First release must propagate the throw (no try/finally swallowing).
    expect(() => store.release(handle)).toThrow('intentional cleanup failure');
    expect(onRelease).toHaveBeenCalledTimes(1);

    // After M4 gen increment, the store gen is now 1 while handle gen is 0.
    // Second release returns stale (gen mismatch), not double-release.
    const second = store.release(handle);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBeInstanceOf(UniqueRefStaleError);
    }
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('AC-07: 1000-iteration alloc/release loop reuses slots (no unbounded growth)', () => {
    const store = new UniqueRefStore();

    for (let i = 0; i < 1000; i++) {
      const handle = store.alloc('Test', { id: i });
      const result = store.release(handle);
      expect(result.ok).toBe(true);
    }

    expect(store._liveCount()).toBe(0);

    // nextSlot is private. After M3 (w7) deletes the gen-255 retirement path
    // a single slot recycles forever and nextSlot stays at 2. Before w7,
    // gen-255 retirement forces ~4 fresh slots over 1000 iters (256 per slot
    // before retirement). The bound below stays true in both regimes and
    // tightens after M3; the inline comment is the bridge between this test
    // and M3's removal of gen retirement (research Finding 1.4).
    // biome-ignore lint/suspicious/noExplicitAny: targeted private read for slot-reuse verification
    const nextSlot = (store as any).nextSlot as number;
    expect(nextSlot).toBeLessThan(10);
  });
});

// ─── w6 M3: gen welding alloc tests ─────────────────────────────────────
// feat-20260623-asset-handle-generation M3 — alloc embeds generation into
// the returned handle via codec.pack(slot, gen). First alloc gen=0 (AC-06);
// slot 0 sentinel stays pack(0,0)===0 and isLive(0)===false (R6).
// M3 scope: gen welding only, no gen increment on release (that's M4).
// Reused slots always get gen=0 in M3.
describe('w6 M3 UniqueRefStore: gen welding on alloc', () => {
  it('AC-06: first alloc gen=0 => handleSlot matches raw slot', () => {
    const store = new UniqueRefStore();
    const handle = store.alloc('TestAsset', { id: 1 });

    const slot = handleSlot(handle);
    const gen = handleGeneration(handle);

    expect(gen).toBe(0);
    // UniqueRefStore.nextSlot starts at 1, so the first alloc should be slot 1
    expect(slot).toBe(1);
  });

  it('AC-05: pack(slot,0)===slot for slot 0-5 (sentinel + typical slots)', () => {
    for (let s = 0; s <= 5; s++) {
      expect(pack(s, 0)).toBe(s);
    }
  });

  it('R6: slot 0 sentinel — pack(0,0)===0 and isLive(0)===false', () => {
    expect(pack(0, 0)).toBe(0);

    // isLive should return false for any handle whose raw value is 0.
    // TypeScript disallows constructing Handle<T, 'unique'> with literal 0
    // from outside toUnique, but isLive reads the raw value — passing
    // a brand-cast 0 tests the sentinel path.
    const store = new UniqueRefStore();
    // biome-ignore lint/suspicious/noExplicitAny: sentinel test pattern
    expect(store.isLive(0 as any)).toBe(false);
  });

  it('alloc welds gen into handle — gen extractable via handleGeneration', () => {
    // After alloc gen welding, handleGeneration returns the gen embedded
    // during alloc. In M3, gen is always 0 because release does not yet
    // increment _generations (M4). But the pack(slot,gen) -> handleGeneration
    // round-trip must work.
    const store = new UniqueRefStore();
    const h = store.alloc('TestAsset', { id: 1 });
    expect(handleGeneration(h)).toBe(0);
    expect(handleSlot(h)).toBe(1);
    expect(pack(handleSlot(h), handleGeneration(h))).toBe(unwrapHandle(h));
    // Not using unwrapHandle directly — using pack+handleSlot+handleGeneration
    // as indirect verification.
    // biome-ignore lint/suspicious/noExplicitAny: access the raw brand value
    expect(h as any as number).toBe(pack(1, 0));
  });

  it('resolve works correctly after gen-welded alloc (gen increments on release, M4)', () => {
    // Alloc + release + re-alloc: the second handle resolves to the
    // second payload. After M4, release increments gen, re-alloc gets gen=1.
    const store = new UniqueRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(handleGeneration(h1)).toBe(0);

    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    // M4: release incremented gen to 1, so re-alloc gets gen=1
    expect(handleGeneration(h2)).toBe(1);

    const r = store.resolve(h2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ mesh: 'sphere' });
    }
  });

  it('alloc with onRelease fires after gen-welded release', () => {
    const cb = vi.fn();
    const store = new UniqueRefStore();
    const h = store.alloc('Asset', { key: 1 }, cb);
    expect(store.release(h).ok).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ key: 1 });
  });

  it('R6: slot 0 sentinel isLive false — alloc never produces slot 0', () => {
    const store = new UniqueRefStore();
    // Alloc 100 handles and release them — slot 0 should never appear
    // because nextSlot starts at 1 and freeSlots only contain released
    // slots >= 1.
    const handles: ReturnType<typeof store.alloc>[] = [];
    for (let i = 0; i < 100; i++) {
      handles.push(store.alloc('Test', { id: i }));
    }
    for (const h of handles) {
      expect(handleSlot(h)).toBeGreaterThanOrEqual(1);
      expect(store.release(h).ok).toBe(true);
    }
    // All slots recycled — still no slot 0
    const h = store.alloc('Test', { id: 999 });
    expect(handleSlot(h)).toBeGreaterThanOrEqual(1);
  });

  it('M4: alloc after release reuses slot with gen 1 (gen increments on release)', () => {
    const store = new UniqueRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    void handleSlot(h1); // probe slot
    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    expect(handleGeneration(h2)).toBe(1);

    const r2 = store.resolve(h2);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toEqual({ mesh: 'sphere' });

    // h1 (gen=0) is stale now
    const r1 = store.resolve(h1);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('unique-ref-stale');
  });
});

// ─── w9 M4: stale detection unit tests (red phase) ─────────────────────
// feat-20260623-asset-handle-generation M4 — gen comparison on
// resolve/release (UniqueRefStore has no retain). RED phase: gen increment
// on release is NOT implemented yet, so stale detections return ok.
describe('w9 M4 UniqueRefStore: stale detection (resolve/release + retire)', () => {
  it('AC-01: stale resolve returns error with code unique-ref-stale', () => {
    const store = new UniqueRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    // Release bumps gen 0->1, then re-alloc gets gen=1.
    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    expect(handleGeneration(h2)).toBe(1);

    // h1 (gen=0) is stale
    const r = store.resolve(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('unique-ref-stale');
    }
    // h2 resolves normally
    const r2 = store.resolve(h2);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value).toEqual({ mesh: 'sphere' });
    }
  });

  it('AC-01: stale resolve never returns a payload', () => {
    const store = new UniqueRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);
    store.alloc('MeshAsset', { mesh: 'sphere' });

    const r = store.resolve(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // biome-ignore lint/suspicious/noExplicitAny: accessing value on Result union error branch to verify no payload leak
      expect((r as any).value).toBeUndefined();
    }
  });

  it('AC-03: stale release returns error, does NOT drop payload of new holder', () => {
    const store = new UniqueRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    // h2 is live. Stale release of h1 must NOT drop h2's payload.
    const r = store.release(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('unique-ref-stale');
    }

    // h2 is still live — resolve should succeed
    const r2 = store.resolve(h2);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value).toEqual({ mesh: 'sphere' });
    }
  });

  it('AC-03: stale release does not trigger onRelease callback', () => {
    const cb = vi.fn();
    const store = new UniqueRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' }, cb);
    expect(store.release(h1).ok).toBe(true);

    // Re-alloc with new gen
    store.alloc('MeshAsset', { mesh: 'sphere' });

    // Stale release of h1 should NOT fire h2's callback
    const r = store.release(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('unique-ref-stale');
    }
    expect(cb).toHaveBeenCalledTimes(1); // only from the first release (gen match)
  });

  it('AC-04: new handle after reuse resolves and releases normally', () => {
    const store = new UniqueRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    expect(handleGeneration(h2)).toBe(1);

    // resolve
    const r = store.resolve(h2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ mesh: 'sphere' });

    // release
    expect(store.release(h2).ok).toBe(true);

    // h1 still stale
    const rStale = store.resolve(h1);
    expect(rStale.ok).toBe(false);
    if (!rStale.ok) {
      expect(rStale.error.code).toBe('unique-ref-stale');
    }
  });

  it('AC-07: retire-on-255 — gen pushed past MAX_GEN then slot not recycled', () => {
    const store = new UniqueRefStore();
    const h = store.alloc('MeshAsset', { mesh: 'cube' });
    const slot = handleSlot(h);

    // gen=255 is still a usable handle under the new gen > MAX_GEN predicate.
    // Bump _generations[slot] to 255 and push to freeSlots so the next alloc
    // reuses it with gen=255.
    // biome-ignore lint/suspicious/noExplicitAny: private mutation for retire edge boundary
    (store as any)._generations[slot] = 255;
    // biome-ignore lint/suspicious/noExplicitAny: push slot to free list so alloc reuses
    (store as any).freeSlots.push(slot);

    // Alloc reuses slot with gen=255
    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    expect(handleGeneration(h2)).toBe(255);
    // Verify gen=255 is a usable handle — resolve succeeds.
    const rResolve = store.resolve(h2);
    expect(rResolve.ok).toBe(true);

    // Release h2: gen matches, gen++ to 256 (>MAX_GEN), slot retired.
    expect(store.release(h2).ok).toBe(true);

    // Slot must not be recycled (retired)
    // biome-ignore lint/suspicious/noExplicitAny: private read
    const freeSlots: number[] = (store as any).freeSlots;
    expect(freeSlots.indexOf(slot)).toBe(-1);
  });
});
