import { vec3 } from '@forgeax/engine-math';
import type { PhysicsContactObservation } from '@forgeax/engine-physics';
import { toShared } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import type { World as RapierWorld } from '../../pkg/rapier.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d';
import { loadRapier3D } from '../wasm-loader';

it.each([
  { yaw: 0, projectileFirst: false, shape: 0 },
  { yaw: Math.PI / 3, projectileFirst: false, shape: 0 },
  { yaw: Math.PI / 3, projectileFirst: true, shape: 0 },
  { yaw: Math.PI / 3, projectileFirst: true, shape: 1 },
  { yaw: Math.PI / 3, projectileFirst: true, shape: 2 },
])('samples world-space contact against a compound wall ($yaw, $projectileFirst, $shape)', async ({
  yaw,
  projectileFirst,
  shape,
}) => {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  try {
    physics.setGravity(vec3.create(0, -9.81, 0));
    const pose = (x: number, y: number, z: number) => ({
      position: { x, y, z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    });
    const body = (type: number) => ({
      type,
      mass: 1,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 1,
      ccdEnabled: 1,
    });
    const addProjectile = () =>
      physics.ensureBody(
        2,
        pose(10 + Math.cos(yaw) + 0.5 * Math.sin(yaw), 4, -Math.sin(yaw) + 0.5 * Math.cos(yaw)),
        body(1),
        {
          shape,
          mesh: toShared<'MeshAsset'>(0),
          halfExtents: [0.2, 0.2, 0.2],
          radius: 0.2,
          halfHeight: 0.2,
          friction: 0.5,
          restitution: 0,
          density: 1,
          isSensor: false,
          collisionGroups: 0xffffffff,
          solverGroups: 0xffffffff,
        },
      );
    if (projectileFirst) addProjectile();
    const wallPose = pose(10, 0, 0);
    wallPose.rotation = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    physics.ensureBody(1, wallPose, body(0), undefined);
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity: 1,
        sourceKey: 'wall',
        revision: 0,
        bodyType: 'static',
        shapes: [
          {
            id: 'main',
            revision: 0,
            kind: 'convex-compound',
            origin: [0, 0, 0],
            pieces: [boxPoints([0, 0, 0], [3, 1.5, 1])],
          },
        ],
        massProperties: {
          mode: 'explicit',
          mass: 9,
          centerOfMass: [1.5, 0.75, 0.5],
          principalInertia: [1, 1, 1],
        },
      })
      .unwrap();
    physics.admitDerivedShapeCandidate(candidate).unwrap();
    physics.step(1 / 60);
    if (!projectileFirst) addProjectile();
    let contact: PhysicsContactObservation | undefined;
    for (let i = 0; i < 120 && contact === undefined; i++) {
      physics.step(1 / 60);
      contact = physics.getContactObservations().find((event) => event.phase === 'started');
    }
    expect(contact).toBeDefined();
    if (contact === undefined) throw new Error('expected a started physics contact');
    const point = contact.point;
    expect(point).toBeDefined();
    if (point === undefined) throw new Error('expected a contact point');
    expect(point[1]).toBeCloseTo(1.5, 1);
    const normal = contact.normal;
    expect(normal).toBeDefined();
    if (normal === undefined) throw new Error('expected a contact normal');
    expect(normal[1]).toBeCloseTo(contact.entityA === 1 ? 1 : -1, 2);
    const dx = point[0] - 10;
    const dz = point[2];
    const localX = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
    const localZ = Math.sin(yaw) * dx + Math.cos(yaw) * dz;
    expect(localX).toBeGreaterThan(0);
    expect(localX).toBeLessThan(3);
    expect(localZ).toBeGreaterThan(0);
    expect(localZ).toBeLessThan(1);
    const held = physics.getContactObservations();
    const heldBytes = structuredClone(held);
    expect(physics.getContactObservations()).toBe(held);
    expect(Object.isFrozen(held)).toBe(true);
    expect(Object.isFrozen(contact)).toBe(true);
    expect(Object.isFrozen(point)).toBe(true);
    expect(Object.isFrozen(normal)).toBe(true);
    expect(() => {
      (point as unknown as number[])[0] = 999;
    }).toThrow(TypeError);
    physics.teleport(2, vec3.create(100, 100, 100));
    physics.step(1 / 60);
    expect(physics.getContactObservations()).not.toBe(held);
    expect(held).toEqual(heldBytes);
  } finally {
    physics.dispose();
  }
});

it.each([
  false,
  true,
])('reports a unit normal for coincident capsule/hull contact (capsule first: %s)', async (capsuleFirst) => {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  try {
    physics.setGravity(vec3.create(0, 0, 0));
    const raw = physics.raw as RapierWorld;
    const addCapsule = () => {
      const body = raw.createRigidBody(module.RigidBodyDesc.fixed());
      body.userData = 1;
      physics.registerBody(1, body.handle);
      return raw.createCollider(
        module.ColliderDesc.capsule(0.5, 0.5).setActiveEvents(module.ActiveEvents.COLLISION_EVENTS),
        body,
      );
    };
    const addHull = () => {
      const body = raw.createRigidBody(module.RigidBodyDesc.dynamic().setTranslation(0, 1.5, 0));
      body.userData = 2;
      physics.registerBody(2, body.handle);
      return raw.createCollider(
        module.ColliderDesc.convexHull(boxPoints([-1, -1, -1], [1, 1, 1])).setActiveEvents(
          module.ActiveEvents.COLLISION_EVENTS,
        ),
        body,
      );
    };
    const [capsule, hull] = capsuleFirst
      ? [addCapsule(), addHull()]
      : (() => {
          const hull = addHull();
          return [addCapsule(), hull];
        })();
    if (capsule === undefined || hull === undefined) throw new Error('expected both colliders');
    physics.step(1 / 60);
    const observations = physics.getContactObservations();
    expect(observations).toHaveLength(1);
    const contact = observations[0];
    if (contact === undefined) throw new Error('expected a started physics contact');
    expect(contact.phase).toBe('started');
    expect(contact.fixedStep).toBe(1);
    expect([contact.entityA, contact.entityB].sort()).toEqual([1, 2]);
    expect(contact.point).toBeDefined();
    expect(contact.point?.every(Number.isFinite)).toBe(true);
    let nativePoint: readonly number[] | undefined;
    raw.contactPair(capsule, hull, (manifold) => {
      expect(manifold.numSolverContacts()).toBeGreaterThan(0);
      const point = manifold.solverContactPoint(0);
      if (point !== null) nativePoint = [point.x, point.y, point.z];
    });
    expect(nativePoint).toBeDefined();
    expect(contact.point).toEqual(nativePoint);
    // This native capsule/hull overlap previously retained real solver points
    // but supplied a zero normal. The valid geometry needs its resolved plane.
    const normal = contact.normal;
    expect(normal).toBeDefined();
    if (normal === undefined) throw new Error('expected a contact normal');
    expect(normal.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...normal)).toBeCloseTo(1, 6);
    expect(normal[0]).toBeCloseTo(0, 6);
    expect(normal[1]).toBeCloseTo(contact.entityA === 1 ? 1 : -1, 6);
    expect(normal[2]).toBeCloseTo(0, 6);
  } finally {
    physics.dispose();
  }
});
