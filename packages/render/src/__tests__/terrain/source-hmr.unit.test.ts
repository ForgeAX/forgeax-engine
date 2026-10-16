import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { Terrain, terrainSurfaceVertex } from '@forgeax/engine-terrain';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import {
  type MaterialAsset,
  type MeshAsset,
  standardSurfaceParameters,
  type TerrainAsset,
  type TextureAsset,
} from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { Layer } from '../../components/layer.js';
import { ShadowParticipation } from '../../components/shadow-participation.js';
import type {
  DispatchEntry,
  ExtractedFrame,
  RenderableSnapshot,
} from '../../render-system-extract.js';
import { extractTerrainSources } from '../../terrain/source.js';
import { projectTerrainView } from '../../terrain/view.js';

function fixture(grid = { columns: 2, rows: 2, spacing: 1, subsectionVertices: 2 }) {
  const packageId = definePackageId('019fca53-7400-7000-8000-000000000001');
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
  const material: MaterialAsset = {
    kind: 'material',
    parameters: standardSurfaceParameters([]),
    values: { baseColor: [1, 1, 1, 1] },
    passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
  };
  const outputs = (heights: readonly number[]) =>
    buildTerrainAssets(
      {
        ...grid,
        heights: Float32Array.from(heights),
        weights: new Float32Array(grid.columns * grid.rows).fill(1),
        layers: [{ material: guid('layer'), blend: 'weight' }],
      },
      guid,
      { [guid('layer')]: material },
    ).unwrap();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  assets.catalog(guid('layer'), material).unwrap();
  const adopt = (heights: readonly number[]) => {
    for (const [key, asset] of Object.entries(outputs(heights)))
      assets.catalog(guid(key), asset).unwrap();
    const root = assets.lookup<TerrainAsset>(guid('terrain'));
    if (root === undefined) throw new Error('missing adopted Terrain root');
    return root;
  };
  const heights = new Array<number>(grid.columns * grid.rows).fill(0);
  heights[heights.length - 1] = 1;
  const initial = adopt(heights);
  const world = new World();
  for (const component of [Terrain, Transform, GlobalTransform, Layer, ShadowParticipation])
    world.components.register(component).unwrap();
  const handle = world.sharedRefs.acquire('TerrainAsset', initial);
  const entity = world
    .spawn(
      { component: Terrain, data: { asset: handle } },
      { component: Transform, data: { pos: [0, 0, 0] } },
    )
    .unwrap();
  world.sharedRefs.release(handle).unwrap();
  const extract = () => {
    const sources: RenderableSnapshot[] = [],
      dispatch: DispatchEntry[] = [];
    extractTerrainSources(world, assets, undefined, 0, sources, dispatch);
    return { sources, dispatch };
  };
  const bind = (root: TerrainAsset) => {
    const next = world.sharedRefs.acquire('TerrainAsset', root);
    try {
      world.set(entity, Terrain, { ...world.get(entity, Terrain).unwrap(), asset: next }).unwrap();
    } finally {
      world.sharedRefs.release(next).unwrap();
    }
    return next;
  };
  return { assets, world, entity, initial, guid, adopt, extract, bind };
}

it('isolates the ordinary Catalog loading window and resumes only after the coherent new root binds', () => {
  const f = fixture();
  expect(f.extract().sources).toHaveLength(1);
  f.assets.invalidate(f.guid('terrain'));
  expect(f.world.sharedRefs.resolve(f.world.get(f.entity, Terrain).unwrap().asset).unwrap()).toBe(
    f.initial,
  );
  expect(f.extract()).toEqual({ sources: [], dispatch: [] });
  const next = f.adopt([1, 1, 1, 2]);
  expect(f.assets.terrainClosureCurrent(next)).toBe(true);
  expect(f.extract().sources).toHaveLength(0);
  const handle = f.bind(next);
  expect(f.extract().sources[0]?.terrain?.asset).toBe(next);
  // A retry may hit the same immutable payload and handle; its producer grant is still owned.
  expect(f.bind(next)).toBe(handle);
  expect(f.world.sharedRefs.refcount(handle)).toBe(1);
  expect(f.world.sharedRefs.resolve(handle).unwrap()).toBe(next);
});

it('keeps the root GPU bounds conservative across f32 decode cancellation', () => {
  const f = fixture();
  f.bind(f.adopt([-1e8, -0.1, -1e8, -0.1]));
  const source = f.extract().sources[0];
  if (source?.localAabb === undefined) throw new Error('missing admitted terrain bounds');
  // Preserve conservative bounds even though the endpoint decoder avoids min/span cancellation.
  const decoded = Math.fround(Math.fround(-1e8) + Math.fround(1e8 - Math.fround(0.1)));
  expect(decoded).toBe(0);
  expect(source.localAabb[1]).toBeLessThanOrEqual(-1e8);
  expect(source.localAabb[4]).toBeGreaterThanOrEqual(decoded);
});

