import type { Result } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import {
  type BufferHandle,
  type BufferLease,
  type FrameArena,
  type MemoryError,
  type MemoryErrorCode,
  World,
} from '../index';

describe('typed World memory capabilities', () => {
  it('preserves numeric layout through allocation, views and leases', () => {
    const world = new World();
    const buffer = world.buffers.alloc(Float32Array, 12).unwrap();
    expectTypeOf(buffer).toMatchTypeOf<BufferHandle<Float32Array>>();
    expectTypeOf(world.buffers.view(buffer).unwrap()).toMatchTypeOf<Float32Array>();
    expectTypeOf(world.buffers.borrow(buffer).unwrap()).toMatchTypeOf<BufferLease<Float32Array>>();
    expectTypeOf(world.frameArena).toMatchTypeOf<FrameArena>();
    expectTypeOf(world.frameArena.alloc(Uint32Array, 3)).toMatchTypeOf<
      Result<Uint32Array, MemoryError>
    >();
    // @ts-expect-error Layouts are not interchangeable.
    const wrong: BufferHandle<Uint32Array> = buffer;
    void wrong;
  });
  it('exhaustively handles the memory error domain', () => {
    const classify = (code: MemoryErrorCode): string => {
      switch (code) {
        case 'memory-request-invalid':
        case 'memory-budget-exceeded':
        case 'memory-allocation-failed':
        case 'memory-scope-invalid':
        case 'memory-handle-invalid':
          return code;
      }
    };
    expectTypeOf(classify).toBeFunction();
  });
});
