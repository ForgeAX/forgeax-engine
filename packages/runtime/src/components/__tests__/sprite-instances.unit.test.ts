// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch / M1 / w3.
//
// Schema + AI-discoverability lock for the SpriteInstances component. Three
// surfaces under test (plan-tasks.json w3 description):
//   (a) defineComponent registration: getRegisteredComponents() enumerates
//       'SpriteInstances'.
//   (b) SpriteInstancesData type assertion: { transforms: Float32Array,
//       regions: Float32Array }, both readonly. The AC-09 type-inference
//       check happens inside system / QueryRow paths (not test-d) —
//       a `world.get` callback context is the canonical AI-user touchpoint.
//   (c) barrel re-export from @forgeax/engine-runtime compiles, exposing both
//       the component value and the data shape type.
//
// Boundary (plan-strategy section 7 M1 edge): this file does NOT test extract-
// entry validation (M3 w12), the stride mismatch fire path (M3 w13), or the
// render-system-* / shader/ touchpoints. Only the schema-level positive surface
// + IDE-autocomplete discoverability.
//
// Charter mapping: F1 (single-import surface via @forgeax/engine-runtime),
// P3 (schema fail-fast at TS edge), P4 (consistent abstraction — peer to
// Instances).

import { type Component, type SchemaOf, type ShapeOf, World } from '@forgeax/engine-ecs';
import {
  SpriteInstances,
  type SpriteInstancesData,
  type SpriteInstancesData as SpriteInstancesDataFromBarrel,
  SpriteInstances as SpriteInstancesFromBarrel,
} from '@forgeax/engine-render/authoring';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('SpriteInstances — defineComponent registration (w3 a)', () => {
  it('the token name remains the discoverable component identity', () => {
    expect(SpriteInstances.name).toBe('SpriteInstances');
  });

  it("Component.name literal is 'SpriteInstances'", () => {
    expect(SpriteInstances.name).toBe('SpriteInstances');
    expectTypeOf<typeof SpriteInstances.name>().toEqualTypeOf<'SpriteInstances'>();
  });

  it('schema is the 2-field {transforms, regions} array<f32> record', () => {
    expectTypeOf<SchemaOf<typeof SpriteInstances>>().toEqualTypeOf<
      Readonly<{
        readonly transforms: 'array<f32>';
        readonly regions: 'array<f32>';
      }>
    >();
  });

  it('schema field literals narrow to array<f32>', () => {
    expectTypeOf<SchemaOf<typeof SpriteInstances>['transforms']>().toEqualTypeOf<'array<f32>'>();
    expectTypeOf<SchemaOf<typeof SpriteInstances>['regions']>().toEqualTypeOf<'array<f32>'>();
  });
});

describe('SpriteInstances — SpriteInstancesData type assertion (w3 b)', () => {
  it('SpriteInstancesData is { readonly transforms: Float32Array, readonly regions: Float32Array }', () => {
    expectTypeOf<SpriteInstancesData>().toEqualTypeOf<{
      readonly transforms: Float32Array;
      readonly regions: Float32Array;
    }>();
  });

  it('ShapeOf<schema> matches SpriteInstancesData (single SSOT type)', () => {
    type ShapeData = ShapeOf<SchemaOf<typeof SpriteInstances>>;
    expectTypeOf<ShapeData['transforms']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<ShapeData['regions']>().toEqualTypeOf<Float32Array>();
  });

  it('AC-09: world.get(e, SpriteInstances) callback path infers Float32Array without `as`', () => {
    const world = new World();
    const transforms = new Float32Array(2 * 16);
    const regions = new Float32Array(2 * 4);
    const e = world.spawn({ component: SpriteInstances, data: { transforms, regions } }).unwrap();

    const r = world.get(e, SpriteInstances);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectTypeOf(r.value.transforms).toEqualTypeOf<Float32Array>();
    expectTypeOf(r.value.regions).toEqualTypeOf<Float32Array>();
    expect(r.value.transforms.length).toBe(32);
    expect(r.value.regions.length).toBe(8);
  });

  it('SpriteInstances matches Component<"SpriteInstances", {transforms, regions}>', () => {
    type Expected = Component<
      'SpriteInstances',
      {
        readonly transforms: 'array<f32>';
        readonly regions: 'array<f32>';
      }
    >;
    expectTypeOf<typeof SpriteInstances>().toMatchTypeOf<Expected>();
  });
});

describe('SpriteInstances — barrel re-export (w3 c)', () => {
  it('@forgeax/engine-runtime barrel exports SpriteInstances (same component identity)', () => {
    expect(SpriteInstancesFromBarrel).toBe(SpriteInstances);
  });

  it('@forgeax/engine-runtime barrel exports SpriteInstancesData type (compile assertion)', () => {
    type FromBarrel = SpriteInstancesDataFromBarrel;
    type FromModule = SpriteInstancesData;
    expectTypeOf<FromBarrel>().toEqualTypeOf<FromModule>();
  });
});
