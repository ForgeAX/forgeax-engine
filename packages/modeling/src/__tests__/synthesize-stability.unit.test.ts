import { describe, expect, it } from 'vitest';
import { type StabilityCheck, stabilityOf } from '../tools/synthesize-tool';

const check = (value: number, jaccard: number, failed = false): StabilityCheck => ({
  parameter: 'spokes',
  value,
  jaccard,
  expected: 10,
  matched: failed ? 0 : Math.round(jaccard * 10),
  lost: failed ? 10 : 10 - Math.round(jaccard * 10),
  ...(failed
    ? {
        error: {
          code: 'model-capture-failed',
          expected: 'the rebuild verifies the selector',
          hint: 'timed out',
        },
      }
    : {}),
});

describe('synthesize stability', () => {
  it('is stable only when every rebuild verified J = 1', () => {
    expect(stabilityOf(true, false, [check(5, 1), check(10, 1)])).toBe('stable');
  });

  it('reads an unverifiable rebuild as unchecked, never unstable', () => {
    // Falsifier: a capture that timed out under load used to make a sound selector unstable.
    expect(stabilityOf(true, false, [check(5, 1), check(10, 0, true)])).toBe('unchecked');
    expect(stabilityOf(true, false, [])).toBe('unchecked');
  });

  it('stays unstable on a verified miss, whatever else failed', () => {
    expect(stabilityOf(true, false, [check(5, 1), check(10, 0.5)])).toBe('unstable');
    expect(stabilityOf(true, false, [check(5, 0.5), check(10, 0, true)])).toBe('unstable');
    expect(stabilityOf(false, false, [check(5, 1)])).toBe('unstable');
    expect(stabilityOf(true, true, [check(5, 1)])).toBe('unstable');
  });
});
