import { type EntityHandle, World } from '@forgeax/engine-ecs';
import {
  DirectionalLight,
  extractVolumetricFog,
  MAX_VOLUMETRIC_FOG_OWNERS,
  VolumetricFog,
  type VolumetricFogAuthoring,
  VolumetricFogSamplingValue,
} from '@forgeax/engine-render';
import type { Handle, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const DENSITY_GUID = 'cpu-fixture-density';

function densityAsset(): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array([16, 32, 48, 64, 80, 96, 112, 128]),
  };
}

function tuple3(value: ArrayLike<number>): readonly [number, number, number] {
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
}

function authorings(world: World): VolumetricFogAuthoring[] {
  const query = world.query({ read: [VolumetricFog] }).unwrap();
  const result: VolumetricFogAuthoring[] = [];
  for (const row of query) {
    const source = row.get(VolumetricFog);
    if (source.light === null) throw new Error('fixture VolumetricFog has no selected light');
    if (source.density === null) throw new Error('fixture VolumetricFog has no density handle');
    const resolved = world.sharedRefs.resolve(source.density);
    if (!resolved.ok) throw resolved.error;
    const asset = resolved.value as TextureAsset;
    if (asset.shape.viewDimension !== '3d') throw new Error('fixture density must be 3D');

    result.push({
      light: source.light,
      ...(source.spotLight === null ? {} : { spotLight: source.spotLight }),
      density: {
        guid: DENSITY_GUID,
        generation: 1,
        shape: {
          viewDimension: '3d',
          extent: {
            width: asset.shape.extent.width,
            height: asset.shape.extent.height,
            depth: asset.shape.extent.depth,
          },
        },
        format: asset.format,
        colorSpace: asset.colorSpace,
      },
      bounds: { min: tuple3(source.boundsMin), max: tuple3(source.boundsMax) },
      extinction: tuple3(source.extinction),
      albedo: tuple3(source.albedo),
      emission: tuple3(source.emission),
      anisotropy: source.anisotropy,
      maxDistance: source.maxDistance,
      sampling: source.sampling === VolumetricFogSamplingValue.density ? 'density' : 'noise',
    });
  }
  return result;
}

function worldOwnerSnapshot(world: World, densityHandle: Handle<'TextureAsset', 'shared'>) {
  const query = world.query({ read: [VolumetricFog] }).unwrap();
  return {
    owners: Array.from(query, (row) => {
      const owner = row.get(VolumetricFog);
      return {
        entity: Number(row.entity),
        light: Number(owner.light),
        density: Number(owner.density),
        boundsMin: Array.from(owner.boundsMin),
        boundsMax: Array.from(owner.boundsMax),
        extinction: Array.from(owner.extinction),
        albedo: Array.from(owner.albedo),
        emission: Array.from(owner.emission),
        anisotropy: owner.anisotropy,
        maxDistance: owner.maxDistance,
        sampling: owner.sampling,
      };
    }),
    densityRefcount: world.sharedRefs.refcount(densityHandle),
  };
}

function spawnOwner(
  world: World,
  light: EntityHandle,
  densityHandle: Handle<'TextureAsset', 'shared'>,
): EntityHandle {
  return world
    .spawn({
      component: VolumetricFog,
      data: {
        light,
        density: densityHandle,
        boundsMin: [-1, -1, -1],
        boundsMax: [1, 1, 1],
        extinction: [0.2, 0.2, 0.2],
        albedo: [0.8, 0.8, 0.8],
        emission: [0, 0, 0],
        anisotropy: 0,
        maxDistance: 50,
        sampling: VolumetricFogSamplingValue.density,
      },
    })
    .unwrap();
}

function createWorldFixture() {
  const world = new World();
  const densityHandle = world.allocSharedRef('TextureAsset', densityAsset());
  const light = world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 },
    })
    .unwrap();
  return { world, densityHandle, light };
}

