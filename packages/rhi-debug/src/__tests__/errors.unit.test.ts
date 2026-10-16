import { describe, expect, it } from 'vitest';
import { createRhiDebugError, type RhiDebugError } from '../errors';

function describeError(error: RhiDebugError): string {
  switch (error.code) {
    case 'capture-unavailable':
    case 'capture-busy':
    case 'capture-snapshot-failed':
    case 'capture-timeout':
    case 'tape-invalid':
    case 'tape-version-unsupported':
    case 'replay-capability-mismatch':
    case 'replay-event-failed':
    case 'replay-position-invalid':
    case 'readback-failed':
    case 'readback-unsupported':
      return `${error.code}:${error.hint}`;
  }
}

describe('RhiDebugError', () => {
  it('keeps capture failures structured at the snapshot boundary', () => {
    const error = createRhiDebugError('capture-snapshot-failed', {
      stage: 'snapshot',
      cause: 'texture readback failed during map',
      handleId: 'texture:7',
      resourceKind: 'texture',
    });

    expect(error.code).toBe('capture-snapshot-failed');
    expect(error.expected).toContain('capture');
    expect(error.detail).toEqual({
      stage: 'snapshot',
      cause: 'texture readback failed during map',
      handleId: 'texture:7',
      resourceKind: 'texture',
    });
  });

  it('keeps tape graph failures in the tape validation owner', () => {
    const error = createRhiDebugError('tape-invalid', {
      stage: 'validate',
      cause: 'handleId texture:7 has no create event',
      handleId: 'texture:7',
      eventIndex: 42,
    });

    expect(error.detail.stage).toBe('validate');
    expect(error.detail.handleId).toBe('texture:7');
    expect(error.detail.eventIndex).toBe(42);
  });

  it('keeps bounded snapshot timeout progress machine-readable', () => {
    const error = createRhiDebugError('capture-timeout', {
      stage: 'snapshot',
      cause: 'queue drain exceeded the bound',
      timeoutMs: 1000,
      progress: {
        snapshotStage: 'queue-drain',
        totalResources: 4,
        completedResources: 1,
        skippedResources: 0,
        currentHandleId: 'buffer:readback',
        currentKind: 'buffer',
        currentSizeBytes: 128,
        elapsedMs: 1001,
      },
    });

    expect(error.detail.progress?.currentHandleId).toBe('buffer:readback');
    expect(error.detail.timeoutMs).toBe(1000);
  });

  it('supports an exhaustive consumer switch over the closed union', () => {
    const error = createRhiDebugError('readback-unsupported', {
      stage: 'readback',
      format: 'depth24plus',
      reason: 'the backend has no depth blit path',
    });

    expect(describeError(error)).toContain('readback-unsupported');
  });
});
