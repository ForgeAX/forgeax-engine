// w12 --- 'string' SchemaVocabKeyword + FieldValueType<'string'> = string.
//
// Locks two tier-2 invariants after the StringView collapse (D-R1):
//
//   1. 'string' remains a member of the closed `SchemaVocabKeyword` union
//      (the union member count is unchanged at 7 --- the collapse swapped
//      the value shape only, not the keyword surface).
//
//   2. `FieldValueType<'string'>` resolves to a native JS `string` (not
//      the retired StringView wrapper). `ShapeOf<{ value: 'string' }>`
//      threads through to `{ value: string }`.
//
// The prior file's StringView 5-surface assertions and JS-string
// prototype-method `@ts-expect-error` cases were retired together with
// StringView; the file survives as the focused vocab + FieldValueType
// contract test.

import { describe, expectTypeOf, it } from 'vitest';
import type {
  defineComponent,
  FieldValueType,
  SchemaOf,
  SchemaVocabKeyword,
  ShapeOf,
} from '../component';

describe('w12 --- "string" remains a SchemaVocabKeyword member (closed-union invariant)', () => {
  it("'string' extends SchemaVocabKeyword", () => {
    expectTypeOf<'string'>().toMatchTypeOf<SchemaVocabKeyword>();
  });
});

describe('w12 --- FieldValueType<"string"> = string (post-collapse)', () => {
  it("FieldValueType<'string'> = string", () => {
    expectTypeOf<FieldValueType<'string'>>().toEqualTypeOf<string>();
  });

  it('ShapeOf threads "string" through FieldValueType', () => {
    type S = { value: 'string' };
    type Expected = { value: string };
    expectTypeOf<ShapeOf<S>>().toEqualTypeOf<Expected>();
  });

  it('three application points all infer the value field as string', () => {
    type Foo = ReturnType<typeof defineComponent<'Foo', { value: 'string' }>>;
    type FooShape = ShapeOf<SchemaOf<Foo>>;
    expectTypeOf<FooShape['value']>().toEqualTypeOf<string>();
  });
});
