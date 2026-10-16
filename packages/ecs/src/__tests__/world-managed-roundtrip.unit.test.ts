// feat-20260614-ecs-shared-component-and-unique-rename M6 w52 (AC-31, R-14):
// write-barrier slot-range short-circuit.
//
// D-15: builtin asset handles (slot < BUILTIN_BASE, e.g. HANDLE_CUBE=1) are
// process-static and NEVER reference-counted. The ECS write barrier for
// `shared<T>` columns must short-circuit on builtin slots: retain/release on a
// builtin handle makes ZERO calls to World.sharedRefs and never surfaces a
// SharedRefReleasedError / BuiltinSlotNotOwnedError. R-14 requires the
// short-circuit cover BOTH the scalar `shared<T>` arm AND the
// `array<shared<T>>` element dispatch (single helper SSOT).
//
// User-tier handles (slot >= BUILTIN_BASE, minted by allocSharedRef) keep
// flowing through World.sharedRefs as before.

import { BUILTIN_BASE, toShared } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { type Component, defineComponent } from '../component';
import { World } from '../world';

// HANDLE_CUBE's runtime slot (1) — a builtin-tier handle constructed without
// importing @forgeax/engine-runtime (ecs must not depend on runtime).
const BUILTIN_HANDLE = toShared<'MeshAsset'>(1);

describe('M6 w52: write-barrier builtin-slot short-circuit (AC-31 / R-14)', () => {
  it('scalar shared<T> field = builtin handle: spawn retains 0 calls + no error', () => {
    const Holder = defineComponent('W52ScalarHolder', { asset: { type: 'shared<MeshAsset>' } });
    const w = new World();
    const retainSpy = vi.spyOn(w.sharedRefs, 'retain');
    const releaseSpy = vi.spyOn(w.sharedRefs, 'release');

    const e = w
      .spawn({
        component: Holder as unknown as Component,
        data: { asset: BUILTIN_HANDLE } as never,
      })
      .unwrap();
    // spawn write-barrier must short-circuit on the builtin slot.
    expect(retainSpy).not.toHaveBeenCalled();

    w.despawn(e).unwrap();
    // despawn write-barrier must short-circuit on the builtin slot.
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('array<shared<T>> field = [builtin handle]: retain/release 0 calls, no SharedRefReleasedError (R-14)', () => {
    const Holder = defineComponent('W52ArrayHolder', {
      assets: { type: 'array<shared<MeshAsset>>' },
    });
    const w = new World();
    const retainSpy = vi.spyOn(w.sharedRefs, 'retain');
    const releaseSpy = vi.spyOn(w.sharedRefs, 'release');

    const e = w
      .spawn({
        component: Holder as unknown as Component,
        data: { assets: [BUILTIN_HANDLE, BUILTIN_HANDLE] } as never,
      })
      .unwrap();
    expect(retainSpy).not.toHaveBeenCalled();

    expect(() => w.despawn(e).unwrap()).not.toThrow();
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('user-tier scalar handle still flows through World.sharedRefs (retain on spawn)', () => {
    const Holder = defineComponent('W52UserScalarHolder', {
      asset: { type: 'shared<MeshAsset>' },
    });
    const w = new World();
    const userHandle = w.allocSharedRef('MeshAsset', { kind: 'mesh' });
    expect(userHandle).toBeGreaterThanOrEqual(BUILTIN_BASE);
    const retainSpy = vi.spyOn(w.sharedRefs, 'retain');

    w.spawn({
      component: Holder as unknown as Component,
      data: { asset: userHandle } as never,
    }).unwrap();
    // user-tier handle is retained by the write barrier (rc 1 -> 2).
    expect(retainSpy).toHaveBeenCalled();
    expect(w.sharedRefs.refcount(userHandle)).toBe(2);
  });

  it('user-tier array element still flows through World.sharedRefs (R-14 control)', () => {
    const Holder = defineComponent('W52UserArrayHolder', {
      assets: { type: 'array<shared<MeshAsset>>' },
    });
    const w = new World();
    const userHandle = w.allocSharedRef('MeshAsset', { kind: 'mesh' });
    const retainSpy = vi.spyOn(w.sharedRefs, 'retain');

    w.spawn({
      component: Holder as unknown as Component,
      data: { assets: [userHandle] } as never,
    }).unwrap();
    expect(retainSpy).toHaveBeenCalled();
    expect(w.sharedRefs.refcount(userHandle)).toBe(2);
  });
});
