// Type-level — MappedBuffer brand + method form (this: MappedBuffer guard).
//
// Introduced in feat-20260511-rhi-spec-realign-aggressive w4 (red) -> w10
// (green) per requirements AC-11 + plan-strategy §7.1 MappedBuffer + D-P2
// break-point #6 (brand + method form merged into one row).
//
// Shape:
//   - `MappedBuffer = Buffer & { readonly __mapped: void }`
//   - `buffer.mapAsync(mode, ...)` returns `Promise<Result<MappedBuffer,
//     RhiError>>` — success branch carries the branded handle the caller
//     subsequently consumes for getMappedRange / unmap.
//   - `MappedBuffer.getMappedRange(...)` / `MappedBuffer.unmap()` are method
//     forms on the brand (`this: MappedBuffer` implicit guard); the previous
//     top-level `Buffer.getMappedRange` / `Buffer.unmap` are removed.
//
// charter mapping: proposition 4 (TS compile-time guard against calling
// getMappedRange on an un-mapped Buffer) + proposition 5 (consistent
// abstraction — the brand encodes state at the type level, no runtime
// re-validation needed at every call site).
//
// Related Rust analogue: `wgpu::BufferSlice<'_>` ownership/borrow tracking;
// forgeax uses a brand instead of lifetimes because TS lacks affine types.

import { describe, expectTypeOf, it } from 'vitest';
import type { Buffer, MappedBuffer, Result, RhiError } from '../index';

describe('MappedBuffer brand — type-level state machine', () => {
  it('mapAsync resolves to Promise<Result<MappedBuffer, RhiError>>', () => {
    type MapAsyncRet = ReturnType<Buffer['mapAsync']>;
    expectTypeOf<MapAsyncRet>().toEqualTypeOf<Promise<Result<MappedBuffer, RhiError>>>();
  });

  it('MappedBuffer is a structural superset of Buffer (Buffer & { __mapped })', () => {
    expectTypeOf<MappedBuffer>().toMatchTypeOf<Buffer>();
    // Negative direction — plain Buffer is NOT a MappedBuffer (brand guard).
    // @ts-expect-error TS2345 — Buffer is missing the __mapped brand.
    const _bogus: MappedBuffer = undefined as unknown as Buffer;
    void _bogus;
  });

  it('getMappedRange is a method on MappedBuffer (not on Buffer)', () => {
    type GMR = MappedBuffer['getMappedRange'];
    expectTypeOf<GMR>().toMatchTypeOf<
      (offset?: number, size?: number) => Result<ArrayBuffer, RhiError>
    >();
  });

  it('unmap is a method on MappedBuffer (not on Buffer)', () => {
    type Unmap = MappedBuffer['unmap'];
    expectTypeOf<Unmap>().toMatchTypeOf<() => void>();
  });

  it('AI user pattern: const r = await buf.mapAsync(...); if (r.ok) mappedBuffer.getMappedRange()', async () => {
    const buffer = undefined as unknown as Buffer;
    const r = await buffer.mapAsync(1);
    if (r.ok) {
      const mappedBuffer: MappedBuffer = r.value;
      // method-form: mappedBuffer.getMappedRange and mappedBuffer.unmap exist
      const range = mappedBuffer.getMappedRange();
      expectTypeOf(range).toEqualTypeOf<Result<ArrayBuffer, RhiError>>();
      const u = mappedBuffer.unmap();
      expectTypeOf<typeof u>().toEqualTypeOf<void>();
    }
  });
});
