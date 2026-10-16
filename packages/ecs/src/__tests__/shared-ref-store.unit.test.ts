import { Update } from '../schedule-token';
// feat-20260614-ecs-shared-component-and-unique-rename M3 — SharedRefStore
// red-green-refactor unit tests.
//
// Drives the SharedRefStore class directly (no World) per plan-strategy §5.3.
// The store mirrors UniqueRefStore in shape but adds reference counting and
// structured release evidence. Five public API surfaces:
//
//   alloc(tag, value)          -> Handle<T, 'shared'> (rc starts at 1)
//   resolve(handle)            -> Result<T, SharedRefReleasedError>
//   retain(handle)             -> Result<void, SharedRefReleasedError>
//   release(handle)            -> Result<release evidence | undefined, ...>
//
// Tests are split across three describe blocks tracking the w6 / w7 / w8
// task boundary. The first two run as TDD red against the still-absent
// SharedRefStore class in w6 / w7; w9 implements the class to turn them
// green. w8 covers the World.allocSharedRef facade including AC-16 type
// inference inside an addSystem fn callback.
//
// M3 scope: store + facade + parser/TYPE_METADATA wiring. Spawn-retain /
// despawn-release of `'shared<T>'` schema fields is M4 work (w12 inserts the
// fieldType.startsWith('shared<') sub-dispatch in releaseManagedFieldOnRow);
// that integration is covered by the M4 test surface (w11), not here.

import type { Handle } from '@forgeax/engine-types';
import {
  BUILTIN_BASE,
  handleGeneration,
  handleSlot,
  MAX_SLOT,
  pack,
  toShared,
  unwrapHandle,
} from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineComponent } from '../component';
import { BuiltinSlotNotOwnedError, SharedRefStaleError } from '../errors';
import { SharedRefStore } from '../shared-ref-store';
import { World } from '../world';

// ─── w6: alloc + resolve ────────────────────────────────────────────────
describe('w6 SharedRefStore: alloc + resolve', () => {
  it('alloc returns a Handle<T, "shared"> branded value with rc=1', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('TestAsset', { id: 1 });

    expectTypeOf(handle).toEqualTypeOf<Handle<'TestAsset', 'shared'>>();
    expect(store.refcount(handle)).toBe(1);
    expect(store._liveCount()).toBe(1);
  });

  it('resolve returns the payload while rc > 0', () => {
    const store = new SharedRefStore();
    const payload = { mesh: 'cube' };
    const handle = store.alloc('MeshAsset', payload);

    const r = store.resolve(handle);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(payload);
    }
  });

  it('resolve returns SharedRefStaleError after rc drops to 0 (gen incremented on release)', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('MeshAsset', { id: 7 });

    const releaseResult = store.release(handle);
    expect(releaseResult.ok).toBe(true);

    // After w10 gen increment on release, old handle gen=0 mismatches store
    // gen=1 — stale, not released. Gen comparison runs before payload lookup.
    const r = store.resolve(handle);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shared-ref-stale');
      if (r.error instanceof SharedRefStaleError) {
        expect(typeof r.error.detail.slot).toBe('number');
      }
    }
  });

  it('release after rc=0 returns SharedRefStaleError (gen mismatch after first release)', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('MeshAsset', { id: 9 });

    expect(store.release(handle).ok).toBe(true);
    // Second release: gen=0 vs store gen=1 — stale, not double-release.
    const second = store.release(handle);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('shared-ref-stale');
      // error.detail is a discriminated union; use error instance check
      if (second.error instanceof SharedRefStaleError) {
        expect(typeof second.error.detail.slot).toBe('number');
      }
    }
  });
});

