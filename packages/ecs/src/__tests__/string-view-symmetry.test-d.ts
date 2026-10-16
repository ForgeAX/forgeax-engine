// w9 --- AC-01 type-level FieldValueType<'string'> contract.
//
// Locks AC-01: the `'string'` schema-vocab keyword resolves through
// `FieldValueType<...>` to a native JS `string`. After the StringView
// collapse (D-R1, requirements 2.2), there is no longer a 3-arm symmetry
// between StringView / FixedArrayView / VarArrayView --- the string field
// reads directly as a JS string by-reference, leaving the array fields
// alone in the view-class category.
//
// This file is a focused FieldValueType<'string'> contract test; the prior
// 3-arm view-class symmetry content was retired together with StringView.

import { describe, expectTypeOf, it } from 'vitest';
import type { FieldValueType, ShapeOf } from '../component';

describe('w9 --- FieldValueType<"string"> resolves to native JS string (AC-01)', () => {
  it('FieldValueType<"string"> = string', () => {
    expectTypeOf<FieldValueType<'string'>>().toEqualTypeOf<string>();
  });

  it('ShapeOf threads "string" through FieldValueType to a native string field', () => {
    type S = { value: 'string' };
    type Expected = { value: string };
    expectTypeOf<ShapeOf<S>>().toEqualTypeOf<Expected>();
  });
});
