import {
  encodeTerrainHeight,
  terrainHeightAtlas,
  terrainHeightBounds,
  terrainHeightMipOffset,
  terrainSampleHeight,
} from '@forgeax/engine-terrain';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import {
  type Asset,
  AssetError,
  type AssetHandle,
  err,
  ok,
  type Result,
  type TerrainAsset,
  type TerrainMaterialEncoding,
  type TerrainSource,
  type TextureAsset,
} from '@forgeax/engine-types';
import { copyAssetData } from './internal/asset-data';
import type {
  AssetByteWrite,
  AssetLimits,
  AssetRangeUpdate,
  AssetRecords,
  PreparedAssetRanges,
} from './internal/asset-records';

/** Author data can create a Terrain directly; the runtime owns its derived closure. */
export type TerrainInput = TerrainSource & {
  readonly kind: 'terrain';
  readonly materialEncoding?: TerrainMaterialEncoding;
};

const authorFields = new Set([
  'columns',
  'rows',
  'spacing',
  'subsectionVertices',
  'heights',
  'weights',
  'layers',
  'materialEncoding',
]);

export function captureTerrainEdit(
  current: TerrainInput,
  patch: Readonly<Record<string, unknown>>,
): Result<TerrainInput, AssetError> {
  try {
    const captured = copyAssetData(patch);
    if (Object.keys(captured).some((field) => !authorFields.has(field)))
      return err(invalid('Terrain author fields; section bounds, textures and grids are derived'));
    return ok({ ...current, ...captured });
  } catch {
    return err(invalid('plain owned Terrain author data without accessors or shared buffers'));
  }
}

/** Pure CPU derivation is bounded by the changed author's complete content, never its users. */
export function prepareTerrainOutputs(
  input: TerrainInput,
  records: AssetRecords,
  resolve: (guid: string) => AssetHandle | undefined,
): Result<Readonly<Record<string, Asset>>, AssetError> {
  let source: TerrainInput;
  try {
    source = copyAssetData(input);
  } catch {
    return err(invalid('plain owned Terrain author data'));
  }
  const pending: number[] = [];
  const reference = <K extends 'material' | 'texture'>(
    value: string | AssetHandle<K>,
    kind: K,
  ): AssetHandle<K> => {
    const handle = typeof value === 'number' ? value : resolve(value.toLowerCase());
    if (handle === undefined || handle === 0 || !records.validate(handle, kind).ok)
      throw invalid(`a loaded ${kind} owned by this runtime`);
    pending.push(handle);
    return handle as AssetHandle<K>;
  };
  try {
    source = {
      ...source,
      layers: source.layers.map((layer) =>
        layer.blend === 'height'
          ? {
              ...layer,
              material: reference(layer.material, 'material'),
              height: reference(layer.height, 'texture'),
            }
          : { ...layer, material: reference(layer.material, 'material') },
      ),
    };
    const borrowed = records.borrowClosure<Asset>(pending);
    if (!borrowed.ok) return borrowed;
    const assets = Object.fromEntries(borrowed.value);
    // These keys only name values in this private candidate; they are not GUIDs.
    const outputs = buildTerrainAssets(source, (key) => key, assets, source.materialEncoding);
    return outputs.ok ? outputs : err(invalid(outputs.error.expected));
  } catch (cause) {
    if (cause instanceof AssetError) return err(cause);
    throw cause;
  }
}

function invalid(expected: string): AssetError {
  return new AssetError({
    code: 'asset-invalid-value',
    expected,
    hint: 'supply valid Terrain author values and resident layer dependencies; the runtime derives its complete closure',
  });
}

/** A packed, X-fast rectangle in the existing Terrain author sample grid. */
export interface TerrainHeightRange {
  readonly origin: { readonly x: number; readonly z: number };
  readonly size: { readonly columns: number; readonly rows: number };
  readonly heights: Float32Array;
}

