import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  rigidBodyTypeFromF32,
} from '@forgeax/engine/physics';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';
import { createPhysicsHarness3D, vec3 } from './support/rapier3d';

export default defineFeature({
  title: 'Rigid body types',
  catalog: 'Rigid body types',
  kind: 'headless',
  summary:
    'RigidBody.type is the closed set static=0 / dynamic=1 / kinematic=2 (RigidBodyTypeValue). rigidBodyTypeFromF32 narrows the stored value; Rapier maps them to Fixed / Dynamic / KinematicPositionBased.',
  expect:
    'All checks pass: the value map and narrowing agree, and three bodies spawned at y=5 behave differently: static stays, dynamic falls, kinematic ignores gravity but follows its Transform.',
  async run(checks) {
    checks.equal(
      'RigidBodyTypeValue',
      { ...RigidBodyTypeValue },
      { static: 0, dynamic: 1, kinematic: 2 },
    );
    checks.equal('narrow 0', rigidBodyTypeFromF32(0), 'static');
    checks.equal('narrow 1', rigidBodyTypeFromF32(1), 'dynamic');
    checks.equal('narrow 2', rigidBodyTypeFromF32(2), 'kinematic');
    checks.equal('unknown value narrows to static', rigidBodyTypeFromF32(9), 'static');
    const harness = await createPhysicsHarness3D();
    if (typeof harness === 'string') {
      checks.ok('Rapier 3D loads', false, harness);
      return;
    }
    const spawnAt = (x: number, type: number) =>
      harness.spawn(
        { component: Transform, data: { pos: [x, 5, 0] } },
        { component: RigidBody, data: { type } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.4, 0.4, 0.4] },
        },
      );
    const fixed = spawnAt(-3, RigidBodyTypeValue.static);
    const dynamic = spawnAt(0, RigidBodyTypeValue.dynamic);
    const kinematic = spawnAt(3, RigidBodyTypeValue.kinematic);
    harness.tick(30);
    checks.near('static stays at y=5', harness.pos(fixed)[1], 5, 1e-4);
    checks.ok(
      'dynamic falls under gravity',
      harness.pos(dynamic)[1] < 4,
      `y=${harness.pos(dynamic)[1]}`,
    );
    checks.near('kinematic ignores gravity', harness.pos(kinematic)[1], 5, 1e-4);
    harness.world.set(kinematic, Transform, { pos: [3, 2, 0] } as never);
    harness.tick(3);
    const hit = harness.physics.raycast(vec3(3, 10, 0), vec3(0, -1, 0), 20);
    checks.ok(
      'kinematic body follows its authored Transform',
      hit?.entity === kinematic && Math.abs((hit.point[1] ?? 0) - 2.4) < 0.05,
      `entity=${hit?.entity} y=${hit?.point[1]}`,
    );
    harness.dispose();
  },
});
