import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import {
  bin,
  calculateSphereClusterBounds,
  clusterSpaceObjectAabb,
  createClusterBinScratch,
} from '../cluster-binner';

function makeInputs() {
  const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
  const proj = mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100);
  const grid = { x: 4, y: 3, z: 4 };
  return { view, proj, grid };
}

describe('cluster binner scratch path', () => {
  it('preserves cluster-major light ordering across scratch reuse', () => {
    const { view, proj, grid } = makeInputs();
    const lights = [
      { position: vec3.create(-1, 0, -4), range: 2 },
      { position: vec3.create(1, 0, -5), range: 2 },
    ];
    const scratch = createClusterBinScratch();
    const firstGrid = new Uint32Array(grid.x * grid.y * grid.z * 2);
    const firstIndices = new Uint32Array(128);
    const secondGrid = new Uint32Array(firstGrid.length);
    const secondIndices = new Uint32Array(firstIndices.length);

    const firstResult = bin(
      lights,
      view,
      proj,
      grid,
      0.1,
      100,
      firstGrid,
      firstIndices,
      128,
      scratch,
    );
    const secondResult = bin(
      lights,
      view,
      proj,
      grid,
      0.1,
      100,
      secondGrid,
      secondIndices,
      128,
      scratch,
    );
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    if (firstResult.ok && secondResult.ok) {
      expect(firstResult.value).toBeGreaterThan(0);
      expect(secondResult.value).toBe(firstResult.value);
    }
    expect(Array.from(secondGrid)).toEqual(Array.from(firstGrid));
    expect(Array.from(secondIndices)).toEqual(Array.from(firstIndices));
  });

  it('reports overflow before writing a partial cluster layout', () => {
    const { view, proj, grid } = makeInputs();
    const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2).fill(7);
    const lightIndexList = new Uint32Array(8).fill(9);
    const result = bin(
      [{ position: vec3.create(0, 0, -4), range: 100 }],
      view,
      proj,
      grid,
      0.1,
      100,
      clusterGrid,
      lightIndexList,
      0,
      createClusterBinScratch(),
    );

    expect(result.ok).toBe(false);
    expect(clusterGrid.every((value) => value === 0)).toBe(true);
    expect(lightIndexList.every((value) => value === 9)).toBe(true);
  });

  it('matches independently reconstructed counts and ascending light order', () => {
    const { view, proj, grid } = makeInputs();
    const lights = [
      { position: vec3.create(-1, 0, -4), range: 2 },
      { position: vec3.create(1, 0, -5), range: 2 },
      { position: vec3.create(0, 1, -7), range: 1 },
    ];
    const clusterCount = grid.x * grid.y * grid.z;
    const clusterGrid = new Uint32Array(clusterCount * 2);
    const lightIndexList = new Uint32Array(256);
    const result = bin(
      lights,
      view,
      proj,
      grid,
      0.1,
      100,
      clusterGrid,
      lightIndexList,
      lightIndexList.length,
      createClusterBinScratch(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedCounts = new Uint32Array(clusterCount);
    const expectedIndices: number[] = [];
    const bounds = lights.map((light) =>
      calculateSphereClusterBounds(
        clusterSpaceObjectAabb(light.position, light.range, view, proj),
        grid.x,
        grid.y,
        grid.z,
        0.1,
        100,
      ),
    );
    for (let clusterIdx = 0; clusterIdx < clusterCount; clusterIdx++) {
      const cz = Math.floor(clusterIdx / (grid.x * grid.y));
      const rem = clusterIdx - cz * grid.x * grid.y;
      const cy = Math.floor(rem / grid.x);
      const cx = rem - cy * grid.x;
      for (let lightIdx = 0; lightIdx < bounds.length; lightIdx++) {
        const bound = bounds[lightIdx];
        if (
          bound !== undefined &&
          cx >= bound.min.x &&
          cx <= bound.max.x &&
          cy >= bound.min.y &&
          cy <= bound.max.y &&
          cz >= bound.min.z &&
          cz <= bound.max.z
        ) {
          expectedCounts[clusterIdx] = (expectedCounts[clusterIdx] ?? 0) + 1;
        }
      }
    }

    let expectedOffset = 0;
    const expectedGrid = new Uint32Array(clusterCount * 2);
    for (let clusterIdx = 0; clusterIdx < clusterCount; clusterIdx++) {
      expectedGrid[clusterIdx * 2] = expectedOffset;
      expectedGrid[clusterIdx * 2 + 1] = expectedCounts[clusterIdx] ?? 0;
      for (let lightIdx = 0; lightIdx < bounds.length; lightIdx++) {
        const bound = bounds[lightIdx];
        if (
          bound !== undefined &&
          Math.floor(clusterIdx / (grid.x * grid.y)) >= bound.min.z &&
          Math.floor(clusterIdx / (grid.x * grid.y)) <= bound.max.z &&
          Math.floor((clusterIdx % (grid.x * grid.y)) / grid.x) >= bound.min.y &&
          Math.floor((clusterIdx % (grid.x * grid.y)) / grid.x) <= bound.max.y &&
          clusterIdx % grid.x >= bound.min.x &&
          clusterIdx % grid.x <= bound.max.x
        ) {
          expectedIndices.push(lightIdx);
        }
      }
      expectedOffset += expectedCounts[clusterIdx] ?? 0;
    }

    expect(result.value).toBe(expectedIndices.length);
    expect(Array.from(clusterGrid)).toEqual(Array.from(expectedGrid));
    expect(Array.from(lightIndexList.slice(0, result.value))).toEqual(expectedIndices);
  });

  it('reuses AABB and bounds outputs without changing helper results', () => {
    const { view, proj, grid } = makeInputs();
    const scratch = createClusterBinScratch();
    const lights = [
      { position: vec3.create(-1, 0, -4), range: 2 },
      { position: vec3.create(1, 0, -5), range: 2 },
      { position: vec3.create(0, 1, -7), range: 1 },
    ];

    for (const light of lights) {
      const allocatingAabb = clusterSpaceObjectAabb(light.position, light.range, view, proj);
      const reusedAabb = clusterSpaceObjectAabb(
        light.position,
        light.range,
        view,
        proj,
        scratch.aabbOutput,
      );
      const allocatingBounds = calculateSphereClusterBounds(
        allocatingAabb,
        grid.x,
        grid.y,
        grid.z,
        0.1,
        100,
      );
      const reusedBounds = calculateSphereClusterBounds(
        reusedAabb,
        grid.x,
        grid.y,
        grid.z,
        0.1,
        100,
        scratch.boundsOutput,
      );

      expect(Array.from(reusedAabb.min)).toEqual(Array.from(allocatingAabb.min));
      expect(Array.from(reusedAabb.max)).toEqual(Array.from(allocatingAabb.max));
      expect(reusedBounds).toEqual(allocatingBounds);
      expect(reusedAabb).toBe(scratch.aabbOutput);
      expect(reusedBounds).toBe(scratch.boundsOutput);
    }
  });

  it('can reserve the ordered ranges without materializing the CPU membership list', () => {
    const { view, proj, grid } = makeInputs();
    const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2);
    const lightIndexList = new Uint32Array(256).fill(0xcafe);
    const result = bin(
      [{ position: vec3.create(0, 0, -4), range: 2 }],
      view,
      proj,
      grid,
      0.1,
      100,
      clusterGrid,
      lightIndexList,
      lightIndexList.length,
      createClusterBinScratch(),
      undefined,
      { writeMembership: false },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBeGreaterThan(0);
    expect(clusterGrid.some((value) => value > 0)).toBe(true);
    expect(lightIndexList.every((value) => value === 0xcafe)).toBe(true);
  });

  it('reports the bounded phases around the existing passes', () => {
    const { view, proj, grid } = makeInputs();
    const phases: string[] = [];
    const result = bin(
      [{ position: vec3.create(0, 0, -4), range: 2 }],
      view,
      proj,
      grid,
      0.1,
      100,
      new Uint32Array(grid.x * grid.y * grid.z * 2),
      new Uint32Array(128),
      128,
      createClusterBinScratch(),
      (phase, action) => {
        phases.push(phase);
        return action();
      },
    );

    expect(result.ok).toBe(true);
    expect(phases).toEqual([
      'light-bounds-and-occupancy',
      'light-bounds-and-occupancy/light-aabb',
      'light-bounds-and-occupancy/cluster-occupancy',
      'cluster-reserve',
      'light-index-write',
      'light-index-write/bounds-read',
      'light-index-write/cluster-write',
    ]);
  });
});
