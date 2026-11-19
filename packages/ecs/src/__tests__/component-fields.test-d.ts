import type { AssetHandle, Handle } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import {
  type DefineComponentOptions,
  defineComponent,
  type FieldValueType,
  isScalarFieldType,
  type ScalarFieldType,
  type SchemaFieldType,
  type SchemaOf,
  type SchemaVocabKeyword,
  type ShapeOf,
  type TypedArrayFor,
} from '../component';
import type { EntityHandle } from '../entity-handle';
import { World } from '../world';

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

describe('component schema vocabulary', () => {
  it('narrows native scalar keys without widening the schema vocabulary', () => {
    expectTypeOf(isScalarFieldType).toEqualTypeOf<(value: string) => value is ScalarFieldType>();
    function narrow(value: string) {
      if (isScalarFieldType(value)) expectTypeOf(value).toEqualTypeOf<ScalarFieldType>();
    }
    narrow('f32');
  });

  it('retains reference and collection schema keywords', () => {
    type Sample =
      | 'array<u8, 128>'
      | 'unique<MaterialAsset>'
      | 'asset<mesh>'
      | 'entity'
      | 'array<f32, 16>'
      | 'array<u32>'
      | 'string';
    // Every member of `Sample` is assignable to `SchemaVocabKeyword`.
    expectTypeOf<Sample>().toMatchTypeOf<SchemaVocabKeyword>();
  });
});

