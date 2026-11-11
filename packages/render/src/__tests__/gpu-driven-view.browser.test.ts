import { describe, expect, it } from 'vitest';
import { shadowCameraCullDilation } from '../gpu-driven/shadow-views';
import {
  runGpuDrivenMultiBatchVisibleOrderEvidence,
  runGpuDrivenShadowCameraCullEvidence,
  runGpuDrivenSharedMemberGrowthEvidence,
  runGpuDrivenSharedMemberSubmeshEvidence,
  runGpuDrivenViewGpuEvidence,
  runGpuDrivenViewLifecycleEvidence,
  runGpuDrivenVisibleOrderEvidence,
  runSharedGeometryCullEvidence,
} from './gpu-driven-view-gpu-evidence';

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;
const lifecycleFrames = 60;

describe.skipIf(!browserReady)('GPU-driven View Browser WebGPU', () => {
  it.each([
    'separate',
    'combined',
  ] as const)('draws visible instances in candidate order with %s passes', async (mode) => {
    const { instanceCount, rows } = await runGpuDrivenVisibleOrderEvidence(mode);
    const expected = Array.from({ length: instanceCount }, (_, i) => i).filter((i) => i % 3 !== 2);
    for (const row of rows) expect(row).toEqual(expected);
  });

  it.each([
    'separate',
    'combined',
  ] as const)('keeps multi-batch tile order after partial updates with %s passes', async (mode) => {
    const frames = await runGpuDrivenMultiBatchVisibleOrderEvidence(mode);
    expect(frames.map((frame) => frame.stage)).toEqual([
      'initial',
      'grow-first',
      'pose-middle',
      'shrink-first',
      'quiet',
    ]);
    for (const frame of frames)
      for (const batch of frame.batches) {
        expect(batch.actual, `${frame.stage} group ${batch.group}`).toEqual(batch.expected);
      }
    expect(
      frames.map((frame) => frame.batches.find((batch) => batch.group === 1)?.firstCandidate),
    ).toEqual([37, 68, 68, 13, 13]);
  });

  it.each([
    'separate',
    'combined',
  ] as const)('keeps shared submesh visible members and Surface addresses with %s passes', async (mode) => {
    const result = await runGpuDrivenSharedMemberSubmeshEvidence(mode);
    expect(result.batchCount).toBe(96);
    expect(result.candidateCount).toBe(288);
    expect(result.uniqueMemberships).toBe(1);
    for (const batch of result.batches) expect(batch.actual).toEqual(batch.expected);
    const growth = await runGpuDrivenSharedMemberGrowthEvidence(mode);
    expect(growth.map((frame) => frame.candidateCount)).toEqual([34, 94]);
    expect(growth.map((frame) => frame.uniqueMembers)).toEqual([4, 4]);
    expect(growth[1]?.capacities).toEqual(growth[0]?.capacities);
    for (const frame of growth)
      for (const batch of frame.batches) expect(batch.actual).toEqual(batch.expected);
  });

  it('culls edited geometry and displacement through fixed shared descriptors', async () => {
    const evidence = await runSharedGeometryCullEvidence();
    expect(evidence.geometryUpload).toBe(4 * 1024 + 32);
    expect(evidence.frames.map((frame) => frame.visible)).toEqual([0, 1024, 0, 1024, 0]);
    expect(evidence.frames[0]?.sharedInputUploadBytes).toBeGreaterThan(0);
    expect(evidence.frames.slice(1).map((frame) => frame.sharedInputUploadBytes)).toEqual([
      4 * 1024 + 32,
      0,
      4 * 1024 + 12,
      0,
    ]);
  });
  it.each([
    'separate',
    'combined',
  ] as const)('produces real browser indirect args with %s passes', async (mode) => {
    await expect(runGpuDrivenViewGpuEvidence(mode)).resolves.toEqual({
      visibleInstance: 0,
      indexCount: 12,
      instanceCount: 1,
      firstIndex: 9,
      baseVertex: 4,
      firstInstance: 0,
      overflow: 0,
      persistentTranslationX: 0,
      firstReadbackFrame: 10,
      recoveredReadbackFrame: 11,
      firstVisible: 1,
      recoveredVisible: 0,
    });
  });

  it(`survives ${lifecycleFrames} frames of spawn/despawn capacity crossings without stale buffers`, async () => {
    await expect(runGpuDrivenViewLifecycleEvidence(lifecycleFrames)).resolves.toEqual({
      frames: lifecycleFrames,
      bufferRebuilds: 4,
      candidateCapacity: 8,
    });
  }, 30_000);

  it('culls hidden shadow casters against the camera HZB on the browser device', async () => {
    const ndcDilation = shadowCameraCullDilation(1, 0, 64)?.ndcDilation ?? Number.NaN;
    await expect(
      runGpuDrivenShadowCameraCullEvidence({ light: 'camera', wall: 'left', ndcDilation }),
    ).resolves.toEqual({ visible: 2, cameraCulled: 1 });
    await expect(
      runGpuDrivenShadowCameraCullEvidence({ light: 'side', wall: 'left', ndcDilation }),
    ).resolves.toEqual({ visible: 3, cameraCulled: 0 });
  }, 30_000);
});
