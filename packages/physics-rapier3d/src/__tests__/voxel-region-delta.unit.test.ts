import type { VoxelShapeInput } from '@forgeax/engine-physics';
import { expect, it } from 'vitest';
import { voxelRegionDelta } from '../voxel-region-delta.js';

const shape = (regions: number[]): VoxelShapeInput => ({
  id: 'test',
  revision: 1,
  kind: 'voxels',
  voxelSize: [1, 1, 1],
  regions: Int32Array.from(regions),
});
const occupancy = (shape: VoxelShapeInput) => {
  const cells = new Set<string>(),
    r = shape.regions;
  for (let i = 0; i < r.length; i += 6)
    for (let z = r[i + 2] as number; z < (r[i + 5] as number); z++)
      for (let y = r[i + 1] as number; y < (r[i + 4] as number); y++)
        for (let x = r[i] as number; x < (r[i + 3] as number); x++) cells.add(`${x}/${y}/${z}`);
  return cells;
};
const keys = (coords: Int32Array) => {
  const out = [];
  for (let i = 0; i < coords.length; i += 3)
    out.push(`${coords[i]}/${coords[i + 1]}/${coords[i + 2]}`);
  return out.sort();
};
it('matches independent occupied-cell union differences for overlapping, reordered and negative regions', () => {
  let seed = 7139;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return seed >>> 0;
  };
  const regions = () =>
    Array.from({ length: 12 }, () => {
      const lo = [0, 0, 0].map(() => (random() % 12) - 6);
      return [...lo, ...lo.map((v) => v + 1 + (random() % 4))];
    }).flat();
  for (let i = 0; i < 100; i++) {
    const a = shape(regions()),
      reordered = Array.from({ length: a.regions.length / 6 }, (_, j) =>
        Array.from(a.regions.subarray(j * 6, j * 6 + 6)),
      )
        .reverse()
        .flat();
    const b = shape(i % 2 ? regions() : reordered);
    const old = occupancy(a),
      next = occupancy(b),
      delta = voxelRegionDelta(a, b);
    expect(delta).toBeDefined();
    if (!delta) throw new Error('Expected a bounded delta');
    expect(keys(delta.removed)).toEqual([...old].filter((k) => !next.has(k)).sort());
    expect(keys(delta.added)).toEqual([...next].filter((k) => !old.has(k)).sort());
  }
});
it('falls back for large changes or a changed voxel scale', () => {
  expect(voxelRegionDelta(shape([0, 0, 0, 20, 20, 20]), shape([0, 0, 0, 1, 1, 1]))).toBeUndefined();
  expect(
    voxelRegionDelta(shape([0, 0, 0, 1, 1, 1]), {
      ...shape([0, 0, 0, 1, 1, 1]),
      voxelSize: [2, 1, 1],
    }),
  ).toBeUndefined();
});
