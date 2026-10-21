import { terrainDerivedClosureValid, terrainHeight } from '@forgeax/engine-terrain';
import { cookTerrain } from '@forgeax/engine-terrain/cook';
import {
  type Asset,
  type AssetHandle,
  standardSurfaceParameters,
  type TerrainAsset,
  type TextureAsset,
} from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { installDefaultAssetDecoders } from '../../../runtime/src/asset-contributions';
import { AssetRegistry } from '../asset-registry';
import { runtimeAssets } from '../internal/runtime-assets';
import { prepareTerrainHeightRange } from '../runtime-terrain';

function fixture(assemble = true) {
  const assets = new AssetRegistry();
  if (assemble) installDefaultAssetDecoders(assets);
  const layer = assets
    .create({
      kind: 'material',
      colorSpace: 'linear',
      parameters: standardSurfaceParameters([]),
      values: { baseColor: [0.2, 0.4, 0.7, 1] },
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    })
    .unwrap();
  const source = {
    kind: 'terrain' as const,
    columns: 2,
    rows: 2,
    spacing: 1,
    subsectionVertices: 2,
    heights: new Float32Array([0, 0, 0, 1]),
    weights: new Float32Array(4).fill(1),
    layers: [{ material: layer, blend: 'weight' as const }],
  };
  return { assets, layer, source };
}

function closure(assets: AssetRegistry, root: AssetHandle<'terrain'>) {
  const records = runtimeAssets(assets),
    table = new Map<string, Asset>(),
    pending: number[] = [root];
  while (pending.length) {
    const handle = pending.pop() as number;
    if (table.has(String(handle))) continue;
    table.set(String(handle), records.borrow<Asset>(handle).unwrap());
    pending.push(...records.dependencies(handle).unwrap());
  }
  return table;
}

it('requires the derived output owners and rejects missing assembly atomically', () => {
  const { assets, source } = fixture(false);
  const observer = assets.observe().unwrap();
  expect(assets.create(source)).toMatchObject({
    ok: false,
    error: { code: 'asset-invalid-value' },
  });
  expect(observer.read().unwrap().changes).toHaveLength(0);
  installDefaultAssetDecoders(assets);
  const handle = assets.create(source).unwrap();
  expect(terrainDerivedClosureValid(assets.read(handle).unwrap(), closure(assets, handle))).toBe(
    true,
  );
  observer.dispose();
  assets.dispose();
});

it('creates Terrain directly from author values and owned layer handles without a Catalog', () => {
  const { assets, source } = fixture();
  const load = vi.spyOn(assets, 'load');
  const enumerate = vi.spyOn(assets, 'enumerateCatalog');
  const handle = assets.create(source).unwrap();
  const root = assets.read(handle).unwrap();
  expect(root.grids.every((value) => typeof value === 'number')).toBe(true);
  expect(root.sections.every((value) => typeof value.material === 'number')).toBe(true);
  expect(terrainDerivedClosureValid(root, closure(assets, handle))).toBe(true);
  expect(load).not.toHaveBeenCalled();
  expect(enumerate).not.toHaveBeenCalled();
  source.heights.fill(99);
  expect(terrainHeight(assets.read(handle).unwrap(), 1, 1)).toBe(1);
  assets.dispose();
});

it('atomically derives height edits under the bound identity and retains fixed old closures', () => {
  const { assets, source } = fixture();
  const handle = assets.create(source).unwrap();
  const copy = assets.copy(handle).unwrap();
  const fixed = assets.snapshot(handle).unwrap();
  const previous = fixed.read<TerrainAsset>(handle).unwrap();
  const observer = assets.observe().unwrap();
  const heights = new Float32Array([0, 0, 0, 8]);
  assets.update(handle, { heights }).unwrap();
  heights.fill(99);
  const root = assets.read(handle).unwrap();
  expect(terrainHeight(root, 1, 1)).toBe(8);
  expect(root.heightRange).toEqual([0, 8]);
  expect(root.sections[0]?.maxHeight).toBe(8);
  expect(terrainDerivedClosureValid(root, closure(assets, handle))).toBe(true);
  expect(assets.read(copy).unwrap().heights).toEqual(previous.heights);
  expect(assets.read(copy).unwrap().sections[0]?.heightTexture).not.toBe(
    previous.sections[0]?.heightTexture,
  );
  expect(fixed.read<TerrainAsset>(handle).unwrap()).toEqual(previous);
  expect(fixed.matchesCurrent()).toBe(false);
  const changes = observer.read().unwrap();
  expect(changes.changes.filter((value) => value.handle === handle)).toHaveLength(1);
  expect(
    new Set(changes.changes.filter((value) => !value.removed).map((value) => value.revision)).size,
  ).toBe(1);
  changes.accept();
  observer.dispose();
  fixed.dispose();
  assets.dispose();
});

