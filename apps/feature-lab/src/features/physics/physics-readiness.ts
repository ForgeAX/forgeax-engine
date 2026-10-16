import {
  Collider,
  ColliderShapeValue,
  PhysicsError,
  physicsPlugin,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import type { RapierPhysicsWorld3D } from '@forgeax/engine/physics-rapier3d';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera } from '../../lab/stage';
import { tryResource, waitForPhysicsWorld, waitUntil } from './support/live';

export default defineFeature({
  title: 'Physics readiness',
  catalog: 'Physics readiness',
  kind: 'probe',
  appOptions: { plugins: [physicsPlugin('rapier-3d')] },
  summary:
    'physicsPlugin activates asynchronously: the PhysicsWorld resource appears after WASM loads, and hasBody(entity) stays false until the next sync phase builds the body. Drivers guard with hasBody before moveAndSlide.',
  expect:
    'All checks pass: the resource is observed as absent-then-present or present on first read, a new entity reports hasBody false then true, and moveAndSlide before the body exists throws PhysicsError body-not-found.',
  async setup({ world, frames }) {
    const checks = new CheckList();
    spawnCamera(world);
    const presentAtSetup = tryResource(world) !== undefined;
    const { physics, waitedFrames } = await waitForPhysicsWorld<RapierPhysicsWorld3D>(
      world,
      frames,
    );
    checks.ok(
      'PhysicsWorld resource becomes available',
      physics !== undefined,
      `presentAtSetup=${presentAtSetup} waited=${waitedFrames}`,
    );
    if (physics === undefined) return { checks: () => checks.items };
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [0, 3, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 },
        },
      )
      .unwrap();
    checks.ok('hasBody is false right after spawn', !physics.hasBody(entity));
    try {
      physics.moveAndSlide(entity, Float32Array.of(1, 0, 0) as never);
      checks.ok('moveAndSlide before the body exists throws body-not-found', false, 'no error');
    } catch (error) {
      checks.ok(
        'moveAndSlide before the body exists throws body-not-found',
        error instanceof PhysicsError && error.code === 'body-not-found',
        String((error as { code?: unknown }).code),
      );
    }
    const ready = await waitUntil(frames, () => physics.hasBody(entity), 60);
    checks.ok('hasBody turns true after a sync tick', ready !== undefined, `frames=${ready}`);
    return { checks: () => checks.items };
  },
});