it.each([
  { n: 2, spacing: 0.3 },
  { n: 128, spacing: 1.3 },
])('encloses two-stage f32 XZ endpoints in actual root and section bounds ($n, $spacing)', ({
  n,
  spacing,
}) => {
  const columns = 3 * (n - 1) + 1;
  const f = fixture({ columns, rows: n, spacing, subsectionVertices: n });
  f.world.set(f.entity, Terrain, { forcedLod: 0 }).unwrap();
  const source = f.extract().sources[0];
  if (source?.localAabb === undefined) throw new Error('missing terrain bounds');
  const projected = projectTerrainView(
    { renderables: [source], dispatch: [], cameras: [{}] } as unknown as ExtractedFrame,
    new Map(),
  );
  const section = f.initial.sections[2];
  const texture = f.assets.lookup<TextureAsset>(section?.heightTexture ?? '');
  const draw = projected.renderables[2];
  if (section === undefined || texture === undefined || draw?.localAabb === undefined)
    throw new Error('missing last section');
  const vertex = terrainSurfaceVertex(
    {
      vertices: n,
      width: (n - 1) * spacing,
      lod: 0,
      neighbors: [0, 0, 0, 0],
      heightRange: f.initial.heightRange,
      heights: texture.data,
    },
    n - 1,
    n - 1,
    [section.x, section.z],
  );
  expect(Math.fround((columns - 1) * spacing)).toBeLessThan(vertex[0]);
  expect(source.localAabb[3]).toBeGreaterThanOrEqual(vertex[0]);
  expect(draw.localAabb[3]).toBeGreaterThanOrEqual(vertex[0]);
  expect(draw.localAabb[5]).toBeGreaterThanOrEqual(vertex[2]);
});

it.each([
  'heightTexture',
  'weightTexture',
] as const)('isolates a partial same-GUID %s rewrite instead of repinning its old root', (field) => {
  const f = fixture();
  const section = f.initial.sections[0];
  if (section === undefined) throw new Error('missing Terrain section');
  const height = f.assets.lookup<TextureAsset>(section[field]);
  if (height === undefined) throw new Error('missing height texture');
  f.assets
    .catalog(section[field], { ...height, data: new Uint8Array(height.data).fill(255) })
    .unwrap();
  expect(f.assets.lookup(f.guid('terrain'))).toBe(f.initial);
  expect(f.assets.terrainClosureCurrent(f.initial)).toBe(false);
  expect(f.extract()).toEqual({ sources: [], dispatch: [] });
  expect(f.assets.catalog(f.guid('terrain'), { ...f.initial }).ok).toBe(false);
  expect(f.extract().sources).toHaveLength(0);
  f.bind(f.adopt([1, 1, 1, 2]));
  expect(f.extract().sources).toHaveLength(1);
});

it('keeps never-catalogued Terrain input and an unsupported coherent pose as explicit failures', () => {
  const f = fixture();
  f.bind({ ...f.initial });
  expect(f.extract).toThrow(expect.objectContaining({ code: 'terrain-query-unavailable' }));
  f.bind(f.initial);
  f.world
    .set(f.entity, GlobalTransform, {
      world: new Float32Array([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    })
    .unwrap();
  expect(f.extract).toThrow(expect.objectContaining({ code: 'terrain-pose-unsupported' }));
});

it('rejects a fresh root whose same-GUID grid changed the exact submitted diagonal', () => {
  const f = fixture();
  const guid = f.initial.grids[0];
  if (guid === undefined) throw new Error('missing Terrain grid');
  const grid = f.assets.lookup<MeshAsset>(guid);
  if (grid === undefined) throw new Error('missing Terrain grid mesh');
  // Legal Mesh topology, but the 00->11 diagonal produces height .5 at the center
  // of [0, 0, 0, 1], while Terrain physics and submitted queries both require 0.
  f.assets.catalog(guid, { ...grid, indices: new Uint32Array([0, 2, 3, 0, 3, 1]) }).unwrap();
  expect(f.assets.catalog(f.guid('terrain'), { ...f.initial }).ok).toBe(false);
  expect(f.assets.lookup(f.guid('terrain'))).toBe(f.initial);
  expect(f.extract().sources).toHaveLength(0);
});

it.each([
  'tiny-scale',
  'world-overflow',
] as const)('rejects %s before publishing a Terrain source', (mode) => {
  const f = fixture();
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  if (mode === 'tiny-scale') matrix[0] = 1.0000001;
  else {
    f.bind(f.adopt([-1e38, 1e38, -1e38, 1e38]));
    matrix[13] = 3e38;
  }
  f.world.set(f.entity, GlobalTransform, { world: matrix }).unwrap();
  expect(f.extract).toThrow(expect.objectContaining({ code: 'terrain-pose-unsupported' }));
});

it.each([
  'terrainHeightTexture',
  'terrainWeightTexture',
] as const)('rejects a fresh root whose section material redirects %s away from its author closure', (binding) => {
  const f = fixture();
  const section = f.initial.sections[0];
  if (section === undefined) throw new Error('missing Terrain section');
  const texture = f.assets.lookup<TextureAsset>(
    binding === 'terrainHeightTexture' ? section.heightTexture : section.weightTexture,
  );
  const material = f.assets.lookup<MaterialAsset>(section.material);
  if (texture === undefined || material === undefined) throw new Error('missing section closure');
  const alternate = f.guid('alternate-texture');
  f.assets
    .catalog(alternate, { ...texture, data: new Uint8Array(texture.data).fill(255) })
    .unwrap();
  f.assets
    .catalog(section.material, {
      ...material,
      values: {
        ...material.values,
        [binding]:
          binding === 'terrainHeightTexture'
            ? alternate
            : { texture: alternate, sampler: f.guid('control-sampler') },
      },
    })
    .unwrap();
  expect(f.assets.catalog(f.guid('terrain'), { ...f.initial }).ok).toBe(false);
  expect(f.assets.lookup(f.guid('terrain'))).toBe(f.initial);
  expect(f.extract().sources).toHaveLength(0);
});
