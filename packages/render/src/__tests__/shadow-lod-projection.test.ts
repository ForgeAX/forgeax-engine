import { mat4 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { projectedHeightForCandidate } from '../gpu-driven/batch-topology';
import { lodViewCameraFromMatrix, SHADOW_LOD_COARSEST } from '../gpu-driven/production-raster-lod';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { buildGpuLodRows, type GpuLodRow, selectGpuLod } from '../scene/visibility/gpu-lod';
import { projectedHeight as measureProjectedHeight } from '../scene/visibility/lod-selector';

function slotAt(x: number, y: number, z: number): RenderSceneSlot {
  const world = new Float32Array(mat4.identity(mat4.create()));
  world[12] = x;
  world[13] = y;
  world[14] = z;
  return {
    snapshot: {
      localAabb: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
      transform: { world },
    },
  } as unknown as RenderSceneSlot;
}

function viewProjection(projection: Float32Array, eye: readonly number[]): Float32Array {
  const view = mat4.lookAt(mat4.create(), eye, [0, 0, 0], [0, 1, 0]);
  return new Float32Array(mat4.multiply(mat4.create(), projection, view));
}

const RADIUS = Math.hypot(0.5, 0.5, 0.5);

describe('shadow light-view LOD projection', () => {
  it('matches the orthographic camera height in an orthographic light view', () => {
    const matrix = viewProjection(
      new Float32Array(mat4.orthographic(mat4.create(), -8, 8, -4, 4, 0.1, 100)),
      [0, 20, 10],
    );
    expect(
      projectedHeightForCandidate(slotAt(3, 0, -2), lodViewCameraFromMatrix(matrix)),
    ).toBeCloseTo(
      measureProjectedHeight({
        radius: RADIUS,
        depth: 1,
        projection: 'orthographic',
        orthoHeight: 8,
      }),
      6,
    );
  });

  it('matches the perspective camera height along the view axis', () => {
    const fov = Math.PI / 3;
    const matrix = viewProjection(
      new Float32Array(mat4.perspective(mat4.create(), fov, 1, 0.1, 100)),
      [0, 0, 12],
    );
    expect(
      projectedHeightForCandidate(slotAt(0, 0, 0), lodViewCameraFromMatrix(matrix)),
    ).toBeCloseTo(
      measureProjectedHeight({ radius: RADIUS, depth: 12, projection: 'perspective', fov }),
      6,
    );
    expect(
      [...lodViewCameraFromMatrix(matrix).position].map((v) => Math.round(v * 1e4) / 1e4),
    ).toEqual([0, 0, 12]);
  });
});

function chain(coverages: readonly number[], hysteresis = 0.08): readonly GpuLodRow[] {
  return buildGpuLodRows({
    generation: 1,
    hysteresis,
    ranges: coverages.map((_, level) => ({
      firstIndex: level * 12,
      indexCount: 12,
      baseVertex: 0,
    })),
    coverages,
    ready: coverages.map(() => true),
  });
}

const level = (rows: readonly GpuLodRow[], projectedHeight: number) =>
  selectGpuLod(rows, { projectedHeight, previousLevel: 0, historyValid: false }).level;

/** CPU model of view-gpu candidateLod in a view whose LodViewConstants set clamp. */
function shadowLevel(rows: readonly GpuLodRow[], height: number): number {
  const threshold = rows[SHADOW_LOD_COARSEST + 1]?.screenCoverage;
  const floor = threshold === undefined ? 0 : threshold * (1 + (rows[0]?.hysteresis ?? 0));
  return level(rows, height >= 0 ? Math.max(height, floor) : height);
}

describe('shadow view LOD cap', () => {
  it('is the GPU view kernel gate the CPU model and the Dawn harness mirror', () => {
    const kernel = GPU_DRIVEN_VIEW_WGSL.replace(/\s+/g, ' ');
    expect(kernel).toContain(
      `if (view.lod.clamp != 0u && height >= 0.0) { height = max(height, lodCoarsestHeight(${SHADOW_LOD_COARSEST}u, rows, lodCount)); }`,
    );
  });

  it('never selects coarser than SHADOW_LOD_COARSEST, nor coarser than its own light level', () => {
    expect(SHADOW_LOD_COARSEST).toBe(1);
    const rows = chain([1, 0.5, 0.25, 0.1, 0.02]);
    const slot = slotAt(0, 0, 0);
    // A wide cascade shrinks the caster far below every coverage threshold.
    const wide = viewProjection(
      new Float32Array(mat4.orthographic(mat4.create(), -400, 400, -400, 400, 0.1, 100)),
      [0, 20, 10],
    );
    const far = projectedHeightForCandidate(slot, lodViewCameraFromMatrix(wide));
    expect(level(rows, far)).toBe(4);
    expect(shadowLevel(rows, far)).toBe(SHADOW_LOD_COARSEST);
    // A tight view keeps its own finer level.
    const tight = viewProjection(
      new Float32Array(mat4.orthographic(mat4.create(), -1, 1, -1, 1, 0.1, 100)),
      [0, 20, 10],
    );
    expect(
      shadowLevel(rows, projectedHeightForCandidate(slot, lodViewCameraFromMatrix(tight))),
    ).toBe(0);
    // Across the whole height range (hysteresis band included) the cap is min(own, LOD1).
    for (let step = 1; step <= 2000; step++) {
      const height = step / 1000;
      expect(shadowLevel(rows, height), `height ${height}`).toBe(
        Math.min(level(rows, height), SHADOW_LOD_COARSEST),
      );
    }
    // A zero height is ordered, so it takes the cap rather than the root fallback.
    expect(shadowLevel(rows, 0)).toBe(SHADOW_LOD_COARSEST);
  });

  it('leaves invalid heights and chains without an LOD2 uncapped', () => {
    const rows = chain([1, 0.5, 0.25, 0.1]);
    for (const invalid of [Number.NaN, -1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY])
      expect(shadowLevel(rows, invalid)).toBe(level(rows, invalid));
    expect(shadowLevel(rows, Number.NaN)).toBe(0);
    for (const coverages of [[1], [1, 0.5]]) {
      const short = chain(coverages);
      for (const height of [0, 0.01, 0.4, 0.6, 2])
        expect(shadowLevel(short, height)).toBe(level(short, height));
    }
  });
});
