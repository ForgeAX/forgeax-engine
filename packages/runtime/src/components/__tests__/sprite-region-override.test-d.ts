// feat-20260521-sprite-atlas-animation / M2 / T-08.
//
// TDD red phase: packages/runtime/src/components/sprite-region-override.ts
// does not yet exist; this test-d stays red (TS module-resolution failure)
// until T-11 lands the SSOT (plan-strategy section 2 D-6 + section 3.1
// SRO node). After T-11 the import resolves and the type-level assertions
// turn green. AC-01 schema lock + AC-08 IDE-autocomplete affordance are
// the consumer-side guarantees these checks defend.
//
// Schema decision lineage:
//   - requirements section 2.4 names `region: 'vec4'` semantically;
//     plan-strategy D-6 + research F-5 lock the concrete schema vocab to
//     `'array<f32, 4>'` because the ECS schema whitelist (`SchemaFieldType`,
//     packages/ecs/src/component.ts) does not accept `'vec4'`. The
//     compile-time `length=4` enforcement that `'array<f32, 4>'` provides
//     is the entire reason this test-d encodes the literal schema
//     (instead of widening to `'array<f32>'`).
//   - The `data.region` consumer shape is `Float32Array` (FieldValueType
//     resolves `array<f32, 4>` -> `TypedArrayFor<'f32'>` -> `Float32Array`).
//     AI users at the `world.spawn(..., { component: SpriteRegionOverride,
//     data: { region: ... } })` call site see one branded type, no
//     widening to `number[]` or `Uint32Array`.
//
// Anchors: plan-tasks.json T-08 (acceptanceCheck: vitest --typecheck on
// sprite-region-override.test-d turns green after T-11); plan-strategy
// section 2 D-6 + section 3.1 PR/SRO + section 4 risk R-SCHEMA-2 reaction;
// research F-5; requirements section AC-01 schema lock + section AC-08
// IDE autocomplete affordance + section 2.4 SpriteRegionOverride field
// table; charter F1 (single-import surface for AI users), P3 (schema
// fail-fast at TS edge — `'array<f32, 4>'` rejects mismatched lengths
// at the ECS storage / runtime boundary).

import type { Component, SchemaOf, ShapeOf } from '@forgeax/engine-ecs';
import type { SpriteRegionOverride } from '@forgeax/engine-render/authoring';
import { describe, expectTypeOf, it } from 'vitest';

describe('SpriteRegionOverride — Component token shape (AC-01 schema lock)', () => {
  it("name literal type is 'SpriteRegionOverride'", () => {
    expectTypeOf<typeof SpriteRegionOverride.name>().toEqualTypeOf<'SpriteRegionOverride'>();
  });

  it("schema is exactly { region: 'array<f32, 4>' } (D-6 fixed-length 4)", () => {
    expectTypeOf<SchemaOf<typeof SpriteRegionOverride>>().toEqualTypeOf<
      Readonly<{ readonly region: 'array<f32, 4>' }>
    >();
  });

  it("schema field 'region' literal narrows to 'array<f32, 4>' (compile-time length=4)", () => {
    expectTypeOf<
      SchemaOf<typeof SpriteRegionOverride>['region']
    >().toEqualTypeOf<'array<f32, 4>'>();
  });

  it('SpriteRegionOverride is Component<"SpriteRegionOverride", { region: "array<f32, 4>" }>', () => {
    type Expected = Component<'SpriteRegionOverride', { readonly region: 'array<f32, 4>' }>;
    expectTypeOf<typeof SpriteRegionOverride>().toMatchTypeOf<Expected>();
  });
});

describe('SpriteRegionOverride — data shape via ShapeOf (AC-08 spawn affordance)', () => {
  it('ShapeOf<schema> has a single readonly field `region` typed Float32Array', () => {
    type Data = ShapeOf<SchemaOf<typeof SpriteRegionOverride>>;
    expectTypeOf<keyof Data>().toEqualTypeOf<'region'>();
    expectTypeOf<Data['region']>().toEqualTypeOf<Float32Array>();
  });

  it('world.spawn data is Partial<ShapeOf<schema>> — region optional at consumer surface', () => {
    type SpawnData = Partial<ShapeOf<SchemaOf<typeof SpriteRegionOverride>>>;
    expectTypeOf<SpawnData['region']>().toEqualTypeOf<Float32Array | undefined>();

    const empty: SpawnData = {};
    void empty;

    const filled: SpawnData = { region: new Float32Array([0, 0, 1, 1]) };
    void filled;
  });
});

describe('SpriteRegionOverride — @ts-expect-error negative assertions (AC-08)', () => {
  it('1. plain number[] is not assignable to data.region (Float32Array nominal)', () => {
    type SpawnData = Partial<ShapeOf<SchemaOf<typeof SpriteRegionOverride>>>;
    // @ts-expect-error number[] lacks the Float32Array brand.
    const wrong: SpawnData = { region: [0, 0, 1, 1] };
    void wrong;
  });

  it('2. Uint32Array is not assignable to data.region (TypedArrays do not cross-assign)', () => {
    type SpawnData = Partial<ShapeOf<SchemaOf<typeof SpriteRegionOverride>>>;
    // @ts-expect-error TypedArray nominal types do not cross-assign in TS.
    const wrong: SpawnData = { region: new Uint32Array(4) };
    void wrong;
  });

  it('3. extra fields beyond schema (e.g. layer) are not part of ShapeOf', () => {
    type Data = ShapeOf<SchemaOf<typeof SpriteRegionOverride>>;
    // The schema is a single-field record; an unknown key has no inferred
    // entry on Data. Negative assertion: a key the schema does not declare
    // is not on the type.
    expectTypeOf<{ layer: number } & Data>().not.toEqualTypeOf<Data>();
  });
});
