import { describe, expect, it } from 'vitest';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppErrorCode } from '../index';

const EXECUTION_CODES = [
  'app-execution-worker-unavailable',
  'app-execution-bootstrap-failed',
  'app-execution-deadline-exceeded',
  'app-execution-kernel-failed',
  'app-execution-stale-world',
  'app-execution-rebuild-failed',
] as const satisfies readonly AppErrorCode[];

describe('execution errors', () => {
  it('has executable expected and hint tables for every execution code', () => {
    for (const code of EXECUTION_CODES) {
      expect(APP_EXPECTED[code].length).toBeGreaterThan(0);
      expect(APP_ERROR_HINTS[code].length).toBeGreaterThan(0);
    }
  });

  it('exposes unavailable facts without message parsing', () => {
    const error = new AppError({
      code: 'app-execution-worker-unavailable',
      expected: APP_EXPECTED['app-execution-worker-unavailable'],
      hint: APP_ERROR_HINTS['app-execution-worker-unavailable'],
      detail: {
        worker: 'kernels' as const,
        reason: 'capability-unavailable' as const,
        missingCapabilities: ['sharedArrayBuffer'],
      },
    });
    expect(error.detail.worker).toBe('kernels');
    expect(error.detail.missingCapabilities).toEqual(['sharedArrayBuffer']);
  });
});
