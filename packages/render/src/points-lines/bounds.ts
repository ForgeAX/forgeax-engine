import type { PointsLinesStyle } from './snapshot';

/**
 * Expands the local culling envelope by the maximum raster radius. The shader
 * applies the exact pixel or world-space offset (including round caps, which
 * add at most half the width); this envelope is deliberately conservative so
 * transformed edge primitives are retained.
 */
export function expandPointsLinesBounds(
  bounds: ArrayLike<number>,
  style: PointsLinesStyle | undefined,
): Float32Array {
  if (bounds.length < 6 || style === undefined) return new Float32Array(bounds);
  const margin = style.kind === 'points' ? style.sizePx * 0.5 : style.width * 2;
  if (!Number.isFinite(margin) || margin <= 0) return new Float32Array(bounds);
  return new Float32Array([
    (bounds[0] ?? 0) - margin,
    (bounds[1] ?? 0) - margin,
    (bounds[2] ?? 0) - margin,
    (bounds[3] ?? 0) + margin,
    (bounds[4] ?? 0) + margin,
    (bounds[5] ?? 0) + margin,
  ]);
}
