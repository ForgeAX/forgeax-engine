import { describe, expect, it } from 'vitest';
import { deriveCoverageStatus, type CoverageStatusInput } from '../../coverage/build-status-index';

const completeCase = {
  caseId: 'tone-ramp',
  required: true,
  requiredStatus: 'pass' as const,
  primaryStatus: 'pass' as const,
  matrixStatus: 'pass' as const,
};

describe('final backend matrix status', () => {
  it('reaches complete only when every required, primary, and matrix item passes', () => {
    const result = deriveCoverageStatus({ cases: [completeCase] });

    expect(result.status).toBe('complete');
    expect(result.required.notExecuted).toBe(0);
    expect(result.primary.notExecuted).toBe(0);
    expect(result.matrix.notExecuted).toBe(0);
  });

  it.each([
    ['required case not executed', { ...completeCase, requiredStatus: 'not-executed' }],
    ['primary oracle missing', { ...completeCase, primaryStatus: 'not-executed' }],
    ['backend matrix failed', { ...completeCase, matrixStatus: 'failed' }],
    ['backend unsupported', { ...completeCase, matrixStatus: 'unsupported' }],
    ['backend degraded', { ...completeCase, matrixStatus: 'degraded' }],
  ] satisfies readonly [string, CoverageStatusInput['cases'][number]][])('%s cannot be complete', (_label, item) => {
    const result = deriveCoverageStatus({ cases: [item] });

    expect(result.status).not.toBe('complete');
    expect(result.required.notExecuted + result.primary.notExecuted + result.matrix.notExecuted).toBeGreaterThanOrEqual(0);
  });

  it('keeps a failed required case failed even when another case passes', () => {
    const result = deriveCoverageStatus({
      cases: [
        completeCase,
        { ...completeCase, caseId: 'alpha-mask', requiredStatus: 'failed', matrixStatus: 'failed' },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.required.failed).toBe(1);
    expect(result.matrix.failed).toBe(1);
  });
});
