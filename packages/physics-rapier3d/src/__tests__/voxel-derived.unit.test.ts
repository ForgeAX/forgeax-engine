import { createWorldContext, World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  type DerivedPhysicsCandidateInput,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

async function fixture() {
  const world = new World(),
    scene = await createWorldContext(world, [scenePlugin()]);
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
    async dispose() {
      world.despawn(entity).unwrap();
      world.update(1 / 60).unwrap();
      release();
      await scene.fiber.dispose();
      physics.dispose();
    },
  };
}
function input(
  entity: number,
  world: World,
  revision: number,
  regions = [-2, 0, -1, -1, 1, 0, 1, 0, -1, 2, 1, 0],
): DerivedPhysicsCandidateInput {
  return {
    entity,
    worldIdentity: world,
    sourceKey: 'voxel-bracket',
    revision,
    bodyType: 'dynamic',
    shapes: [
      {
        id: 'voxel-bracket',
        revision,
        kind: 'voxels',
        regions: Int32Array.from(regions),
        voxelSize: [1, 1, 1],
      },
    ],
    massProperties: { mode: 'automatic', density: 7 },
  };
}
it('publishes compact voxel holes, isolates inputs, rolls back paired refusal and recovers mass', async () => {
  const f = await fixture(),
    restored = await fixture();
  const ray = () => f.physics.raycast(vec3.create(-1.5, -1, -0.5), vec3.create(0, 1, 0), 4);
  try {
    const source = input(f.entity, f.world, 1),
      candidate = f.physics.prepareDerivedShapeCandidate(source).unwrap();
    for (const shape of [...source.shapes, ...candidate.input.shapes])
      if (shape.kind === 'voxels') shape.regions.fill(999);
    f.physics.admitDerivedShapeCandidate(candidate).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(ray()?.entity).toBe(f.entity);
    expect(f.physics.getDerivedBodyMass(f.entity)).toBeCloseTo(14, 5);
    expect(f.physics.raycast(vec3.create(0, -1, -0.5), vec3.create(0, 1, 0), 4)).toBeUndefined();
    const cancelled = f.physics
      .prepareDerivedShapeCandidate(input(f.entity, f.world, 2, [1, 0, -1, 2, 1, 0]))
      .unwrap();
    f.physics.cancelDerivedShapeCandidate(cancelled).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(ray()).toBeDefined();
    const refused = f.physics
      .prepareDerivedShapeCandidate(input(f.entity, f.world, 3, [1, 0, -1, 2, 1, 0]))
      .unwrap();
    f.physics
      .admitDerivedShapeCandidate(refused, () => err(new Error('deliberate geometry refusal')))
      .unwrap();
    f.world.update(1 / 60).unwrap();
    expect(f.physics.getDerivedPublication(f.entity)?.revision).toBe(1);
    expect(ray()).toBeDefined();
    expect(f.physics.getDerivedBodyMass(f.entity)).toBeCloseTo(14, 5);
    const next = f.physics
      .prepareDerivedShapeCandidate(input(f.entity, f.world, 4, [1, 0, -1, 2, 1, 0]))
      .unwrap();
    f.physics.admitDerivedShapeCandidate(next).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(ray()).toBeUndefined();
    expect(f.physics.getDerivedBodyMass(f.entity)).toBeCloseTo(7, 5);
    const snapshot = f.physics.captureDerivedPhysicsState();
    restored.physics.restoreDerivedPhysicsState(snapshot).unwrap();
    restored.world.update(1 / 60).unwrap();
    expect(restored.physics.getDerivedBodyMass(restored.entity)).toBeCloseTo(7, 5);
    expect(
      restored.physics.raycast(vec3.create(1.5, -1, -0.5), vec3.create(0, 1, 0), 4)?.entity,
    ).toBe(restored.entity);
    const saved = snapshot.bodies[0]?.shapes[0];
    if (saved?.kind !== 'voxels') throw Error('Missing voxel snapshot');
    saved.regions.fill(500);
    expect(f.physics.captureDerivedPhysicsState().bodies[0]?.shapes[0]).toMatchObject({
      regions: Int32Array.from([1, 0, -1, 2, 1, 0]),
    });
  } finally {
    await restored.dispose();
    await f.dispose();
  }
});
it('refuses malformed or excessively expanded regions before native allocation', async () => {
  const f = await fixture();
  try {
    for (const regions of [
      [0, 0, 0, 0, 1, 1],
      [0, 0, 0, 1000000, 1000000, 1000000],
      [0, 0, 0, 1],
    ]) {
      expect(f.physics.prepareDerivedShapeCandidate(input(f.entity, f.world, 1, regions)).ok).toBe(
        false,
      );
      expect(f.physics.getDerivedPublication(f.entity)).toBeUndefined();
    }
    const bad = input(f.entity, f.world, 1);
    const shape = bad.shapes[0];
    if (shape?.kind !== 'voxels') throw Error('Missing input');
    expect(
      f.physics.prepareDerivedShapeCandidate({
        ...bad,
        shapes: [{ ...shape, voxelSize: [0, 1, 1] }],
      }).ok,
    ).toBe(false);
    expect(f.physics.prepareDerivedShapeCandidate(input(f.entity, f.world, 1)).ok).toBe(true);
  } finally {
    await f.dispose();
  }
});

