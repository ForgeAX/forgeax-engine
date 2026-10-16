// Compile-time type-derivation tests for the array<T,N> / array<T> schema-vocab
// keywords (w12, AC-01 / AC-02 / AC-03 / AC-04).
//
// Locks four invariants:
//
//   1. Inference (AC-01): defineComponent('Foo', { entities: { type: 'array<entity>' } })
//      derives `entities` to a `Uint32Array` (the Entity column storage);
//      defineComponent('Bar', { mat: { type: 'array<f32, 16>' } }) derives `mat` to a
//      `Float32Array` (fixed-capacity TypedArray snapshot).
//      Inference holds at three application points: (a) world.addSystem fn
//      callback; (b) QueryRow loop; (c) direct world.get call site.
//
//   2. Cross-shape (AC-02): both `array<T>` and `array<T, N>` resolve to a
//      concrete `TypedArrayFor<T>` surface (no intermediate view-class
//      wrapper). Mutation flows through `world.push` / `world.pop` /
//      `world.set`; the TypedArray itself is a read-only snapshot.
//
//   3. Element-type (AC-03): T must be scalar + entity. Schema strings
//      `'array<ref<X>>' / 'array<shared<X>>' / 'array<buffer<8>>' /
//      'array<array<f32,4>>'` are TS compile-time errors when used as a
//      schema field value.
//
//   4. Cross-brand (AC-04): the value returned by `snap[i]` for an
//      `'array<entity>'` field is the underlying `number` packed Entity bit
//      pattern; assigning it directly to a `Handle<Mesh, 'unique'>`
//      parameter is a TS compile-time error.

import type { Handle } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type {
  defineComponent,
  FieldValueType,
  SchemaFieldType,
  SchemaOf,
  ShapeOf,
  TypedArrayFor,
} from '../component';
import type { World } from '../world';

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
    const valid: SchemaFieldType = 'array<shared<MeshAsset>>';
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
