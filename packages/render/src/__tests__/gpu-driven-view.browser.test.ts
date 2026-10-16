import { describe, expect, it } from 'vitest';
import { shadowCameraCullDilation } from '../gpu-driven/shadow-views';
import {
  runGpuDrivenShadowCameraCullEvidence,
  runGpuDrivenViewGpuEvidence,
  runGpuDrivenViewLifecycleEvidence,
} from './gpu-driven-view-gpu-evidence';

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;
const lifecycleFrames = 60;

describe.skipIf(!browserReady)('GPU-driven View Browser WebGPU', () => {
  it('produces compact visible IDs and portable indirect args on the real browser device', async () => {
    await expect(runGpuDrivenViewGpuEvidence()).resolves.toEqual({
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
