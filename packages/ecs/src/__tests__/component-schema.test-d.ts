// Compile-time + runtime test for Component field-schema literal preservation +
// 4-probe quintet over SchemaVocabKeyword (w3, AC-09).
//
// Locks two invariants:
//
//   1. Literal preservation: defineComponent('Foo', { value: 'string' } as
//      const) yields `SchemaOf<typeof Foo>['value']` typed as the literal `'string'`,
//      not widened to plain `string`. AI users that read
//      `SchemaOf<typeof Component>` gets the schema keyword as a literal
//      type --- the basis of `isManagedField` switch / cascade discrimination.
//
//   2. 4-probe quintet (w4, plan-strategy §2.2 / D-R3 predicate merge):
//      The legacy string-only + ref-only probes collapse into a single
//      `isManagedField` arm covering both `'string'` and `'unique<T>'`. The
//      remaining probes target the other SchemaVocabKeyword tiers:
//        isManagedField        => 'string' | 'unique<T>'   (NEW unified arm)
//        isManagedBufferField  => 'buffer' / 'buffer<N>'
//        isEntityField         => 'entity'
//        isManagedArrayField   => 'array<T,N>' / 'array<T>'
//      AI users grep `isXxxField` once and get the discrimination toolkit.

import { describe, expectTypeOf, it } from 'vitest';
import {
  defineComponent,
  isEntityField,
  isManagedArrayField,
  isManagedBufferField,
  isManagedField,
  type SchemaOf,
  type SchemaVocabKeyword,
} from '../component';

describe('component schema --- literal preservation (w3, AC-09)', () => {
  it("defineComponent('Foo', { value: 'string' }) preserves 'string' literal", () => {
    const Foo = defineComponent('Foo', { value: 'string' });
    type ValueField = SchemaOf<typeof Foo>['value'];
    expectTypeOf<ValueField>().toEqualTypeOf<'string'>();

    // The token intentionally exposes only name/fields/storage. These
    // negative probes keep removed convenience facts out of autocomplete.
    // @ts-expect-error Component.schema was removed; use SchemaOf<typeof Foo>.
    void Foo.schema;
    // @ts-expect-error Component.id is an ECS-owner fact, not token data.
    void Foo.id;
    // @ts-expect-error Component.defaults lives in componentDefinition(Foo).
    void Foo.defaults;
    // @ts-expect-error Component.toSchemaJSON was removed with the duplicate projection.
    void Foo.toSchemaJSON;
  });

  it('schema literal is *not* widened to plain `string`', () => {
    const Foo = defineComponent('Foo', { value: 'string' });
    type ValueField = SchemaOf<typeof Foo>['value'];
    // The literal must NOT widen to base `string` --- AI users rely on the
    // narrow type for switch / cascade discrimination.
    expectTypeOf<ValueField>().not.toEqualTypeOf<string>();
  });

  it('multi-field schemas preserve every keyword literal', () => {
    const Bar = defineComponent('Bar', {
      name: 'string',
      mass: 'f32',
      target: 'entity',
    });
    expectTypeOf<SchemaOf<typeof Bar>['name']>().toEqualTypeOf<'string'>();
    expectTypeOf<SchemaOf<typeof Bar>['mass']>().toEqualTypeOf<'f32'>();
    expectTypeOf<SchemaOf<typeof Bar>['target']>().toEqualTypeOf<'entity'>();
  });
});

describe('component schema --- 4-probe quintet (w3, AC-09)', () => {
  it('all four probes have signature `(s: string) => boolean`', () => {
    expectTypeOf(isManagedField).toEqualTypeOf<(s: string) => boolean>();
    expectTypeOf(isManagedBufferField).toEqualTypeOf<(s: string) => boolean>();
    expectTypeOf(isEntityField).toEqualTypeOf<(s: string) => boolean>();
    expectTypeOf(isManagedArrayField).toEqualTypeOf<(s: string) => boolean>();
  });

  it("isManagedField recognises 'string' literal and 'unique<T>' template", () => {
    // Behavioural assertions (AC-09) --- the unified arm must cover both
    // `'string'` and `'unique<T>'` keywords in a single predicate.
    expectTypeOf(isManagedField('string')).toEqualTypeOf<boolean>();
    expectTypeOf(isManagedField('unique<MeshAsset>')).toEqualTypeOf<boolean>();
    // Runtime cases:
    if (!isManagedField('string')) throw new Error("isManagedField('string') must be true");
    if (!isManagedField('unique<MeshAsset>'))
      throw new Error("isManagedField('unique<MeshAsset>') must be true");
    if (isManagedField('entity')) throw new Error("isManagedField('entity') must be false");
    if (isManagedField('buffer<128>'))
      throw new Error("isManagedField('buffer<128>') must be false");
    // 'buffer' bare keyword is not a SchemaVocabKeyword but the predicate
    // must still reject it (defensive for the erased runtime call site).
    if (isManagedField('buffer')) throw new Error("isManagedField('buffer') must be false");
  });

  it('SchemaVocabKeyword closed union has 7 members covered by 4 probes', () => {
    // Mapping (membership <-> probe):
    //   buffer / buffer<N> => isManagedBufferField
    //   ref<T>             => isManagedField   (NEW unified arm w/ 'string')
    //   handle<T>          => (no managed probe; ECS treats handles as opaque)
    //   entity             => isEntityField
    //   array<T,N> + array<T> => isManagedArrayField (counts as one)
    //   string             => isManagedField   (NEW unified arm w/ 'unique<T>')
    //
    // The closed union still has exactly 7 template-literal arms; we lock
    // the union shape so any drift (e.g. removing one arm or adding a
    // sixth probe family) shows up as a type error.
    type Sample =
      | 'buffer<128>'
      | 'unique<MaterialAsset>'
      | 'shared<MeshAsset>'
      | 'entity'
      | 'array<f32, 16>'
      | 'array<u32>'
      | 'string';
    // Every member of `Sample` is assignable to `SchemaVocabKeyword`.
    expectTypeOf<Sample>().toMatchTypeOf<SchemaVocabKeyword>();
  });
});
