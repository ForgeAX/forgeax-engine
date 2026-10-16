import { describe, expect, it } from 'vitest';
import { Disabled, defineComponent, World } from '../index';
import type { Query } from '../query/query';

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
});
