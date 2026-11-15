import type { Handle } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import {
  defineComponent,
  type FieldValueType,
  type ScalarFieldType,
  type SchemaFieldType,
  type SchemaOf,
  type ShapeOf,
} from '../component';

const expectedScalarTypes = [
  'f32',
  'f64',
  'i32',
  'u32',
  'i16',
  'u16',
  'i8',
  'u8',
  'bool',
  'enum',
] as const satisfies readonly ScalarFieldType[];
type ExpectedScalarFieldType = (typeof expectedScalarTypes)[number];

const ScalarFields = defineComponent('ScalarFieldTypeOwnerProof', {
  f32: 'f32',
  f64: 'f64',
  i32: 'i32',
  u32: 'u32',
  i16: 'i16',
  u16: 'u16',
  i8: 'i8',
  u8: 'u8',
  bool: 'bool',
  enum: 'enum',
});

describe('ScalarFieldType owner', () => {
  it('keeps the exact scalar scalar vocabulary', () => {
    expectTypeOf<ScalarFieldType>().toEqualTypeOf<ExpectedScalarFieldType>();
    expectTypeOf<ExpectedScalarFieldType>().toEqualTypeOf<ScalarFieldType>();
    expectTypeOf(expectedScalarTypes).toMatchTypeOf<readonly SchemaFieldType[]>();

    // @ts-expect-error unknown schema keywords remain outside the scalar union.
    const invalid: ScalarFieldType = 'scalar-not-real';
    void invalid;
  });

  it('preserves scalar schema acceptance and value declarations', () => {
    type Shape = ShapeOf<SchemaOf<typeof ScalarFields>>;
    expectTypeOf<Shape>().toEqualTypeOf<{
      readonly f32: number;
      readonly f64: number;
      readonly i32: number;
      readonly u32: number;
      readonly i16: number;
      readonly u16: number;
      readonly i8: number;
      readonly u8: number;
      readonly bool: boolean;
      readonly enum: number;
    }>();

    expectTypeOf<FieldValueType<'f32'>>().toEqualTypeOf<number>();
    expectTypeOf<FieldValueType<'bool'>>().toEqualTypeOf<boolean>();
    expectTypeOf<FieldValueType<'unique<Resource>'>>().toEqualTypeOf<
      Handle<'Resource', 'unique'>
    >();
    expectTypeOf<'ref'>().not.toExtend<SchemaFieldType>();
  });
});
