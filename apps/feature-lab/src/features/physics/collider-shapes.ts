import { Collider, ColliderShapeValue, colliderShapeFromF32 } from '@forgeax/engine/physics';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';
import { createPhysicsHarness3D, vec3 } from './support/rapier3d';

export default defineFeature({
  title: 'Collider shapes',
  catalog: 'Collider shapes',
  kind: 'headless',
  summary:
    'Collider supports primitive and managed shapes. This fixture raycasts cuboid, sphere and capsule using halfExtents, radius and halfHeight. A bare Collider (no RigidBody) becomes implicit static geometry.',
  expect:
    'All checks pass: shape narrowing agrees with the value map, and a downward raycast hits each shape exactly at its parameterised top (cuboid 0.5, sphere 0.7, capsule 0.3+0.5).',
  async run(checks) {
    for (const [shape, value] of Object.entries(ColliderShapeValue)) {
      checks.equal(`narrow ${shape}`, colliderShapeFromF32(value), shape);
    }
    const harness = await createPhysicsHarness3D();
    if (typeof harness === 'string') {
      checks.ok('Rapier 3D loads', false, harness);
      return;
    }
    const shapes = [
      {
        name: 'cuboid',
        x: -3,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.6, 0.5, 0.6] },
        top: 0.5,
      },
      { name: 'sphere', x: 0, data: { shape: ColliderShapeValue.sphere, radius: 0.7 }, top: 0.7 },
      {
        name: 'capsule',
        x: 3,
        data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 },
        top: 0.8,
      },
    ] as const;
    const entities = shapes.map((shape) =>
      harness.spawn(
        { component: Transform, data: { pos: [shape.x, 0, 0] } },
        { component: Collider, data: shape.data },
      ),
    );
    harness.tick(1);
    checks.equal('bare Colliders became three static bodies', harness.physics.getBodyCount(), 3);
    shapes.forEach((shape, index) => {
      const hit = harness.physics.raycast(vec3(shape.x, 5, 0), vec3(0, -1, 0), 20);
      checks.ok(
        `${shape.name} hit by its own ray`,
        hit?.entity === entities[index],
        `entity=${hit?.entity}`,
      );
      checks.near(`${shape.name} top surface`, hit?.point[1] ?? Number.NaN, shape.top, 0.02);
    });
    harness.dispose();
  },
});
