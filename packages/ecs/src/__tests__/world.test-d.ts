// feat-20260517-spawn-default-fallback / M2 / t6.
//
// Compile-time type assertions for the `ComponentData<S>['data']` surface
// after the M2 widening + the spawn mapped-tuple primary-inference probe.
//
// Three pinned invariants (Red until t9 lands):
//
//   (a) ComponentData<S>['data'] === Partial<ShapeOf<S>>      — AC-01
//       The shared field bridge between `world.spawn` / `world.addComponent`
//       / overrides; widening from ShapeOf<S> to Partial<ShapeOf<S>> is the
//       single physical edit that takes the whole route off the ts(2739)
//       cliff (AC-02).
//
//   (b) `world.spawn({ component: Camera, data: { fov, aspect, near, far } })`
//       compiles                                              — AC-02
//       hello-window:93 baseline. With ShapeOf<S> the same call reports
//       ts(2739) "missing 5 properties"; with Partial<ShapeOf<S>> it
//       compiles (and at runtime layer-2 / layer-3 fallback fills the
//       remaining fields).
//
//   (c) `data: { fov: 'bad' }` fires field-level TS2322           — AC-03
//       Mapped-tuple primary inference must NOT degrade after the
//       widening: the wrong-VALUE case continues to surface as
//       TS2322 ("Type 'string' is not assignable to type 'number'")
//       directly on the offending key — NOT as the "No overload matches"
//       wall the legacy fallback overload would fall back to (C-4).
//
// AI users grep `// @ts-expect-error AC-` here to find the regression
// barrier that protects the mapped-tuple primary-inference behaviour
// across TS upgrades (R-1 / plan-strategy §2.7 P3).

import { describe, expectTypeOf, it } from 'vitest';
import { defineComponent, type SchemaOf, type ShapeOf } from '../component';
import { type ComponentData, World } from '../world';

// Shared schema fixture — mirrors the runtime Camera token (9 f32) without
// pulling @forgeax/engine-runtime in.
const CameraLike = defineComponent('CameraLike', {
  fov: { type: 'f32' },
  aspect: { type: 'f32' },
  near: { type: 'f32' },
  far: { type: 'f32' },
  projection: { type: 'f32' },
  left: { type: 'f32' },
  right: { type: 'f32' },
  bottom: { type: 'f32' },
  top: { type: 'f32' },
});

type CameraLikeSchema = SchemaOf<typeof CameraLike>;

describe('ComponentData<S>.data — Partial<ShapeOf<S>> (AC-01, t6.a)', () => {
  it('ComponentData<S>["data"] equals Partial<ShapeOf<S>>', () => {
    type DataField = ComponentData<CameraLikeSchema>['data'];
    expectTypeOf<DataField>().toEqualTypeOf<Partial<ShapeOf<CameraLikeSchema>>>();
  });

  it('ComponentData<S>["data"] is NOT the un-Partial ShapeOf<S>', () => {
    type DataField = ComponentData<CameraLikeSchema>['data'];
    // The wider Partial<ShapeOf<S>> is assignable to itself but the
    // narrower ShapeOf<S> would need every key. After M2 widening,
    // a Partial value is assignable to DataField; before M2 the same
    // Partial is rejected by ShapeOf<S>'s required-keys contract.
    const partial: Partial<ShapeOf<CameraLikeSchema>> = { fov: 1 };
    const field: DataField = partial;
    void field;
  });

  it('ComponentData<S>["data"] is NOT widened to any', () => {
    type DataField = ComponentData<CameraLikeSchema>['data'];
    expectTypeOf<DataField>().not.toBeAny();
  });
});

describe('world.spawn — partial data accepted (AC-02, t6.b)', () => {
  it('hello-window-shape 4-field call compiles after M2 widening', () => {
    const w = new World();
    // The hello-window:93 baseline call: drop the 5 ortho fields on a
    // perspective spawn. Before M2 this fires ts(2739) ("missing 5
    // properties"); after M2 it compiles and runtime layer-2 / layer-3
    // fallback fills the missing fields.
    const r = w.spawn({
      component: CameraLike,
      data: { fov: 1, aspect: 1, near: 1, far: 100 },
    });
    void r;
  });

  it('full 9-field call still compiles (no regression)', () => {
    const w = new World();
    const r = w.spawn({
      component: CameraLike,
      data: {
        fov: 1,
        aspect: 1,
        near: 1,
        far: 100,
        projection: 0,
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
      },
    });
    void r;
  });

  it('completely empty data: {} compiles (every field defaulted)', () => {
    const w = new World();
    const r = w.spawn({
      component: CameraLike,
      data: {},
    });
    void r;
  });
});

describe('world.spawn — wrong-value fires field-level TS2322 (AC-03, t6.c)', () => {
  it('data: { fov: "bad" } reports field-level TS2322 (mapped-tuple primary intact)', () => {
    const w = new World();
    // AC-03: mapped-tuple primary inference surfaces wrong-VALUE on the
    // OFFENDING KEY (field-level TS2322), not as the overload wall.
    // The directive sits directly above the offending key so vitest's
    // ts-expect-error tracker sees the suppression land on the right
    // expression.
    w.spawn({
      component: CameraLike,
      data: {
        // @ts-expect-error AC-03 fov is f32 (number), not string
        fov: 'bad',
      },
    });
  });

  it('data: { aspect: false } reports field-level TS2322 (bool->f32 narrowing)', () => {
    const w = new World();
    w.spawn({
      component: CameraLike,
      data: {
        // @ts-expect-error AC-03 aspect is f32 (number), not boolean
        aspect: false,
      },
    });
  });

  it('data: { unknownKey: 1 } reports excess-property error, not "No overload matches"', () => {
    const w = new World();
    w.spawn({
      component: CameraLike,
      data: {
        // @ts-expect-error AC-03 unknownKey is not part of CameraLike schema
        unknownKey: 1,
      },
    });
  });
});
