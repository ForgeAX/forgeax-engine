import type { TerrainLayer } from '@forgeax/engine-types';

/** UE weight/height group followed by ordered alpha; zero group retains Standard defaults. */
export function terrainLayerWeights(
  layers: readonly TerrainLayer[],
  author: ArrayLike<number>,
  heights: ArrayLike<number>,
  out: Float32Array,
): { readonly defaultWeight: number } {
  out.fill(0);
  let sum = 0;
  let hasHeight = false;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer || layer.blend === 'alpha') continue;
    const weight = author[i] ?? 0;
    const value =
      layer.blend === 'height'
        ? Math.max(0.0001, Math.min(1, weight * 2 - 1 + (heights[i] ?? 0)))
        : weight;
    hasHeight ||= layer.blend === 'height';
    out[i] = value;
    sum += value;
  }
  if (hasHeight && sum > 0) for (let i = 0; i < layers.length; i++) out[i] = (out[i] ?? 0) / sum;
  let defaultWeight = sum === 0 ? 1 : 0;
  for (let i = 0; i < layers.length; i++) {
    if (layers[i]?.blend !== 'alpha') continue;
    const alpha = Math.max(0, Math.min(1, author[i] ?? 0));
    for (let j = 0; j < layers.length; j++) out[j] = (out[j] ?? 0) * (1 - alpha);
    defaultWeight *= 1 - alpha;
    out[i] = alpha;
  }
  return { defaultWeight };
}
