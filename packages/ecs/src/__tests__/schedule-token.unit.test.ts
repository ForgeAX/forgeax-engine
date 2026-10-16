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
});
