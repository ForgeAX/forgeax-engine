import { expectTypeOf, it } from 'vitest';
import type { RhiDebugError, RhiDebugErrorCode } from '../errors';

it('keeps the eleven error codes closed', () => {
  expectTypeOf<RhiDebugErrorCode>().toEqualTypeOf<
    | 'capture-unavailable'
    | 'capture-busy'
    | 'capture-snapshot-failed'
    | 'capture-timeout'
    | 'tape-invalid'
    | 'tape-version-unsupported'
    | 'replay-capability-mismatch'
    | 'replay-event-failed'
    | 'replay-position-invalid'
    | 'readback-failed'
    | 'readback-unsupported'
  >();
});

it('narrows detail with the error code', () => {
  const error = null as unknown as RhiDebugError;
  if (error.code === 'tape-version-unsupported') {
    expectTypeOf(error.detail).toMatchTypeOf<
      { foundVersion: number; expectedVersion: number } | undefined
    >();
  }
  if (error.code === 'replay-position-invalid') {
    expectTypeOf(error.detail).toMatchTypeOf<
      { requested: number; available: number } | undefined
    >();
  }
});
