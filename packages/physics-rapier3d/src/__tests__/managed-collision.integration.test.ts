import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import { expect, it, vi } from 'vitest';
import { samplerContribution } from '../../../render/src/assets/asset-decoders';
import type { RigidBody as NativeBody, Collider as NativeCollider } from '../../pkg/rapier.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d';
import { loadRapier3D } from '../wasm-loader';

async function fixture() {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  for (const token of [Transform, GlobalTransform, Terrain])
    world.components.register(token).unwrap();
  registerPhysicsComponents(world);
  const physics = createRapier3DPhysicsWorld(await loadRapier3D());
  const sync = () => physics._syncFromEcs(world, Transform, GlobalTransform);
  const step = () => {
    sync();
    physics.step(1 / 60);
  };
  return { assets, world, physics, sync, step };
}

function body(physics: ReturnType<typeof createRapier3DPhysicsWorld>, entity: number): NativeBody {
  let result: NativeBody | undefined;
  physics.raw.forEachRigidBody((value: NativeBody) => {
    if (value.userData === entity) result = value;
  });
  if (result === undefined) throw new Error('missing native body');
  return result;
}

it('adopts one Mesh root for 512 instances without recreating colliders and retains a fixed native shape', async () => {
  const { assets, world, physics, step, sync } = await fixture();
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const entities = Array.from({ length: 512 }, (_, i) =>
    world
      .spawn(
        { component: Transform, data: { pos: [i * 5, 0, 0] } },
        { component: Collider, data: { shape: ColliderShapeValue.trimesh, mesh } },
      )
      .unwrap(),
  );
  try {
    step();
    const collider: NativeCollider = body(physics, entities[0] as number).collider(0);
    const handle = collider.handle;
    const fixed = collider.shape;
    const create = vi.spyOn(physics.raw, 'createCollider');
    const replace = vi.spyOn(physics.raw.colliders, 'replaceSharedGeometry');
    const read = vi.spyOn(world, 'get');
    assets.replace(mesh, createBoxGeometry(3, 2, 1).unwrap()).unwrap();
    step();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(collider.handle).toBe(handle);
    expect(
      physics.raycast(vec3.create(1.25, 4, 0), vec3.create(0, -1, 0), 8)?.point[1],
    ).toBeCloseTo(1);
    expect(
      fixed.castRay(
        new (await loadRapier3D()).Ray({ x: 1.25, y: 4, z: 0 }, { x: 0, y: -1, z: 0 }),
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0, w: 1 },
        8,
        true,
      ),
    ).toBe(-1);
    for (let i = 0; i < 60; i++) sync();
    expect(replace).toHaveBeenCalledTimes(1);
    create.mockRestore();
    replace.mockRestore();
    read.mockRestore();
  } finally {
    physics.dispose();
    assets.dispose();
  }
});

it('same-identity sleeping dynamic hull edits update mass and integrate while retaining body/collider identities', async () => {
  const { assets, world, physics, step } = await fixture();
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: RigidBody,
        data: { type: RigidBodyTypeValue.dynamic, gravityScale: 0, mass: 0 },
      },
      { component: Collider, data: { shape: ColliderShapeValue.convexHull, mesh, density: 2 } },
    )
    .unwrap();
  try {
    step();
    const native = body(physics, entity),
      collider = native.collider(0).handle;
    expect(native.mass()).toBeCloseTo(2);
    native.sleep();
    assets.replace(mesh, createBoxGeometry(2, 3, 4).unwrap()).unwrap();
    step();
    expect(native.mass()).toBeCloseTo(48);
    expect(native.isSleeping()).toBe(false);
    expect(native.collider(0).handle).toBe(collider);
    expect(native.translation()).toEqual({ x: 0, y: 0, z: 0 });
  } finally {
    physics.dispose();
    assets.dispose();
  }
});