describe('public volumetric fog owner CPU contract', () => {
  it('accepts eight owners, rejects the ninth, and reuses capacity after despawn', () => {
    const { world, densityHandle, light } = createWorldFixture();
    const ownerEntities: EntityHandle[] = [];
    for (let index = 0; index < MAX_VOLUMETRIC_FOG_OWNERS; index += 1) {
      ownerEntities.push(spawnOwner(world, light, densityHandle));
    }

    const accepted = authorings(world);
    const acceptedResult = extractVolumetricFog(accepted);
    expect(acceptedResult.ok).toBe(true);
    if (!acceptedResult.ok) throw acceptedResult.error;
    expect(acceptedResult.value.status).toBe('available');
    if (acceptedResult.value.status !== 'available') {
      throw new Error('eight live owners must extract as available');
    }
    expect(acceptedResult.value.fogs).toHaveLength(MAX_VOLUMETRIC_FOG_OWNERS);

    const ninthEntity = spawnOwner(world, light, densityHandle);
    const nineLiveOwners = authorings(world);
    expect(nineLiveOwners).toHaveLength(9);
    const stateBeforeRejection = worldOwnerSnapshot(world, densityHandle);
    const rejected = extractVolumetricFog(nineLiveOwners);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toMatchObject({
        code: 'volume-owner-conflict',
        expected: expect.any(String),
        hint: expect.any(String),
        detail: { ownerCount: 9 },
      });
    }
    expect(worldOwnerSnapshot(world, densityHandle)).toEqual(stateBeforeRejection);

    world.despawn(ninthEntity).unwrap();
    const acceptedAfterDestroy = extractVolumetricFog(authorings(world));
    expect(acceptedAfterDestroy.ok).toBe(true);
    if (!acceptedAfterDestroy.ok) throw acceptedAfterDestroy.error;
    expect(acceptedAfterDestroy.value.status).toBe('available');
    if (acceptedAfterDestroy.value.status !== 'available') {
      throw new Error('eight live owners must remain available after destroying the ninth');
    }
    expect(acceptedAfterDestroy.value.fogs).toHaveLength(MAX_VOLUMETRIC_FOG_OWNERS);
    expect(world.sharedRefs.refcount(densityHandle)).toBe(9);

    const destroyed = ownerEntities[3];
    if (destroyed === undefined) throw new Error('fixture has no owner to despawn');
    world.despawn(destroyed).unwrap();
    expect(authorings(world)).toHaveLength(7);
    expect(world.sharedRefs.refcount(densityHandle)).toBe(8);

    spawnOwner(world, light, densityHandle);
    const readmitted = extractVolumetricFog(authorings(world));
    expect(readmitted.ok).toBe(true);
    if (!readmitted.ok) throw readmitted.error;
    expect(readmitted.value.status).toBe('available');
    if (readmitted.value.status !== 'available') {
      throw new Error('eight owners must be available after capacity is reused');
    }
    expect(readmitted.value.fogs).toHaveLength(MAX_VOLUMETRIC_FOG_OWNERS);
    expect(world.sharedRefs.refcount(densityHandle)).toBe(9);
  });

  it('rejects invalid density and bounds without mutating live owners or accepted inputs', () => {
    const { world, densityHandle, light } = createWorldFixture();
    spawnOwner(world, light, densityHandle);
    const accepted = authorings(world);
    const acceptedResult = extractVolumetricFog(accepted);
    expect(acceptedResult.ok).toBe(true);
    if (!acceptedResult.ok) throw acceptedResult.error;
    expect(acceptedResult.value.status).toBe('available');
    if (acceptedResult.value.status !== 'available') {
      throw new Error('one live owner must extract as available');
    }
    const acceptedInputBefore = JSON.stringify(accepted);
    const acceptedProjectionBefore = JSON.stringify(acceptedResult);
    const worldBefore = worldOwnerSnapshot(world, densityHandle);
    const owner = accepted[0];
    if (owner === undefined) throw new Error('fixture has no accepted owner');

    const invalidDensity: VolumetricFogAuthoring = {
      ...owner,
      density: {
        ...owner.density,
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
      },
    };
    const densityRejected = extractVolumetricFog([owner, invalidDensity]);
    expect(densityRejected.ok).toBe(false);
    if (!densityRejected.ok) {
      expect(densityRejected.error.code).toBe('volume-density-shape-mismatch');
    }
    expect(JSON.stringify(accepted)).toBe(acceptedInputBefore);
    expect(JSON.stringify(acceptedResult)).toBe(acceptedProjectionBefore);
    expect(worldOwnerSnapshot(world, densityHandle)).toEqual(worldBefore);

    const invalidBounds: VolumetricFogAuthoring = {
      ...owner,
      bounds: { min: [1, 0, 0], max: [0, 1, 1] },
    };
    const boundsRejected = extractVolumetricFog([owner, invalidBounds]);
    expect(boundsRejected.ok).toBe(false);
    if (!boundsRejected.ok) expect(boundsRejected.error.code).toBe('volume-invalid-bounds');
    expect(JSON.stringify(accepted)).toBe(acceptedInputBefore);
    expect(JSON.stringify(acceptedResult)).toBe(acceptedProjectionBefore);
    expect(worldOwnerSnapshot(world, densityHandle)).toEqual(worldBefore);
  });

  it('rebinds one live owner to a new shared 3D density asset', () => {
    const { world, densityHandle, light } = createWorldFixture();
    const ownerEntity = spawnOwner(world, light, densityHandle);
    const updatedDensity = world.allocSharedRef('TextureAsset', {
      ...densityAsset(),
      data: new Uint8Array(8).fill(255),
    });

    world.set(ownerEntity, VolumetricFog, { density: updatedDensity }).unwrap();

    const ownerRows = world.query({ read: [VolumetricFog] }).unwrap();
    const owner = Array.from(ownerRows, (row) => row.get(VolumetricFog))[0];
    expect(Number(owner?.density)).toBe(Number(updatedDensity));
    expect(world.sharedRefs.refcount(densityHandle)).toBe(1);
    expect(world.sharedRefs.refcount(updatedDensity)).toBe(2);

    const resolvedDensity = world.sharedRefs.resolve<'TextureAsset', TextureAsset>(updatedDensity);
    expect(resolvedDensity.ok).toBe(true);
    if (!resolvedDensity.ok) throw resolvedDensity.error;
    expect(Array.from(resolvedDensity.value.data)).toEqual(new Array(8).fill(255));

    const extracted = extractVolumetricFog(authorings(world));
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) throw extracted.error;
    expect(extracted.value.status).toBe('available');
    if (extracted.value.status !== 'available') {
      throw new Error('the updated owner must remain available to the public extractor');
    }
    expect(extracted.value.fogs).toHaveLength(1);

    world.despawn(ownerEntity).unwrap();
    expect(world.sharedRefs.refcount(updatedDensity)).toBe(1);
  });
});
