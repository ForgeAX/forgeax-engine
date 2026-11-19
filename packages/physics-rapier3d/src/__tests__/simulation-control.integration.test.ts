import { defineSystem, Update, World } from '@forgeax/engine-ecs';
import {
  Collider,
  PhysicsSimulationControl,
  PhysicsWorldResource,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it('suspends automatic native stepping without clearing momentum, accumulating debt or stopping cleanup', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const world = new World(),
    physics = createRapier3DPhysicsWorld(R);
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  world.insertResource(PhysicsWorldResource, physics);
  const release = registerPhysicsSystems(world);
  try {
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, gravityScale: 0 } },
        { component: Collider, data: {} },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    const initial = physics.getBodyMotion(entity).unwrap();
    physics
      .setBodyMotion(entity, { ...initial, linearVelocity: [3, 0, 0], angularVelocity: [0, 1, 0] })
      .unwrap();
    world.update(1 / 60).unwrap();
    const before = physics.getBodyMotion(entity).unwrap(),
      control = { paused: true };
    world.insertResource(PhysicsSimulationControl, control);
    let updates = 0;
    world
      .addSystem(
        Update,
        defineSystem({
          name: 'pause-independent-ui',
          queries: [],
          fn: () => {
            updates++;
          },
        }),
      )
      .unwrap();
    for (let i = 0; i < 120; i++) world.update(1 / 60).unwrap();
    expect(physics.getBodyMotion(entity).unwrap()).toEqual(before);
    expect(updates).toBe(120);
    const temporary = world
      .spawn({ component: Transform, data: { pos: [20, 0, 0] } }, { component: Collider, data: {} })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(physics.hasBody(temporary)).toBe(true);
    world.despawn(temporary).unwrap();
    world.update(1 / 60).unwrap();
    expect(physics.hasBody(temporary)).toBe(false);
    control.paused = false;
    world.update(1 / 60).unwrap();
    const after = physics.getBodyMotion(entity).unwrap();
    expect(after.position[0] - before.position[0]).toBeCloseTo(3 / 60, 5);
    expect(after.linearVelocity).toEqual(before.linearVelocity);
    for (const axis of [0, 1, 2] as const)
      expect(after.angularVelocity[axis]).toBeCloseTo(before.angularVelocity[axis], 5);
  } finally {
    release();
    physics.dispose();
  }
});

it('keeps prepared derived work unpublished while paused and rejects invalid step policy', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const world = new World(),
    physics = createRapier3DPhysicsWorld(R);
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  world.insertResource(PhysicsWorldResource, physics);
  const control = { paused: true };
  world.insertResource(PhysicsSimulationControl, control);
  const release = registerPhysicsSystems(world);
  try {
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, gravityScale: 0 } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(physics.hasBody(entity)).toBe(true);
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity,
        revision: 1,
        sourceKey: 'paused-hull',
        shapes: [
          {
            id: 'box',
            revision: 1,
            kind: 'convex-compound',
            pieces: [boxPoints([-1, -1, -1], [1, 1, 1])],
          },
        ],
      })
      .unwrap();
    physics.admitDerivedShapeCandidate(candidate).unwrap();
    world.update(1 / 60).unwrap();
    expect(physics.getDerivedPublication(entity)).toBeUndefined();
    control.paused = false;
    world.update(1 / 60).unwrap();
    expect(physics.getDerivedPublication(entity)?.candidateId).toBe(candidate.candidateId);
    const before = physics.getBodyMotion(entity).unwrap();
    Reflect.set(control, 'paused', 'invalid');
    expect(() => world.update(1 / 60).unwrap()).toThrow();
    expect(physics.getBodyMotion(entity).unwrap()).toEqual(before);
  } finally {
    release();
    physics.dispose();
  }
});
