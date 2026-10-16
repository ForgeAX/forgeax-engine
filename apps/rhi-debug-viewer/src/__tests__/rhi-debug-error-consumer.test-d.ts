import type { RhiDebugError, RhiDebugErrorCode } from '@forgeax/engine-rhi-debug';
import { describe, expectTypeOf, it } from 'vitest';
import type { ViewerShellCapability } from '../viewer-context';

function consumeError(error: RhiDebugError): string {
  switch (error.code) {
    case 'capture-unavailable':
    case 'capture-busy':
    case 'capture-snapshot-failed':
    case 'capture-timeout':
    case 'tape-invalid':
    case 'replay-capability-mismatch':
    case 'replay-event-failed':
    case 'replay-position-invalid':
    case 'readback-failed':
    case 'readback-unsupported':
      return error.hint;
    case 'tape-version-unsupported':
      return `${error.detail?.foundVersion ?? 0}/${error.detail?.expectedVersion ?? 7}`;
  }
}

describe('RHI debug error consumer', () => {
  it('covers the closed code union without a default branch', () => {
    expectTypeOf(consumeError).parameter(0).toEqualTypeOf<RhiDebugError>();
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

  it('keeps shell capability failures distinct from core errors', () => {
    expectTypeOf<ViewerShellCapability>().toEqualTypeOf<
      | { readonly kind: 'no-webgpu'; readonly message: string }
      | { readonly kind: 'backend-unavailable'; readonly message: string }
      | { readonly kind: 'webgpu'; readonly message: string }
      | { readonly kind: 'core-error'; readonly error: RhiDebugError }
    >();
  });
});