it('budgets the shared chunk union for heavily overlapping compact boxes', async () => {
  const f = await fixture();
  try {
    const regions = Array.from({ length: 4000 }, () => [0, 0, 0, 1, 1, 1]).flat();
    const candidate = f.physics
      .prepareDerivedShapeCandidate(input(f.entity, f.world, 1, regions))
      .unwrap();
    f.physics.admitDerivedShapeCandidate(candidate).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(f.physics.getDerivedBodyMass(f.entity)).toBeCloseTo(7, 5);
  } finally {
    await f.dispose();
  }
});

it('retains unchanged native shapes through a mixed edit, cancellation, rollback and retirement', async () => {
  const f = await fixture();
  const source = (revision: number, cut = false): DerivedPhysicsCandidateInput => {
    const base = input(f.entity, f.world, revision);
    const unchanged = base.shapes[0];
    if (unchanged === undefined) throw Error('Missing fixture shape');
    return {
      ...base,
      shapes: [
        { ...unchanged, id: 'unchanged' },
        {
          id: 'edited',
          revision,
          kind: 'voxels',
          regions: Int32Array.from(cut ? [4, 0, 0, 5, 1, 1] : [3, 0, 0, 5, 1, 1]),
          voxelSize: [1, 1, 1],
        },
      ],
    };
  };
  const create = vi.spyOn(f.physics.raw, 'createColliderFromVoxelEdits');
  try {
    f.physics
      .admitDerivedShapeCandidate(f.physics.prepareDerivedShapeCandidate(source(0)).unwrap())
      .unwrap();
    f.world.update(1 / 60).unwrap();
    const old = f.physics.getDerivedPublication(f.entity),
      before = f.physics.raw.colliders.len();
    create.mockClear();
    const cancelled = f.physics.prepareDerivedShapeCandidate(source(1, true)).unwrap();
    expect(create).toHaveBeenCalledTimes(1);
    f.physics.cancelDerivedShapeCandidate(cancelled).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(f.physics.raw.colliders.len()).toBe(before);
    expect(f.physics.getDerivedBodyMass(f.entity)).toBeCloseTo(28, 5);
    const refused = f.physics.prepareDerivedShapeCandidate(source(2, true)).unwrap();
    f.physics
      .admitDerivedShapeCandidate(refused, () => err(new Error('refuse paired surface')))
      .unwrap();
    f.world.update(1 / 60).unwrap();
    expect(f.physics.getDerivedPublication(f.entity)).toBe(old);
    expect(f.physics.raw.colliders.len()).toBe(before);
    expect(f.physics.getDerivedBodyMass(f.entity)).toBeCloseTo(28, 5);
    create.mockClear();
    f.physics
      .admitDerivedShapeCandidate(f.physics.prepareDerivedShapeCandidate(source(3, true)).unwrap())
      .unwrap();
    f.world.update(1 / 60).unwrap();
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.physics.raw.colliders.len()).toBe(before);
    expect(f.physics.getDerivedBodyMass(f.entity)).toBeCloseTo(21, 5);
    expect(f.physics.raycast(vec3.create(-1.5, -1, -0.5), vec3.create(0, 1, 0), 4)?.entity).toBe(
      f.entity,
    );
    expect(f.physics.raycast(vec3.create(3.5, -1, 0.5), vec3.create(0, 1, 0), 4)).toBeUndefined();
    const prepared = f.physics.prepareDerivedShapeCandidate(source(5, true)).unwrap();
    f.physics
      .admitDerivedShapeCandidate(f.physics.prepareDerivedShapeCandidate(source(4)).unwrap())
      .unwrap();
    f.world.update(1 / 60).unwrap();
    expect(f.physics.admitDerivedShapeCandidate(prepared)).toMatchObject({
      ok: false,
      error: { code: 'derived-candidate-stale' },
    });
    expect(f.physics.raw.colliders.len()).toBe(before);
  } finally {
    create.mockRestore();
    await f.dispose();
  }
});

it('does not retain a changed sensor policy even when the producer repeats a shape revision', async () => {
  const f = await fixture(),
    create = vi.spyOn(f.physics.raw, 'createColliderFromVoxelEdits');
  try {
    const first = input(f.entity, f.world, 0);
    f.physics
      .admitDerivedShapeCandidate(f.physics.prepareDerivedShapeCandidate(first).unwrap())
      .unwrap();
    f.world.update(1 / 60).unwrap();
    create.mockClear();
    const next = {
      ...first,
      revision: 1,
      shapes: first.shapes.map((shape) => ({ ...shape, isSensor: true })),
    };
    f.physics
      .admitDerivedShapeCandidate(f.physics.prepareDerivedShapeCandidate(next).unwrap())
      .unwrap();
    f.world.update(1 / 60).unwrap();
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.physics.captureDerivedPhysicsState().bodies[0]?.shapes[0]?.isSensor).toBe(true);
    const sensors: boolean[] = [];
    f.physics.raw.forEachCollider((c: { isSensor(): boolean }) => sensors.push(c.isSensor()));
    expect(sensors).toEqual([true]);
  } finally {
    create.mockRestore();
    await f.dispose();
  }
});
