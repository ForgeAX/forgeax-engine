import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';
import { createPhysicsHarness3D, vec3 } from './support/rapier3d';

export default defineFeature({
  title: 'Teleport',
  catalog: 'Teleport',
  kind: 'headless',
  summary:
    'PhysicsWorld.teleport(entity, position) immediately places a ready body, its colliders, and its Transform at one position and clears movable-body velocity.',
  expect:
    'All checks pass: the teleport is visible before the next fixed step, the body remains near the target after stepping, and it starts falling again from rest.',
  async run(checks) {
    const harness = await createPhysicsHarness3D();
    if (typeof harness === 'string') {
      checks.ok('Rapier 3D loads', false, harness);
      return;
    }
    const body = harness.spawn(
      { component: Transform, data: { pos: [0, 50, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
      { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.5 } },
    );
    harness.tick(60);
    const beforeY = harness.pos(body)[1];
    checks.ok('body was falling fast before teleport', beforeY < 47, `y=${beforeY}`);
    harness.physics.teleport(body, vec3(3, 20, 0));
    checks.near('teleport updates Transform before the next step', harness.pos(body)[1], 20, 1e-5);
    harness.tick(1);
    const [x, y] = harness.pos(body);
    checks.near('x moved to the target', x, 3, 0.01);
    checks.ok(
      'y is at the target (from rest, one step of gravity)',
      Math.abs(y - 20) < 0.02,
      `y=${y}`,
    );
    harness.tick(10);
    const drop = 20 - harness.pos(body)[1];
    checks.ok(
      'fall after teleport starts from zero velocity',
      drop > 0 && drop < 1.5,
      `drop=${drop} (from rest about 0.67; with inherited velocity it would exceed 6)`,
    );
    harness.dispose();
  },
});