describe('SharedRefStore.intern: producer identity', () => {
  it('acquires independent grants without duplicating the payload handle', () => {
    const store = new SharedRefStore();
    const payload = { material: 'shared' };
    const first = store.acquire('MaterialAsset', payload);
    const second = store.acquire('MaterialAsset', payload);
    expect(second).toBe(first);
    expect(store.refcount(first)).toBe(2);
    store.release(first).unwrap();
    expect(store.resolve(second).unwrap()).toBe(payload);
    store.release(second).unwrap();
    expect(store._liveCount()).toBe(0);
    const producer = store.intern('MaterialAsset', payload);
    const borrowed = store.acquire('MaterialAsset', payload);
    expect(borrowed).toBe(producer);
    store.release(borrowed).unwrap();
    expect(store.refcount(producer)).toBe(1);
    store.release(producer).unwrap();
    expect(store._liveCount()).toBe(0);
  });
  it('returns one producer handle for the same target and payload object', () => {
    const store = new SharedRefStore();
    const payload = { id: 1 };

    const first = store.intern('MaterialAsset', payload);
    const second = store.intern('MaterialAsset', payload);

    expect(second).toBe(first);
    expect(store.refcount(first)).toBe(1);
    expect(store._liveCount()).toBe(1);
  });

  it('does not alias ordinary allocations or different targets', () => {
    const store = new SharedRefStore();
    const payload = { id: 1 };

    const allocatedA = store.alloc('MaterialAsset', payload);
    const allocatedB = store.alloc('MaterialAsset', payload);
    const material = store.intern('MaterialAsset', payload);
    const texture = store.intern('TextureAsset', payload);

    expect(allocatedB).not.toBe(allocatedA);
    expect(material).not.toBe(allocatedA);
    expect(texture).not.toBe(material);
  });

  it('forgets the identity entry when the producer grant reaches zero', () => {
    const store = new SharedRefStore();
    const payload = { id: 1 };
    const released = store.intern('MaterialAsset', payload);

    expect(store.release(released).ok).toBe(true);
    const next = store.intern('MaterialAsset', payload);

    expect(next).not.toBe(released);
    expect(store.resolve(next)).toMatchObject({ ok: true, value: payload });
  });
});

// ─── w29 (D-10): retain + release evidence ─────────────────────────────
describe('w29 SharedRefStore: retain + structured release evidence', () => {
  it('alloc -> retain N -> release N+1 cycles through rc=0 cleanly', () => {
    const store = new SharedRefStore();
    const payload = { id: 4 };
    const handle = store.alloc('Asset', payload);
    for (let i = 0; i < 5; i++) {
      expect(store.retain(handle).ok).toBe(true);
    }
    expect(store.refcount(handle)).toBe(6);

    for (let i = 0; i < 6; i++) {
      expect(store.release(handle).ok).toBe(true);
    }
    expect(store.refcount(handle)).toBe(0);
    expect(store.resolve(handle).ok).toBe(false);
    expect(store.refcount(handle)).toBe(0);
  });

  it('final release returns the same payload/refcount/generation evidence', () => {
    const store = new SharedRefStore();
    const payload = { id: 1 };
    const handle = store.alloc('Asset', payload);

    const result = store.release(handle);
    expect(result.ok).toBe(true);
    expect(result.unwrap()).toEqual({ payload, refcount: 0, generation: 1, evidence: 'released' });
  });

  it('retain after release-to-zero is a SharedRefStaleError (gen mismatch after w10)', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('Asset', { id: 5 });
    expect(store.release(handle).ok).toBe(true);

    const r = store.retain(handle);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shared-ref-stale');
    }
  });
});

