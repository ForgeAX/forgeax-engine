import type { TerrainAsset } from '@forgeax/engine-types';

/** Actual two-stage f32 section endpoint, shared by bounds and pose admission. */
export function terrainAxisEndpoint(offset: number, width: number): number {
  return Math.fround(Math.fround(offset) + Math.fround(width));
}

/** Packed RG16 quantization and f32 decode/morph rounding are renderer geometry facts. */
export function terrainHeightBounds(
  min: number,
  max: number,
  range: readonly [number, number],
): readonly [number, number] {
  const span = range[1] - range[0];
  // Cover UNORM conversion, byte reconstruction, multiply/add, morph and AABB f32 storage.
  const rounding = 16 * 2 ** -23 * (Math.max(Math.abs(range[0]), Math.abs(range[1])) + span);
  const padding = span / 65535 / 2 + rounding;
  return [min - padding, max + padding];
}

/** Both consumers admit only the translation applied by the submitted-surface query. */
export function terrainTranslationValid(asset: TerrainAsset, matrix: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) {
    const value = matrix[i];
    if (!Number.isFinite(value) || ((i < 12 || i === 15) && value !== (i % 5 === 0 ? 1 : 0)))
      return false;
  }
  const range = asset.heightRange;
  if (!range || range.length !== 2 || !range.every(Number.isFinite)) return false;
  const height = terrainHeightBounds(range[0], range[1], range);
  const width = (asset.subsectionVertices - 1) * asset.spacing;
  const endpoint = (samples: number) =>
    terrainAxisEndpoint((samples - asset.subsectionVertices) * asset.spacing, width);
  return [
    Math.fround(endpoint(asset.columns) + (matrix[12] ?? NaN)),
    Math.fround(endpoint(asset.rows) + (matrix[14] ?? NaN)),
    ...height.map((value) => Math.fround(Math.fround(value) + (matrix[13] ?? NaN))),
  ].every(Number.isFinite);
}
