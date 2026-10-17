import type { VoxelShapeInput } from '@forgeax/engine-physics';

/** Exact bounded union difference. A large or adversarial change returns to
 * full shape preparation instead of allocating an unbounded edit list. */
export function voxelRegionDelta(before: VoxelShapeInput, after: VoxelShapeInput) {
  if (!before.voxelSize.every((v, i) => v === after.voxelSize[i])) return undefined;
  let visits = 0,
    cells = 0;
  const limit = 4096;
  const subtract = (source: Int32Array, cuts: Int32Array): Int32Array | undefined => {
    const coordinates: number[] = [],
      unique = new Set<string>();
    const unchanged = new Set<string>();
    for (let j = 0; j < cuts.length; j += 6) unchanged.add(cuts.subarray(j, j + 6).join('/'));
    for (let i = 0; i < source.length; i += 6) {
      if (unchanged.has(source.subarray(i, i + 6).join('/'))) continue;
      let pieces: number[][] = [Array.from(source.subarray(i, i + 6))];
      for (let j = 0; j < cuts.length && pieces.length; j += 6) {
        if (++visits > 100_000) return undefined;
        if (
          [0, 1, 2].some(
            (a) =>
              (source[i + a] as number) >= (cuts[j + a + 3] as number) ||
              (source[i + a + 3] as number) <= (cuts[j + a] as number),
          )
        )
          continue;
        const next: number[][] = [];
        for (const piece of pieces) {
          if (++visits > 100_000) return undefined;
          if (
            [0, 1, 2].some(
              (a) =>
                (piece[a] as number) >= (cuts[j + a + 3] as number) ||
                (piece[a + 3] as number) <= (cuts[j + a] as number),
            )
          ) {
            next.push(piece);
            continue;
          }
          const rest = piece.slice();
          for (let a = 0; a < 3; a++) {
            if ((rest[a] as number) < (cuts[j + a] as number)) {
              const part = rest.slice();
              part[a + 3] = cuts[j + a] as number;
              next.push(part);
              rest[a] = cuts[j + a] as number;
            }
            if ((rest[a + 3] as number) > (cuts[j + a + 3] as number)) {
              const part = rest.slice();
              part[a] = cuts[j + a + 3] as number;
              next.push(part);
              rest[a + 3] = cuts[j + a + 3] as number;
            }
          }
        }
        if (next.length > 8192) return undefined;
        pieces = next;
      }
      for (const p of pieces) {
        if (
          ((p[3] as number) - (p[0] as number)) *
            ((p[4] as number) - (p[1] as number)) *
            ((p[5] as number) - (p[2] as number)) >
          limit
        )
          return undefined;
        for (let z = p[2] as number; z < (p[5] as number); z++)
          for (let y = p[1] as number; y < (p[4] as number); y++)
            for (let x = p[0] as number; x < (p[3] as number); x++) {
              if (++visits > 100_000) return undefined;
              const key = `${x}/${y}/${z}`;
              if (unique.has(key)) continue;
              if (++cells > limit) return undefined;
              unique.add(key);
              coordinates.push(x, y, z);
            }
      }
    }
    return Int32Array.from(coordinates);
  };
  const removed = subtract(before.regions, after.regions);
  if (removed === undefined) return undefined;
  const added = subtract(after.regions, before.regions);
  return added === undefined ? undefined : { removed, added };
}
