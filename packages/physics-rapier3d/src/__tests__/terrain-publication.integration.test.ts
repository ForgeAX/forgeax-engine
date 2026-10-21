import { vec3 } from '@forgeax/engine-math';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { createRapier3DPhysicsWorld, loadRapier3D } from '@forgeax/engine-physics-rapier3d';
import { terrainHeightfield } from '@forgeax/engine-terrain';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import {
  type Asset,
  type CatalogEntry,
  standardSurfaceParameters,
  type TerrainAsset,
} from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { terrainSourceFixture } from '../../../assets-runtime/src/__tests__/fixtures/terrain-source';

function sourceGuid(value: string | number): string {
  if (typeof value !== 'string') throw new Error('expected source GUID');
  return value;
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected defined value');
  return value;
}

it.each([
  { kind: 'weights' as const },
  { kind: 'ids' as const, maxWeightError: 0 },
])('rejects invalid terrain candidates while retaining the root and collider: %j', async (encoding) => {
  const packageId = definePackageId('019fca53-7400-7000-8000-000000000021');
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
  const layer: Asset = {
    kind: 'material',
    parameters: standardSurfaceParameters([]),
    values: { baseColor: [1, 1, 1, 1] },
    passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
  };
  const cook = (heights: number[]) =>
    buildTerrainAssets(
      {
        columns: 3,
        rows: 2,
        spacing: 1,
        subsectionVertices: 2,
        heights: Float32Array.from(heights),
        weights: new Float32Array(6).fill(1),
        layers: [{ material: guid('layer'), blend: 'weight' }],
      },
      guid,
      { [guid('layer')]: layer },
      encoding,
    ).unwrap();
  const oldOutputs = cook([0, 0, 0, 0, 1, 1]);
  const newOutputs = cook([0, 1, 1, 0, 1, 1]);
  const source = terrainSourceFixture(guid);
  const { assets: registry, fetcher } = source;
  const accepted = source.publish({ layer, ...oldOutputs });
  const handle = (await registry.load(guid('terrain'), 'terrain')).unwrap();
  const runtimeRoot = registry.read(handle).unwrap();
  const oldRoot = oldOutputs.terrain as TerrainAsset;
  const fixed = registry.snapshot(handle).unwrap();
  const dependencies = new Map<string, { asset: Asset; row: CatalogEntry }>();
  for (const [key, asset] of Object.entries({ layer, ...oldOutputs })) {
    if (key === 'terrain') continue;
    dependencies.set(guid(key), {
      asset,
      row: defined(accepted.rows.find((row) => row.guid === guid(key))),
    });
  }
  const makePublication = (root: TerrainAsset, sourceRevision: string) =>
    source.publication({ terrain: root }, sourceRevision);

  const entity = 1;
  const physics = createRapier3DPhysicsWorld(await loadRapier3D());
  const step = () => {
    physics.step(1 / 60);
    physics.finalizeDerivedFixedStep();
  };
  const ray = () => physics.raycast(vec3.create(0.8, 5, 0.4), vec3.create(0, -1, 0), 10);
  try {
    physics.ensureBody(
      entity,
      {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      { type: 0, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
      undefined,
    );
    const shape = terrainHeightfield(runtimeRoot);
    physics
      .admitDerivedShapeCandidate(
        physics
          .prepareDerivedShapeCandidate({
            entity,
            sourceKey: 'accepted-terrain',
            revision: 1,
            bodyType: 'static',
            shapes: [
              {
                kind: 'heightfield',
                id: 'accepted-terrain',
                revision: 1,
                rows: shape.rows,
                columns: shape.columns,
                heights: shape.heights,
                scale: shape.scale,
                origin: shape.origin,
              },
            ],
          })
          .unwrap(),
      )
      .unwrap();
    step();
    expect(ray()?.point[1]).toBeCloseTo(0.2, 5);
    const acceptedPhysics = physics.getDerivedPublication(entity);
    expect(fixed.matchesCurrent()).toBe(true);

    // Positive control goes through the actual Terrain domain loader and fixed dependency path.
    const valid = makePublication(oldRoot, 'unchanged');
    const prepared = (
      await registry.preparePublication(valid.rows, fetcher, undefined, {
        pack: valid.pack,
        dependencies,
      })
    ).unwrap();
    const read = defined(prepared.get(guid('terrain')));
    const staged = (typeof read === 'function' ? await read() : read) as TerrainAsset;
    expect(staged.heights).toBeInstanceOf(Float32Array);
    expect(Array.from(staged.heights)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(registry.read(handle).unwrap()).toEqual(runtimeRoot);

    // This is a valid new author root, but its same-GUID retained height bytes describe the old surface.
    const invalid = makePublication(newOutputs.terrain as TerrainAsset, 'changed-author');
    expect(
      await registry.preparePublication(invalid.rows, fetcher, undefined, {
        pack: invalid.pack,
        dependencies,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'asset-parse-failed',
        hint: expect.stringContaining('terrain derived geometry/height/control/layer closure'),
      },
    });
    expect(() => registry.commitPreparedPublication(invalid.pack)).toThrow();
    const invalidControls = makePublication(
      { ...oldRoot, weights: new Float32Array(6) },
      'changed-weights',
    );
    expect(
      await registry.preparePublication(invalidControls.rows, fetcher, undefined, {
        pack: invalidControls.pack,
        dependencies,
      }),
    ).toMatchObject({ ok: false, error: { code: 'asset-parse-failed' } });
    expect(() => registry.commitPreparedPublication(invalidControls.pack)).toThrow();
    if (encoding.kind === 'ids') {
      const materialGuid = sourceGuid(defined(oldRoot.sections[1]).material);
      const retained = defined(dependencies.get(materialGuid));
      if (retained.asset.kind !== 'material' || retained.asset.parent !== undefined)
        throw new Error('expected root material');
      const aliased = new Map(dependencies);
      aliased.set(materialGuid, {
        ...retained,
        asset: {
          ...retained.asset,
          values: {
            ...retained.asset.values,
            terrainLayerIndices: [0, 0, 0, 0],
          },
        },
      });
      const aliasCandidate = makePublication(oldRoot, 'invalid-layer-indices');
      expect(
        await registry.preparePublication(aliasCandidate.rows, fetcher, undefined, {
          pack: aliasCandidate.pack,
          dependencies: aliased,
        }),
      ).toMatchObject({ ok: false, error: { code: 'asset-parse-failed' } });
      expect(() => registry.commitPreparedPublication(aliasCandidate.pack)).toThrow();
    }
    expect(registry.read(handle).unwrap()).toEqual(runtimeRoot);
    expect((await registry.load(guid('terrain'), 'terrain')).unwrap()).toBe(handle);
    expect(fixed.matchesCurrent()).toBe(true);
    step();
    expect(physics.getDerivedPublication(entity)).toEqual(acceptedPhysics);
    expect(ray()?.point[1]).toBeCloseTo(0.2, 5);
  } finally {
    physics.dispose();
    fixed.dispose();
    registry.dispose();
  }
});
