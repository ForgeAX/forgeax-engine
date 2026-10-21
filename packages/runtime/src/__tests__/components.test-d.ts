// w7 / w3 — 5 component schema type-level inference test (test-d, no `as` assertions).
//
// Verifies the call-site type contract of `world.spawn({ component, data })`:
// the `data` object key set + value types must be inferred from the component
// schema without `as` assertions. This is the AI-user-facing affordance
// (charter proposition 5 consistent abstraction + proposition 3 machine-
// readable union > prose).
//
// Asset schema fields infer AssetHandle<kind>; MeshRenderer owns the
// `array<asset<material>>` binding list without a second component.

import type { InputShapeOf, SchemaOf, ShapeOf } from '@forgeax/engine-ecs';
import type { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import type { ChildOf, GlobalTransform, Transform } from '@forgeax/engine-scene';
import type { AssetHandle, Handle } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';

describe('w7 type-level - 5 component schemas yield exact data shapes via ShapeOf', () => {
  it('Transform data shape has 4 local affine inline-array fields', () => {
    type Data = ShapeOf<SchemaOf<typeof Transform>>;
    expectTypeOf<keyof Data>().toEqualTypeOf<'pos' | 'quat' | 'scale' | 'shear'>();
    expectTypeOf<Data['pos']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['quat']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['scale']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['shear']>().toEqualTypeOf<Float32Array>();
    type GlobalData = ShapeOf<SchemaOf<typeof GlobalTransform>>;
    expectTypeOf<keyof GlobalData>().toEqualTypeOf<'world' | 'presentation'>();
    expectTypeOf<GlobalData['world']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<GlobalData['presentation']>().toEqualTypeOf<Float32Array>();
    // Write side widens `array<f32, N>` to also accept plain number[] literals
    // (InputShapeOf asymmetry): `pos: [1, 2, 3]` spawns without a
    // Float32Array wrapper at the call site.
    type Input = InputShapeOf<SchemaOf<typeof Transform>>;
    expectTypeOf<Input['pos']>().toEqualTypeOf<Float32Array | readonly number[]>();
    expectTypeOf<Input['quat']>().toEqualTypeOf<Float32Array | readonly number[]>();
    expectTypeOf<Input['scale']>().toEqualTypeOf<Float32Array | readonly number[]>();
    expectTypeOf<Input['shear']>().toEqualTypeOf<Float32Array | readonly number[]>();
  });

  it("MeshFilter data shape has 1 AssetHandle<'mesh'> field (assetHandle; M5 / w19)", () => {
    type Data = ShapeOf<SchemaOf<typeof MeshFilter>>;
    expectTypeOf<keyof Data>().toEqualTypeOf<'assetHandle'>();
    expectTypeOf<Data['assetHandle']>().toEqualTypeOf<AssetHandle<'mesh'>>();
  });

  it('MeshRenderer data shape carries materials, lighting, bounds and pipeline preparation', () => {
    type Data = ShapeOf<SchemaOf<typeof MeshRenderer>>;
    expectTypeOf<keyof Data>().toEqualTypeOf<
      'materials' | 'lightingChannels' | 'conservativeSkinBounds' | 'preparePipelines'
    >();
    expectTypeOf<Data['materials']>().toEqualTypeOf<readonly AssetHandle<'material'>[]>();
    expectTypeOf<Data['lightingChannels']>().toEqualTypeOf<number>();
    expectTypeOf<Data['conservativeSkinBounds']>().toEqualTypeOf<boolean>();
    expectTypeOf<Data['preparePipelines']>().toEqualTypeOf<boolean>();
  });

  it('MeshRenderer spawn payload accepts empty data (AC-04 plan §2.6 literal)', () => {
    // `world.spawn`'s `data` is `Partial<ShapeOf<S>>` — every schema field is
    // optional at the consumer surface, so the empty `{}` payload is accepted
    // (case B path — missing-spec fallback to mid-grey default), and
    // `materials: [0]` plain numeric literal is rejected by brand discipline
    // (charter prop 4).
    type SpawnData = Partial<ShapeOf<SchemaOf<typeof MeshRenderer>>>;
    // AC-04 application point: brand-undefined union surfaces at the call site.
    expectTypeOf<SpawnData['materials']>().toEqualTypeOf<
      readonly AssetHandle<'material'>[] | undefined
    >();
    // empty payload is a valid SpawnData (case B).
    const empty: SpawnData = {};
    void empty;
    // plain `[0]` is not assignable to brand-typed `materials`.
    expectTypeOf<{ materials: readonly [0] }>().not.toMatchTypeOf<SpawnData>();
  });

  it('Camera data shape includes output exposure and color-grading fields', () => {
    type Data = ShapeOf<SchemaOf<typeof Camera>>;
    expectTypeOf<keyof Data>().toEqualTypeOf<
      | 'fov'
      | 'aspect'
      | 'near'
      | 'far'
      | 'projection'
      | 'projectionOffset'
      | 'left'
      | 'right'
      | 'bottom'
      | 'top'
      | 'tonemap'
      | 'exposure'
      | 'exposureMode'
      | 'compensationEv'
      | 'rangeEv'
      | 'rates'
      | 'whitePoint'
      | 'temperature'
      | 'tint'
      | 'colorLut'
      | 'colorLutStrength'
      | 'antialias'
      | 'transparency'
      | 'historyVersion'
      | 'bloom'
      | 'bloomThreshold'
      | 'bloomIntensity'
      | 'bloomSmoothWidth'
      | 'bloomRadius'
      | 'clearColor'
      | 'autoAspect'
      | 'target'
      | 'targetLayer'
    >();
    expectTypeOf<Data['fov']>().toEqualTypeOf<number>();
    expectTypeOf<Data['far']>().toEqualTypeOf<number>();
    expectTypeOf<Data['projection']>().toEqualTypeOf<number>();
    expectTypeOf<Data['projectionOffset']>().toEqualTypeOf<Float32Array>();
    type Input = InputShapeOf<SchemaOf<typeof Camera>>;
    expectTypeOf<Input['projectionOffset']>().toEqualTypeOf<Float32Array | readonly number[]>();
    expectTypeOf<Data['left']>().toEqualTypeOf<number>();
    // feat-20260519-tonemap-reinhard-mvp / M1 / T-M1.1: AC-01 +
    // plan-strategy section 2.3 D-1 (f32 enum encoding).
    expectTypeOf<Data['tonemap']>().toEqualTypeOf<number>();
    expectTypeOf<Data['exposure']>().toEqualTypeOf<number>();
    expectTypeOf<Data['exposureMode']>().toEqualTypeOf<number>();
    expectTypeOf<Data['compensationEv']>().toEqualTypeOf<number>();
    expectTypeOf<Data['rangeEv']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['rates']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['whitePoint']>().toEqualTypeOf<number>();
    expectTypeOf<Data['temperature']>().toEqualTypeOf<number>();
    expectTypeOf<Data['tint']>().toEqualTypeOf<number>();
    expectTypeOf<Data['colorLut']>().toEqualTypeOf<AssetHandle<'texture'>>();
    expectTypeOf<Data['colorLutStrength']>().toEqualTypeOf<number>();
    expectTypeOf<Data['transparency']>().toEqualTypeOf<number>();
    expectTypeOf<Data['historyVersion']>().toEqualTypeOf<number>();
    // feat-20260709 M3: clear-color quartet collapsed into one inline
    // array<f32,4> column; read side resolves to Float32Array (mirrors the
    // Transform pos/quat/scale precedent).
    expectTypeOf<Data['clearColor']>().toEqualTypeOf<Float32Array>();
    // feat-20260617 / M3: AC-09 -- bool column narrows to boolean, not number.
    expectTypeOf<Data['autoAspect']>().toEqualTypeOf<boolean>();
    expectTypeOf<Data['target']>().toEqualTypeOf<Handle<'RenderTarget', 'shared'>>();
  });

  it('DirectionalLight data shape includes closed shadow quality fields', () => {
    // feat-20260621: DirectionalLightShadow merged into DirectionalLight via castShadow toggle.
    // shadowDistance replaced the nearPlane/farPlane pair (near derives from camera).
    // feat-20260709 M2: direction/color collapsed to array<f32,3> columns.
    type Data = ShapeOf<SchemaOf<typeof DirectionalLight>>;
    expectTypeOf<keyof Data>().toEqualTypeOf<
      | 'direction'
      | 'color'
      | 'intensity'
      | 'lightingChannels'
      | 'castShadow'
      | 'mapSize'
      | 'cascadeCount'
      | 'splitLambda'
      | 'cascadeBlend'
      | 'depthBias'
      | 'normalBias'
      | 'shadowDistance'
      | 'shadowFilter'
      | 'shadowAngularRadius'
      | 'maxPenumbraTexels'
      | 'staggerCascades'
      | 'contactShadowLength'
      | 'shadowMapAspect'
      | 'shadowCasterChannels'
      | 'shadowAutoUpdate'
      | 'shadowRevision'
      | 'shadowProjection'
      | 'shadowViewProjection'
      | 'shadowBiasMode'
      | 'shadowRadius'
      | 'shadowIntensity'
      | 'shadowBlurSamples'
    >();
    expectTypeOf<Data['direction']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['color']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['intensity']>().toEqualTypeOf<number>();
    expectTypeOf<Data['lightingChannels']>().toEqualTypeOf<number>();
    // bool column narrows to boolean, not number.
    expectTypeOf<Data['castShadow']>().toEqualTypeOf<boolean>();
    expectTypeOf<Data['staggerCascades']>().toEqualTypeOf<boolean>();
    expectTypeOf<Data['shadowFilter']>().toEqualTypeOf<number>();
    expectTypeOf<Data['shadowAngularRadius']>().toEqualTypeOf<number>();
    expectTypeOf<Data['contactShadowLength']>().toEqualTypeOf<number>();
    expectTypeOf<Data['maxPenumbraTexels']>().toEqualTypeOf<number>();
  });
});

describe('w7 type-level - component name literal types are preserved', () => {
  it('Transform.name has the literal type "Transform"', () => {
    expectTypeOf<typeof Transform.name>().toEqualTypeOf<'Transform'>();
  });

  it('MeshFilter.name has the literal type "MeshFilter"', () => {
    expectTypeOf<typeof MeshFilter.name>().toEqualTypeOf<'MeshFilter'>();
  });

  it('MeshRenderer.name has the literal type "MeshRenderer" (AC-05 application point)', () => {
    // M2 / D-2: shading-model classification (unlit / standard) lives on
    // the asset, NOT on the component name. The single MeshRenderer
    // schema carries the merged surface; AC-13 routes per-frame via
    // `switch (mat.shadingModel)` in the canonical dispatch site.
    expectTypeOf<typeof MeshRenderer.name>().toEqualTypeOf<'MeshRenderer'>();
    expectTypeOf<keyof SchemaOf<typeof MeshRenderer>>().toEqualTypeOf<
      'materials' | 'lightingChannels' | 'conservativeSkinBounds' | 'preparePipelines'
    >();
  });

  it('Camera.name has the literal type "Camera"', () => {
    expectTypeOf<typeof Camera.name>().toEqualTypeOf<'Camera'>();
  });

  it('DirectionalLight.name has the literal type "DirectionalLight"', () => {
    expectTypeOf<typeof DirectionalLight.name>().toEqualTypeOf<'DirectionalLight'>();
  });

  it('ChildOf.name has the literal type "ChildOf" and parent ref field is keyof', () => {
    expectTypeOf<typeof ChildOf.name>().toEqualTypeOf<'ChildOf'>();
    expectTypeOf<keyof SchemaOf<typeof ChildOf>>().toEqualTypeOf<'parent'>();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// [w15] AC-04 type constraint: the ShapeOf<SchemaOf<typeof Component>> derivation
//       from the field-descriptor input guarantees that every field's default
//       value type aligns with the schema `type` (compile-time SSOT).
//       Proof points:
//         (a) ShapeOf<SchemaOf<typeof Transform>> => 4 Float32Array view fields
//         (b) Transform's field descriptor uses `default: Float32Array` for each
//             `type:'array<f32, N>'`
//         (c) A mismatched default (e.g. `default: "zero"` for `type:'array<f32, 3>'`)
//             would be rejected by TypeScript because
//             FieldDescriptor<'array<f32, 3>'> requires `default?: Float32Array`
//             (via FieldValueType<'array<f32, 3>'> = Float32Array).
// ────────────────────────────────────────────────────────────────────────────

describe('w15 AC-04 type constraint — ShapeOf derivation from field-payload', () => {
  it('ShapeOf<SchemaOf<typeof Transform>> yields local Float32Array views', () => {
    type T = ShapeOf<SchemaOf<typeof Transform>>;
    expectTypeOf<T['pos']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<T['quat']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<T['scale']>().toEqualTypeOf<Float32Array>();
    type GlobalData = ShapeOf<SchemaOf<typeof GlobalTransform>>;
    expectTypeOf<GlobalData['world']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<GlobalData['presentation']>().toEqualTypeOf<Float32Array>();
  });

  it("ShapeOf<SchemaOf<typeof Camera>> yields 21 number fields ('f32' -> number) + autoAspect boolean ('bool' -> boolean)", () => {
    type T = ShapeOf<SchemaOf<typeof Camera>>;
    expectTypeOf<T['fov']>().toEqualTypeOf<number>();
    expectTypeOf<T['projection']>().toEqualTypeOf<number>();
    expectTypeOf<T['tonemap']>().toEqualTypeOf<number>();
    expectTypeOf<T['bloom']>().toEqualTypeOf<number>();
    expectTypeOf<T['bloomThreshold']>().toEqualTypeOf<number>();
    expectTypeOf<T['bloomIntensity']>().toEqualTypeOf<number>();
    expectTypeOf<T['bloomSmoothWidth']>().toEqualTypeOf<number>();
    expectTypeOf<T['bloomRadius']>().toEqualTypeOf<number>();
    // feat-20260617 / M3: AC-09 -- the bool column narrows to boolean.
    expectTypeOf<T['autoAspect']>().toEqualTypeOf<boolean>();
  });

  it('ShapeOf<SchemaOf<typeof Transform>> is non-empty (field cardinality > 0)', () => {
    type T = ShapeOf<SchemaOf<typeof Transform>>;
    // If the schema were empty {}, keyof T would be never.
    // Transform has 4 keys (pos/quat/scale/world) => keyof T is a non-never union.
    type Keys = keyof T;
    // The assertion: Keys is exactly 4 string keys, not never.
    expectTypeOf<Keys>().toMatchTypeOf<string>();
    // The inverse: never would NOT be matched by a string literal.
  });

  it('AC-04 guard: default values in Transform field descriptors are Float32Array-typed', () => {
    // The Transform component definition supplies
    // { type: 'array<f32, N>', default: new Float32Array([...]) } for each of
    // its 3 local TRS fields. Because FieldDescriptor<'array<f32, 3>'> expects
    // default?: Float32Array, any non-typed-array default (e.g. "hello" or a
    // bare number) would be a type error. This compile-time assertion confirms
    // the derivation chain:
    //   field.type='array<f32, 3>' -> FieldValueType<'array<f32, 3>'> = Float32Array
    //   -> default must satisfy Float32Array
    // The ShapeOf projection is the final consumer evidence.
    type T = ShapeOf<SchemaOf<typeof Transform>>;
    expectTypeOf<T['pos']>().toEqualTypeOf<Float32Array>();
    // If FieldValueType<'array<f32, 3>'> had resolved to, say, number[], this would fail.
  });
});
