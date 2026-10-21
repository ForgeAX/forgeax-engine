import { World } from '@forgeax/engine-ecs';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { Terrain, terrainSurfaceVertex } from '@forgeax/engine-terrain';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import {
  type Asset,
  type AssetHandle,
  type MaterialAsset,
  type MeshAsset,
  standardSurfaceParameters,
  type TerrainAsset,
  type TextureAsset,
} from '@forgeax/engine-types';
import { afterEach, expect, it } from 'vitest';
import { terrainSourceFixture } from '../../../../assets-runtime/src/__tests__/fixtures/terrain-source';
import { Layer } from '../../components/layer.js';
import { ShadowParticipation } from '../../components/shadow-participation.js';
import { worldRenderResources } from '../../publication/resource-scope';
import type {
  DispatchEntry,
  ExtractedFrame,
  RenderableSnapshot,
} from '../../render-system-extract.js';
import { MaterialFrame } from '../../scene/material-dispatch';
import { extractTerrainSources } from '../../terrain/source.js';
import { projectTerrainView } from '../../terrain/view.js';
import { terrainViewPreparation } from './runtime-fixture';

const dispose: (() => void)[] = [];
afterEach(() => {
  for (const fn of dispose.splice(0)) fn();
});

async function fixture(grid = { columns: 2, rows: 2, spacing: 1, subsectionVertices: 2 }) {
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
  const source = terrainSourceFixture(guid);
  const { assets } = source;
  dispose.push(() => assets.dispose());
  const heights = new Array<number>(grid.columns * grid.rows).fill(0);
  heights[heights.length - 1] = 1;
  let sourceAssets: Record<string, Asset> = { layer: material, ...outputs(heights) };
  source.publish(sourceAssets);
  const handle = (await assets.load(guid('terrain'), 'terrain')).unwrap();
  const initial = assets.read(handle).unwrap();
  const publish = (values: Record<string, Asset>) => {
    sourceAssets = values;
    source.publish(values);
  };
  const publishHeights = (values: readonly number[]) =>
    publish({ layer: material, ...outputs(values) });
  const reload = () => assets.reload(handle, { conflict: 'overwrite' });
  const adopt = async (values: readonly number[]) => {
    publishHeights(values);
    (await reload()).unwrap();
    return assets.read(handle).unwrap();
  };
  const sourceRoot = sourceAssets.terrain as TerrainAsset;
  const sourceAsset = <T extends Asset>(sourceGuid: string | number): T => {
    const key = Object.keys(sourceAssets).find((key) => guid(key) === sourceGuid);
    const asset = key === undefined ? undefined : sourceAssets[key];
    if (asset === undefined) throw new Error('missing source closure asset');
    return asset as T;
  };
  const changeSource = (sourceGuid: string | number, asset: Asset) => {
    const key = Object.keys(sourceAssets).find((key) => guid(key) === sourceGuid);
    if (key === undefined) throw new Error('missing source closure key');
    publish({ ...sourceAssets, [key]: asset });
  };
  const world = new World({ assets });
  for (const component of [Terrain, Transform, GlobalTransform, Layer, ShadowParticipation])
    world.components.register(component).unwrap();
  const entity = world
    .spawn(
      { component: Terrain, data: { asset: handle } },
      { component: Transform, data: { pos: [0, 0, 0] } },
    )
    .unwrap();
  const extract = () => {
    const sources: RenderableSnapshot[] = [],
      dispatch: DispatchEntry[] = [];
    extractTerrainSources(world, assets, undefined, 0, sources, dispatch);
    return { sources, dispatch };
  };
  const bind = (root: TerrainAsset) => {
    assets.replace(handle, root).unwrap();
    return handle;
  };
  return {
    assets,
    world,
    entity,
    initial,
    sourceRoot,
    handle,
    guid,
    adopt,
    extract,
    bind,
    publishHeights,
    reload,
    sourceAsset,
    changeSource,
    addSource: (key: string, asset: Asset) => publish({ ...sourceAssets, [key]: asset }),
  };
}

it('keeps bound runtime Terrain stable during source replacement until explicit reload', async () => {
  const f = await fixture();
  const before = f.assets.read(f.handle).unwrap();
  const fixed = f.assets.snapshot(f.handle).unwrap();
  f.publishHeights([1, 1, 1, 2]);
  expect(f.assets.read(f.handle).unwrap()).toEqual(before);
  expect(f.extract().sources).toHaveLength(1);
  (await f.reload()).unwrap();
  expect(f.assets.read(f.handle).unwrap().heightRange).toEqual([1, 2]);
  expect(fixed.read(f.handle).unwrap()).toEqual(before);
  expect(f.extract().sources[0]?.terrain?.handle).toBe(f.handle);
  fixed.dispose();
});

