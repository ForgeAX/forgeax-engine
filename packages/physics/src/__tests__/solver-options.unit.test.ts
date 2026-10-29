import { describe, expect, it } from 'vitest';
import { PhysicsError, validateSolverIterations } from '../index.js';

describe('global solver iterations', () => {
  it('defaults to four iterations when omitted', () => {
    expect(validateSolverIterations()).toBe(4);
  });

  it.each([1, 2, 4, 8, 32])('accepts %s iterations', (value) => {
    expect(validateSolverIterations(value)).toBe(value);
  });

  it.each([
    0,
    -1,
    1.5,
    33,
    NaN,
    Infinity,
    -Infinity,
    null,
    '2',
  ])('rejects invalid precision %s without clamping', (value) => {
    try {
      validateSolverIterations(value as number);
      throw new Error('Expected invalid solverIterations to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(PhysicsError);
      expect(error).toMatchObject({
        code: 'invalid-body-config',
        detail: { code: 'invalid-body-config', field: 'solverIterations', value },
      });
    }
  });
});
