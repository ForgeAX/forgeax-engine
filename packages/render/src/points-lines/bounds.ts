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
  output?: Float32Array,
): Float32Array {
  if (bounds.length < 6 || style === undefined) return unexpanded(bounds);
  const margin = style.kind === 'points' ? style.size * 0.5 : style.width * 2;
  if (!Number.isFinite(margin) || margin <= 0) return unexpanded(bounds);
  const expanded = output ?? new Float32Array(6);
  for (let axis = 0; axis < 3; axis++) {
    expanded[axis] = (bounds[axis] ?? 0) - margin;
    expanded[axis + 3] = (bounds[axis + 3] ?? 0) + margin;
  }
  return expanded;
}

function unexpanded(bounds: ArrayLike<number>): Float32Array {
  return bounds instanceof Float32Array ? bounds : new Float32Array(bounds);
}
