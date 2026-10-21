import { encodeTileBits } from '@forgeax/engine-graphics-extras';
import { mat4 } from '@forgeax/engine-math';
import type { AssetHandle, TilesetAsset } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import {
  type TilemapRenderSource,
  tilemapCellGeometry,
  tilemapChunks,
  tilemapMesh,
  tilemapRegionMesh,
  validTilemapSource,
} from '../tilemap-geometry';

const source: TilemapRenderSource = {
  tileset: 1 as AssetHandle<'tileset'>,
  cols: 1,
  rows: 1,
  tiles: new Uint32Array([1]),
  tileSize: [1, 1],
  chunkSize: 1,
  layerOrder: 0,
  sortScope: 0,
};
const asset: TilesetAsset = {
  kind: 'tileset',
  atlases: ['atlas'],
  tileWidth: 16,
  tileHeight: 16,
  columns: 2,
  rows: 2,
  regions: [
    { x: 0, y: 0, width: 16, height: 16 },
    { x: 16, y: 16, width: 16, height: 16 },
  ],
  tiles: [{ regionIndex: 0, widthCells: 2, heightCells: 3, pivotX: 0.25, pivotY: 0.2 }],
};

it.each([
  [false, false, false, 0.75, 1.1, 1, 1.5],
  [true, false, false, 0.25, 1.1, 1, 1.5],
  [false, true, false, 0.75, -0.1, 1, 1.5],
  [true, true, false, 0.25, -0.1, 1, 1.5],
  [false, false, true, 0.8, 1, 1.5, 1],
  [true, false, true, 0.2, 1, 1.5, 1],
  [false, true, true, 0.8, 0, 1.5, 1],
  [true, true, true, 0.2, 0, 1.5, 1],
] as const)('preserves pivot and overhang for flips H=%s V=%s D=%s', (h, v, d, x, y, halfX, halfY) => {
  const input = { ...source, tiles: new Uint32Array([encodeTileBits(1, h, v, d, false)]) };
  const geometry = tilemapCellGeometry(input, asset, 0);
  assert(geometry);
  const mesh = tilemapMesh(asset, [geometry]);
  expect(geometry.matrix[12]).toBeCloseTo(x);
  expect(geometry.matrix[13]).toBeCloseTo(y);
  for (const [axis, expected] of [x - halfX, y - halfY, 0, x + halfX, y + halfY, 0].entries())
    expect(mesh.aabb?.[axis]).toBeCloseTo(expected);
  expect(mesh.indices).toHaveLength(6);
});

it('unit cells and nonunit tile sizes share the same geometry kernel', () => {
  const input = {
    ...source,
    cols: 2,
    rows: 2,
    tiles: new Uint32Array([0, 0, 0, 1]),
    tileSize: [2, 3] as const,
  };
  const unit = { ...asset, tiles: [{ regionIndex: 0 }] };
  const geometry = tilemapCellGeometry(input, unit, 3);
  assert(geometry);
  const mesh = tilemapMesh(unit, [geometry]);
  assert(mesh.aabb);
  expect(Array.from(mesh.aabb)).toEqual([2, 3, 0, 4, 6, 0]);
  expect(tilemapCellGeometry(input, unit, 0)).toBeUndefined();
});

it('half-texel insets keep adjacent atlas regions a full texel apart', () => {
  const a = tilemapRegionMesh(asset, 0).attributes?.uv as Float32Array;
  const b = tilemapRegionMesh(asset, 1).attributes?.uv as Float32Array;
  expect(Math.min(...a)).toBe(0.5 / 32);
  expect(Math.max(...a)).toBe(15.5 / 32);
  expect(Math.min(...b)).toBe(16.5 / 32);
  expect(Math.max(...b)).toBe(31.5 / 32);
  expect(Math.min(...b) - Math.max(...a)).toBe(1 / 32);
});

it('multi-atlas UVs use each atlas extent and one-pixel regions remain valid', () => {
  const multi = {
    ...asset,
    atlases: ['a', 'b'],
    atlasSizes: [
      { pixelWidth: 32, pixelHeight: 32 },
      { pixelWidth: 64, pixelHeight: 16 },
    ],
    regions: [{ x: 32, y: 0, width: 1, height: 1, atlasIndex: 1 }],
  };
  const mesh = tilemapRegionMesh(multi, 0);
  expect(Array.from(mesh.attributes?.uv as Float32Array)).toEqual([
    32.5 / 64,
    0.5 / 16,
    32.5 / 64,
    0.5 / 16,
    32.5 / 64,
    0.5 / 16,
    32.5 / 64,
    0.5 / 16,
  ]);
  expect(Array.from(mesh.vertices).every(Number.isFinite)).toBe(true);
});

it('partitions only nonempty cells into declared chunks', () => {
  const map = {
    ...source,
    cols: 55,
    rows: 56,
    chunkSize: 16,
    tiles: new Uint32Array(55 * 56).fill(1),
  };
  const chunks = tilemapChunks(map);
  expect(chunks).toHaveLength(16);
  expect(chunks.reduce((n, chunk) => n + chunk.cells.length, 0)).toBe(55 * 56);
  expect(tilemapChunks({ ...map, tiles: new Uint32Array(55 * 56) })).toEqual([]);
});

it('rejects malformed publications and undefined tile ids before drawing', () => {
  expect(validTilemapSource(source)).toBe(true);
  for (const patch of [
    { tiles: new Uint32Array(0) },
    { tileSize: [NaN, 1] },
    { chunkSize: 0 },
    { sortScope: 2 },
    { cols: -1 },
  ])
    expect(validTilemapSource({ ...source, ...patch } as TilemapRenderSource)).toBe(false);
  expect(() => tilemapCellGeometry({ ...source, tiles: new Uint32Array([2]) }, asset, 0)).toThrow();
  expect(
    tilemapMesh(asset, [{ regionIndex: 0, matrix: mat4.identity(mat4.create()) }]).aabb,
  ).toEqual(new Float32Array([-0.5, -0.5, 0, 0.5, 0.5, 0]));
});
