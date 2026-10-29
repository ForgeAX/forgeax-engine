import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { expect, test, vi } from 'vitest';
import type { RigidBody as NativeBody, World as NativeWorld } from '../../pkg/rapier.mjs';
import { createRapier3DPhysicsWorld, loadRapier3D } from '../index';
import type { PhysicsSyncState } from '../physics-sync';

const rapier = await loadRapier3D();
if ('code' in rapier) throw rapier;

const shapes = ['cuboid', 'sphere', 'capsule', 'cylinder', 'cone'] as const;
const cases = shapes.flatMap((shape) =>
  (['static', 'kinematic'] as const).map((bodyType) => ({ shape, bodyType })),
);

test('pose writeback does not decode unchanged body, collider or controller inputs', () => {
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: GlobalTransform, data: {} },
      { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
      { component: Collider, data: {} },
      { component: CharacterController, data: {} },
    )
    .unwrap();
  const physics = createRapier3DPhysicsWorld(rapier);
  const reads = vi.fn();
  const restorers: (() => void)[] = [];
  try {
    physics._syncFromEcs(world, Transform, GlobalTransform);
    const state = (physics as unknown as { syncState: PhysicsSyncState }).syncState;
    for (const query of state.queries) {
      const at = query.at.bind(query);
      const spy = vi.spyOn(query, 'at').mockImplementation((handle) => {
        const row = at(handle);
        return row === undefined
          ? undefined
          : {
              entity: row.entity,
              has: row.has.bind(row),
              get(component) {
                reads(component);
                return row.get(component);
              },
            };
      });
      restorers.push(() => spy.mockRestore());
    }
    for (let frame = 1; frame <= 10; frame++) {
      world.set(entity, Transform, { pos: [frame, 0, 0] }).unwrap();
      physics._syncFromEcs(world, Transform, GlobalTransform);
    }
    expect(reads).not.toHaveBeenCalled();

    world.set(entity, RigidBody, { linearDamping: 0.7 }).unwrap();
    world.set(entity, Collider, { friction: 0.2 }).unwrap();
    physics._syncFromEcs(world, Transform, GlobalTransform);
    let body: NativeBody | undefined;
    (physics.raw as NativeWorld).forEachRigidBody((candidate) => {
      if (candidate.userData === entity) body = candidate;
    });
    expect(body?.linearDamping()).toBeCloseTo(0.7);
    expect(body?.collider(0).friction()).toBeCloseTo(0.2);
  } finally {
    for (const restore of restorers) restore();
    physics.dispose();
  }
});

test.each(cases)('$bodyType $shape retains pose-only geometry and applies actual resize', ({
  shape,
  bodyType,
}) => {
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: RigidBody, data: { type: RigidBodyTypeValue[bodyType] } },
      { component: Collider, data: { shape: ColliderShapeValue[shape] } },
    )
    .unwrap();
  const physics = createRapier3DPhysicsWorld(rapier);
  let body: NativeBody | undefined;
  const halfExtents = vi.spyOn(rapier.Collider.prototype, 'setHalfExtents');
  const radius = vi.spyOn(rapier.Collider.prototype, 'setRadius');
  const halfHeight = vi.spyOn(rapier.Collider.prototype, 'setHalfHeight');
  try {
    physics._syncFromEcs(world, Transform, GlobalTransform);
    (physics.raw as NativeWorld).forEachRigidBody((value) => {
      if (value.userData === entity) body = value;
    });
    if (body === undefined) throw new Error('native body missing');
    const collider = body.collider(0);
    const handle = collider.handle;
    const topHit = () => physics.raycast(vec3.create(20, 10, 0), vec3.create(0, -1, 0), 20);
    for (let frame = 1; frame <= 20; frame++) {
      world.set(entity, Transform, { pos: [frame, 0, 0] }).unwrap();
      physics._syncFromEcs(world, Transform, GlobalTransform);
      physics.step(1 / 60);
    }
    world.set(entity, Transform, { quat: [0, Math.sin(0.2), 0, Math.cos(0.2)] }).unwrap();
    physics._syncFromEcs(world, Transform, GlobalTransform);
    physics.step(1 / 60);
    expect(body.rotation().y).toBeCloseTo(Math.sin(0.2));
    expect(body.translation().x).toBeCloseTo(20);
    expect(body.collider(0).handle).toBe(handle);
    expect(halfExtents).not.toHaveBeenCalled();
    expect(radius).not.toHaveBeenCalled();
    expect(halfHeight).not.toHaveBeenCalled();
    expect(topHit()?.entity).toBe(entity);
    expect(topHit()?.timeOfImpact).toBeCloseTo(shape === 'capsule' ? 9 : 9.5, 3);

    world.set(entity, Transform, { scale: [2, 3, 4] }).unwrap();
    physics._syncFromEcs(world, Transform, GlobalTransform);
    physics.step(1 / 60);
    if (shape === 'cuboid') expect(collider.halfExtents()).toEqual({ x: 1, y: 1.5, z: 2 });
    else {
      expect(collider.radius()).toBe(2);
      if (shape !== 'sphere') expect(collider.halfHeight()).toBe(1.5);
    }
    expect(body.collider(0).handle).toBe(handle);
    const grownTop = shape === 'sphere' ? 2 : shape === 'capsule' ? 3.5 : 1.5;
    expect(topHit()?.timeOfImpact).toBeCloseTo(10 - grownTop, 3);

    halfExtents.mockClear();
    radius.mockClear();
    halfHeight.mockClear();
    const equivalentScale =
      shape === 'cuboid' ? [-2, -3, -4] : shape === 'sphere' ? [-4, -2, -3] : [-4, -3, -2];
    world.set(entity, Transform, { scale: equivalentScale }).unwrap();
    physics._syncFromEcs(world, Transform, GlobalTransform);
    physics.step(1 / 60);
    expect(topHit()?.timeOfImpact).toBeCloseTo(10 - grownTop, 3);
    expect(halfExtents).not.toHaveBeenCalled();
    expect(radius).not.toHaveBeenCalled();
    expect(halfHeight).not.toHaveBeenCalled();
  } finally {
    halfExtents.mockRestore();
    radius.mockRestore();
    halfHeight.mockRestore();
    physics.dispose();
  }
});
