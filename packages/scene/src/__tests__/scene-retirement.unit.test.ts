import { Disabled, defineComponent, Entity, type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, Children, Transform } from '../index';
import { createSceneRetirement } from '../instances/retirement';

const Release = defineComponent('StreamRetirementRelease', { token: 'unique<RetirementCallback>' });
function fixture(count = 32) {
  const world = new World();
  for (const component of [ChildOf, Children, Transform, Disabled, Release])
    world.components.register(component).unwrap();
  const released: number[] = [];
  const members: EntityHandle[] = [];
  for (let index = 0; index < count; index++) {
    const parent = members.at(-1);
    const token = world.allocUniqueRef('RetirementCallback', index, () => {
      released.push(index);
    });
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: Disabled, data: {} },
        { component: Release, data: { token } },
        ...(parent === undefined ? [] : [{ component: ChildOf, data: { parent } }]),
      )
      .unwrap();
    members.push(entity);
  }
  return { world, members, released };
}

function drain(task: ReturnType<typeof createSceneRetirement>) {
  let calls = 0;
  while (!task.inspect().done) {
    expect(calls++).toBeLessThan(10000);
    const result = task.step(1);
    if (!result.ok) return result;
  }
  return task.step(1);
}

describe('bounded owned Scene retirement', () => {
  it('borrows the caller turn through planning and preserves the exact leaf cursor before yielding', () => {
    const f = fixture(32);
    const task = createSceneRetirement(f.world, f.members, () => true);
    const before = task.inspect();
    expect(task.step(1000, () => false).unwrap()).toEqual(before);
    let granted = 4;
    task.step(1000, () => granted-- > 0).unwrap();
    expect(task.inspect()).toEqual(before);
    expect(f.released).toEqual([]);
    while (!task.inspect().planned) task.step(1).unwrap();
    granted = 3;
    task.step(1000, () => granted-- > 0).unwrap();
    expect(task.inspect().retiredMembers).toBe(3);
    expect(f.released).toEqual([31, 30, 29]);
    expect(drain(task).unwrap()).toMatchObject({ done: true, retiredMembers: 32 });
    expect(f.released).toEqual(Array.from({ length: 32 }, (_, index) => 31 - index));
  });

  it('retires a deep hierarchy child-first with at most one despawn per work quantum and no future frame', () => {
    const f = fixture(128);
    const constant = f.world.spawn({ component: Transform, data: {} }).unwrap();
    const task = createSceneRetirement(f.world, f.members, () => true);
    expect(task.step(0)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'invalid-budget' } },
    });
    let previous = f.world.inspect().entityCount;
    let work = 0;
    while (!task.inspect().done) {
      expect(work++).toBeLessThan(2000);
      task.step(1).unwrap();
      const current = f.world.inspect().entityCount;
      expect(previous - current).toBeLessThanOrEqual(1);
      previous = current;
    }
    expect(f.released).toEqual(Array.from({ length: 128 }, (_, index) => 127 - index));
    expect(task.inspect()).toMatchObject({ done: true, retiredMembers: 128, pendingMembers: 0 });
    expect(f.world.get(constant, Entity).ok).toBe(true);
    expect(f.world.inspect().entityCount).toBe(1);
    expect(task.step(1).unwrap().retiredMembers).toBe(128);
  });

  it('refuses an unowned linked descendant before destruction and retries the same ownership after repair', () => {
    const f = fixture(2);
    const foreign = f.world
      .spawn({ component: ChildOf, data: { parent: f.members[0] as EntityHandle } })
      .unwrap();
    const task = createSceneRetirement(f.world, f.members, () => true);
    expect(drain(task)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'foreign-child' } },
    });
    expect(f.released).toEqual([]);
    f.world.removeComponent(foreign, ChildOf).unwrap();
    expect(drain(task).unwrap().done).toBe(true);
    expect(f.released).toEqual([1, 0]);
    expect(f.world.get(foreign, Entity).ok).toBe(true);
  });

  it('preserves the exact retirement cursor across an intervening hierarchy change and ownership pause', () => {
    const f = fixture(2);
    let safe = true;
    const task = createSceneRetirement(f.world, f.members, () => safe);
    while (!task.inspect().planned) task.step(1).unwrap();
    const foreign = f.world
      .spawn({ component: ChildOf, data: { parent: f.members[0] as EntityHandle } })
      .unwrap();
    task.step(1).unwrap();
    expect(f.released).toEqual([1]);
    expect(task.step(1)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'changed-hierarchy' } },
    });
    expect(task.inspect().pendingMembers).toBe(1);
    safe = false;
    expect(task.step(1)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'stale-ownership' } },
    });
    f.world.removeComponent(foreign, ChildOf).unwrap();
    safe = true;
    expect(drain(task).unwrap().done).toBe(true);
    expect(f.released).toEqual([1, 0]);
  });

  it('does not retire a new entity reusing an old member slot', () => {
    const f = fixture(2);
    const old = f.members[1] as EntityHandle;
    f.world.despawn(old).unwrap();
    const replacement = f.world.spawn({ component: Transform, data: {} }).unwrap();
    const task = createSceneRetirement(f.world, f.members, () => true);
    expect(drain(task).unwrap()).toMatchObject({ done: true, retiredMembers: 1 });
    expect(f.world.get(replacement, Entity).ok).toBe(true);
    expect(replacement).not.toBe(old);
  });
});
