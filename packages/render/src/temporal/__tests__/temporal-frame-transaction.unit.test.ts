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
  it('detaches once at staging and keeps public results separate from accepted history', () => {
    const transaction = createTemporalFrameTransaction({ deviceEpoch: 4 });
    const input = frame(1);
    input.currentViewProjection[0] = 2;
    transaction.stage(input);
    input.currentViewProjection[0] = 9;
    input.jitter[0] = 3;
    input.viewport.width = 128;
    input.cameraPosition[0] = 7;
    transaction.commit({ accepted: true }).unwrap();
    const committed = transaction.snapshot();
    expect(committed.currentViewProjection[0]).toBe(2);
    expect(committed.jitter).toEqual([0, 0]);
    expect(committed.viewport.width).toBe(64);
    expect(committed.currentCameraPosition[0]).toBe(1);
    committed.currentViewProjection[0] = 8;
    expect(transaction.snapshot().currentViewProjection[0]).toBe(2);
    transaction.stage(frame(2));
    transaction.commit({ accepted: true }).unwrap();
    const next = transaction.snapshot();
    expect(next.previousViewProjection?.[0]).toBe(2);
    expect(transaction.snapshot().currentViewProjection[0]).toBe(0);
    expect(committed.currentViewProjection[0]).toBe(8);
  });

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
