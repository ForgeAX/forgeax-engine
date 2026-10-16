import {
  Collider,
  ColliderShapeValue,
  PhysicsSet,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';
import { createPhysicsHarness3D, vec3 } from './support/rapier3d';

export default defineFeature({
  title: 'Three-phase physics tick',
  catalog: 'Three-phase physics tick',
  kind: 'headless',
  summary:
    'registerPhysicsSystems adds syncBackend -> stepSimulation -> writeback (+ collision sync) to FixedUpdate. The World fixed step drives Rapier; game code never calls step().',
  expect:
    'All checks pass: no body exists before the first World update, the first fixed step creates bodies, the dynamic Transform falls only through writeback, the static floor never moves, and an authored Transform write reaches the backend on the next sync.',
  async run(checks) {
    const harness = await createPhysicsHarness3D();
    if (typeof harness === 'string') {
      checks.ok('Rapier 3D loads', false, harness);
      return;
    }
    const { world, physics } = harness;
    checks.equal('PhysicsSet label', PhysicsSet.name, 'physics');
    const floor = harness.spawn(
      { component: Transform, data: { pos: [0, -0.5, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [10, 0.5, 10] },
      },
    );
    const ball = harness.spawn(
      { component: Transform, data: { pos: [0, 5, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
      { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.5 } },
    );
    checks.ok(
      'sync phase has not run: no native bodies yet',
      physics.getBodyCount() === 0 && !physics.hasBody(ball),
    );
    world.update(0).unwrap();
    checks.ok(
      'zero delta runs no fixed step',
      physics.getBodyCount() === 0,
      `bodies=${physics.getBodyCount()}`,
    );
    harness.tick(1);
    checks.equal('sync phase created both bodies', physics.getBodyCount(), 2);
    harness.tick(40);
    const y = harness.pos(ball)[1];
    checks.ok('writeback moved the dynamic Transform down', y < 4.5, `y=${y}`);
    checks.near('static floor Transform untouched', harness.pos(floor)[1], -0.5, 1e-5);
    harness.tick(80);
    checks.near('ball rests on the floor after simulation', harness.pos(ball)[1], 0.5, 0.05);
    world.set(floor, Transform, { pos: [0, -3.5, 0] } as never);
    harness.tick(1);
    const hit = physics.raycast(vec3(5, 5, 0), vec3(0, -1, 0), 20);
    checks.ok(
      'authored static pose reached Rapier on the next sync',
      hit !== undefined && Math.abs((hit.point[1] ?? 0) + 3) < 0.05,
      `hitY=${hit?.point[1]}`,
    );
    harness.dispose();
  },
});
