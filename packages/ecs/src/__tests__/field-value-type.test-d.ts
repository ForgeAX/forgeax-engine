// Compile-time type-derivation tests for the FieldValueType<T> 4-keyword
// TypedArray contract after the M1 buffer/array vocab collapse (w2, AC-02).
//
// Locks the new contract: the four schema-vocab keywords for byte / typed
// array storage all resolve to a concrete TypedArray (or Uint8Array for the
// byte-only `buffer` family) without an intermediate view-class wrapper.
//
//   FieldValueType<'array<f32>'>      => Float32Array
//   FieldValueType<'array<entity>'>   => Uint32Array (Entity column storage)
//   FieldValueType<'buffer'>          => Uint8Array
//   FieldValueType<'buffer<8>'>       => Uint8Array
//
// Pre-M1 (before w4): array<...> derives to Var/FixedArrayView and buffer<N>
// is unrecognised — both shapes produce TS errors against the expected
// TypedArray equivalence below; this is the TDD red state.
//
// Post-M1 (after w4): the 4 keywords resolve directly to TypedArray and the
// expectTypeOf assertions hold.

import { describe, expectTypeOf, it } from 'vitest';
import type { FieldValueType, TypedArrayFor } from '../component';

describe('FieldValueType — buffer/array TypedArray contract (w2, AC-02)', () => {
  it("FieldValueType<'array<f32>'> resolves to Float32Array", () => {
    expectTypeOf<FieldValueType<'array<f32>'>>().toEqualTypeOf<Float32Array>();
  });

  it("FieldValueType<'array<u32>'> resolves to Uint32Array", () => {
    expectTypeOf<FieldValueType<'array<u32>'>>().toEqualTypeOf<Uint32Array>();
  });

  it("FieldValueType<'array<entity>'> resolves to Uint32Array (Entity column storage)", () => {
    expectTypeOf<FieldValueType<'array<entity>'>>().toEqualTypeOf<Uint32Array>();
  });

  it("FieldValueType<'array<f32, 16>'> resolves to Float32Array (fixed capacity)", () => {
    expectTypeOf<FieldValueType<'array<f32, 16>'>>().toEqualTypeOf<Float32Array>();
  });

  it("FieldValueType<'buffer'> resolves to Uint8Array (variable byte slot)", () => {
    expectTypeOf<FieldValueType<'buffer'>>().toEqualTypeOf<Uint8Array>();
  });

  it("FieldValueType<'buffer<8>'> resolves to Uint8Array (fixed byte slot)", () => {
    expectTypeOf<FieldValueType<'buffer<8>'>>().toEqualTypeOf<Uint8Array>();
  });
});

describe('TypedArrayFor — public single-export contract (w2, AC-02)', () => {
  it("TypedArrayFor<'f32'> is Float32Array", () => {
    expectTypeOf<TypedArrayFor<'f32'>>().toEqualTypeOf<Float32Array>();
  });

  it("TypedArrayFor<'u32'> is Uint32Array", () => {
    expectTypeOf<TypedArrayFor<'u32'>>().toEqualTypeOf<Uint32Array>();
  });
});