it('shared Terrain height and spacing edits change real collision once without entity scans or origin fanout', async () => {
  const { assets, world, physics, step } = await fixture();
  const material = assets
    .create({
      kind: 'material',
      values: {},
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    })
    .unwrap();
  const terrain = assets
    .create({
      kind: 'terrain',
      columns: 2,
      rows: 2,
      spacing: 1,
      subsectionVertices: 2,
      heights: new Float32Array([0, 0, 0, 1]),
      weights: new Float32Array(4).fill(1),
      layers: [{ material, blend: 'weight' }],
    })
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: Terrain, data: { asset: terrain } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    )
    .unwrap();
  world
    .set(entity, GlobalTransform, {
      world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    })
    .unwrap();
  try {
    const version = () => {
      const snapshot = assets.snapshot(terrain).unwrap();
      const result = snapshot.version(terrain).unwrap();
      snapshot.dispose();
      return result;
    };
    expect(physics.getTerrainAssetVersion(entity)).toBeUndefined();
    step();
    const firstVersion = version();
    expect(physics.getTerrainAssetVersion(entity)).toEqual({
      asset: terrain,
      version: firstVersion,
    });
    const native = body(physics, entity),
      collider = native.collider(0).handle;
    const create = vi.spyOn(physics.raw, 'createCollider');
    const replace = vi.spyOn(physics.raw.colliders, 'replaceSharedGeometry');
    const read = vi.spyOn(world, 'get');
    assets.update(terrain, { heights: new Float32Array([2, 2, 2, 3]), spacing: 2 }).unwrap();
    expect(physics.getTerrainAssetVersion(entity)).toEqual({
      asset: terrain,
      version: firstVersion,
    });
    step();
    expect(physics.getTerrainAssetVersion(entity)).toEqual({ asset: terrain, version: version() });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(native.collider(0).handle).toBe(collider);
    expect(
      physics.raycast(vec3.create(1.8, 8, 1.8), vec3.create(0, -1, 0), 10)?.point[1],
    ).toBeCloseTo(2.8, 4);
    create.mockRestore();
    replace.mockRestore();
    read.mockRestore();
    world.removeComponent(entity, Terrain).unwrap();
    step();
    expect(native.numColliders()).toBe(0);
    expect(physics.getTerrainAssetVersion(entity)).toBeUndefined();
    expect(physics.raycast(vec3.create(1.8, 8, 1.8), vec3.create(0, -1, 0), 10)).toBeUndefined();
  } finally {
    physics.dispose();
    assets.dispose();
  }
});

it('sends only changed Terrain samples to native geometry while keeping old captured shapes fixed', async () => {
  const { assets, world, physics, step } = await fixture();
  const material = assets
    .create({
      kind: 'material',
      values: {},
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    })
    .unwrap();
  const n = 32,
    columns = 63,
    rows = 32;
  const terrain = assets
    .create({
      kind: 'terrain',
      columns,
      rows,
      spacing: 1,
      subsectionVertices: n,
      heights: new Float32Array(columns * rows),
      weights: new Float32Array(columns * rows).fill(1),
      layers: [{ material, blend: 'weight' }],
    })
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: Terrain, data: { asset: terrain } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    )
    .unwrap();
  try {
    step();
    const native = body(physics, entity),
      collider = native.collider(0),
      previous = collider.shape;
    const replace = vi.spyOn(physics.raw.colliders, 'replaceSharedGeometry');
    const range = vi.spyOn(physics.raw.colliders, 'writeSharedHeightfield');
    const create = vi.spyOn(physics.raw, 'createCollider');
    assets
      .writeRange(terrain, {
        origin: { x: 10, z: 10 },
        size: { columns: 2, rows: 2 },
        heights: Float32Array.of(3, 3, 3, 3),
      })
      .unwrap();
    assets
      .writeRange(terrain, {
        origin: { x: 50, z: 20 },
        size: { columns: 1, rows: 1 },
        heights: Float32Array.of(5),
      })
      .unwrap();
    const beforeVersion = physics.getTerrainAssetVersion(entity);
    range.mockReturnValueOnce(false);
    expect(() => step()).toThrow();
    expect(physics.getTerrainAssetVersion(entity)).toEqual(beforeVersion);
    range.mockClear();
    step();
    const snapshot = assets.snapshot(terrain).unwrap();
    expect(physics.getTerrainAssetVersion(entity)).toEqual({
      asset: terrain,
      version: snapshot.version(terrain).unwrap(),
    });
    snapshot.dispose();
    expect(range).toHaveBeenCalledTimes(1);
    expect(range.mock.calls[0]?.[1]).toEqual(
      Uint32Array.of(
        10 * rows + 10,
        11 * rows + 10,
        10 * rows + 11,
        11 * rows + 11,
        50 * rows + 20,
      ),
    );
    expect(range.mock.calls[0]?.[2]).toEqual(Float32Array.of(3, 3, 3, 3, 5));
    expect(replace).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(native.collider(0).handle).toBe(collider.handle);
    expect(
      physics.raycast(vec3.create(10.5, 8, 10.5), vec3.create(0, -1, 0), 10)?.point[1],
    ).toBeCloseTo(3, 4);
    const RAPIER = await loadRapier3D();
    expect(
      previous.castRay(
        new RAPIER.Ray({ x: 10.5, y: 8, z: 10.5 }, { x: 0, y: -1, z: 0 }),
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0, w: 1 },
        10,
        true,
      ),
    ).toBeCloseTo(8);
    for (let i = 0; i < 60; i++) step();
    expect(range).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    create.mockRestore();
    range.mockRestore();
    replace.mockRestore();
  } finally {
    physics.dispose();
    assets.dispose();
  }
});
