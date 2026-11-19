import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { PhysicsWorldResource, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import { GlobalTransform, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it.each([
  { base: RigidBodyTypeValue.kinematic, published: 'dynamic' as const },
  { base: RigidBodyTypeValue.static, published: 'dynamic' as const },
  { base: RigidBodyTypeValue.dynamic, published: 'kinematic' as const },
])('retains published $published type over base $base during authored scalar edits', async ({
  base,
  published,
}) => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const world = new World(),
    physics = createRapier3DPhysicsWorld(R);
  physics.setGravity(vec3.create(0, 0, 0));
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  world.insertResource(PhysicsWorldResource, physics);
  const scene = registerPropagateTransforms(world),
    release = registerPhysicsSystems(world);
  try {
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: RigidBody,
          data: {
            type: base,
            canSleep: false,
            gravityScale: 0,
            linearDamping: 0.2,
            angularDamping: 0.3,
          },
        },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    physics.raw.forEachRigidBody((body) => {
      expect(body.linearDamping()).toBeCloseTo(0.2, 5);
      expect(body.angularDamping()).toBeCloseTo(0.3, 5);
      expect(body.gravityScale()).toBe(0);
    });
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity,
        revision: 1,
        sourceKey: 'body-policy',
        bodyType: published,
        worldIdentity: world,
        shapes: [
          { id: 'box', revision: 1, kind: 'cuboid', halfExtents: [0.5, 0.5, 0.5], density: 0 },
        ],
        massProperties: {
          mode: 'explicit',
          mass: 8,
          centerOfMass: [0, 0, 0],
          principalInertia: [1, 1, 1],
        },
      })
      .unwrap();
    physics.admitDerivedShapeCandidate(candidate).unwrap();
    world.update(1 / 60).unwrap();
    const isDynamic = () =>
      physics
        .getBodyMassProperties(entity)
        .unwrap()
        .effectiveInverseMass.some((n) => n > 0);
    expect(isDynamic()).toBe(published === 'dynamic');
    world
      .set(entity, RigidBody, {
        gravityScale: 0,
        linearDamping: 0.7,
        angularDamping: 0.8,
        ccdEnabled: true,
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(isDynamic()).toBe(published === 'dynamic');
    expect(physics.getDerivedPublication(entity)?.candidateId).toBe(candidate.candidateId);
    world.set(entity, Transform, { pos: [5, 2, 3] }).unwrap();
    world.update(1 / 60).unwrap();
    const pose = physics.getBodyMotion(entity).unwrap().position;
    expect(pose[0]).toBeCloseTo(published === 'dynamic' ? 0 : 5, 5);
    expect(pose[1]).toBeCloseTo(published === 'dynamic' ? 0 : 2, 5);
    expect(pose[2]).toBeCloseTo(published === 'dynamic' ? 0 : 3, 5);
    if (published === 'dynamic') {
      for (let frame = 0; frame < 360; frame++) world.update(1 / 60).unwrap();
      expect(physics.getBodyMotion(entity).unwrap().sleeping).toBe(false);
    }
    physics.raw.forEachRigidBody((body) => {
      expect(body.linearDamping()).toBeCloseTo(0.7, 5);
      expect(body.angularDamping()).toBeCloseTo(0.8, 5);
      expect(body.isCcdEnabled()).toBe(true);
    });
  } finally {
    release();
    scene();
    physics.dispose();
  }
});
