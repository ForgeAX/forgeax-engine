// errors-pointer-lock-failed.test.ts -- M2 w10: AppErrorCode closed union
// (6 members) + 'app-pointer-lock-failed' detail shape + exhaustive switch
// + APP_EXPECTED / APP_ERROR_HINTS bidirectional symmetry.
//
// TDD red phase: this test is written BEFORE the 'app-pointer-lock-failed'
// member lands in errors.ts (w12). It will fail typecheck / assertions until
// w12 expands the union and adds the detail variant.
//
// charter awareness:
//   P3 explicit failure -- every assertion produces a clear diagnostic
//   P4 closed-union exhaustive switch -- zero default branch, tsc guards completeness

import { describe, expect, it } from 'vitest';
import {
  APP_ERROR_HINTS,
  APP_EXPECTED,
  AppError,
  type AppErrorCode,
  type AppErrorDetail,
  type AppErrorDetailFor,
  isAppError,
} from '../errors';

// ---------------------------------------------------------------------------
// 1. AppErrorCode closed union
// ---------------------------------------------------------------------------

describe('AppErrorCode closed union', () => {
  it('has every source-owned member', () => {
    // Verify the full set of members. When 'app-pointer-lock-failed' is added
    // in w12, this set will be complete and the exhaustive-switch check below
    // will pass tsc with no default branch.
    const allCodes: AppErrorCode[] = [
      'app-not-started',
      'app-already-running',
      'app-canvas-detached',
      'app-frame-step-invalid',
      'app-system-update-failed',
      'app-pointer-lock-failed',
      'app-plugin-activation-failed',
      'app-execution-worker-unavailable',
      'app-execution-bootstrap-failed',
      'app-execution-deadline-exceeded',
      'app-execution-kernel-failed',
      'app-execution-rebuild-failed',
      'app-renderer-inspection-unavailable',
    ];

    expect(allCodes).toHaveLength(13);

    // Each member must be unique.
    const unique = new Set(allCodes);
    expect(unique.size).toBe(13);
  });

  it('exhaustive switch over AppErrorCode has zero default branch', () => {
    // This function MUST compile with no default. If a member is missing from
    // the union, tsc will flag the switch as non-exhaustive. If a member is
    // removed from the union but left here, tsc will flag the dead case.
    // The test assertion itself is trivially true -- the test is the
    // compile-time guarantee.
    function exhaust(code: AppErrorCode): string {
      switch (code) {
        case 'app-not-started':
          return 'not started';
        case 'app-already-running':
          return 'already running';
        case 'app-canvas-detached':
          return 'canvas detached';
        case 'app-frame-step-invalid':
          return 'frame step invalid';
        case 'app-system-update-failed':
          return 'system update failed';
        case 'app-pointer-lock-failed':
          return 'pointer lock failed';
        case 'app-plugin-activation-failed':
          return 'plugin activation failed';
        case 'app-execution-worker-unavailable':
        case 'app-execution-bootstrap-failed':
        case 'app-execution-deadline-exceeded':
        case 'app-execution-kernel-failed':
        case 'app-renderer-inspection-unavailable':
        case 'app-execution-rebuild-failed':
          return 'execution';
      }
    }

    // Verify the function is callable for representative codes.
    expect(exhaust('app-not-started')).toBe('not started');
    expect(exhaust('app-already-running')).toBe('already running');
    expect(exhaust('app-canvas-detached')).toBe('canvas detached');
    expect(exhaust('app-system-update-failed')).toBe('system update failed');
    expect(exhaust('app-pointer-lock-failed')).toBe('pointer lock failed');
  });
});

// ---------------------------------------------------------------------------
// 2. 'app-pointer-lock-failed' detail shape
// ---------------------------------------------------------------------------