it('rejects invalid height/layer edits and forged derived fields without publishing partial outputs', () => {
  const { assets, source } = fixture();
  const handle = assets.create(source).unwrap();
  const before = assets.read(handle).unwrap();
  const observer = assets.observe().unwrap();
  expect(assets.update(handle, { heights: new Float32Array([NaN, 0, 0, 1]) }).ok).toBe(false);
  expect(assets.update(handle, { sections: [] }).ok).toBe(false);
  expect(assets.update(handle, { weights: new Float32Array(4).fill(0.5) }).ok).toBe(false);
  expect(assets.read(handle).unwrap()).toEqual(before);
  expect(observer.read().unwrap().changes).toHaveLength(0);
  observer.dispose();
  assets.dispose();
});

it('keeps derived output immutable while independent output copies remain editable', () => {
  const { assets, source } = fixture(),
    root = assets.create(source).unwrap();
  const section = assets.read(root).unwrap().sections[0];
  if (section === undefined) throw new Error('Expected Terrain section');
  const material = section.material as AssetHandle<'material'>;
  const height = section.heightTexture as AssetHandle<'texture'>;
  const observer = assets.observe().unwrap();
  expect(assets.update(material, { values: { terrainLod: [0, 0, 0, 99] } }).ok).toBe(false);
  expect(assets.replace(height, assets.read(height).unwrap()).ok).toBe(false);
  expect(
    assets.writeRange(height, {
      origin: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
      data: new Uint8Array(4),
    }).ok,
  ).toBe(false);
  expect(observer.read().unwrap().changes).toHaveLength(0);
  const copy = assets.copy(material).unwrap();
  expect(assets.update(copy, { values: { terrainLod: [0, 0, 0, 99] } }).ok).toBe(true);
  expect(assets.read(material).unwrap().values?.terrainLod).toEqual([0, 0, 1, 1]);
  observer.dispose();
  assets.dispose();
});

it('adopts a seam rectangle and its atlas at one revision without replacing identities or old captures', () => {
  const { assets, source } = fixture();
  const columns = 22,
    rows = 15,
    n = 8;
  const handle = assets
    .create({
      ...source,
      columns,
      rows,
      subsectionVertices: n,
      heights: new Float32Array(columns * rows),
      weights: new Float32Array(columns * rows).fill(1),
    })
    .unwrap();
  const records = runtimeAssets(assets);
  const original = assets.read(handle).unwrap();
  const texture = original.sections[0]?.heightTexture as AssetHandle<'texture'>;
  const oldBytes = assets.read(texture).unwrap().data;
  const copied = assets.copy(handle).unwrap();
  const fixed = assets.snapshot(handle).unwrap();
  const observer = assets.observe().unwrap();
  const patch = {
    origin: { x: 7, z: 7 },
    size: { columns: 1, rows: 1 },
    heights: Float32Array.of(17),
  };
  assets.writeRange(handle, patch).unwrap();
  patch.heights[0] = 99;
  const root = assets.read(handle).unwrap();
  expect(root.sections.map((section) => section.heightTexture)).toEqual(
    original.sections.map((section) => section.heightTexture),
  );
  expect(root.sections.filter((section) => section.maxHeight === 17)).toHaveLength(4);
  expect(root.heightRange).toEqual([0, 17]);
  expect(root.heights[7 * columns + 7]).toBe(17);
  expect(terrainDerivedClosureValid(root, closure(assets, handle))).toBe(true);
  expect(assets.read(texture).unwrap().data).toEqual(cookTerrain(root).unwrap().height.data);
  expect(fixed.read<TerrainAsset>(handle).unwrap()).toEqual(original);
  expect(fixed.read<TextureAsset>(texture).unwrap().data).toEqual(oldBytes);
  const independent = assets.read(copied).unwrap();
  expect(independent.heights).toEqual(original.heights);
  expect(independent.sections[0]?.heightTexture).not.toBe(texture);
  expect(terrainDerivedClosureValid(independent, closure(assets, copied))).toBe(true);
  const changes = observer.read().unwrap();
  expect(changes.changes.map((change) => change.handle).sort()).toEqual([handle, texture].sort());
  expect(new Set(changes.changes.map((change) => change.revision)).size).toBe(1);
  expect(records.version(handle).unwrap()).toBe(records.version(texture).unwrap());
  const atlasChange = changes.changes.find((change) => change.handle === texture);
  const transferred =
    atlasChange?.ranges.reduce(
      (sum, range) =>
        sum +
        (range.rowBytes === undefined
          ? range.byteLength
          : ((range.byteLength - range.rowBytes) / (range.byteStride as number) + 1) *
            range.rowBytes),
      0,
    ) ?? 0;
  expect(transferred).toBeLessThan(oldBytes.length / 4);
  changes.accept();
  assets.writeRange(handle, { ...patch, heights: Float32Array.of(-3) }).unwrap();
  const lower = assets.read(handle).unwrap();
  expect(lower.heightRange).toEqual([-3, 17]);
  expect(terrainDerivedClosureValid(lower, closure(assets, handle))).toBe(true);
  fixed.dispose();
  observer.dispose();
  assets.dispose();
});

