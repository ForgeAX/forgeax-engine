import { World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { beforeAll, expect, test } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import type { RigidBody as NativeBody, World as NativeWorld } from '../../pkg/rapier.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D, type Rapier3DModule } from '../wasm-loader.js';

let rapier: Rapier3DModule;
beforeAll(async () => {
  rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
});

function fixture(lockRotation?: boolean, derived = false) {
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const entity = world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 1, 0], quat: [0, Math.sin(0.2), 0, Math.cos(0.2)] },
      },
      {
        component: RigidBody,
        data: {
          type: RigidBodyTypeValue.dynamic,
          ...(lockRotation === undefined ? {} : { lockRotation }),
          ccdEnabled: true,
        },
      },
    )
    .unwrap();
  if (!derived)
    world
      .addComponent(entity, {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.8, 0.3, 0.2] },
      })
      .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, -1, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [20, 0.5, 20] },
      },
    )
    .unwrap();
  const physics = createRapier3DPhysicsWorld(rapier);
  physics._syncFromEcs(world, Transform, GlobalTransform);
  let body: NativeBody | undefined;
  (physics.raw as NativeWorld).forEachRigidBody((candidate) => {
    if (candidate.userData === entity) body = candidate;
  });
  if (body === undefined) throw new Error('Missing native body');
  return { world, entity, physics, body };
}

