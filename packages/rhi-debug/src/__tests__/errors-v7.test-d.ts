import { expectTypeOf, it } from 'vitest';
import type { RhiDebugError, RhiDebugErrorCode } from '../errors';

it('has the frozen eleven-member error union', () => {
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
  expectTypeOf<RhiDebugError['detail']>().not.toEqualTypeOf<unknown>();
});
