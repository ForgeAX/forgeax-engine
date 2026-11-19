import { describe, expect, it } from 'vitest';
import { defineResource } from '../resource';
import { defineSystem, defineSystemSet } from '../schedule';
import { defineSchedule, FixedUpdate, Update } from '../schedule-token';
import { Time } from '../time';
import { World } from '../world';

describe('ECS identity', () => {
  it('orders and removes same-name systems by their original object', () => {
    const world = new World();
    const calls: number[] = [];
    const first = defineSystem({ name: 'same', queries: [], fn: () => calls.push(1) });
    const second = defineSystem({
      name: 'same',
      queries: [],
      after: [first],
      fn: () => calls.push(2),
    });
    world.addSystem(Update, second).unwrap();
    world.addSystem(Update, first).unwrap();
    world.update(0).unwrap();
    expect(calls).toEqual([1, 2]);
    world.removeSystem(Update, first).unwrap();
    calls.length = 0;
    world.update(0).unwrap();
    expect(calls).toEqual([2]);
    expect(world.scheduleData()[0]?.systems.map((system) => system.id)).toEqual([0]);
  });

  it('keeps same-name resources distinct and infers their value types', () => {
    const world = new World();
    const count = defineResource<number>('same');
    const text = defineResource<string>('same');
    world.insertResource(count, 3);
    world.insertResource(text, 'three');
    const actual: number = world.getResource(count);
    expect(actual).toBe(3);
    expect(world.getResource(text)).toBe('three');
    world.removeResource(count);
    expect(world.hasResource(count)).toBe(false);
    expect(world.hasResource(text)).toBe(true);
  });

  it('protects the actual clock resource rather than any token named Time', () => {
    const world = new World();
    const other = defineResource<number>('Time');
    world.insertResource(other, 4);
    expect(world.getResource(other)).toBe(4);
    expect(world.getResource(Time).elapsed).toBe(0);
    expect(() => world.removeResource(Time)).toThrow();
  });

  it('does not confuse same-name schedules or groups', () => {
    const world = new World();
    const schedule = defineSchedule('Update');
    const blocked = defineSystemSet({ name: 'same', runIf: () => false });
    const open = defineSystemSet({ name: 'same' });
    const calls: string[] = [];
    const a = defineSystem({ name: 'a', queries: [], fn: () => calls.push('a') });
    const b = defineSystem({ name: 'b', queries: [], fn: () => calls.push('b') });
    world.addSystems(schedule, blocked, [a]).unwrap();
    world.addSystems(schedule, open, [b]).unwrap();
    world.update(0).unwrap();
    expect(calls).toEqual([]);
    world.run(schedule).unwrap();
    expect(calls).toEqual(['b']);
    world.removeSystem(schedule, b).unwrap();
    expect(world.hasSystem(schedule, open)).toBe(false);
  });

  it('rejects cross-scope intrinsic groups before inserting a system', () => {
    const world = new World();
    const group = defineSystemSet({ name: 'scope' });
    const a = defineSystem({ name: 'a', queries: [], sets: [group], fn: () => {} });
    const b = defineSystem({ name: 'b', queries: [], sets: [group], fn: () => {} });
    world.addSystem(Update, a).unwrap();
    expect(world.addSystem(FixedUpdate, b).ok).toBe(false);
    expect(world.hasSystem(FixedUpdate, b)).toBe(false);
  });

  it('preserves registered groups and identity when replacing an implementation', () => {
    const world = new World();
    let allowed = false;
    let calls = 0;
    const group = defineSystemSet({ name: 'gated', runIf: () => allowed });
    const system = defineSystem({ name: 'original', queries: [], sets: [group], fn: () => {} });
    world.addSystem(Update, system).unwrap();
    world
      .replaceSystem(Update, system, {
        queries: [],
        fn: () => calls++,
      })
      .unwrap();
    world.update(0).unwrap();
    expect(calls).toBe(0);
    allowed = true;
    world.update(0).unwrap();
    expect(calls).toBe(1);
    world.removeSystem(Update, system).unwrap();
    expect(world.hasSystem(Update, group)).toBe(false);
  });
  it('releases group scope when its last registered member is removed', () => {
    const world = new World();
    const group = defineSystemSet({ name: 'movable' });
    const first = defineSystem({ name: 'first', queries: [], sets: [group], fn: () => {} });
    const second = defineSystem({ name: 'second', queries: [], sets: [group], fn: () => {} });
    world.addSystem(Update, first).unwrap();
    world.removeSystem(Update, first).unwrap();
    expect(world.hasSystem(Update, group)).toBe(false);
    world.addSystem(FixedUpdate, second).unwrap();
    expect(world.hasSystem(FixedUpdate, group)).toBe(true);
  });
  it('rejects raw names at JavaScript call boundaries', () => {
    const world = new World();
    const raw = 'count' as unknown as import('../resource').Resource<number>;
    expect(() => world.insertResource(raw, 1)).toThrow(TypeError);
    expect(() => world.getResource(raw)).toThrow(TypeError);
    expect(() => world.hasResource(raw)).toThrow(TypeError);
    expect(() => world.removeResource(raw)).toThrow(TypeError);
    expect(() =>
      defineSystem({
        name: 'invalid',
        queries: [],
        fn: () => {},
        after: ['system' as unknown as import('../schedule').SystemOrderReference],
      }),
    ).toThrow(TypeError);
  });
});

it('retains inherited declaration fields and reads their getters once', () => {
  const world = new World();
  const group = defineSystemSet({ name: 'gated', runIf: () => false });
  let names = 0;
  let memberships = 0;
  let calls = 0;
  class Declaration {
    get name() {
      names++;
      return 'inherited';
    }
    get sets() {
      memberships++;
      return [group];
    }
    readonly queries = [] as const;
    fn() {
      calls++;
    }
  }
  const system = defineSystem(new Declaration());
  world.addSystem(Update, system).unwrap();
  world.update(0).unwrap();
  expect(calls).toBe(0);
  expect(names).toBe(1);
  expect(memberships).toBe(1);
});
