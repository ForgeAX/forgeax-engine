import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { decodeTileBits } from '@forgeax/engine-graphics-extras';
import { mat4 } from '@forgeax/engine-math';
import {
  AssetError,
  type AssetHandle,
  type MeshAsset,
  type TilesetAsset,
  type TilesetTileEntry,
} from '@forgeax/engine-types';
import { Tilemap } from './components/tilemap';

/** Author values retained at the source acceptance boundary and transported unchanged. */
export interface TilemapRenderSource {
  readonly tileset: AssetHandle<'tileset'>;
  readonly cols: number;
  readonly rows: number;
  readonly tileSize: readonly [number, number];
  readonly chunkSize: number;
  readonly tiles: Uint32Array;
  readonly layerOrder: number;
  readonly sortScope: 0 | 1;
}

export function validTilemapSource(value: TilemapRenderSource): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isInteger(value.tileset) &&
    value.tileset > 0 &&
    value.tileset <= 0xffff_ffff &&
    Number.isSafeInteger(value.cols) &&
    value.cols > 0 &&
    Number.isSafeInteger(value.rows) &&
    value.rows > 0 &&
    Number.isSafeInteger(value.chunkSize) &&
    value.chunkSize > 0 &&
    value.chunkSize <= 256 &&
    Array.isArray(value.tileSize) &&
    value.tileSize.length === 2 &&
    value.tileSize.every((n) => Number.isFinite(n) && n > 0) &&
    value.tiles instanceof Uint32Array &&
    value.tiles.length === value.cols * value.rows &&
    Number.isInteger(value.layerOrder) &&
    value.layerOrder >= -2048 &&
    value.layerOrder <= 2047 &&
    (value.sortScope === 0 || value.sortScope === 1)
  );
}

export function tilemapSource(world: World, entity: EntityHandle): TilemapRenderSource | undefined {
  const row = world.get(entity, Tilemap);
  if (!row.ok || row.value.tileset === 0) return undefined;
  const source = {
    ...row.value,
    tiles: row.value.tiles.slice(),
    tileSize: [row.value.tileSize[0], row.value.tileSize[1]],
  } as TilemapRenderSource;
  if (!validTilemapSource(source))
    throw new AssetError({
      code: 'asset-invalid-value',
      expected:
        'a Tilemap with positive dimensions, matching cells, valid tileSize and chunkSize in [1, 256]',
      hint: 'set the complete Tilemap row with a managed Tileset and TilemapSort value',
    });
  return source;
}

export interface TilemapChunk {
  readonly index: number;
  readonly cells: readonly number[];
  readonly x: number;
  readonly y: number;
}

/** Build only from accepted author cells. Tileset edits never rebuild this partition. */
export function tilemapChunks(source: TilemapRenderSource): readonly TilemapChunk[] {
  const chunks = new Map<number, { index: number; cells: number[]; x: number; y: number }>();
  const nx = Math.ceil(source.cols / source.chunkSize);
  for (let cell = 0; cell < source.tiles.length; cell++) {
    if (decodeTileBits(source.tiles[cell] ?? 0).tileId === 0) continue;
    const x = Math.floor((cell % source.cols) / source.chunkSize);
    const y = Math.floor(Math.floor(cell / source.cols) / source.chunkSize);
    const index = y * nx + x;
    let chunk = chunks.get(index);
    if (chunk === undefined) {
      chunk = { index, cells: [], x, y };
      chunks.set(index, chunk);
    }
    chunk.cells.push(cell);
  }
  return [...chunks.values()];
}

/** The same post-flip TRS drives rendering, bounds and exact CPU queries. */
export function tilemapCellMatrix(
  source: TilemapRenderSource,
  cell: number,
  entry: TilesetTileEntry,
): Float32Array {
  const { flipH, flipV, flipDiagonal } = decodeTileBits(source.tiles[cell] ?? 0);
  const px = entry.pivotX ?? 0.5,
    py = entry.pivotY ?? 0.5;
  const ex = flipH ? 1 - (flipDiagonal ? py : px) : flipDiagonal ? py : px;
  const ey = flipV ? 1 - (flipDiagonal ? px : py) : flipDiagonal ? px : py;
  const width = entry.widthCells ?? 1,
    height = entry.heightCells ?? 1;
  const x = ((cell % source.cols) + ex + (0.5 - ex) * width) * source.tileSize[0];
  const y = (Math.floor(cell / source.cols) + ey + (0.5 - ey) * height) * source.tileSize[1];
  return mat4.compose(
    mat4.create(),
    [x, y, 0],
    [0, 0, flipDiagonal ? Math.SQRT1_2 : 0, flipDiagonal ? Math.SQRT1_2 : 1],
    [
      (flipH ? -1 : 1) * width * source.tileSize[0],
      (flipV ? -1 : 1) * height * source.tileSize[1],
      1,
    ],
  );
}

