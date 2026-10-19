import { describe, expect, it } from 'vitest';
import { defineSystemSet } from '../schedule';
import { FixedUpdate, Update } from '../schedule-token';
import { World } from '../world';

describe('ScheduleToken registration', () => {
  it('exports frozen, nominal built-in tokens', () => {
    expect(Object.isFrozen(Update)).toBe(true);
    expect(Object.isFrozen(FixedUpdate)).toBe(true);
    expect(Update).not.toBe(FixedUpdate);
  });

  it('requires ScheduleToken as the first registration argument', () => {
    const world = new World();
    const system = { name: 'update-system', queries: [], fn: () => {} };

    world.addSystem(Update, system);
    // @ts-expect-error token-first registration has no implicit Update overload
    world.addSystem(system);
  });

  it('scopes set membership and configuration to a token', () => {
    const world = new World();
    const set = defineSystemSet({ name: 'update-set' });
    const system = { name: 'set-system', queries: [], fn: () => {} };

    expect(world.addSystems(Update, set, [system]).ok).toBe(true);
    expect(world.inspect().systemCount).toBe(1);
  });

  it('requires a token for removal and replacement', () => {
    const world = new World();
    world.addSystem(Update, { name: 'replaceable', queries: [], fn: () => {} });

    expect(world.removeSystem(Update, 'replaceable').ok).toBe(true);
    world.addSystem(Update, { name: 'replaceable', queries: [], fn: () => {} });
    expect(
      world.replaceSystem(Update, 'replaceable', {
        name: 'replaceable',
        queries: [],
        fn: () => {},
      }).ok,
    ).toBe(true);
  });

  it('publishes one identity for split runtime bundles', () => {
    const registry = globalThis as typeof globalThis & {
      readonly [key: symbol]: unknown;
    };

    expect(registry[Symbol.for('forgeax.ecs.schedule-token.Update')]).toBe(Update);
    expect(registry[Symbol.for('forgeax.ecs.schedule-token.FixedUpdate')]).toBe(FixedUpdate);
  });

  it('refreshes set membership after removal and keeps run conditions live each frame', () => {
    const world = new World();
    const calls: string[] = [];
    let enabled = false;
    let checks = 0;
    const set = defineSystemSet({
      name: 'live-set',
      runIf: () => {
        checks++;
        return enabled;
      },
    });
    const system = (name: string) => ({
      name,
      queries: [] as const,
      fn: () => {
        calls.push(name);
      },
    });
    world.addSystems(Update, set, [system('a'), system('b')]).unwrap();
    world.update(0).unwrap();
    expect(calls).toEqual([]);
    expect(checks).toBe(1);
    enabled = true;
    world.update(0).unwrap();
    expect(calls).toEqual(['a', 'b']);
    expect(checks).toBe(2);
    world.removeSystem(Update, 'a').unwrap();
    world.addSystem(Update, system('a')).unwrap();
    enabled = false;
    world.update(0).unwrap();
    expect(calls).toEqual(['a', 'b', 'a']);
    expect(checks).toBe(3);
    world.replaceSystem(Update, 'b', system('b')).unwrap();
    world.update(0).unwrap();
    expect(calls).toEqual(['a', 'b', 'a', 'a']);
    expect(checks).toBe(4);
  });
});
