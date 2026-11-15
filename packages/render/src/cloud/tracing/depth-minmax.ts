import { CLOUD_UNTRACED_DEPTH_METERS } from './geometry';

/** Reduce linear ray distances, including empty sky as a valid far distance. */
export function cloudDepthRangeMeters(depths: ArrayLike<number>): readonly [number, number] {
  let near = CLOUD_UNTRACED_DEPTH_METERS;
  let far = 0;
  for (let index = 0; index < depths.length; index++) {
    const depth = depths[index];
    if (depth === undefined || !Number.isFinite(depth) || depth < 0)
      throw new RangeError('Cloud depth reduction requires finite nonnegative meter distances.');
    near = Math.min(near, depth);
    far = Math.max(far, depth);
  }
  return depths.length === 0 ? [near, near] : [near, far];
}
