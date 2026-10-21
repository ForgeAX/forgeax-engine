/** Bounded median partition of owned convex point sets. Geometry, local frame and
 * original child order within each group remain unchanged. This is not a hull merge. */
export function spatialCompoundGroups(
  pieces: readonly Float32Array[],
): readonly (readonly Float32Array[])[] | undefined {
  if (pieces.length <= 16 || pieces.length > 128) return undefined;
  const centers: number[][] = [];
  for (const piece of pieces) {
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < piece.length; i++) {
      const axis = i % 3,
        value = piece[i] as number;
      lo[axis] = Math.min(lo[axis] as number, value);
      hi[axis] = Math.max(hi[axis] as number, value);
    }
    const center = lo.map((value, axis) =>
      Math.fround(Math.fround(value + (hi[axis] as number)) * 0.5),
    );
    if (!center.every(Number.isFinite)) return undefined;
    centers.push(center);
  }
  const groups: Float32Array[][] = [];
  const split = (ids: number[]): boolean => {
    if (ids.length <= 16) {
      groups.push(ids.sort((a, b) => a - b).map((id) => pieces[id] as Float32Array));
      return true;
    }
    const spans = [0, 1, 2].map((axis) => {
      const values = ids.map((id) => centers[id]?.[axis] as number);
      return Math.fround(Math.max(...values) - Math.min(...values));
    });
    if (!spans.every(Number.isFinite)) return false;
    let axis = 0;
    for (let i = 1; i < 3; i++) if ((spans[i] as number) >= (spans[axis] as number)) axis = i;
    ids.sort((a, b) => {
      const x = centers[a]?.[axis] as number,
        y = centers[b]?.[axis] as number;
      // Match Rust f32::total_cmp for finite values, including signed zero.
      return x === y ? (Object.is(x, y) ? a - b : Object.is(x, -0) ? -1 : 1) : x - y;
    });
    const mid = Math.floor(ids.length / 2);
    return split(ids.slice(0, mid)) && split(ids.slice(mid));
  };
  return split(pieces.map((_, i) => i)) ? groups : undefined;
}