export function tilemapRegionMesh(tileset: TilesetAsset, regionIndex: number): MeshAsset {
  return tilemapMesh(tileset, [{ regionIndex, matrix: mat4.identity(mat4.create()) }]);
}

export interface TilemapCellGeometry {
  readonly regionIndex: number;
  readonly matrix: Float32Array;
}

/** Half-texel inset, arbitrary atlas sizes, all Tiled flips and overhanging pivots. */
export function tilemapMesh(
  tileset: TilesetAsset,
  cells: readonly TilemapCellGeometry[],
): MeshAsset {
  const vertices = new Float32Array(cells.length * 4 * 12);
  const indices = new Uint32Array(cells.length * 6);
  for (const [i, cell] of cells.entries()) {
    const region = tileset.regions[cell.regionIndex];
    if (region === undefined) throw new Error('Tilemap cell references a missing region');
    const size = tileset.atlasSizes?.[region.atlasIndex ?? 0];
    const width = size?.pixelWidth ?? tileset.columns * tileset.tileWidth;
    const height = size?.pixelHeight ?? tileset.rows * tileset.tileHeight;
    const u = (region.x + 0.5) / width,
      v = (region.y + 0.5) / height;
    const uw = (region.width - 1) / width,
      vh = (region.height - 1) / height;
    const m = cell.matrix;
    for (let corner = 0; corner < 4; corner++) {
      const right = corner % 2,
        bottom = Math.floor(corner / 2);
      const x = right - 0.5,
        y = 0.5 - bottom;
      vertices.set(
        [
          (m[0] as number) * x + (m[4] as number) * y + (m[12] as number),
          (m[1] as number) * x + (m[5] as number) * y + (m[13] as number),
          (m[2] as number) * x + (m[6] as number) * y + (m[14] as number),
          0,
          0,
          1,
          u + right * uw,
          v + bottom * vh,
          (m[0] as number) / Math.hypot(m[0] as number, m[1] as number),
          (m[1] as number) / Math.hypot(m[0] as number, m[1] as number),
          0,
          -1,
        ],
        (i * 4 + corner) * 12,
      );
    }
    const start = i * 4;
    indices.set([start, start + 2, start + 1, start + 2, start + 3, start + 1], i * 6);
  }
  const attributes = unpackInterleavedVertexAttributes(
    vertices,
    deriveVertexLayoutProjection(DEFAULT_VERTEX_ATTRIBUTE_MAP),
  );
  if (attributes === undefined) throw new Error('Tilemap requires canonical vertex attributes');
  const aabb = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let base = 0; base < vertices.length; base += 12)
    for (let axis = 0; axis < 3; axis++) {
      aabb[axis] = Math.min(aabb[axis] as number, vertices[base + axis] as number);
      aabb[axis + 3] = Math.max(aabb[axis + 3] as number, vertices[base + axis] as number);
    }
  return {
    kind: 'mesh',
    vertices,
    indices,
    attributes,
    aabb,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: vertices.length / 12,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
}

export function tilemapCellGeometry(
  source: TilemapRenderSource,
  tileset: TilesetAsset,
  cell: number,
): TilemapCellGeometry | undefined {
  const tileId = decodeTileBits(source.tiles[cell] ?? 0).tileId;
  if (tileId === 0) return undefined;
  const entry = tileset.tiles[tileId - 1];
  if (entry === undefined)
    throw new AssetError({
      code: 'asset-invalid-value',
      expected: 'every nonempty Tilemap cell to name a Tileset tile',
      hint: 'repair the cell id or add the missing Tileset tile',
    });
  return { regionIndex: entry.regionIndex, matrix: tilemapCellMatrix(source, cell, entry) };
}

/** Explicit query work shares the accepted component/asset values and draw geometry kernel. */
export function tilemapGeometry(world: World, entity: EntityHandle): MeshAsset | undefined {
  const source = tilemapSource(world, entity);
  if (source === undefined) return undefined;
  const resolved = runtimeAssets(world.assets).resolveAsset<TilesetAsset>(source.tileset);
  if (!resolved.ok || resolved.value.kind !== 'tileset') return undefined;
  const cells: TilemapCellGeometry[] = [];
  for (const chunk of tilemapChunks(source))
    for (const cell of chunk.cells) {
      const geometry = tilemapCellGeometry(source, resolved.value, cell);
      if (geometry !== undefined) cells.push(geometry);
    }
  return cells.length === 0 ? undefined : tilemapMesh(resolved.value, cells);
}