// ─── w8: World.allocSharedRef + AC-16 type inference inside addSystem fn ─
describe('w8 World.allocSharedRef: facade + AC-16 type inference', () => {
  it('World.allocSharedRef returns Handle<Tag, "shared"> (no `as` assertion)', () => {
    const world = new World();
    const handle = world.allocSharedRef('SkinAsset', { joints: 24 });

    expectTypeOf(handle).toEqualTypeOf<Handle<'SkinAsset', 'shared'>>();
    expect(world.sharedRefs.refcount(handle)).toBe(1);
  });

  it('World.internSharedRef preserves target handle inference', () => {
    const world = new World();
    const handle = world.internSharedRef('MaterialAsset', { kind: 'material' });

    expectTypeOf(handle).toEqualTypeOf<Handle<'MaterialAsset', 'shared'>>();
  });

  it('explicit release of the alloc-grant takes rc to 0 and publishes evidence', () => {
    const world = new World();

    const payload = { id: 99 };
    const handle = world.allocSharedRef('Asset', payload);
    const r = world.sharedRefs.release(handle);
    expect(r.ok).toBe(true);
    expect(world.sharedRefs.refcount(handle)).toBe(0);
    expect(r.unwrap()).toMatchObject({ payload, refcount: 0, generation: 1, evidence: 'released' });
  });

  it('AC-16 fourth application point: addSystem fn callback infers Handle<Target, "shared">', () => {
    // AC-16 application point #4: `addSystem({ fn })` callback consumer reads
    // a `'shared<T>'` schema field via world.get and the bundle field type
    // must narrow to `Handle<Target, 'shared'>` with no `as` assertion.
    // Validated inside a real system fn (not a *.test-d.ts file).
    //
    // This test exercises the type-inference end-to-end: schema vocab keyword
    // 'shared<MaterialAsset>' -> column u32 -> world.get unwrap -> field
    // value type. Runtime spawn-retain wiring is M4 (w12) work; here we only
    // exercise the type assertion, not the rc transition.
    const Material = defineComponent('SharedMaterialField', {
      asset: 'shared<MaterialAsset>',
    });
    const world = new World();
    const handle = world.allocSharedRef('MaterialAsset', { albedo: 0xffffff });

    const e = world.spawn({ component: Material, data: { asset: handle } }).unwrap();

    let observedType: 'matched' | 'unmatched' = 'unmatched';
    world.addSystem(Update, {
      name: 'shared-bundle-reader',
      queries: [{ with: [Material] }],
      fn: () => {
        const row = world.get(e, Material).unwrap();
        // The type assertion: row.asset MUST be Handle<'MaterialAsset', 'shared'>
        // (not Handle<'MaterialAsset', 'unique'>, not Uint32Array, not unknown).
        expectTypeOf(row.asset).toEqualTypeOf<Handle<'MaterialAsset', 'shared'>>();
        observedType = 'matched';
      },
    });

    world.update();
    expect(observedType).toBe('matched');
  });
});

// ─── w50 (AC-32): builtin-slot fail-fast guard ───────────────────────────
// D-15: World.sharedRefs manages ONLY user-tier slots (>= BUILTIN_BASE).
// Passing a builtin slot (< BUILTIN_BASE) to alloc/retain/release/resolve is a
// caller error -> BuiltinSlotNotOwnedError with a hint pointing at
// the builtin asset owner. (toShared(1) is the cube slot.)
describe('w50 SharedRefStore: fail-fast on builtin slot < BUILTIN_BASE (AC-32)', () => {
  it('retain(builtin slot) returns BuiltinSlotNotOwnedError with a hint', () => {
    const store = new SharedRefStore();
    const r = store.retain(toShared<'MeshAsset'>(1));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(BuiltinSlotNotOwnedError);
      expect(r.error.code).toBe('builtin-slot-not-owned');
      if (r.error.code === 'builtin-slot-not-owned') {
        expect(r.error.hint.length).toBeGreaterThan(0);
        expect(r.error.detail.slot).toBe(1);
      }
    }
  });

  it('release(builtin slot) returns BuiltinSlotNotOwnedError', () => {
    const store = new SharedRefStore();
    const r = store.release(toShared<'MeshAsset'>(2));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(BuiltinSlotNotOwnedError);
  });

  it('resolve(builtin slot) returns BuiltinSlotNotOwnedError', () => {
    const store = new SharedRefStore();
    const r = store.resolve(toShared<'MeshAsset'>(3));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(BuiltinSlotNotOwnedError);
  });

  it('alloc mints user-tier slots (>= BUILTIN_BASE), never a builtin slot', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('MeshAsset', { kind: 'mesh' });
    expect(unwrapHandle(handle)).toBeGreaterThanOrEqual(BUILTIN_BASE);
  });
});