it('keeps the root GPU bounds conservative across f32 decode cancellation', async () => {
  const f = await fixture();
  f.bind(await f.adopt([-1e8, -0.1, -1e8, -0.1]));
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
])('encloses two-stage f32 XZ endpoints in actual root and section bounds ($n, $spacing)', async ({
  n,
  spacing,
}) => {
  const columns = 3 * (n - 1) + 1;
  const f = await fixture({ columns, rows: n, spacing, subsectionVertices: n });
  f.world.set(f.entity, Terrain, { forcedLod: 0 }).unwrap();
  const source = f.extract().sources[0];
  if (source?.localAabb === undefined) throw new Error('missing terrain bounds');
  const projected = projectTerrainView(
    { renderables: [source], dispatch: [], cameras: [{}] } as unknown as ExtractedFrame,
    new Map(),
    source.materials.reduce(
      (frame, material) => frame.with(material),
      new MaterialFrame(undefined),
    ),
    [f.world].map(worldRenderResources),
    ...terrainViewPreparation(f.assets),
  ).frame;
  const section = f.initial.sections[2];
  const texture =
    section === undefined
      ? undefined
      : f.assets.read(section.heightTexture as AssetHandle<'texture'>).unwrap();
  const draw = projected.renderables.at(2);
  if (section === undefined || texture === undefined || draw?.localAabb === undefined)
    throw new Error('missing last section');
  const vertex = terrainSurfaceVertex(
    {
      vertices: n,
      width: (n - 1) * spacing,
      lod: 0,
      neighbors: [0, 0, 0, 0],
      textureWidth: texture.shape.extent.width,
      textureHeight: texture.shape.extent.height,
      sectionIndex: 2,
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
] as const)('rejects a partial source %s rewrite without replacing the accepted root', async (field) => {
  const f = await fixture();
  const fixed = f.assets.snapshot(f.handle).unwrap();
  const section = f.sourceRoot.sections[0];
  if (section === undefined) throw new Error('missing Terrain section');
  const texture = f.sourceAsset<TextureAsset>(section[field]);
  f.changeSource(section[field], { ...texture, data: new Uint8Array(texture.data).fill(255) });
  expect((await f.reload()).ok).toBe(false);
  expect(fixed.matchesCurrent()).toBe(true);
  expect(f.extract().sources).toHaveLength(1);
  await f.adopt([1, 1, 1, 2]);
  expect(f.assets.read(f.handle).unwrap().heightRange).toEqual([1, 2]);
  expect(f.extract().sources).toHaveLength(1);
  fixed.dispose();
});

it('accepts detached author input and rejects an unsupported coherent pose', async () => {
  const f = await fixture();
  f.bind({ ...f.initial });
  expect(f.extract().sources).toHaveLength(1);
  f.bind(f.initial);
  f.world
    .set(f.entity, GlobalTransform, {
      world: new Float32Array([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    })
    .unwrap();
  expect(f.extract).toThrow(expect.objectContaining({ code: 'terrain-pose-unsupported' }));
});

it('rejects a source grid whose topology changes the submitted diagonal', async () => {
  const f = await fixture();
  const gridGuid = f.sourceRoot.grids[0];
  if (gridGuid === undefined) throw new Error('missing Terrain grid');
  const grid = f.sourceAsset<MeshAsset>(gridGuid);
  const fixed = f.assets.snapshot(f.handle).unwrap();
  // A legal Mesh diagonal that disagrees with Terrain physics and surface queries.
  f.changeSource(gridGuid, { ...grid, indices: new Uint32Array([0, 2, 3, 0, 3, 1]) });
  expect((await f.reload()).ok).toBe(false);
  expect(fixed.matchesCurrent()).toBe(true);
  expect(f.extract().sources).toHaveLength(1);
  fixed.dispose();
});

it.each([
  'tiny-scale',
  'world-overflow',
] as const)('rejects %s before publishing a Terrain source', async (mode) => {
  const f = await fixture();
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  if (mode === 'tiny-scale') matrix[0] = 1.0000001;
  else {
    f.bind(await f.adopt([-1e38, 1e38, -1e38, 1e38]));
    matrix[13] = 3e38;
  }
  f.world.set(f.entity, GlobalTransform, { world: matrix }).unwrap();
  expect(f.extract).toThrow(expect.objectContaining({ code: 'terrain-pose-unsupported' }));
});

it.each([
  'terrainHeightTexture',
  'terrainWeightTexture',
] as const)('rejects a section material redirecting %s away from its author closure', async (binding) => {
  const f = await fixture();
  const section = f.sourceRoot.sections[0];
  if (section === undefined) throw new Error('missing Terrain section');
  const texture = f.sourceAsset<TextureAsset>(
    binding === 'terrainHeightTexture' ? section.heightTexture : section.weightTexture,
  );
  const material = f.sourceAsset<MaterialAsset>(section.material);
  const fixed = f.assets.snapshot(f.handle).unwrap();
  const alternate = f.guid('alternate-texture');
  f.addSource('alternate-texture', { ...texture, data: new Uint8Array(texture.data).fill(255) });
  f.changeSource(section.material, {
    ...material,
    values: {
      ...material.values,
      [binding]:
        binding === 'terrainHeightTexture'
          ? alternate
          : { texture: alternate, sampler: f.guid('control-sampler') },
    },
  });
  expect((await f.reload()).ok).toBe(false);
  expect(fixed.matchesCurrent()).toBe(true);
  expect(f.extract().sources).toHaveLength(1);
  fixed.dispose();
});

it('reloads changed layer values without advancing the unchanged root or unlocking derived data', async () => {
  const f = await fixture();
  const before = f.assets.snapshot(f.handle).unwrap();
  const layer = f.sourceAsset<MaterialAsset>(f.guid('layer'));
  f.changeSource(f.guid('layer'), {
    ...layer,
    values: { ...layer.values, baseColor: [0.2, 0.5, 1, 1] },
  });
  (await f.reload()).unwrap();
  const current = f.assets.snapshot(f.handle).unwrap();
  expect(current.version(f.handle).unwrap()).toBe(before.version(f.handle).unwrap());
  expect(before.matchesCurrent()).toBe(false);
  const section = f.assets.read(f.handle).unwrap().sections[0];
  if (section === undefined) throw new Error('missing accepted Terrain section');
  const height = section.heightTexture as AssetHandle<'texture'>;
  const material = section.material as AssetHandle<'material'>;
  expect(f.assets.replace(height, f.assets.read(height).unwrap()).ok).toBe(false);
  expect(f.assets.update(material, { values: { terrainLod: [0, 0, 0, 99] } }).ok).toBe(false);
  expect(f.extract().sources).toHaveLength(1);
  current.dispose();
  before.dispose();
});
