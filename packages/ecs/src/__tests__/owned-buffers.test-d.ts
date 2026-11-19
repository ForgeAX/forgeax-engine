import type { Result } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { MemoryError } from '../memory-types';
import type { BufferHandle, OwnedBuffers } from '../owned-buffers';

describe('owned buffer capability contract', () => {
  it('release validates opaque ownership and returns the source-owned memory error union', () => {
    expectTypeOf<ReturnType<OwnedBuffers['release']>>().toEqualTypeOf<Result<void, MemoryError>>();
  });
  it('accepts opaque grants and exposes no numeric slot metadata', () => {
    expectTypeOf<Parameters<OwnedBuffers['release']>>().toEqualTypeOf<[handle: BufferHandle]>();
    expectTypeOf<number extends BufferHandle ? true : false>().toEqualTypeOf<false>();
    type Stats = ReturnType<OwnedBuffers['memoryStats']>;
    expectTypeOf<Extract<keyof Stats, 'slotCapacity' | 'metadataBytes'>>().toEqualTypeOf<never>();
  });
});