// ─── w6 M3: gen welding alloc tests ─────────────────────────────────────
// feat-20260623-asset-handle-generation M3 — alloc embeds generation into
// the returned handle via codec.pack(slot, gen). First alloc gen=0 (AC-06);
// builtin invariant pack(slot,0)===slot holds (AC-05).
// M3 scope: gen welding only, no gen increment on release (that's M4).
// Reused slots always get gen=0 in M3 (release does NOT increment
// _generations[slot] yet).
describe('w6 M3 SharedRefStore: gen welding on alloc', () => {
  it('AC-06: first alloc gen=0 => pack(slot,0) === slot (handleSlot matches raw slot)', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('TestAsset', { id: 1 });

    const raw = unwrapHandle(handle);
    const slot = handleSlot(handle);
    const gen = handleGeneration(handle);

    expect(gen).toBe(0);
    expect(raw).toBe(slot);
    // AC-06: slot is the raw value when gen=0
    expect(raw).toBeGreaterThanOrEqual(BUILTIN_BASE);
    expect(raw).toBeLessThanOrEqual(MAX_SLOT);
  });

  it('AC-05: builtin invariant — pack(slot,0) === slot for slot 1-5', () => {
    // Builtin handle constants (slot 1..5, gen=0) must encode to the same
    // u32 value as the raw slot — ensures AssetRegistry builtin Map keys,
    // GUID pre-registration, and entity bit patterns stay unchanged.
    for (let s = 1; s <= 5; s++) {
      expect(pack(s, 0)).toBe(s);
    }
  });

  it('alloc welds gen into handle — gen extractable via handleGeneration', () => {
    // After alloc gen welding, handleGeneration returns the gen embedded
    // during alloc. In M3, gen is always 0 because release does not yet
    // increment _generations (that's M4). But the code path — pack(slot,gen)
    // inside alloc -> toShared -> handleGeneration unpacks it — must work.
    const store = new SharedRefStore();
    const h = store.alloc('TestAsset', { id: 1 });
    expect(handleGeneration(h)).toBe(0);
    expect(handleSlot(h)).toBeGreaterThanOrEqual(BUILTIN_BASE);
    // pack(slot, gen) round-trips: unpackSlot(pack(s,0)) === s
    expect(pack(handleSlot(h), handleGeneration(h))).toBe(unwrapHandle(h));
  });

  it('resolve works correctly after gen-welded alloc (gen increments on release in M4)', () => {
    // Alloc + release + re-alloc: the second handle resolves to the
    // second payload. After M4, release increments gen so the reused
    // slot gets gen=1.
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(handleGeneration(h1)).toBe(0);

    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    // M4: release incremented gen, so re-alloc gets gen=1
    expect(handleGeneration(h2)).toBe(1);

    const r2 = store.resolve(h2);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value).toEqual({ mesh: 'sphere' });
    }
  });

  it('alloc publishes release evidence after gen-welded release', () => {
    const store = new SharedRefStore();
    const payload = { key: 1 };
    const h = store.alloc('Asset', payload);
    expect(store.release(h).unwrap()).toEqual({
      payload,
      refcount: 0,
      generation: 1,
      evidence: 'released',
    });
  });

  it('M4: alloc after release reuses slot with gen 1 (gen increments on release)', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    void handleSlot(h1); // probe slot
    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    // M4: release incremented gen to 1, so re-alloc gets gen=1
    expect(handleGeneration(h2)).toBe(1);

    // h2 resolves to the new payload
    const r2 = store.resolve(h2);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toEqual({ mesh: 'sphere' });

    // h1 (gen=0) is stale now
    const r1 = store.resolve(h1);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('shared-ref-stale');
  });
});

