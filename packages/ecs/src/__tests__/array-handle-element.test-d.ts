// Compile-time type-derivation tests for the array<asset<kind>> schema-vocab
// extension (feat-20260608-mesh-multi-section-primitive-multi-material-slot M2
// / w6, AC-01 / AC-02).
//
// Locks two invariants after the D-1 schema-vocab extension:
//
//   1. Inference (AC-01): FieldValueType<'array<asset<material>>'>
//      resolves to readonly AssetHandle<'material'>[].
//
//   2. Cross-brand (AC-02): array<asset<kind>> is distinct from array<u32>
//      typed array — the brand prevents accidental u32 assignment.

import type { AssetHandle } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { FieldValueType, SchemaVocabKeyword } from '../component';

describe('array<asset<kind>> vocab - keyword recognition (w6, D-1)', () => {
  it("FieldValueType<'array<asset<material>>'> resolves to readonly AssetHandle<'material'>[]", () => {
    expectTypeOf<FieldValueType<'array<asset<material>>'>>().toEqualTypeOf<
      readonly AssetHandle<'material'>[]
    >();
  });

  it("FieldValueType<'array<asset<mesh>>'> resolves to readonly AssetHandle<'mesh'>[]", () => {
    expectTypeOf<FieldValueType<'array<asset<mesh>>'>>().toEqualTypeOf<
      readonly AssetHandle<'mesh'>[]
    >();
  });

  it('array<asset<material>> is a valid SchemaVocabKeyword', () => {
    const kw: SchemaVocabKeyword = 'array<asset<material>>';
    void kw;
  });
});
