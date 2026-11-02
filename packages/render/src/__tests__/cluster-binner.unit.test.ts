import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { bin, createClusterBinScratch } from '../cluster-binner';

describe('cluster binner structured boundaries', () => {
  it.each([
    false,
    true,
  ])('keeps ordinary and profiled ordered writes identical, materialize=%s', (writeMembership) => {
    const grid = { x: 5, y: 3, z: 7 };
    const view = mat4.lookAt(mat4.create(), [1, 2, 3], [0, 0, -4], [0, 1, 0]);
    const projection = mat4.perspective(mat4.create(), Math.PI / 3, 1.4, 0.1, 100);
    for (const capacity of [0, 4096]) {
      for (const count of [0, 1, 8, 32]) {
        const lights = Array.from({ length: count }, (_, index) => ({
          position: vec3.create((index % 7) - 3, (index % 5) - 2, -index - 2),
          range: index % 4 === 0 ? Number.POSITIVE_INFINITY : index % 4 === 1 ? 0 : (index % 9) + 1,
        }));
        const outputs = [];
        for (const observed of [false, true]) {
          const gridBacking = new Uint32Array(grid.x * grid.y * grid.z * 2 + 4).fill(0xcafe);
          const indexBacking = new Uint32Array(4100).fill(0xbeef);
          const clusterGrid = gridBacking.subarray(2, gridBacking.length - 2);
          const indices = indexBacking.subarray(2, indexBacking.length - 2);
          const scratch = createClusterBinScratch();
          const result = bin(
            lights,
            view,
            projection,
            grid,
            0.1,
            100,
            clusterGrid,
            indices,
            capacity,
            scratch,
            observed ? (_phase, action) => action() : undefined,
            { writeMembership },
          );
          outputs.push({
            result,
            gridBacking,
            indexBacking,
            lightBounds: scratch.lightBounds.slice(),
          });
          expect(gridBacking.subarray(0, 2)).toEqual(new Uint32Array([0xcafe, 0xcafe]));
          expect(gridBacking.subarray(gridBacking.length - 2)).toEqual(
            new Uint32Array([0xcafe, 0xcafe]),
          );
          expect(indexBacking.subarray(0, 2)).toEqual(new Uint32Array([0xbeef, 0xbeef]));
          expect(indexBacking.subarray(indexBacking.length - 2)).toEqual(
            new Uint32Array([0xbeef, 0xbeef]),
          );
          if (!writeMembership) expect(indices.every((value) => value === 0xbeef)).toBe(true);
        }
        expect(outputs[0]).toEqual(outputs[1]);
      }
    }
  });

  it('returns a complete structured overflow without truncating output', () => {
    const grid = { x: 4, y: 3, z: 4 };
    const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
    const projection = mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100);
    const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2).fill(7);
    const lightIndexList = new Uint32Array(1).fill(9);
    const result = bin(
      [{ position: vec3.create(0, 0, -4), range: 100 }],
      view,
      projection,
      grid,
      0.1,
      100,
      clusterGrid,
      lightIndexList,
      0,
      createClusterBinScratch(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('index-overflow');
    expect(result.error.expected).toContain('writeCount <= 0');
    expect(result.error.hint).toContain('reduce lights');
    expect(result.error.detail.actual).toBeGreaterThan(0);
    expect(result.error.detail.capacity).toBe(0);
    expect(Array.from(clusterGrid)).toEqual(new Array(clusterGrid.length).fill(0));
    expect(Array.from(lightIndexList)).toEqual([9]);
  });
});
