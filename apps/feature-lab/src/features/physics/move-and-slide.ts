import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  PhysicsError,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import { Transform } from '@forgeax/engine/scene';
import type { CheckList } from '../../lab/feature';
import { defineFeature } from '../../lab/feature';
import { createPhysicsHarness3D, vec3 } from './support/rapier3d';

function expectCode(checks: CheckList, name: string, code: string, body: () => unknown): void {
  try {
    body();
    checks.ok(name, false, 'no error thrown');
  } catch (error) {
    checks.ok(
      name,
      error instanceof PhysicsError && error.code === code,
      String((error as { code?: unknown }).code),
    );
  }
}

export default defineFeature({
  title: 'Move-and-slide',
  catalog: '`moveAndSlide` KCC',
  kind: 'headless',
  summary:
    'PhysicsWorld.moveAndSlide(entity, desiredDelta) resolves a kinematic CharacterController against world geometry, writes Transform and CharacterController.grounded, and returns the applied delta.',
  expect:
    'All checks pass: a flat walk applies the full delta and is grounded, a wall clamps the delta without clip-through, and misuse throws PhysicsError body-not-found / controller-requires-kinematic.',
  async run(checks) {
    const harness = await createPhysicsHarness3D();
    if (typeof harness === 'string') {
      checks.ok('Rapier 3D loads', false, harness);
      return;
    }
    const { world, physics } = harness;
    const box = (pos: [number, number, number], halfExtents: [number, number, number]) =>
      harness.spawn(
        { component: Transform, data: { pos } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
        { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents } },
      );
    const character = (x: number, type: number) =>
      harness.spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: RigidBody, data: { type } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 },
        },
        { component: CharacterController, data: {} },
      );
    box([0, -0.85, 0], [20, 0.5, 20]);
    box([6.8, 0.5, 0], [0.1, 1, 2]);
    const walker = character(0, RigidBodyTypeValue.kinematic);
    const blocked = character(6, RigidBodyTypeValue.kinematic);
    const dynamic = character(-6, RigidBodyTypeValue.dynamic);
    harness.tick(1);
    const moved = physics.moveAndSlide(walker, vec3(1, 0, 0));
    checks.near('flat walk applies the requested x', moved[0] ?? Number.NaN, 1, 0.05);
    checks.near('Transform written back', harness.pos(walker)[0], 1, 0.05);
    const grounded = world.get(walker, CharacterController);
    checks.ok(
      'CharacterController.grounded is true on the floor',
      grounded.ok && (grounded.value as unknown as { grounded: boolean }).grounded === true,
    );
    const clamped = physics.moveAndSlide(blocked, vec3(1, 0, 0));
    checks.ok('wall clamps the delta', (clamped[0] ?? 1) < 1, `dx=${clamped[0]}`);
    checks.ok(
      'no clip-through the wall face',
      harness.pos(blocked)[0] < 6.45,
      `x=${harness.pos(blocked)[0]}`,
    );
    expectCode(
      checks,
      'dynamic body throws controller-requires-kinematic',
      'controller-requires-kinematic',
      () => physics.moveAndSlide(dynamic, vec3(1, 0, 0)),
    );
    expectCode(checks, 'unknown entity throws body-not-found', 'body-not-found', () =>
      physics.moveAndSlide(987654, vec3(1, 0, 0)),
    );
    harness.dispose();
  },
});
