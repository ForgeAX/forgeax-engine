import { describe, expect, it } from 'vitest';
import type { CameraExposure } from '../components/camera';
import { createAutoExposureInspection } from '../pipeline/standard-output/auto-exposure/inspection';

describe('auto-exposure inspection boundary', () => {
  it('returns a detached bounded snapshot of requested, actual, fallback, and LKG', () => {
    const requested: CameraExposure = {
      kind: 'auto',
      fallback: 1,
      compensationEv: 0,
      rangeEv: [-8, 8],
      rates: [3, 1],
    };
    const snapshot = createAutoExposureInspection({
      requested,
      actual: 1.25,
      fallback: 1,
      lastKnownGood: 1.2,
      targetGeneration: 4,
      reset: ['camera-change'],
      cost: { histogramBytes: 1024, passCount: 3, physicalPassCount: 1 },
      receipt: { frameId: 12, committed: true },
    });
    expect(snapshot.requested).toEqual(requested);
    expect(snapshot.actual).toBe(1.25);
    expect(snapshot.actualState).toBe('accepted');
    expect(snapshot.lastKnownGood).toBe(1.2);
    expect(snapshot.targetGeneration).toBe(4);
    expect(snapshot.recentFailure).toBeUndefined();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('histogramBuckets');
    expect(snapshot).not.toHaveProperty('gpuHandle');
    expect(snapshot).not.toHaveProperty('buckets');
  });

  it('does not present the fallback as a measured GPU value after submit', () => {
    const snapshot = createAutoExposureInspection({
      requested: {
        kind: 'auto',
        fallback: 1,
        compensationEv: 0,
        rangeEv: [-8, 8],
        rates: [3, 1],
      },
      actual: null,
      actualState: 'gpu-resident',
      fallback: 1,
      lastKnownGood: 1,
      targetGeneration: 4,
      reset: [],
      cost: { histogramBytes: 1024, passCount: 3, physicalPassCount: 1 },
      receipt: { frameId: 12, committed: true },
    });
    expect(snapshot.actual).toBeNull();
    expect(snapshot.actualState).toBe('gpu-resident');
    expect(snapshot.fallback).toBe(1);
  });

  it('preserves structured recovery failures without message parsing', () => {
    const snapshot = createAutoExposureInspection({
      requested: { kind: 'manual', multiplier: 1 },
      actual: 1,
      fallback: 1,
      lastKnownGood: 1,
      targetGeneration: 7,
      recentFailure: {
        code: 'auto-exposure-capability-unavailable',
        expected: 'compute and storage-buffer capabilities are available',
        hint: 'inspect live capabilities and retry the same camera generation',
        detail: { capability: 'compute', generation: 7 },
      },
      reset: [],
      cost: { histogramBytes: 0, passCount: 0, physicalPassCount: 0 },
      receipt: { frameId: 13, committed: false },
    });
    expect(snapshot.recentFailure?.code).toBe('auto-exposure-capability-unavailable');
    expect(snapshot.recentFailure?.detail).toEqual({ capability: 'compute', generation: 7 });
    expect(snapshot.recentFailure?.hint).toContain('retry');
  });
});
