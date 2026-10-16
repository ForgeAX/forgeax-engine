import { expectTypeOf, test } from 'vitest';
import type { ProfilerError, ProfilerErrorCode } from '../index.js';

type ExpectedProfilerErrorCode =
  | 'capture-boundary-invalid'
  | 'capture-already-active'
  | 'profiler-not-enabled'
  | 'phase-catalog-conflict'
  | 'profile-source-failed'
  | 'profile-sink-failed'
  | 'capture-state-invalid';

expectTypeOf<ProfilerErrorCode>().toEqualTypeOf<ExpectedProfilerErrorCode>();
expectTypeOf<ProfilerErrorCode>().toEqualTypeOf<ProfilerError['code']>();

test('rejects a code outside the exact public vocabulary', () => {
  // @ts-expect-error Unknown profiler error codes are not assignable.
  const invalidCode: ProfilerErrorCode = 'profiler-code-does-not-exist';
  void invalidCode;
});

test('narrows every detail payload by exhaustive code switch', () => {
  const readDetail = (error: ProfilerError): string => {
    switch (error.code) {
      case 'capture-boundary-invalid':
        expectTypeOf(error.detail).toEqualTypeOf<{
          readonly frameLimit: unknown;
          readonly eventLimit: unknown;
        }>();
        return `${String(error.detail.frameLimit)}:${String(error.detail.eventLimit)}`;
      case 'capture-already-active':
        expectTypeOf(error.detail).toEqualTypeOf<{ readonly captureId: string }>();
        return error.detail.captureId;
      case 'profiler-not-enabled':
        expectTypeOf(error.detail).toEqualTypeOf<{ readonly enabled: false }>();
        return String(error.detail.enabled);
      case 'phase-catalog-conflict':
        expectTypeOf(error.detail).toEqualTypeOf<{
          readonly source: 'app' | 'render';
          readonly expected: readonly string[];
          readonly actual: readonly string[];
        }>();
        return `${error.detail.source}:${error.detail.expected.join(',')}:${error.detail.actual.join(',')}`;
      case 'profile-source-failed':
        expectTypeOf(error.detail).toEqualTypeOf<{
          readonly source: string;
          readonly phase: string;
          readonly frameId: number;
        }>();
        return `${error.detail.source}:${error.detail.phase}:${error.detail.frameId}`;
      case 'profile-sink-failed':
        expectTypeOf(error.detail).toEqualTypeOf<{ readonly message: string }>();
        return error.detail.message;
      case 'capture-state-invalid':
        expectTypeOf(error.detail).toEqualTypeOf<{ readonly operation: string }>();
        return error.detail.operation;
    }

    const exhaustive: never = error;
    return exhaustive;
  };

  void readDetail;
});
