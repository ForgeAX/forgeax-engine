import { mat4 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { projectVolumeCompositeBounds, volumeCompositeScissor } from '../volume/composite-scissor';

const identity = () => mat4.identity(mat4.create());
const box = { min: [-0.2, -0.2, -0.2] as const, max: [0.2, 0.2, 0.2] as const };

describe('volume composite footprint', () => {
  it('covers the accepted owner and three filtered-history texels at actual dimensions', () => {
    const projected = projectVolumeCompositeBounds([box], identity(), [0, 0, 2]);
    const rect = volumeCompositeScissor(projected, 1920, 1080, 240, 135);
    if (rect === undefined) throw new Error('Expected local rect');
    expect(rect[0]).toBeLessThanOrEqual(768 - 26);
    expect(rect[1]).toBeLessThanOrEqual(432 - 26);
    expect(rect[0] + rect[2]).toBeGreaterThanOrEqual(1152 + 26);
    expect(rect[1] + rect[3]).toBeGreaterThanOrEqual(648 + 26);
    expect(rect[2] * rect[3]).toBeLessThan((1920 * 1080) / 8);
  });
  it('unions every member and observes in-place matrix and bounds mutations', () => {
    const matrix = identity();
    const other: { min: [number, number, number]; max: [number, number, number] } = {
      min: [0.6, -0.2, -0.2],
      max: [0.8, 0.2, 0.2],
    };
    const first = projectVolumeCompositeBounds([box, other], matrix, [0, 0, 2]);
    matrix[12] = -0.2;
    other.max[0] = 0.9;
    const next = projectVolumeCompositeBounds([box, other], matrix, [0, 0, 2]);
    expect(first?.[2]).toBeGreaterThan(0.9);
    expect(next?.[2]).toBeLessThan(0.86);
    expect(next?.[0]).toBeLessThan(first?.[0] ?? 0);
  });
  it('retains full raster for perspective camera/near-plane crossings', () => {
    const perspective = mat4.create();
    mat4.perspectiveReverseZ(perspective, Math.PI / 3, 16 / 9, 0.1, 1000);
    expect(projectVolumeCompositeBounds([box], perspective, [0, 0, 0])).toBeUndefined();
    expect(
      projectVolumeCompositeBounds([{ min: [-1, -1, -2], max: [1, 1, 0] }], perspective, [0, 0, 0]),
    ).toBeUndefined();
    const far = projectVolumeCompositeBounds(
      [{ min: [-1, -1, -20], max: [1, 1, -18] }],
      perspective,
      [0, 0, 0],
    );
    expect(volumeCompositeScissor(far, 1920, 1080, 240, 135)?.[2]).toBeLessThan(200);
  });
  it('keeps positive-w near-plane crossings and camera-inside owners fullscreen', () => {
    const perspective = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.1, 100);
    expect(
      projectVolumeCompositeBounds(
        [{ min: [-0.001, -0.001, -0.06], max: [0.001, 0.001, -0.04] }],
        perspective,
        [0, 0, 0],
      ),
    ).toBeUndefined();
    expect(projectVolumeCompositeBounds([box], identity(), [0, 0, 0])).toBeUndefined();
    expect(projectVolumeCompositeBounds([box], identity(), [Number.NaN, 0, 2])).toBeUndefined();
  });
  it('maps normalized bounds to the actual target and keeps empty work with the source gate', () => {
    const bounds = [0.4, 0.3, 0.6, 0.7] as const;
    const rect = volumeCompositeScissor(bounds, 800, 600, 100, 75);
    if (rect === undefined) throw new Error('Expected target-local rectangle');
    expect(rect).toEqual([294, 154, 212, 292]);
    expect(volumeCompositeScissor(bounds, 400, 300, 50, 37)).toEqual([134, 63, 132, 174]);
    expect(volumeCompositeScissor([0.8, 0.3, 0.5, 0.7], 800, 600, 100, 75)).toBeUndefined();
  });
  it('retains full raster on unknown, invalid, complete, or empty rects', () => {
    expect(projectVolumeCompositeBounds([], identity(), [0, 0, 2])).toBeUndefined();
    expect(
      projectVolumeCompositeBounds([{ min: [0, 0, 0], max: [0, 1, 1] }], identity(), [0, 0, 2]),
    ).toBeUndefined();
    const matrix = identity();
    matrix[0] = Number.NaN;
    expect(projectVolumeCompositeBounds([box], matrix, [0, 0, 2])).toBeUndefined();
    for (const bounds of [undefined, [-1, -1, 2, 2] as const, [2, 2, 3, 3] as const])
      expect(volumeCompositeScissor(bounds, 1920, 1080, 240, 135)).toBeUndefined();
    expect(volumeCompositeScissor([0.4, 0.4, 0.6, 0.6], 1920, 1080, 0, 135)).toBeUndefined();
  });
});
