import { describe, expect, it } from 'vitest';
import { Disabled, defineComponent, World } from '../index';
import { prepareDisabledBatch } from '../internal';
import type { Query } from '../query/query';
import { worldRead } from '../world-read';

const Target = defineComponent('EntityDisablingTarget', { value: 'u32' });

function count(query: Query): number {
  return [...query].length;
}

describe('Disabled default query filter', () => {
  it('excludes disabled entities while explicit Disabled queries include them', () => {
    const world = new World();
    world.spawn({ component: Target, data: { value: 1 } }).unwrap();
    world
      .spawn({ component: Target, data: { value: 2 } }, { component: Disabled, data: {} })
      .unwrap();

    const active = world.query({ read: [Target] }).unwrap();
    const disabled = world.query({ read: [Target], with: [Disabled] }).unwrap();

    expect(count(active)).toBe(1);
    expect(count(disabled)).toBe(1);
  });

  it('recomputes the default filter when an entity is disabled and re-enabled', () => {
    const world = new World();
    const entity = world.spawn({ component: Target, data: { value: 1 } }).unwrap();
    const active = world.query({ read: [Target] }).unwrap();

    expect(count(active)).toBe(1);
    world.addComponent(entity, { component: Disabled, data: {} }).unwrap();
    expect(count(active)).toBe(0);
    world.removeComponent(entity, Disabled).unwrap();
    expect(count(active)).toBe(1);
  });

  it('preserves query, row data and per-entity change evidence through a fixed Disabled batch', () => {
    const world = new World();
    const spawnDisabled = (value: number) =>
      world
        .spawn({ component: Target, data: { value } }, { component: Disabled, data: {} })
        .unwrap();
    const first = spawnDisabled(1),
      authored = spawnDisabled(2),
      last = spawnDisabled(3);
    const active = world.query({ read: [Target] }).unwrap();
    const hidden = world.query({ read: [Target], with: [Disabled] }).unwrap();
    const change = prepareDisabledBatch(world, [first, last]);
    const initial = world.getStructureEpoch();
    const removed: number[] = [];
    const cursor = { value: 0 };
    const observeRemoval = (entity: number) => removed.push(entity);
    world[worldRead].readRemoved(Disabled, cursor, observeRemoval);
    change(false).unwrap();
    expect(world.getStructureEpoch()).toBe(initial + 2);
    expect(Array.from(active, (row) => row.get(Target).value)).toEqual([1, 3]);
    expect(Array.from(hidden, (row) => row.get(Target).value)).toEqual([2]);
    world[worldRead].readRemoved(Disabled, cursor, observeRemoval);
    expect(removed).toEqual([first, last]);
    const epoch = world[worldRead].getMutationEpoch();
    change(true).unwrap();
    expect(world.getStructureEpoch()).toBe(initial + 4);
    expect(count(active)).toBe(0);
    expect(count(hidden)).toBe(3);
    expect(world.get(authored, Target).unwrap().value).toBe(2);
    expect(world[worldRead].getAddedEpoch(first, Disabled)).toBeGreaterThan(epoch);
    expect(world[worldRead].getAddedEpoch(last, Disabled)).toBeGreaterThan(epoch);
  });

  it('checks all expected old memberships before moving the first row', () => {
    const world = new World();
    const hidden = world.spawn({ component: Disabled, data: {} }).unwrap();
    const active = world.spawn().unwrap();
    const epoch = world.getStructureEpoch();
    const change = prepareDisabledBatch(world, [hidden, active]);
    expect(change(false)).toMatchObject({ ok: false, error: { code: 'component-not-present' } });
    expect(world.getStructureEpoch()).toBe(epoch);
    expect(world.hasComponent(hidden, Disabled)).toBe(true);
  });
});
