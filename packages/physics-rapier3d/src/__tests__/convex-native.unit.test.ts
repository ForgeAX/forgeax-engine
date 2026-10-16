import { createWorldContext, World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  type ConvexCompoundShapeInput,
  type DerivedPhysicsCandidateInput,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

async function fixture() {
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  physics.setGravity(vec3.create(0, 0, 0));
  world.insertResource('PhysicsWorld', physics);
  const release = registerPhysicsSystems(world);
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static, mass: 0 } },
    )
    .unwrap();
  world.update(1 / 60).unwrap();
  return {
    world,
    physics,
    entity,
    module,
    dispose: async () => {
      world.despawn(entity).unwrap();
      world.update(1 / 60).unwrap();
      release();
      await scene.fiber.dispose();
      physics.dispose();
    },
  };
}

it('preserves a compound gap, automatic mass, cancellation and portable recovery', async () => {
  const f = await fixture();
  const restored = await fixture();
  const shape: ConvexCompoundShapeInput = {
    kind: 'convex-compound',
    id: 'bracket',
    revision: 0,
    pieces: [boxPoints([-2, 0, -1], [-1, 1, 0]), boxPoints([1, 0, -1], [2, 1, 0])],
  };
  const input: DerivedPhysicsCandidateInput = {
    entity: f.entity,
    worldIdentity: f.world,
    revision: 0,
    sourceKey: 'bracket',
    bodyType: 'dynamic',
    shapes: [shape],
    massProperties: { mode: 'automatic', density: 7 },
  };
  const leftRay = () => f.physics.raycast(vec3.create(-1.5, -1, -0.5), vec3.create(0, 1, 0), 4);
  try {
    const prepared = f.physics.prepareDerivedShapeCandidate(input).unwrap();
    const exposed = prepared.input.shapes[0];
    if (exposed?.kind !== 'convex-compound') throw new Error('missing compound');
    const exposedPoints = exposed.pieces[0];
    if (exposedPoints === undefined) throw new Error('missing exposed points');
    exposedPoints.fill(99);
    // The private snapshot also owns buffers detached from the original producer.
    const sourcePoints = shape.pieces[0];
    if (sourcePoints === undefined) throw new Error('missing source points');
    sourcePoints.fill(-99);
    f.physics.admitDerivedShapeCandidate(prepared).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(f.physics.getDerivedBodyMass(f.entity)).toBeCloseTo(14, 5);
    expect(leftRay()?.entity).toBe(f.entity);
    expect(f.physics.raycast(vec3.create(0, -1, -0.5), vec3.create(0, 1, 0), 4)).toBeUndefined();
    const next = {
      ...input,
      revision: 1,
      shapes: [{ ...shape, revision: 1, pieces: shape.pieces.slice(1) }],
    };
    const cancelled = f.physics.prepareDerivedShapeCandidate(next).unwrap();
    f.physics.cancelDerivedShapeCandidate(cancelled).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(leftRay()?.entity).toBe(f.entity);
    f.physics
      .admitDerivedShapeCandidate(f.physics.prepareDerivedShapeCandidate(next).unwrap())
      .unwrap();
    expect(leftRay()?.entity).toBe(f.entity);
    f.world.update(1 / 60).unwrap();
    expect(leftRay()).toBeUndefined();
    expect(f.physics.getDerivedBodyMass(f.entity)).toBeCloseTo(7, 5);
    const snapshot = f.physics.captureDerivedPhysicsState();
    expect(snapshot.bodies[0]?.shapes[0]).toMatchObject({
      kind: 'convex-compound',
      pieces: [shape.pieces[1]],
    });
    restored.physics.restoreDerivedPhysicsState(snapshot).unwrap();
    restored.world.update(1 / 60).unwrap();
    expect(restored.physics.getDerivedShapes(restored.entity)).toMatchObject([
      { kind: 'convex-compound', id: 'bracket', revision: 1 },
    ]);
    expect(restored.physics.getDerivedBodyMass(restored.entity)).toBeCloseTo(7, 5);
    expect(
      restored.physics.raycast(vec3.create(1.5, -1, -0.5), vec3.create(0, 1, 0), 4)?.entity,
    ).toBe(restored.entity);
    expect(
      restored.physics.raycast(vec3.create(-1.5, -1, -0.5), vec3.create(0, 1, 0), 4),
    ).toBeUndefined();
  } finally {
    await f.dispose();
    await restored.dispose();
  }
});

it('rejects a collapsed piece before creating native colliders', async () => {
  const f = await fixture();
  const create = vi.spyOn(f.module.World.prototype, 'createCollider');
  try {
    const result = f.physics.prepareDerivedShapeCandidate({
      entity: f.entity,
      revision: 0,
      sourceKey: 'invalid',
      shapes: [
        {
          kind: 'convex-compound',
          id: 'flat',
          revision: 0,
          pieces: [boxPoints([0, 0, 0], [1, 1, 0])],
        },
      ],
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'derived-shape-invalid' } });
    expect(create).not.toHaveBeenCalled();
    expect(f.physics.getDerivedPublication(f.entity)).toBeUndefined();
  } finally {
    create.mockRestore();
    await f.dispose();
  }
});