it('reads only intersecting author triangles during a small range preparation', () => {
  const { assets, source } = fixture();
  const n = 32,
    columns = 125,
    rows = 94;
  const handle = assets
    .create({
      ...source,
      columns,
      rows,
      subsectionVertices: n,
      heights: new Float32Array(columns * rows),
      weights: new Float32Array(columns * rows).fill(1),
    })
    .unwrap();
  const root = runtimeAssets(assets).borrow<TerrainAsset>(handle).unwrap();
  let reads = 0;
  const heights = new Proxy(root.heights, {
    get(target, property) {
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        reads++;
        return target[Number(property)];
      }
      throw new Error(`Unbounded author access: ${String(property)}`);
    },
  });
  const prepared = prepareTerrainHeightRange(
    { ...root, heights },
    { origin: { x: 15, z: 15 }, size: { columns: 1, rows: 1 }, heights: Float32Array.of(5) },
    runtimeAssets(assets),
    handle,
    {
      maxAssets: 65536,
      maxBytes: 256 * 1024 * 1024,
      maxSnapshots: 128,
      maxRanges: 64,
      maxObservers: 32,
      maxDependencies: 1024,
    },
  );
  expect(prepared.ok).toBe(true);
  expect(reads).toBeLessThan(100);
  assets.dispose();
});

it.each([2, 4, 8, 32])('matches full derivation for a fractional mip rectangle (n=%s)', (n) => {
  const { assets, source } = fixture();
  const columns = 3 * (n - 1) + 1,
    rows = 2 * (n - 1) + 1;
  const handle = assets
    .create({
      ...source,
      columns,
      rows,
      subsectionVertices: n,
      heights: Float32Array.from({ length: columns * rows }, (_, i) => Math.sin(i)),
      weights: new Float32Array(columns * rows).fill(1),
    })
    .unwrap();
  const width = Math.min(3, columns - 1),
    height = Math.min(3, rows - 1);
  assets
    .writeRange(handle, {
      origin: { x: n - 1, z: 1 },
      size: { columns: width, rows: height },
      heights: Float32Array.from({ length: width * height }, (_, i) => -10 + i),
    })
    .unwrap();
  const root = assets.read(handle).unwrap();
  const texture = root.sections[0]?.heightTexture as AssetHandle<'texture'>;
  expect(assets.read(texture).unwrap().data).toEqual(cookTerrain(root).unwrap().height.data);
  expect(terrainDerivedClosureValid(root, closure(assets, handle))).toBe(true);
  assets.dispose();
});

it('rejects invalid rectangles and preparation budget failures without changing root or atlas', () => {
  const { assets, source } = fixture();
  const handle = assets.create(source).unwrap();
  const before = assets.snapshot(handle).unwrap();
  const observer = assets.observe().unwrap();
  for (const range of [
    { origin: { x: 2, z: 1 }, size: { columns: 1, rows: 1 }, heights: Float32Array.of(3) },
    { origin: { x: 0, z: 0 }, size: { columns: 1, rows: 1 }, heights: Float32Array.of(NaN) },
    {
      origin: { x: 0, z: 0 },
      size: { columns: 1, rows: 1 },
      heights: Float32Array.of(3.4028234663852886e38),
    },
  ])
    expect(assets.writeRange(handle, range).ok).toBe(false);
  expect(before.matchesCurrent()).toBe(true);
  expect(observer.read().unwrap().changes).toHaveLength(0);
  const records = runtimeAssets(assets);
  const root = records.borrow<TerrainAsset>(handle).unwrap();
  expect(
    prepareTerrainHeightRange(
      root,
      { origin: { x: 1, z: 1 }, size: { columns: 1, rows: 1 }, heights: Float32Array.of(8) },
      records,
      handle,
      {
        maxAssets: 65536,
        maxBytes: 256 * 1024 * 1024,
        maxSnapshots: 128,
        maxRanges: 1,
        maxObservers: 32,
        maxDependencies: 1024,
      },
    ),
  ).toMatchObject({
    ok: false,
    error: { code: 'asset-budget-exceeded' },
  });
  expect(before.matchesCurrent()).toBe(true);
  before.dispose();
  observer.dispose();
  assets.dispose();
});