function expectLockedThroughContacts(f: ReturnType<typeof fixture>) {
  const orientation = { ...f.body.rotation() };
  const derived = f.physics
    .captureDerivedPhysicsState()
    .bodies.find((row) => row.entity === f.entity);
  let touchedGround = false;
  for (let step = 0; step < 90; step++) {
    f.body.addTorque({ x: 0.3, y: 0.2, z: 0.4 }, true);
    f.body.applyTorqueImpulse({ x: 0.02, y: 0.03, z: 0.04 }, true);
    const p = f.body.translation();
    if (derived === undefined) {
      f.body.applyImpulseAtPoint({ x: 0, y: 0.001, z: 0 }, { x: p.x + 0.4, y: p.y, z: p.z }, true);
    } else {
      f.physics
        .applyDerivedImpulse({
          entity: f.entity,
          sourceKey: derived.sourceKey,
          revision: derived.revision,
          impulse: [0, 0.001, 0],
          point: [p.x + 0.4, p.y, p.z],
        })
        .unwrap();
    }
    f.physics.step(1 / 60);
    f.physics.finalizeDerivedFixedStep();
    for (let i = 0; i < f.body.numColliders(); i++) {
      (f.physics.raw as NativeWorld).contactPairsWith(f.body.collider(i), () => {
        touchedGround = true;
      });
    }
    expect(f.body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
    expect(f.body.rotation()).toEqual(orientation);
  }
  expect(touchedGround).toBe(true);
  expect(f.body.translation().y).toBeLessThan(0.5);
}

test('ordinary ECS rotation lock defaults off, clears existing spin, survives edits and unlocks', () => {
  const f = fixture();
  try {
    expect(f.world.get(f.entity, RigidBody).unwrap().lockRotation).toBe(false);
    f.body.setAngvel({ x: 1, y: 2, z: 3 }, true);
    f.physics.step(1 / 60);
    f.physics.finalizeDerivedFixedStep();
    const orientation = { ...f.body.rotation() };
    const linear = { ...f.body.linvel() };
    const mass = f.body.mass();
    f.world.set(f.entity, RigidBody, { lockRotation: true }).unwrap();
    f.world.set(f.entity, Collider, { friction: 0.9 }).unwrap();
    f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
    expect(f.body.rotation()).toEqual(orientation);
    expect(f.body.linvel()).toEqual(linear);
    expect(f.body.mass()).toBeCloseTo(mass, 5);
    expect(f.body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
    f.world.set(f.entity, Collider, { halfExtents: [0.6, 0.3, 0.2] }).unwrap();
    f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
    const motion = f.physics.getBodyMotion(f.entity).unwrap();
    f.physics.setBodyMotion(f.entity, { ...motion, angularVelocity: [4, 5, 6] }).unwrap();
    expect(f.physics.getBodyMotion(f.entity).unwrap().angularVelocity).toEqual([0, 0, 0]);
    expectLockedThroughContacts(f);
    f.world.set(f.entity, RigidBody, { lockRotation: false }).unwrap();
    f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
    f.body.applyTorqueImpulse({ x: 1, y: 2, z: 3 }, true);
    expect(f.body.angvel()).not.toEqual({ x: 0, y: 0, z: 0 });
    f.physics.step(1 / 60);
    f.physics.finalizeDerivedFixedStep();
    expect(f.body.rotation()).not.toEqual(orientation);
  } finally {
    f.physics.dispose();
  }
});

test('locked derived bodies preserve holes, mass and orientation through rebuild, park, wake and recovery', () => {
  const f = fixture(true, true);
  const restored = fixture(undefined, true);
  try {
    const shapes = [
      {
        kind: 'convex-compound' as const,
        id: 'separated',
        revision: 1,
        pieces: [
          boxPoints([-1.2, -0.3, -0.3], [-0.6, 0.3, 0.3]),
          boxPoints([0.6, -0.3, -0.3], [1.2, 0.3, 0.3]),
        ],
      },
    ];
    const massProperties = {
      mode: 'explicit' as const,
      mass: 5,
      centerOfMass: [0, 0, 0] as const,
      principalInertia: [1, 2, 3] as const,
    };
    const rotation = f.physics.getBodyMotion(f.entity).unwrap().rotation;
    for (const revision of [1, 2]) {
      const candidate = f.physics
        .prepareDerivedShapeCandidate({
          entity: f.entity,
          sourceKey: 'rubble',
          revision,
          bodyType: 'dynamic',
          shapes: shapes.map((shape) => ({ ...shape, revision })),
          massProperties: revision === 1 ? { mode: 'automatic', density: 1 } : massProperties,
          motion: {
            centerOfMass: [0, 1, 0],
            rotation,
            linearVelocity: [0, 0, 0],
            angularVelocity: [8, 9, 10],
          },
        })
        .unwrap();
      f.physics.admitDerivedShapeCandidate(candidate).unwrap();
      f.physics.step(1 / 60);
      f.physics.finalizeDerivedFixedStep();
      expect(f.physics.getBodyMotion(f.entity).unwrap().angularVelocity).toEqual([0, 0, 0]);
      if (revision === 2) expect(f.physics.getDerivedBodyMass(f.entity)).toBeCloseTo(5, 5);
      expect(
        f.body
          .collider(0)
          .castRay(new rapier.Ray({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 }), 3, true),
      ).toBe(-1);
    }
    const handles = Array.from(
      { length: f.body.numColliders() },
      (_, i) => f.body.collider(i).handle,
    );
    for (const bodyType of ['static', 'dynamic'] as const) {
      const publication = f.physics.getDerivedPublication(f.entity);
      if (publication === undefined) throw new Error('Missing publication');
      const candidates = f.physics
        .prepareDerivedBodyTypeCandidates([{ publication, bodyType }])
        .unwrap();
      f.physics.admitDerivedShapeCandidates(candidates).unwrap();
      f.physics.step(1 / 60);
      f.physics.finalizeDerivedFixedStep();
      expect(
        Array.from({ length: f.body.numColliders() }, (_, i) => f.body.collider(i).handle),
      ).toEqual(handles);
    }
    const snapshot = f.physics.captureDerivedPhysicsState();
    restored.world
      .set(restored.entity, RigidBody, f.world.get(f.entity, RigidBody).unwrap())
      .unwrap();
    restored.physics._syncFromEcs(restored.world, Transform, GlobalTransform);
    restored.physics.restoreDerivedPhysicsState(snapshot).unwrap();
    restored.physics.step(1 / 60);
    restored.physics.finalizeDerivedFixedStep();
    expect(restored.physics.captureDerivedPhysicsState().bodies[0]?.massProperties).toMatchObject(
      massProperties,
    );
    expect(restored.physics.getBodyMotion(restored.entity).unwrap().rotation).toEqual(rotation);
    expectLockedThroughContacts(f);
    expectLockedThroughContacts(restored);
  } finally {
    f.physics.dispose();
    restored.physics.dispose();
  }
});

test.each([
  false,
  true,
])('kinematic to dynamic handoff clears imposed spin with derived=%s', (derived) => {
  const f = fixture(true, derived);
  const step = () => {
    f.physics.step(1 / 60);
    f.physics.finalizeDerivedFixedStep();
  };
  const changeType = (type: 'kinematic' | 'dynamic') => {
    if (derived) {
      const publication = f.physics.getDerivedPublication(f.entity);
      if (publication === undefined) throw new Error('Missing publication');
      const candidates = f.physics
        .prepareDerivedBodyTypeCandidates([{ publication, bodyType: type }])
        .unwrap();
      f.physics
        .admitDerivedShapeCandidates(candidates, () =>
          f.world.set(f.entity, RigidBody, { type: RigidBodyTypeValue[type] }),
        )
        .unwrap();
    } else {
      f.world.set(f.entity, RigidBody, { type: RigidBodyTypeValue[type] }).unwrap();
      f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
    }
    step();
  };
  try {
    if (derived) {
      const candidate = f.physics
        .prepareDerivedShapeCandidate({
          entity: f.entity,
          sourceKey: 'handoff',
          revision: 1,
          bodyType: 'dynamic',
          shapes: [
            {
              kind: 'convex-compound',
              id: 'block',
              revision: 1,
              pieces: [boxPoints([-0.3, -0.3, -0.3], [0.3, 0.3, 0.3])],
            },
          ],
        })
        .unwrap();
      f.physics.admitDerivedShapeCandidate(candidate).unwrap();
      step();
    }
    changeType('kinematic');
    f.world.set(f.entity, Transform, { quat: [0, Math.sin(0.4), 0, Math.cos(0.4)] }).unwrap();
    f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
    step();
    expect(Math.abs(f.body.angvel().y)).toBeGreaterThan(1);
    const orientation = { ...f.body.rotation() };
    changeType('dynamic');
    expect(f.body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
    expect(f.body.rotation()).toEqual(orientation);
    expectLockedThroughContacts(f);
  } finally {
    f.physics.dispose();
  }
});
