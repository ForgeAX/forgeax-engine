import type { TerrainAsset } from '@forgeax/engine-types';

/** Actual two-stage f32 section endpoint, shared by bounds and pose admission. */
export function terrainAxisEndpoint(offset: number, width: number): number {
  return Math.fround(Math.fround(offset) + Math.fround(width));
}

/** Raw f32 storage is exact; morph, world addition and AABB storage still round. */
export function terrainHeightBounds(min: number, max: number): readonly [number, number] {
  const padding = 16 * 2 ** -23 * Math.max(Math.abs(min), Math.abs(max));
  return [min - padding, max + padding];
}

/** Both consumers admit only the translation applied by the submitted-surface query. */
export function terrainTranslationValid(
  asset: Pick<TerrainAsset, 'heightRange' | 'columns' | 'rows' | 'subsectionVertices' | 'spacing'>,
  matrix: ArrayLike<number>,
): boolean {
  for (let i = 0; i < 16; i++) {
    const value = matrix[i];
    if (!Number.isFinite(value) || ((i < 12 || i === 15) && value !== (i % 5 === 0 ? 1 : 0)))
      return false;
  }
  const range = asset.heightRange;
  if (!range || range.length !== 2 || !range.every(Number.isFinite)) return false;
  const height = terrainHeightBounds(range[0], range[1]);
  const width = (asset.subsectionVertices - 1) * asset.spacing;
  const endpoint = (samples: number) =>
    terrainAxisEndpoint((samples - asset.subsectionVertices) * asset.spacing, width);
  return [
    Math.fround(endpoint(asset.columns) + (matrix[12] ?? NaN)),
    Math.fround(endpoint(asset.rows) + (matrix[14] ?? NaN)),
    ...height.map((value) => Math.fround(Math.fround(value) + (matrix[13] ?? NaN))),
  ].every(Number.isFinite);
}

/** Actual author extrema, independent of the exact f32 height storage. */
export function terrainSourceHeightRange(heights: Float32Array) {
  let min = Infinity,
    max = -Infinity;
  for (const height of heights) {
    min = Math.min(min, height);
    max = Math.max(max, height);
  }
  return { min, max };
}
