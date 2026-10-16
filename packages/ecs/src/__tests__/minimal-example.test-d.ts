import { Update } from '../schedule-token';
// AC-4 minimal-example compile-assertion vehicle.
//
// Pastes requirements §10.4 "30-second onboarding minimal example" into a
// dedicated file so `tsc -b` (and vitest typecheck) certify, every release,
// that an AI user can write the bundle-field access pattern WITHOUT any `as`
// casts and WITHOUT explicit `as const` annotations.
//
// Note: requirements §10.4 prose uses `createWorld()`. The shipped API is
// `new World()`; the load-bearing assertion is the bundle field access shape
// (KD-1 + KD-2 + KD-3 chain), not the constructor form. The minimal-example
// JSDoc on `SystemDescriptor` (w17) and the CHANGELOG migration block (w18)
// follow the same shape so the three discovery surfaces stay congruent
// (charter proposition 1: same signal, three entry points).

import { describe, expectTypeOf, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

describe('[w14] AC-4 — 30-second onboarding minimal example', () => {
  it('bundle field access compiles without `as` casts', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });
    const Velocity = defineComponent('Velocity', { dx: { type: 'f32' }, dy: { type: 'f32' } });

    const world = new World();
    world.addSystem(Update, {
      name: 'movement',
      queries: [{ read: [Velocity], write: [Position] }],
      fn: (_world, queryResults, _commands) => {
        for (const row of queryResults[0]) {
          const velocity = row.get(Velocity);
          const position = row.mut(Position);
          expectTypeOf(position.x).toBeNumber();
          expectTypeOf(velocity.dx).toBeNumber();
          position.x += velocity.dx;
        }
      },
    });

    expectTypeOf(world).toMatchTypeOf<World>();
  });
});