describe("'app-pointer-lock-failed' detail shape", () => {
  it('has .code === "app-pointer-lock-failed"', () => {
    const err = new AppError({
      code: 'app-pointer-lock-failed',
      expected: 'pointer-lock request to succeed',
      hint: 'remain in unlocked state; next trusted click will retry',
      detail: { path: 'w3c', cause: new Error('test') },
    });
    expect(err.code).toBe('app-pointer-lock-failed');
  });

  it('detail.path narrows to "w3c" | "provider"', () => {
    const w3cErr = new AppError({
      code: 'app-pointer-lock-failed',
      expected: 'pointer-lock request to succeed',
      hint: 'remain in unlocked state; next trusted click will retry',
      detail: { path: 'w3c', cause: new DOMException('test', 'NotAllowedError') },
    });
    expect(w3cErr.detail.path).toBe('w3c');

    const provErr = new AppError({
      code: 'app-pointer-lock-failed',
      expected: 'pointer-lock request to succeed',
      hint: 'remain in unlocked state; next trusted click will retry',
      detail: { path: 'provider', cause: new Error('provider reject') },
    });
    expect(provErr.detail.path).toBe('provider');
  });

  it('detail.cause carries the original rejection value verbatim', () => {
    const cause = new Error('W3C lock rejected');
    const err = new AppError({
      code: 'app-pointer-lock-failed',
      expected: 'pointer-lock request to succeed',
      hint: 'remain in unlocked state; next trusted click will retry',
      detail: { path: 'w3c', cause },
    });
    expect(err.detail.cause).toBe(cause);
  });

  it('isAppError returns true for pointer-lock-failed errors', () => {
    const err = new AppError({
      code: 'app-pointer-lock-failed',
      expected: 'pointer-lock request to succeed',
      hint: 'remain in unlocked state; next trusted click will retry',
      detail: { path: 'w3c', cause: new Error('test') },
    });
    expect(isAppError(err)).toBe(true);
  });

  it('message carries path and cause summary', () => {
    const err = new AppError({
      code: 'app-pointer-lock-failed',
      expected: 'pointer-lock request to succeed',
      hint: 'remain in unlocked state; next trusted click will retry',
      detail: { path: 'w3c', cause: new Error('NotAllowedError') },
    });
    expect(err.message).toContain('app-pointer-lock-failed');
    expect(err.message).toContain('NotAllowedError');
  });

  it('narrows via discriminated union: if (err.code === "app-pointer-lock-failed")', () => {
    const err = new AppError({
      code: 'app-pointer-lock-failed',
      expected: 'pointer-lock request to succeed',
      hint: 'remain in unlocked state; next trusted click will retry',
      detail: { path: 'w3c', cause: new Error('test') },
    }) as AppError;

    if (err.code === 'app-pointer-lock-failed') {
      // detail should narrow to { path: 'w3c' | 'provider'; cause: unknown }
      const { path, cause } = err.detail;
      expect(path).toBe('w3c');
      expect(cause).toBeInstanceOf(Error);
    } else {
      // Should not reach here for this test.
      expect.unreachable('expected code to be app-pointer-lock-failed');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. APP_EXPECTED / APP_ERROR_HINTS bidirectional symmetry (6 keys)
// ---------------------------------------------------------------------------

describe('APP_EXPECTED / APP_ERROR_HINTS bidirectional symmetry', () => {
  it('APP_EXPECTED has one key per AppErrorCode member', () => {
    const keys = Object.keys(APP_EXPECTED);
    expect(keys).toHaveLength(13);
  });

  it('APP_ERROR_HINTS has one key per AppErrorCode member', () => {
    const keys = Object.keys(APP_ERROR_HINTS);
    expect(keys).toHaveLength(13);
  });

  it('APP_EXPECTED and APP_ERROR_HINTS have the same key set', () => {
    const expectedKeys = Object.keys(APP_EXPECTED).sort();
    const hintKeys = Object.keys(APP_ERROR_HINTS).sort();
    expect(expectedKeys).toEqual(hintKeys);
  });

  it('every APP_EXPECTED entry is non-empty', () => {
    for (const [key, value] of Object.entries(APP_EXPECTED)) {
      expect(value, `APP_EXPECTED[${key}] must be non-empty`).toBeTruthy();
      expect(value.length, `APP_EXPECTED[${key}] must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('every APP_ERROR_HINTS entry is non-empty', () => {
    for (const [key, value] of Object.entries(APP_ERROR_HINTS)) {
      expect(value, `APP_ERROR_HINTS[${key}] must be non-empty`).toBeTruthy();
      expect(value.length, `APP_ERROR_HINTS[${key}] must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('app-pointer-lock-failed has expected and hint entries', () => {
    expect(APP_EXPECTED).toHaveProperty('app-pointer-lock-failed');
    expect(APP_ERROR_HINTS).toHaveProperty('app-pointer-lock-failed');
    expect(APP_EXPECTED['app-pointer-lock-failed'].length).toBeGreaterThan(0);
    expect(APP_ERROR_HINTS['app-pointer-lock-failed'].length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. AppErrorDetail union includes the new variant
// ---------------------------------------------------------------------------

describe('AppErrorDetail union', () => {
  it('accepts the pointer-lock-failed detail variant', () => {
    const detail: AppErrorDetail = {
      path: 'w3c',
      cause: new Error('test'),
    };
    expect(detail.path).toBe('w3c');
    expect(detail.cause).toBeInstanceOf(Error);
  });

  it('accepts the provider path variant', () => {
    const detail: AppErrorDetail = {
      path: 'provider',
      cause: 'provider string rejection',
    };
    // cause is unknown, so string is valid.
    expect(detail.path).toBe('provider');
    expect(typeof detail.cause).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 5. AppErrorDetailFor conditional type narrows correctly
// ---------------------------------------------------------------------------

describe('AppErrorDetailFor conditional type', () => {
  it('narrows "app-pointer-lock-failed" to { path, cause }', () => {
    // This is a compile-time assertion: if AppErrorDetailFor<'app-pointer-lock-failed'>
    // does not resolve to { path: 'w3c' | 'provider'; cause: unknown }, tsc will fail.
    const detail: AppErrorDetailFor<'app-pointer-lock-failed'> = {
      path: 'w3c',
      cause: new Error('test'),
    };
    expect(detail.path).toBe('w3c');
    expect(detail.cause).toBeInstanceOf(Error);
  });
});
