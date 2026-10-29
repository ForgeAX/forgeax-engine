import type { PointsLinesStyle } from './snapshot';

/**
 * Expands the local culling envelope by the maximum raster radius. The shader
 * applies the exact pixel or world-space offset (including round caps, which
 * add at most half the width); this envelope is deliberately conservative so
 * transformed edge primitives are retained. Unexpanded Float32Array bounds
 * are returned as-is: bounds are immutable once published.
 */
export function expandPointsLinesBounds(
  bounds: ArrayLike<number>,
  style: PointsLinesStyle | undefined,
): Float32Array {
  if (bounds.length < 6 || style === undefined) return unexpanded(bounds);
  const margin = style.kind === 'points' ? style.size * 0.5 : style.width * 2;
  if (!Number.isFinite(margin) || margin <= 0) return unexpanded(bounds);
  return new Float32Array([
    (bounds[0] ?? 0) - margin,
    (bounds[1] ?? 0) - margin,
    (bounds[2] ?? 0) - margin,
    (bounds[3] ?? 0) + margin,
    (bounds[4] ?? 0) + margin,
    (bounds[5] ?? 0) + margin,
  ]);
}

function unexpanded(bounds: ArrayLike<number>): Float32Array {
  return bounds instanceof Float32Array ? bounds : new Float32Array(bounds);
}