it('defineComponent exposes options without arrayStride', () => {
  expectTypeOf<
    NonNullable<Parameters<typeof defineComponent>[2]>
  >().toEqualTypeOf<DefineComponentOptions>();
  expectTypeOf<DefineComponentOptions>().not.toHaveProperty('arrayStride');
});

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
    expectTypeOf<FieldValueType<'array<u8>'>>().toEqualTypeOf<Uint8Array>();
  });

  it("FieldValueType<'buffer<8>'> resolves to Uint8Array (fixed byte slot)", () => {
    expectTypeOf<FieldValueType<'array<u8, 8>'>>().toEqualTypeOf<Uint8Array>();
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

describe('schema vocab — buffer-array-collapse closed union (w1, AC-01)', () => {
  it('legacy buffer:<N> literal is rejected', () => {
    // @ts-expect-error 'buffer:8' is no longer a SchemaVocabKeyword (collapsed
    // to 'buffer<8>' by feat-20260515 w4).
    const bad: SchemaVocabKeyword = 'buffer:8';
    void bad;
  });

  it("'array<u8>' (variable capacity) is a SchemaVocabKeyword", () => {
    const good: SchemaVocabKeyword = 'array<u8>';
    void good;
  });

  it("'array<u8, N>' (fixed capacity) is a SchemaVocabKeyword", () => {
    const good: SchemaVocabKeyword = 'array<u8, 8>';
    void good;
  });

  it("'array<T, N>' (typed fixed) is a SchemaVocabKeyword", () => {
    const good: SchemaVocabKeyword = 'array<f32, 16>';
    void good;
  });

  it("'array<entity>' (entity variable) is a SchemaVocabKeyword", () => {
    const good: SchemaVocabKeyword = 'array<entity>';
    void good;
  });
});

describe('array vocab - keyword recognition (w12, AC-01)', () => {
  it('array<entity> derives to Uint32Array', () => {
    expectTypeOf<FieldValueType<'array<entity>'>>().toEqualTypeOf<Uint32Array>();
  });

  it('array<f32, 16> derives to Float32Array', () => {
    expectTypeOf<FieldValueType<'array<f32, 16>'>>().toEqualTypeOf<Float32Array>();
  });

  it('array<u32> derives to Uint32Array', () => {
    expectTypeOf<FieldValueType<'array<u32>'>>().toEqualTypeOf<Uint32Array>();
  });

  it('array<i32, 4> derives to Int32Array', () => {
    expectTypeOf<FieldValueType<'array<i32, 4>'>>().toEqualTypeOf<Int32Array>();
  });

  it('array<bool> derives to Uint8Array', () => {
    expectTypeOf<FieldValueType<'array<bool>'>>().toEqualTypeOf<Uint8Array>();
  });

  it('ShapeOf threads array vocab through FieldValueType', () => {
    type S = {
      entities: 'array<entity>';
      mat: 'array<f32, 16>';
      indices: 'array<u32>';
    };
    type Expected = {
      entities: Uint32Array;
      mat: Float32Array;
      indices: Uint32Array;
    };
    expectTypeOf<ShapeOf<S>>().toEqualTypeOf<Expected>();
  });
});

describe('array vocab - three-application-point inference (w12, AC-01 / AC-02)', () => {
  it('application point (a) - inside world.addSystem fn callback', () => {
    type Foo = ReturnType<typeof defineComponent<'Foo', { entities: 'array<entity>' }>>;
    type FooShape = ShapeOf<SchemaOf<Foo>>;
    expectTypeOf<FooShape['entities']>().toEqualTypeOf<Uint32Array>();
  });

  it('application point (b) - inside a QueryRow loop', () => {
    type Foo = ReturnType<typeof defineComponent<'Foo', { entities: 'array<entity>' }>>;
    type FooShape = ShapeOf<SchemaOf<Foo>>;
    expectTypeOf<FooShape['entities']>().toEqualTypeOf<Uint32Array>();
  });

  it('application point (c) - direct world.get call site', () => {
    type Foo = ReturnType<typeof defineComponent<'Foo', { entities: 'array<entity>' }>>;
    type FooShape = ShapeOf<SchemaOf<Foo>>;
    // expectType: direct world.get(e, Foo).unwrap().entities matches TypedArrayFor<'u32'>.
    const arr: TypedArrayFor<'u32'> = new Uint32Array(0);
    expectTypeOf(arr).toEqualTypeOf<FooShape['entities']>();
  });

  it('World type still resolves (no parser regression)', () => {
    expectTypeOf<World>().toBeObject();
  });
});

describe('array vocab - element-type rejection (w12, AC-03)', () => {
  it('array<ref<X>> is not a recognised schema field type', () => {
    // @ts-expect-error 'array<ref<X>>' is not a SchemaFieldType (AC-03 element-type).
    const bad: SchemaFieldType = 'array<ref<MaterialAsset>>';
    void bad;
  });

  it('array<handle<X>> is now a recognised schema field type (feat-20260608 M2 D-1)', () => {
    const valid: SchemaFieldType = 'array<asset<mesh>>';
    void valid;
  });

  it('array<buffer<N>> is not a recognised schema field type', () => {
    // @ts-expect-error 'array<buffer<8>>' is not a SchemaFieldType (AC-03 element-type).
    const bad: SchemaFieldType = 'array<buffer<8>>';
    void bad;
  });

  it('array<array<f32,4>> nesting is not a recognised schema field type', () => {
    // @ts-expect-error 'array<array<f32,4>>' is not a SchemaFieldType (AC-03 element-type).
    const bad: SchemaFieldType = 'array<array<f32,4>>';
    void bad;
  });
});

describe('array vocab - cross-brand rejection (w12, AC-04)', () => {
  it("snap[i] is number; not assignable to Handle<Mesh, 'unique'>", () => {
    const takesMeshHandle = (h: Handle<'Mesh', 'unique'>): void => {
      void h;
    };
    const view: TypedArrayFor<'u32'> = new Uint32Array(1);
    const elem: number = view[0] ?? 0;
    // @ts-expect-error number is not assignable to Handle<'Mesh','unique'> (AC-04 cross-brand).
    takesMeshHandle(elem);
  });
});

describe('schema vocab — keyword recognition (w3, AC-01)', () => {
  it('buffer:<N> derives to Uint8Array', () => {
    expectTypeOf<FieldValueType<'array<u8, 128>'>>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<FieldValueType<'array<u8, 1>'>>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<FieldValueType<'array<u8, 65536>'>>().toEqualTypeOf<Uint8Array>();
  });

  it("unique<T> derives to Handle<T, 'unique'>", () => {
    expectTypeOf<FieldValueType<'unique<MaterialAsset>'>>().toEqualTypeOf<
      Handle<'MaterialAsset', 'unique'>
    >();
    expectTypeOf<FieldValueType<'unique<TextureAsset>'>>().toEqualTypeOf<
      Handle<'TextureAsset', 'unique'>
    >();
  });

  it("handle<T> derives to Handle<T, 'shared'>", () => {
    expectTypeOf<FieldValueType<'asset<mesh>'>>().toEqualTypeOf<AssetHandle<'mesh'>>();
    expectTypeOf<FieldValueType<'asset<material>'>>().toEqualTypeOf<AssetHandle<'material'>>();
  });

  it('entity derives to Entity | null', () => {
    expectTypeOf<FieldValueType<'entity'>>().toEqualTypeOf<EntityHandle | null>();
  });

  it('cross-keyword: ref/handle differ on the mode axis (managed vs unmanaged)', () => {
    type Managed = FieldValueType<'unique<MaterialAsset>'>;
    type Unmanaged = FieldValueType<'asset<material>'>;
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
      data: 'array<u8, 64>';
      mat: 'unique<MaterialAsset>';
      mesh: 'asset<mesh>';
      parent: 'entity';
    };
    type Expected = {
      data: Uint8Array;
      mat: Handle<'MaterialAsset', 'unique'>;
      mesh: AssetHandle<'mesh'>;
      parent: EntityHandle | null;
    };
    expectTypeOf<ShapeOf<S>>().toEqualTypeOf<Expected>();
  });

  it('defineComponent infers the new vocab from the schema literal', () => {
    const C = defineComponent('VocabSample', {
      data: { type: 'array<u8, 32>' },
      mat: { type: 'unique<MaterialAsset>' },
      mesh: { type: 'asset<mesh>' },
      parent: { type: 'entity' },
    });
    type Shape = ShapeOf<SchemaOf<typeof C>>;
    expectTypeOf<Shape['data']>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<Shape['mat']>().toEqualTypeOf<Handle<'MaterialAsset', 'unique'>>();
    expectTypeOf<Shape['mesh']>().toEqualTypeOf<AssetHandle<'mesh'>>();
    expectTypeOf<Shape['parent']>().toEqualTypeOf<EntityHandle | null>();
  });
});

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

// The byte-field aliases are retired; callers declare ordinary u8 arrays.
// @ts-expect-error use array<u8>.
const retiredVariableBytes: SchemaFieldType = 'buffer';
// @ts-expect-error use array<u8, N>.
const retiredFixedBytes: SchemaFieldType = 'buffer<8>';
void retiredVariableBytes;
void retiredFixedBytes;

it('binds byte-array writes to the declared component input', () => {
  const Bytes = defineComponent('TypedBytes', { value: 'array<u8>' });
  const world = new World();
  const entity = world.spawn({ component: Bytes, data: { value: [1, 2] } }).unwrap();
  world.set(entity, Bytes, { value: new Uint8Array(2) });
  // @ts-expect-error raw bytes require an explicit byte view.
  world.set(entity, Bytes, { value: new ArrayBuffer(2) });
  // @ts-expect-error a float view is not a declared byte view.
  world.set(entity, Bytes, { value: new Float32Array(2) });
  // @ts-expect-error insertion uses the same component-owned input type.
  world.addComponent(entity, { component: Bytes, data: { value: new Float32Array(2) } });
});
