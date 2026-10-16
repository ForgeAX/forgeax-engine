// Compile-time type-derivation tests for the schema-vocab parser (w3 + AC-01).
//
// Locks the 5 keyword shapes in ScalarFieldType / SchemaVocabKeyword (the
// retired predecessor of `array<entity>` is closed out by feat-20260514-ecs-
// children-instances-managed-buffer-array w3 — `array<entity>` is the SSOT
// now; migration covered by `managed-array-vocab.test-d.ts`):
//   - 'buffer:<bytes>'    => Uint8Array
//   - 'unique<T>'            => Handle<T, 'unique'>
//   - 'shared<T>'         => Handle<T, 'shared'>
//   - 'entity'            => Entity | null
//   - 'array<entity>'     => VarArrayView<Entity>  (covered in managed-array-vocab.test-d)
//
// These five keywords are the schema-vocab surface AI users compose into
// component schemas (`defineComponent('Foo', { mat: { type: 'unique<MaterialAsset>' } })`).
// `FieldValueType<T>` resolves the JS-value shape so `world.get(e, Foo).mat`
// is automatically typed as `Handle<'MaterialAsset','unique'>` without casts.
//
// Anti-keyword guardrail (AC-01 §"unsupported-keyword fail-fast"): unknown
// keywords like `'foobar'` must NOT typecheck as a `ScalarFieldType`. The
// `@ts-expect-error` directive turns RED the moment the union accidentally
// widens to `string`.

import type { Handle } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { FieldValueType, ScalarFieldType, SchemaOf, ShapeOf } from '../component';
import { defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';

describe('schema vocab — keyword recognition (w3, AC-01)', () => {
  it('buffer:<N> derives to Uint8Array', () => {
    expectTypeOf<FieldValueType<'buffer<128>'>>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<FieldValueType<'buffer<1>'>>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<FieldValueType<'buffer<65536>'>>().toEqualTypeOf<Uint8Array>();
  });

  it("ref<T> derives to Handle<T, 'unique'>", () => {
    expectTypeOf<FieldValueType<'unique<MaterialAsset>'>>().toEqualTypeOf<
      Handle<'MaterialAsset', 'unique'>
    >();
    expectTypeOf<FieldValueType<'unique<TextureAsset>'>>().toEqualTypeOf<
      Handle<'TextureAsset', 'unique'>
    >();
  });

  it("handle<T> derives to Handle<T, 'shared'>", () => {
    expectTypeOf<FieldValueType<'shared<MeshAsset>'>>().toEqualTypeOf<
      Handle<'MeshAsset', 'shared'>
    >();
    expectTypeOf<FieldValueType<'shared<MaterialAsset>'>>().toEqualTypeOf<
      Handle<'MaterialAsset', 'shared'>
    >();
  });

  it('entity derives to Entity | null', () => {
    expectTypeOf<FieldValueType<'entity'>>().toEqualTypeOf<EntityHandle | null>();
  });

  it('cross-keyword: ref/handle differ on the mode axis (managed vs unmanaged)', () => {
    type Managed = FieldValueType<'unique<MaterialAsset>'>;
    type Unmanaged = FieldValueType<'shared<MaterialAsset>'>;
    expectTypeOf<Managed>().not.toEqualTypeOf<Unmanaged>();
  });
});

describe('schema vocab — anti-keyword (w3, AC-01)', () => {
  it('unknown keyword is rejected by ScalarFieldType union', () => {
    // @ts-expect-error 'foobar' is not a ScalarFieldType keyword.
    const bad: ScalarFieldType = 'foobar';
    void bad;
  });
});

describe('schema vocab — ShapeOf composition (w3, AC-01)', () => {
  it('ShapeOf threads each keyword through FieldValueType', () => {
    type S = {
      data: 'buffer<64>';
      mat: 'unique<MaterialAsset>';
      mesh: 'shared<MeshAsset>';
      parent: 'entity';
    };
    type Expected = {
      data: Uint8Array;
      mat: Handle<'MaterialAsset', 'unique'>;
      mesh: Handle<'MeshAsset', 'shared'>;
      parent: EntityHandle | null;
    };
    expectTypeOf<ShapeOf<S>>().toEqualTypeOf<Expected>();
  });

  it('defineComponent infers the new vocab from the schema literal', () => {
    const C = defineComponent('VocabSample', {
      data: { type: 'buffer<32>' },
      mat: { type: 'unique<MaterialAsset>' },
      mesh: { type: 'shared<MeshAsset>' },
      parent: { type: 'entity' },
    });
    type Shape = ShapeOf<SchemaOf<typeof C>>;
    expectTypeOf<Shape['data']>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<Shape['mat']>().toEqualTypeOf<Handle<'MaterialAsset', 'unique'>>();
    expectTypeOf<Shape['mesh']>().toEqualTypeOf<Handle<'MeshAsset', 'shared'>>();
    expectTypeOf<Shape['parent']>().toEqualTypeOf<EntityHandle | null>();
  });
});
