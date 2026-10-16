import type { RhiDebugError } from '@forgeax/engine-rhi-debug';
import { expectTypeOf, it } from 'vitest';
import { recoverRhiDebugError } from '../rhi-debug/operations';

declare const error: RhiDebugError;

it('consumes the core closed error union without a default fallback', () => {
  const recovery = recoverRhiDebugError(error);
  expectTypeOf(recovery).toEqualTypeOf<string>();
});
