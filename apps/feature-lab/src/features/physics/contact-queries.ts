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
  title: 'Current contact queries',
  catalog: 'Current contact queries',
  kind: 'headless',
  summary:
    'Query detached contact geometry or unique neighbors from the last completed native physics step, independently of collision-event history.',
  expect:
    'The resting body reports the floor once; direction and collision groups filter contacts, sensors are excluded, and teleport requires a new step before returning an empty snapshot.',
  async run(checks) {
    const h = await createPhysicsHarness3D();
    if (typeof h === 'string') return void checks.ok('Rapier loads', false, h);
    try {
      const floor = h.spawn(
        { component: Transform, data: { pos: [0, -0.5, 0] } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.cuboid, halfExtents: [5, 0.5, 5] },
        },
      );
      const sensor = h.spawn(
        { component: Transform, data: { pos: [0, 0.5, 0] } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 1, 1], isSensor: true },
        },
      );
      const ball = h.spawn(
        { component: Transform, data: { pos: [0, 0.55, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
        { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.5 } },
      );
      h.tick(180);
      const full = h.physics.getCurrentContacts(ball).unwrap();
      const neighbors = h.physics.getCurrentContactNeighbors(ball).unwrap();
      checks.equal('floor is one unique neighbor', neighbors.entities, [floor]);
      checks.equal('sensor is not a solid contact', neighbors.entities.includes(sensor), false);
      checks.equal(
        'both queries name the same completed step',
        neighbors.fixedStep,
        full.fixedStep,
      );
      checks.ok(
        'full query retains world-space solver points',
        full.manifolds.some((m) => m.other === floor && m.points.length > 0),
      );
      checks.equal(
        'downward normal selects support',
        h.physics
          .getCurrentContactNeighbors(ball, undefined, { direction: [0, -1, 0], minimumDot: 0.2 })
          .unwrap().entities,
        [floor],
      );
      checks.equal(
        'opposite normal excludes support',
        h.physics
          .getCurrentContactNeighbors(ball, undefined, { direction: [0, 1, 0], minimumDot: 0.2 })
          .unwrap().entities,
        [],
      );
      checks.equal(
        'empty collision-group filter excludes all',
        h.physics.getCurrentContactNeighbors(ball, 0).unwrap().entities,
        [],
      );
      h.physics.teleport(ball, vec3(20, 5, 0));
      checks.equal(
        'pose edit invalidates old contact evidence',
        h.physics.getCurrentContactNeighbors(ball).ok,
        false,
      );
      h.tick();
      checks.equal(
        'next completed step has no contact',
        h.physics.getCurrentContactNeighbors(ball).unwrap().entities,
        [],
      );
      checks.equal('retained snapshot is detached', neighbors.entities, [floor]);
    } finally {
      h.dispose();
    }
  },
});
