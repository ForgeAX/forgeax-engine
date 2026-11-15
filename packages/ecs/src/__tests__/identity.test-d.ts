import { expectTypeOf, test } from 'vitest';
import { defineResource } from '../resource';
import { defineSystem, defineSystemSet } from '../schedule';
import { Update } from '../schedule-token';
import { World } from '../world';

test('identity APIs reject names, structural tokens and incorrect resource values', () => {
  const world = new World();
  const count = defineResource<number>('count');
  const text = defineResource<string>('text');
  const inspectEither = (key: typeof count | typeof text) => {
    world.hasResource(key);
    world.removeResource(key);
    world.getResourceChange(key);
  };
  expectTypeOf(inspectEither).toBeFunction();
  const system = defineSystem({ name: 'system', queries: [], fn: () => {} });
  const group = defineSystemSet({ name: 'group' });
  world.insertResource(count, 1);
  expectTypeOf(world.getResource(count)).toEqualTypeOf<number>();
  const checkInvalidCalls = () => {
    // @ts-expect-error Read/write resources cannot widen their payload type.
    const widened: import('../resource').Resource<unknown> = count;
    void widened;
    // @ts-expect-error A resource token owns its payload type.
    world.insertResource(count, 'one');
    // @ts-expect-error Diagnostic names cannot address resources.
    world.getResource('count');
    // @ts-expect-error Structural name objects are not resource identities.
    world.getResource({ name: 'count' });
    // @ts-expect-error Diagnostic names cannot remove systems.
    world.removeSystem(Update, system.name);
    // @ts-expect-error Structural name objects are not schedule identities.
    world.addSystem({ name: 'Update' }, system);
    // @ts-expect-error Systems are created through their factory.
    world.addSystem(Update, { name: 'system', queries: [], fn: () => {} });
    // @ts-expect-error Ordering uses identities.
    defineSystem({ name: 'other', queries: [], after: ['system'], fn: () => {} });
    world.replaceSystem(Update, system, {
      queries: [],
      fn: () => {},
      // @ts-expect-error Replacement preserves the registered set memberships.
      sets: [group],
    });
  };
  expectTypeOf(checkInvalidCalls).toBeFunction();
});