// ─── w9 M4: stale detection unit tests (red phase) ─────────────────────
// feat-20260623-asset-handle-generation M4 — gen comparison on
// resolve/retain/release. RED phase: gen increment on release is NOT
// now via release (gen 0->1) + re-alloc (gen=1), making h1 (gen=0)
// stale. No manual _generations mutation needed.
describe('w9 M4 SharedRefStore: stale detection (resolve/retain/release + retire)', () => {
  it('AC-01: stale resolve returns error with code shared-ref-stale', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    // Release bumps gen from 0 to 1, then re-alloc gets gen=1.
    // h1 (gen=0) is now stale.
    expect(store.release(h1).ok).toBe(true);
    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });

    const r = store.resolve(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shared-ref-stale');
    }
    // h2 is the current handle and should always resolve
    const r2 = store.resolve(h2);
    expect(r2.ok).toBe(true);
  });

  it('AC-01: stale resolve never returns a payload (verify error branch has no value)', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);
    store.alloc('MeshAsset', { mesh: 'sphere' });

    const r = store.resolve(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The error must NOT carry a payload — stale resolve does
      // not return the new payload through any channel.
      // biome-ignore lint/suspicious/noExplicitAny: accessing value on Result union error branch to verify no payload leak
      expect((r as any).value).toBeUndefined();
    }
  });

  it('AC-02: stale retain returns error, rc unchanged', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);
    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });

    // h2 is alive with rc=1. Read rc before stale retain.
    const rcBefore = store.refcount(h2);
    expect(rcBefore).toBe(1);

    const r = store.retain(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shared-ref-stale');
    }

    const rcAfter = store.refcount(h2);
    // AC-02: rc MUST be unchanged after stale retain
    expect(rcAfter).toBe(rcBefore);
  });

  it('AC-03: stale release returns error, rc unchanged — read rc before and after', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    expect(handleGeneration(h2)).toBe(1);

    // h2 is alive with rc=1. Stale release with h1 (gen=0) must NOT
    // decrement h2's rc.
    const rcBefore = store.refcount(h2);
    expect(rcBefore).toBe(1);

    const r = store.release(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shared-ref-stale');
    }

    const rcAfter = store.refcount(h2);
    // AC-03 core: stale release MUST NOT touch the new holder's rc.
    expect(rcAfter).toBe(rcBefore);
  });

  it('AC-03: stale release when h2 rc>1 does not decrement', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    // build rc=3 for h2
    expect(store.retain(h2).ok).toBe(true);
    expect(store.retain(h2).ok).toBe(true);
    expect(store.refcount(h2)).toBe(3);

    const rcBefore = store.refcount(h2);
    const r = store.release(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shared-ref-stale');
    }
    // Stale release must not affect h2's rc, even when rc>1
    expect(store.refcount(h2)).toBe(rcBefore);
  });

  it('AC-04: new handle after reuse resolves, retains, releases normally', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);

    // New handle with gen=1 works normally
    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    expect(handleGeneration(h2)).toBe(1);

    // resolve
    const r = store.resolve(h2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ mesh: 'sphere' });
    }

    // retain
    expect(store.retain(h2).ok).toBe(true);
    expect(store.refcount(h2)).toBe(2);

    // release back to rc=1 (gen does NOT increment — rc>1)
    expect(store.release(h2).ok).toBe(true);
    expect(store.refcount(h2)).toBe(1);

    // final release to rc=0 (gen increments 1->2)
    expect(store.release(h2).ok).toBe(true);
    expect(store.refcount(h2)).toBe(0);

    // h1 still stale (gen=0 vs gen=2)
    const rStale = store.resolve(h1);
    expect(rStale.ok).toBe(false);
    if (!rStale.ok) {
      expect(rStale.error.code).toBe('shared-ref-stale');
    }
  });

  it('M32: public World mutation fences a released producer from its replacement', () => {
    const Material = defineComponent('M32SharedMaterialField', {
      asset: 'shared<MaterialAsset>',
    });
    const world = new World();
    const sibling = world.allocSharedRef('MaterialAsset', { id: 'healthy-sibling' });
    const oldPayload = { id: 'old-material' };
    const oldHandle = world.allocSharedRef('MaterialAsset', oldPayload);
    const entity = world.spawn({ component: Material, data: { asset: oldHandle } }).unwrap();

    expect(world.sharedRefs.refcount(oldHandle)).toBe(2);
    expect(world.sharedRefs.refcount(sibling)).toBe(1);

    expect(world.removeComponent(entity, Material).ok).toBe(true);
    expect(world.sharedRefs.refcount(oldHandle)).toBe(1);
    expect(world.sharedRefs.release(oldHandle).ok).toBe(true);

    const replacementPayload = { id: 'replacement-material' };
    const replacementHandle = world.allocSharedRef('MaterialAsset', replacementPayload);
    expect(handleSlot(replacementHandle)).toBe(handleSlot(oldHandle));
    expect(handleGeneration(replacementHandle)).toBe(handleGeneration(oldHandle) + 1);

    const stale = world.sharedRefs.resolve(oldHandle);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('shared-ref-stale');
      expect(stale.error.detail).toEqual({
        slot: handleSlot(oldHandle),
        expectedGeneration: handleGeneration(oldHandle),
        actualGeneration: handleGeneration(replacementHandle),
      });
    }

    expect(
      world.addComponent(entity, { component: Material, data: { asset: replacementHandle } }).ok,
    ).toBe(true);
    expect(world.sharedRefs.refcount(replacementHandle)).toBe(2);
    expect(world.sharedRefs.resolve(replacementHandle)).toMatchObject({
      ok: true,
      value: replacementPayload,
    });

    expect(world.removeComponent(entity, Material).ok).toBe(true);
    expect(world.sharedRefs.release(replacementHandle).ok).toBe(true);
    expect(world.sharedRefs.release(sibling).ok).toBe(true);
    expect(world.sharedRefs.refcount(oldHandle)).toBe(0);
    expect(world.sharedRefs.refcount(replacementHandle)).toBe(0);
    expect(world.sharedRefs.refcount(sibling)).toBe(0);
    expect(world.sharedRefs._liveCount()).toBe(0);
  });

  it('AC-07: retire-on-255 — gen pushed past MAX_GEN then slot not in freeSlots after release', () => {
    const store = new SharedRefStore();
    const h = store.alloc('MeshAsset', { mesh: 'cube' });
    const slot = handleSlot(h);

    // gen=255 is still a usable handle under the new gen > MAX_GEN predicate.
    // Bump _generations[slot] to 255 and push to freeSlots so the next alloc
    // reuses it with gen=255.
    // biome-ignore lint/suspicious/noExplicitAny: private mutation for retire edge boundary
    (store as any)._generations[slot] = 255;
    // biome-ignore lint/suspicious/noExplicitAny: push slot to free list so alloc reuses
    (store as any).freeSlots.push(slot);

    // Alloc reuses slot, reads gen=255 from _generations.
    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    expect(handleGeneration(h2)).toBe(255);
    // Verify gen=255 is a usable handle — resolve succeeds.
    const rResolve = store.resolve(h2);
    expect(rResolve.ok).toBe(true);

    // Release h2: gen matches (255==255), proceed, gen++ to 256 (>MAX_GEN), retired.
    expect(store.release(h2).ok).toBe(true);

    // Verify slot is NOT in freeSlots (retired)
    // biome-ignore lint/suspicious/noExplicitAny: private read
    const freeSlots: number[] = (store as any).freeSlots;
    expect(freeSlots.indexOf(slot)).toBe(-1);
  });
});
