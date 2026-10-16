import { describe, expect, it } from 'vitest';
import {
  createRecoveryFailedError,
  RECOVERY_PHASES,
  type RecoveryFailureDetail,
} from '../errors/recover';

const receipt = Object.freeze({ owner: 'renderer', generation: 4, resourceCount: 3 });

function detail(overrides: Partial<RecoveryFailureDetail> = {}): RecoveryFailureDetail {
  return {
    phase: 'compile-graph',
    oldGeneration: 4,
    candidateGeneration: 5,
    attempt: 2,
    elapsedMs: 120,
    retryable: true,
    guidance: 'retry',
    owner: 'standard-pipeline',
    resourceKind: 'pipeline',
    lastOutcome: 'failed',
    rehydratedRoots: 3,
    staleLossEvents: 1,
    cause: new Error('candidate failed'),
    cleanupFailures: [],
    receipt,
    ...overrides,
  };
}

describe('renderer recovery error contract', () => {
  it('keeps recovery phases and guidance closed and machine-readable', () => {
    expect(RECOVERY_PHASES).toEqual([
      'quiesce',
      'acquire-adapter',
      'acquire-device',
      'rehydrate',
      'compile-graph',
      'publish',
      'cleanup',
    ]);

    const failure = createRecoveryFailedError(detail());
    expect(failure.code).toBe('recovery-failed');
    expect(failure.expected).toContain('complete replacement');
    expect(failure.hint).toContain('detail');
    expect(failure.detail.phase).toBe('compile-graph');
    expect(failure.detail.oldGeneration).toBe(4);
    expect(failure.detail.candidateGeneration).toBe(5);
    expect(failure.detail.attempt).toBe(2);
    expect(failure.detail.elapsedMs).toBe(120);
    expect(failure.detail.retryable).toBe(true);
    expect(failure.detail.guidance).toBe('retry');
    expect(failure.detail.owner).toBe('standard-pipeline');
    expect(failure.detail.resourceKind).toBe('pipeline');
    expect(failure.detail.lastOutcome).toBe('failed');
    expect(failure.detail.rehydratedRoots).toBe(3);
    expect(failure.detail.staleLossEvents).toBe(1);
    expect(failure.detail.cleanupFailures).toEqual([]);
    expect(Object.isFrozen(failure.detail)).toBe(true);
  });

  it.each([
    ['retry', true],
    ['repair-owner', true],
    ['rebuild-renderer', false],
  ] as const)('preserves the %s guidance branch', (guidance, retryable) => {
    const failure = createRecoveryFailedError(detail({ guidance, retryable }));
    expect(failure.detail.guidance).toBe(guidance);
    expect(failure.detail.retryable).toBe(retryable);
    expect(failure.message).not.toContain('retry');
  });
});
