import { Collider, ColliderShapeValue } from '@forgeax/engine/physics';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';
import { createPhysicsHarness3D, vec3 } from './support/rapier3d';

export default defineFeature({
  title: 'Physics raycast',
  catalog: 'Physics raycast',
  kind: 'headless',
  summary:
    'PhysicsWorld.raycast(origin, direction, maxDist, filterMask?) returns the nearest RaycastHit { entity, point, normal, timeOfImpact } or undefined on a miss. entity is the ECS handle, not a Rapier handle.',
  expect:
    'All checks pass: a +X ray reaches the box face at toi 4 with normal -X, a downward ray hits the ground, maxDist shorter than the gap misses, and a ray into empty space returns undefined.',
  async run(checks) {
    const harness = await createPhysicsHarness3D();
    if (typeof harness === 'string') {
      checks.ok('Rapier 3D loads', false, harness);
      return;
    }
    const { physics } = harness;
    const ground = harness.spawn(
      { component: Transform, data: { pos: [0, -0.5, 0] } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [10, 0.5, 10] },
      },
    );
    const target = harness.spawn(
      { component: Transform, data: { pos: [5, 1, 0] } },
      { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 1, 1] } },
    );
    harness.tick(2);
    const side = physics.raycast(vec3(0, 1, 0), vec3(1, 0, 0), 20);
    checks.ok('side ray hits the target entity', side?.entity === target, `entity=${side?.entity}`);
    checks.near('timeOfImpact to near face', side?.timeOfImpact ?? Number.NaN, 4, 0.02);
    checks.near('hit normal faces -X', side?.normal[0] ?? Number.NaN, -1, 0.02);
    checks.near('hit point x', side?.point[0] ?? Number.NaN, 4, 0.02);
    const down = physics.raycast(vec3(0, 5, 0), vec3(0, -1, 0), 20);
    checks.ok('down ray hits the ground entity', down?.entity === ground, `entity=${down?.entity}`);
    checks.near('ground normal faces +Y', down?.normal[1] ?? Number.NaN, 1, 0.02);
    checks.ok(
      'maxDist shorter than the gap misses',
      physics.raycast(vec3(0, 1, 0), vec3(1, 0, 0), 3) === undefined,
    );
    checks.ok(
      'empty direction misses',
      physics.raycast(vec3(0, 1, 0), vec3(0, 1, 0), 50) === undefined,
    );
    harness.dispose();
  },
});
