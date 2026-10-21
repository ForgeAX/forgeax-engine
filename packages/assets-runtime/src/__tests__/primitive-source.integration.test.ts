import { createPrimitiveMesh, meshAssetContribution } from '@forgeax/engine-geometry';
import { BUILTIN_MESH_ASSETS } from '@forgeax/engine-pack/builtin';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { assert, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';

it('loads every delivered builtin GUID through the ordinary Catalog and Mesh decoder', async () => {
  const packageUrl = 'https://assets.invalid/primitives.pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'primitives',
    sourceRevision: '1',
    packageUrl,
    pack: {
      assets: BUILTIN_MESH_ASSETS.map(({ guid, geometry }) => ({
        guid,
        kind: 'mesh',
        payload: { kind: 'mesh', geometry },
        refs: [],
        artifacts: {},
      })),
    },
  });
  const fetch = vi.fn(async () => Response.json(publication.pack));
  const assets = new AssetRegistry({
    catalog: createCatalogSource({
      entries: BUILTIN_MESH_ASSETS.map(({ guid }) => ({
        guid,
        kind: 'mesh',
        packageUrl,
        sourcePath: 'primitives',
        publication: publication.publication,
      })),
      fetch,
    }),
  });
  assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  const foreign = new AssetRegistry();
  try {
    for (const { guid, geometry } of BUILTIN_MESH_ASSETS) {
      const handle = (await assets.load(guid, 'mesh')).unwrap();
      const mesh = assets.read(handle).unwrap();
      const expected = createPrimitiveMesh(
        geometry.replace('procedural-', '') as Parameters<typeof createPrimitiveMesh>[0],
      ).unwrap();
      expect(mesh.vertices).toEqual(expected.vertices);
      expect(mesh.indices).toEqual(expected.indices);
      expect(mesh.aabb).toEqual(expected.aabb);
      expect((await assets.load(guid, 'mesh')).unwrap()).toBe(handle);
      expect(assets.guidOf(handle)).toBe(guid);
      expect(foreign.read(handle).ok).toBe(false);
      const independent = assets.create(mesh).unwrap();
      expect(independent).not.toBe(handle);
      expect(assets.guidOf(independent)).toBeUndefined();
      assets.release(independent).unwrap();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await assets.load('00000000-0000-7000-8000-000000000000', 'mesh')).ok).toBe(false);
  } finally {
    assets.dispose();
    foreign.dispose();
  }
});

it('creates primitives without a source while GUID loads require a delivered catalog', async () => {
  const assets = new AssetRegistry();
  try {
    const mesh = assets.create(createPrimitiveMesh('nine-slice-quad').unwrap()).unwrap();
    const payload = assets.read(mesh).unwrap();
    expect(payload.vertices.length / 12).toBe(16);
    expect(payload.indices?.length).toBe(54);
    expect(payload.vertices.byteLength / (payload.vertices.length / 12)).toBe(12 * 4);
    const builtin = BUILTIN_MESH_ASSETS[0];
    assert(builtin);
    expect((await assets.load(builtin.guid, 'mesh')).ok).toBe(false);
    assets.release(mesh).unwrap();
    expect(assets.read(mesh).ok).toBe(false);
  } finally {
    assets.dispose();
  }
});
