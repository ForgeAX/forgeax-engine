import { handleSlot } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

const Holder = defineComponent('SharedValueHolder', {
  value: { type: 'shared<GameData>' },
  items: { type: 'array<shared<GameData>>' },
});

describe('World shared values have no builtin slot exemption', () => {
  it('retains and releases the first allocated slot through scalar and array fields', () => {
    const world = new World();
    const first = world.allocSharedRef('GameData', { value: 1 });
    const second = world.allocSharedRef('GameData', { value: 2 });
    expect(handleSlot(first)).toBe(1);
    const entity = world
      .spawn({ component: Holder, data: { value: first, items: [first, second] } })
      .unwrap();
    expect(world.sharedRefs.refcount(first)).toBe(3);
    expect(world.sharedRefs.refcount(second)).toBe(2);
    world.set(entity, Holder, { value: second, items: [second] }).unwrap();
    expect(world.sharedRefs.refcount(first)).toBe(1);
    expect(world.sharedRefs.refcount(second)).toBe(3);
    world.despawn(entity).unwrap();
    expect(world.sharedRefs.refcount(first)).toBe(1);
    expect(world.sharedRefs.refcount(second)).toBe(1);
    world.sharedRefs.release(first).unwrap();
    const reused = world.allocSharedRef('GameData', { value: 3 });
    expect(handleSlot(reused)).toBe(1);
    expect(world.sharedRefs.resolve(first).ok).toBe(false);
    expect(world.sharedRefs.resolve(reused).unwrap()).toEqual({ value: 3 });
    world.sharedRefs.release(second).unwrap();
    world.sharedRefs.release(reused).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
  });

  it('ignores only empty default fields', () => {
    const world = new World();
    const retain = vi.spyOn(world.sharedRefs, 'retain');
    const release = vi.spyOn(world.sharedRefs, 'release');
    const entity = world.spawn({ component: Holder, data: {} }).unwrap();
    world.despawn(entity).unwrap();
    expect(retain).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
