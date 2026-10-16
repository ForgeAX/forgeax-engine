import { describe, expect, it } from 'vitest';
import { createRhiDebugError } from '../errors';

describe('RhiDebugError', () => {
  it('exposes the closed code and recovery fields', () => {
    const error = createRhiDebugError('tape-version-unsupported', {
      foundVersion: 5,
      expectedVersion: 7,
    });
    expect(error.code).toBe('tape-version-unsupported');
    expect(error.expected).toContain('7');
    expect(error.hint).toContain('source revision');
    expect(error.detail).toMatchObject({ foundVersion: 5, expectedVersion: 7 });
  });
});
