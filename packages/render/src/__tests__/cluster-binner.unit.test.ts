import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { bin, createClusterBinScratch } from '../cluster-binner';

describe('cluster binner structured boundaries', () => {
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
