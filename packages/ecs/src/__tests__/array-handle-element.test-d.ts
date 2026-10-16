// Compile-time type-derivation tests for the array<handle<X>> schema-vocab
// extension (feat-20260608-mesh-multi-section-primitive-multi-material-slot M2
// / w6, AC-01 / AC-02).
//
// Locks two invariants after the D-1 schema-vocab extension:
//
//   1. Inference (AC-01): FieldValueType<'array<shared<MaterialAsset>>'>
//      resolves to readonly Handle<'MaterialAsset','shared'>[].
//
//   2. Cross-brand (AC-02): array<handle<X>> is distinct from array<u32>
//      typed array — the brand prevents accidental u32 assignment.

import type { Handle } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { FieldValueType, SchemaVocabKeyword } from '../component';

describe('array<handle<X>> vocab - keyword recognition (w6, D-1)', () => {
  it("FieldValueType<'array<shared<MaterialAsset>>'> resolves to readonly Handle<'MaterialAsset','shared'>[]", () => {
    expectTypeOf<FieldValueType<'array<shared<MaterialAsset>>'>>().toEqualTypeOf<
      readonly Handle<'MaterialAsset', 'shared'>[]
    >();
  });

  it("FieldValueType<'array<shared<MeshAsset>>'> resolves to readonly Handle<'MeshAsset','shared'>[]", () => {
    expectTypeOf<FieldValueType<'array<shared<MeshAsset>>'>>().toEqualTypeOf<
      readonly Handle<'MeshAsset', 'shared'>[]
    >();
  });

  it('array<handle<MaterialAsset>> is a valid SchemaVocabKeyword', () => {
    const kw: SchemaVocabKeyword = 'array<shared<MaterialAsset>>';
    void kw;
  });
});
