import assert from 'node:assert/strict';
import { createWorldContext, World } from '@forgeax/engine/ecs';
import { startNativePlugin } from '@forgeax/engine/plugin';
import * as physics from '@forgeax/engine/physics';
import preset from '@forgeax/engine/physics/rapier3d';

if (process.argv[2] === 'descriptor') {
  console.log(JSON.stringify({ name: preset.name, provide: preset.provide }));
} else {
const started = performance.now();
const world = new World();
const context = await createWorldContext(world);
try {
  const activated = await startNativePlugin(context, preset);
  assert.equal(activated.ok, true, JSON.stringify(activated.ok ? null : activated.error));
  assert.equal(world.components.resolve('CharacterController'), physics.CharacterController);
  assert.equal(world.hasResource('PhysicsWorld'), true);
} finally {
  await context.fiber.dispose();
}
assert.equal(world.components.resolve('CharacterController'), undefined);
assert.equal(world.hasResource('PhysicsWorld'), false);
console.log(JSON.stringify({ sameToken: true, installed: true, released: true, elapsedMs: performance.now() - started }));
}
