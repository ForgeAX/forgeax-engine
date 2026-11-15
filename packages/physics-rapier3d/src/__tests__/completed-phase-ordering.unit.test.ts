import { defineSystem, FixedUpdate, World } from '@forgeax/engine-ecs';
import { PhysicsWritebackPhase } from '@forgeax/engine-physics';
import { expect, it } from 'vitest';
import { PhysicsCollisionSync } from '../physics-sync.js';

it('publishes completed collision facts before a downstream writeback phase consumer', () => {
  const world = new World();
  const calls: string[] = [];
  const consumer = defineSystem({
    name: 'completed-physics-consumer',
    queries: [],
    after: [PhysicsWritebackPhase],
    fn: () => {
      calls.push('consumer');
    },
  });
  // Registration order must not let the consumer observe unfinished contacts.
  world.addSystem(FixedUpdate, consumer).unwrap();
  world.addSystem(FixedUpdate, PhysicsCollisionSync).unwrap();
  world
    .replaceSystem(FixedUpdate, PhysicsCollisionSync, {
      queries: [],
      fn: () => {
        calls.push('collision-completion');
      },
    })
    .unwrap();
  world.update(1 / 60).unwrap();
  expect(calls).toEqual(['collision-completion', 'consumer']);
});
