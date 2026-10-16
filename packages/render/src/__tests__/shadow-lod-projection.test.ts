import { mat4 } from '@forgeax/engine-math';
import { describe, expect, it, vi } from 'vitest';
import type { GpuDrivenBatch, SubmissionPlan } from '../gpu-driven/batch-topology';
import { projectedHeightForCandidate } from '../gpu-driven/batch-topology';
import {
  lodProjectionState,
  lodSelectionChangeCount,
  lodViewCameraFromMatrix,
  prepareLodProjectionPlan,
  rasterLodDraws,
  SHADOW_LOD_MAX_COARSER,
  shadowLodHeightFloor,
  shadowLodProjectionState,
} from '../gpu-driven/production-raster-lod';
import type { CameraSnapshot } from '../render-contract';
import type { RenderSceneSlot } from '../scene/render-scene-types';
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

  it('never selects more than the allowed levels coarser than the main camera', () => {
    const source = {
      key: { first: 0, count: 36, baseVertex: 0 },
      lod: {
        coverages: [1, 0.5, 0.25, 0.1, 0.02],
        hysteresis: 0.08,
        ranges: [
          { first: 36, count: 24, baseVertex: 0 },
          { first: 60, count: 12, baseVertex: 0 },
          { first: 72, count: 6, baseVertex: 0 },
          { first: 78, count: 3, baseVertex: 0 },
        ],
      },
    } as unknown as GpuDrivenBatch;
    const prepared = {
      lodPlan: { groups: [{ source, primitiveIndex: 0, candidateCount: 1 }], primitives: [0] },
    };
    const slot = slotAt(0, 0, 0);
    const camera = {
      projection: 'perspective',
      fov: Math.PI / 3,
      position: new Float32Array([0, 0, 2]),
      orthoTop: 1,
      orthoBottom: -1,
    } as unknown as CameraSnapshot;
    const main = lodProjectionState(prepared, camera, () => slot);
    const mainLevel = main.selections[0]?.[0] ?? -1;
    expect(mainLevel).toBe(0);

    // A wide cascade shrinks the caster far below every coverage threshold.
    const wide = viewProjection(
      new Float32Array(mat4.orthographic(mat4.create(), -400, 400, -400, 400, 0.1, 100)),
      [0, 20, 10],
    );
    const shadow = shadowLodProjectionState(prepared, wide, main, () => slot);
    const levels = shadow.selections[0] ?? [];
    expect(Math.max(...levels)).toBe(mainLevel + SHADOW_LOD_MAX_COARSER);

    // A tight view keeps its own finer level.
    const tight = viewProjection(
      new Float32Array(mat4.orthographic(mat4.create(), -1, 1, -1, 1, 0.1, 100)),
      [0, 20, 10],
    );
    expect(shadowLodProjectionState(prepared, tight, main, () => slot).selections[0]).toEqual([0]);
  });
});

function batch(primitives: readonly number[], crossfade = true, scale = 1): GpuDrivenBatch {
  return {
    candidates: primitives.map((primitiveIndex, instanceIndex) => ({
      primitiveIndex,
      instanceIndex,
    })),
    prepared: {
      identity: {
        material: crossfade ? 'forgeax::default-standard-pbr' : 'custom',
        deformation: 'rigid',
      },
    },
    lod: {
      coverages: [1, 0.5 * scale, 0.25 * scale, 0.1 * scale, 0.02 * scale],
      hysteresis: 0.08,
      ranges: Array.from({ length: 4 }, (_, at) => ({ first: at * 12, count: 12, baseVertex: 0 })),
    },
  } as unknown as GpuDrivenBatch;
}

function plan(batches: readonly GpuDrivenBatch[]): SubmissionPlan {
  return { batches } as SubmissionPlan;
}

function cameraAt(z: number): CameraSnapshot {
  return {
    projection: 'perspective',
    fov: Math.PI / 3,
    position: new Float32Array([0, 0, z]),
    orthoTop: 1,
    orthoBottom: -1,
  } as CameraSnapshot;
}

