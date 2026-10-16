import { expectTypeOf, it } from 'vitest';
import type { AppError } from '../index';

it('narrows execution error detail by code', () => {
  const error = null as unknown as AppError;
  if (error.code === 'app-execution-kernel-failed') {
    expectTypeOf(error.detail.partialWrite).toEqualTypeOf<true>();
    expectTypeOf(error.detail.retryable).toEqualTypeOf<false>();
  }
  if (error.code === 'app-execution-deadline-exceeded') {
    expectTypeOf(error.detail.phase).toEqualTypeOf<'startup' | 'handshake' | 'frame' | 'dispose'>();
  }
});