/** Prepare only the edited author rectangle and intersecting mip samples. */
export function prepareTerrainHeightRange(
  current: unknown,
  range: TerrainHeightRange,
  records: AssetRecords,
  handle: number,
  limits: Required<AssetLimits>,
): Result<readonly AssetRangeUpdate[], AssetError> {
  const terrain = current as TerrainAsset;
  if (terrain.kind !== 'terrain' || !range || !range.origin || !range.size)
    return err(invalid('a Terrain height rectangle'));
  const { x, z } = range.origin;
  const { columns, rows } = range.size;
  if (
    ![x, z, columns, rows].every(Number.isSafeInteger) ||
    x < 0 ||
    z < 0 ||
    columns <= 0 ||
    rows <= 0 ||
    x + columns > terrain.columns ||
    z + rows > terrain.rows ||
    !(range.heights instanceof Float32Array) ||
    range.heights.length !== columns * rows
  )
    return err(invalid('an in-bounds rectangle with one finite f32 height per sample'));
  let low = Infinity,
    high = -Infinity,
    changed = false,
    sample = 0;
  for (const height of range.heights) {
    if (!Number.isFinite(height)) return err(invalid('finite f32 height samples'));
    low = Math.min(low, height);
    high = Math.max(high, height);
    const previous =
      terrain.heights[
        (z + Math.floor(sample / columns)) * terrain.columns + x + (sample % columns)
      ];
    if (!Object.is(previous, height)) changed = true;
    sample++;
  }
  if (!changed) return ok([]);
  const heightRange = [
    Math.min(terrain.heightRange[0], low),
    Math.max(terrain.heightRange[1], high),
  ];
  if (
    terrainHeightBounds(heightRange[0] as number, heightRange[1] as number).some(
      (height) => !Number.isFinite(Math.fround(height)),
    )
  )
    return err(invalid('finite conservative GPU height bounds'));
  const textureHandle = terrain.sections[0]?.heightTexture;
  if (typeof textureHandle !== 'number') return err(invalid('an owned Terrain height atlas'));
  const texture = records.borrow<TextureAsset>(textureHandle);
  if (!texture.ok) return texture;
  const atlas = terrainHeightAtlas(terrain);
  const n = terrain.subsectionVertices,
    quads = n - 1;
  const fieldWrites: NonNullable<PreparedAssetRanges['fieldWrites']>[number][] = [];
  const writes: AssetByteWrite[] = [];
  const read = (index: number) => {
    const sx = (index % terrain.columns) - x,
      sz = Math.floor(index / terrain.columns) - z;
    return sx >= 0 && sx < columns && sz >= 0 && sz < rows
      ? (range.heights[sz * columns + sx] as number)
      : (terrain.heights[index] as number);
  };
  // One changed author sample influences only the incident author triangles.
  const firstX = Math.max(0, Math.floor((x - 1) / quads));
  const firstZ = Math.max(0, Math.floor((z - 1) / quads));
  const lastX = Math.min(atlas.columns - 1, Math.floor((x + columns) / quads));
  const lastZ = Math.min(atlas.rows - 1, Math.floor((z + rows) / quads));
  let candidateBytes = range.heights.byteLength;
  for (let sz = firstZ; sz <= lastZ; sz++)
    for (let sx = firstX; sx <= lastX; sx++) {
      const index = sz * atlas.columns + sx;
      const section = terrain.sections[index];
      if (section === undefined) return err(invalid('a complete Terrain section roster'));
      let sectionLow = section.minHeight,
        sectionHigh = section.maxHeight;
      for (let iz = Math.max(z, sz * quads); iz <= Math.min(z + rows - 1, (sz + 1) * quads); iz++)
        for (
          let ix = Math.max(x, sx * quads);
          ix <= Math.min(x + columns - 1, (sx + 1) * quads);
          ix++
        ) {
          const height = range.heights[(iz - z) * columns + ix - x] as number;
          sectionLow = Math.min(sectionLow, height);
          sectionHigh = Math.max(sectionHigh, height);
        }
      if (sectionLow !== section.minHeight)
        fieldWrites.push({ path: ['sections', String(index), 'minHeight'], value: sectionLow });
      if (sectionHigh !== section.maxHeight)
        fieldWrites.push({ path: ['sections', String(index), 'maxHeight'], value: sectionHigh });
      for (let mip = 0, size = n; size >= 1; mip++, size /= 2) {
        const bounds = (
          origin: number,
          count: number,
          sectionOrigin: number,
        ): readonly [number, number] => {
          if (size === 1)
            return sectionOrigin + quads / 2 >= origin - 1 &&
              sectionOrigin + quads / 2 <= origin + count
              ? [0, 0]
              : [1, 0];
          const scale = (size - 1) / quads;
          return [
            Math.max(0, Math.ceil((origin - 1 - sectionOrigin) * scale)),
            Math.min(size - 1, Math.floor((origin + count - sectionOrigin) * scale)),
          ];
        };
        const [left, right] = bounds(x, columns, sx * quads),
          [top, bottom] = bounds(z, rows, sz * quads);
        if (left > right || top > bottom) continue;
        const width = right - left + 1,
          height = bottom - top + 1;
        candidateBytes += width * height * 4;
        if (candidateBytes > limits.maxBytes) return err(rangeBudget());
        const bytes = new Uint8Array(width * height * 4);
        const byteOffset =
          terrainHeightMipOffset(atlas.width, atlas.height, mip) +
          ((Math.floor(index / atlas.tileColumns) * size + top) * atlas.tileColumns * size +
            (index % atlas.tileColumns) * size +
            left) *
            4;
        let changed = false;
        for (let iz = top; iz <= bottom; iz++)
          for (let ix = left; ix <= right; ix++) {
            const fx = sx * quads + (size === 1 ? quads / 2 : (ix * quads) / (size - 1)),
              fz = sz * quads + (size === 1 ? quads / 2 : (iz * quads) / (size - 1));
            const height = terrainSampleHeight(terrain, fx, fz, read);
            if (height === undefined || !Number.isFinite(height))
              return err(invalid('finite sampled heights'));
            const encoded = encodeTerrainHeight(height);
            const local = ((iz - top) * width + ix - left) * 4;
            bytes.set(encoded, local);
            const destination =
              byteOffset + ((iz - top) * atlas.tileColumns * size + ix - left) * 4;
            for (let lane = 0; lane < 4; lane++)
              if (encoded[lane] !== texture.value.data[destination + lane]) changed = true;
          }
        if (changed)
          writes.push({
            path: ['data'],
            byteOffset,
            bytes,
            rowBytes: width * 4,
            byteStride: atlas.tileColumns * size * 4,
          });
        if (writes.length + fieldWrites.length + 1 > limits.maxRanges) return err(rangeBudget());
      }
    }
  return ok([
    {
      handle,
      ranges: {
        writes: [
          {
            path: ['heights'],
            byteOffset: (z * terrain.columns + x) * 4,
            bytes: new Uint8Array(
              range.heights.buffer,
              range.heights.byteOffset,
              range.heights.byteLength,
            ),
            rowBytes: columns * 4,
            byteStride: terrain.columns * 4,
          },
        ],
        fields: { heightRange },
        fieldWrites,
      },
    },
    { handle: textureHandle, ranges: { writes } },
  ]);
}

function rangeBudget(): AssetError {
  return new AssetError({
    code: 'asset-budget-exceeded',
    expected: 'bounded Terrain region preparation',
    hint: 'split the edit into smaller rectangles or raise the explicit asset range budget',
  });
}