describe('instance-independent LOD projection', () => {
  it('preserves expanded main and shadow selections across thresholds and distinct owners', () => {
    const sources = [
      batch([0, 1, 0, 2, 1]),
      batch([0, 0, 1], false, 0.6),
      batch([0, 1], true, 0.3),
    ];
    // Missing LOD range exercises root fallback within the cross-fade selector.
    sources.push({
      ...batch([0, 1, 0]),
      lod: { ...sources[0]?.lod, coverages: [1, 0.5, 0.25, 0.1], ranges: [] },
    } as GpuDrivenBatch);
    const prepared = { lodPlan: prepareLodProjectionPlan(plan(sources)) };
    const slots = new Map([
      [0, slotAt(0, 0, 0)],
      [1, slotAt(3, 0, -2)],
    ]);
    const slot = (primitive: number) => slots.get(primitive);
    const matrices = [
      new Float32Array(mat4.orthographic(mat4.create(), -400, 400, -400, 400, 0.1, 100)),
      new Float32Array(mat4.orthographic(mat4.create(), -1, 1, -1, 1, 0.1, 100)),
      viewProjection(
        new Float32Array(mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100)),
        [0, 0, 20],
      ),
    ];
    for (const depth of [0, 0.5, 2, 3.2, 3.5, 6.4, 7, 16, 80, Number.NaN]) {
      const camera = cameraAt(depth);
      const main = lodProjectionState(prepared, camera, slot);
      for (const matrix of matrices) {
        const shadow = shadowLodProjectionState(prepared, matrix, main, slot);
        const expectedHeights = new Map<number, number>();
        for (const source of sources) {
          for (const candidate of source.candidates) {
            const owner = slot(candidate.primitiveIndex);
            const mainHeight =
              owner === undefined ? Number.NaN : projectedHeightForCandidate(owner, camera);
            const mainLevels = rasterLodDraws(source, source.lod, mainHeight).map(
              (draw) => draw.level,
            );
            const index = prepared.lodPlan.groups.findIndex(
              (group) =>
                group.source === source && group.primitiveIndex === candidate.primitiveIndex,
            );
            expect(main.selections[index]).toEqual(mainLevels);
            const light =
              owner === undefined
                ? Number.NaN
                : projectedHeightForCandidate(owner, lodViewCameraFromMatrix(matrix));
            const height = Number.isFinite(light)
              ? Math.max(light, shadowLodHeightFloor(source.lod, Math.min(...mainLevels)))
              : Number.NaN;
            expectedHeights.set(candidate.primitiveIndex, height);
            expect(shadow.selections[index]).toEqual(
              rasterLodDraws(source, source.lod, height).map((draw) => draw.level),
            );
          }
        }
        expect(shadow.projectedHeights).toEqual(expectedHeights);
      }
    }
  });

  it('bounds projection and selection storage by primitive owners rather than instance count', () => {
    const source = batch(Array.from({ length: 10_000 }, (_, at) => at % 2));
    const prepared = { lodPlan: prepareLodProjectionPlan(plan([source])) };
    expect(prepared.lodPlan.groups.map((group) => group.candidateCount)).toEqual([5000, 5000]);
    const slot = vi.fn(() => slotAt(0, 0, 0));
    const main = lodProjectionState(prepared, cameraAt(2), slot);
    expect(slot).toHaveBeenCalledTimes(2);
    expect(main.selections).toHaveLength(2);
    const snapshot = JSON.stringify(main.selections);
    slot.mockClear();
    shadowLodProjectionState(prepared, new Float32Array(mat4.identity(mat4.create())), main, slot);
    expect(slot).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(main.selections)).toBe(snapshot);
    expect(
      lodSelectionChangeCount(main.selections, [[1], main.selections[1] ?? []], prepared.lodPlan),
    ).toBe(5000);
    expect(lodSelectionChangeCount([], main.selections, prepared.lodPlan)).toBe(10_000);
  });

  it('ignores single-level batches and retains discrete identity through continuous motion', () => {
    const single = { ...batch([0, 1]), lod: { coverages: [1], ranges: [] } } as GpuDrivenBatch;
    const prepared = { lodPlan: prepareLodProjectionPlan(plan([single, batch([0, 0])])) };
    expect(prepared.lodPlan.groups).toHaveLength(1);
    const left = lodProjectionState(prepared, cameraAt(2), () => slotAt(0, 0, 0));
    const right = lodProjectionState(prepared, cameraAt(2.01), () => slotAt(0, 0, 0));
    expect(left.projectedHeights).not.toEqual(right.projectedHeights);
    expect(left.selectionFingerprint).toBe(right.selectionFingerprint);
    expect(lodSelectionChangeCount(left.selections, right.selections, prepared.lodPlan)).toBe(0);
    expect(prepareLodProjectionPlan(plan([single])).groups).toHaveLength(0);
  });
});
