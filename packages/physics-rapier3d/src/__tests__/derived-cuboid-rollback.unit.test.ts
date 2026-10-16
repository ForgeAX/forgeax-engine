import { RigidBodyTypeValue } from '@forgeax/engine-physics';
import { err } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import type { RigidBody as NativeBody, World as NativeWorld } from '../../pkg/rapier.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

function snapshot(body: NativeBody) {
  return {
    mass: body.mass(),
    com: body.worldCom(),
    position: body.translation(),
    rotation: body.rotation(),
    linear: body.linvel(),
    angular: body.angvel(),
  };
}

it.each([
  ['static', 1],
  ['dynamic', 1],
  ['static', 2],
  ['dynamic', 2],
] as const)('preserves %s body state while staging %i off-center pieces', async (type, count) => {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const physics = createRapier3DPhysicsWorld(rapier);
  physics.ensureBody(
    1,
    {
      position: { x: 5, y: 6, z: 7 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    {
      type: RigidBodyTypeValue[type],
      mass: 0,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 0,
      ccdEnabled: 0,
    },
    undefined,
  );
  const world = physics.raw as NativeWorld;
  let body!: NativeBody;
  world.forEachRigidBody((value) => {
    body = value;
  });
  const prepare = (revision: number, offset = 0, density = 3) =>
    physics
      .prepareDerivedShapeCandidate({
        entity: 1,
        sourceKey: 'piece',
        revision,
        bodyType: type,
        shapes: [
          {
            kind: 'convex-compound',
            id: 'piece',
            revision,
            pieces: Array.from({ length: count }, (_, i) =>
              boxPoints([1 + offset + i * 4, 2, 3], [3 + offset + i * 4, 4, 5]),
            ),
          },
        ],
        massProperties: { mode: 'automatic', density },
      })
      .unwrap();
  const ray = (x: number) => {
    const position = body.translation();
    return world.castRay(
      new rapier.Ray({ x: position.x + x, y: position.y + 3, z: position.z }, { x: 0, y: 0, z: 1 }),
      10,
      true,
    );
  };
  try {
    const empty = snapshot(body);
    const cancelled = prepare(1);
    expect(snapshot(body)).toEqual(empty);
    physics.cancelDerivedShapeCandidate(cancelled).unwrap();
    expect(snapshot(body)).toEqual(empty);
    const refused = prepare(2);
    expect(snapshot(body)).toEqual(empty);
    physics.admitDerivedShapeCandidate(refused, () => err(new Error('geometry refused'))).unwrap();
    physics.step(1 / 60);
    expect(physics.getDerivedRecoveryState()).toBe('ready');
    expect(physics.getDerivedFailure(1)?.recovery).toBe('old-state-retained');
    expect(snapshot(body)).toEqual(empty);
    expect(world.colliders.len()).toBe(0);

    physics.admitDerivedShapeCandidate(prepare(3)).unwrap();
    physics.step(1 / 60);
    expect(physics.getDerivedPublication(1)?.revision).toBe(3);
    expect(body.mass()).toBe(24 * count);
    expect(body.worldCom()).toEqual({ x: 7 + (count - 1) * 2, y: 9, z: 11 });
    expect(ray(2)?.timeOfImpact).toBe(3);
    expect(ray(4)).toBeNull();
    if (count === 2) expect(ray(6)?.timeOfImpact).toBe(3);
    if (type === 'dynamic') {
      physics
        .setBodyMotion(1, {
          position: [5, 6, 7],
          rotation: [0, 0, 0, 1],
          linearVelocity: [1, 0, 0],
          angularVelocity: [0, 0, 0],
        })
        .unwrap();
    }
    const committed = snapshot(body);
    const cancelledReplacement = prepare(4, 10, 6);
    expect(snapshot(body)).toEqual(committed);
    physics.cancelDerivedShapeCandidate(cancelledReplacement).unwrap();
    expect(snapshot(body)).toEqual(committed);
    const refusedReplacement = prepare(5, 10, 6);
    expect(snapshot(body)).toEqual(committed);
    physics
      .admitDerivedShapeCandidate(refusedReplacement, () => err(new Error('replacement refused')))
      .unwrap();
    physics.step(1 / 60);
    expect(physics.getDerivedRecoveryState()).toBe('ready');
    expect(physics.getDerivedFailure(1)?.recovery).toBe('old-state-retained');
    expect(physics.getDerivedPublication(1)?.revision).toBe(3);
    expect(body.mass()).toBe(committed.mass);
    expect(body.localCom()).toEqual({ x: 2 + (count - 1) * 2, y: 3, z: 4 });
    expect(body.linvel()).toEqual(committed.linear);
    expect(body.angvel()).toEqual(committed.angular);
    expect(ray(2)?.timeOfImpact).toBe(3);
    expect(ray(12)).toBeNull();

    const next = prepare(6, 10, 6);
    physics.admitDerivedShapeCandidate(next).unwrap();
    physics.step(1 / 60);
    expect(physics.getDerivedRecoveryState()).toBe('ready');
    expect(physics.getDerivedPublication(1)?.revision).toBe(6);
    expect(body.mass()).toBe(48 * count);
    expect(body.localCom()).toEqual({ x: 12 + (count - 1) * 2, y: 3, z: 4 });
    expect(body.linvel()).toEqual(committed.linear);
    expect(body.angvel()).toEqual(committed.angular);
    expect(world.colliders.len()).toBe(1);
    expect(ray(2)).toBeNull();
    expect(ray(12)?.timeOfImpact).toBe(3);
    expect(ray(14)).toBeNull();
    if (count === 2) expect(ray(16)?.timeOfImpact).toBe(3);
  } finally {
    physics.dispose();
  }
});
