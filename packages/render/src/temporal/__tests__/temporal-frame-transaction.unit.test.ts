import { describe, expect, it } from 'vitest';
import { createTemporalFrameTransaction } from '../frame';

function frame(frameId: number, resetReason?: 'camera-cut') {
  return {
    frameId,
    currentViewProjection: new Float32Array(16),
    jitter: [0, 0] as [number, number],
    viewport: { width: 64, height: 64 },
    cameraPosition: [frameId, 0, 0] as [number, number, number],
    ...(resetReason === undefined ? {} : { resetReason }),
  };
}

describe('renderer temporal candidate lifecycle', () => {
  it('projects a rejected submit while retaining the accepted baseline', () => {
    const transaction = createTemporalFrameTransaction({ deviceEpoch: 4 });
    transaction.stage(frame(1));
    expect(transaction.commit({ accepted: true }).ok).toBe(true);
    const baseline = transaction.snapshot();

    transaction.stage(frame(2));
    expect(transaction.commit({ accepted: false, reason: 'queue-submit-failed' }).ok).toBe(false);
    expect(transaction.snapshot()).toEqual(baseline);
    expect(transaction.inspect()).toEqual({
      accepted: true,
      staged: false,
      lastFailure: 'queue-submit-failed',
    });

    transaction.stage(frame(3));
    expect(transaction.commit({ accepted: true }).ok).toBe(true);
    expect(transaction.inspect()).toEqual({ accepted: true, staged: false });
    expect(transaction.snapshot().frameId).toBe(3);
  });
});
