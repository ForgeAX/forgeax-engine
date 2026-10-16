import { describe, expect, it } from 'vitest';
import { deriveCaseStatus, type CaseStatusInput } from '../../report/status';

describe('per-case evaluator status', () => {
  it.each<[CaseStatusInput, string]>([
    [{ capabilityStatus: 'missing', executionStatus: 'notExecuted', verdict: 'failed' }, 'failed'],
    [{ capabilityStatus: 'supported', executionStatus: 'notExecuted', verdict: 'notRun' }, 'partial'],
    [{ capabilityStatus: 'degraded', executionStatus: 'complete', verdict: 'passed' }, 'partial'],
  ])('does not promote incomplete state %j', (input, expected) => {
    expect(deriveCaseStatus(input)).toBe(expected);
  });
});
