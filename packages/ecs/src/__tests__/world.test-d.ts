import { describe, expectTypeOf, it } from 'vitest';
import { defineComponent, type SchemaOf, type ShapeOf } from '../component';
import type { Query } from '../query/query';
import { defineSystem } from '../schedule';
import { Update } from '../schedule-token';
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

const Position = defineComponent('WorldQueryInferencePosition', { x: 'f32' });
const Velocity = defineComponent('WorldQueryInferenceVelocity', { x: 'f32' });

describe('World.query consumer inference', () => {
  it('preserves descriptor tuples through Result.unwrap', () => {
    const query = new World().query({ read: [Position], write: [Velocity] }).unwrap();
    expectTypeOf(query).toEqualTypeOf<
      Query<readonly [typeof Position], readonly [typeof Velocity], readonly []>
    >();
  });
});

const TestName = defineComponent('TestName', { value: { type: 'string' } });

describe('w7 --- (a) inside world.addSystem fn callback (AC-02)', () => {
  it('world.get(e, TestName).unwrap().value infers as string', () => {
    const w = new World();
    const e = w.spawn({ component: TestName, data: { value: 'Player' } }).unwrap();

    const systemToken1 = defineSystem({
      name: 'reader',
      queries: [],
      fn: () => {
        const value = w.get(e, TestName).unwrap().value;
        expectTypeOf(value).toEqualTypeOf<string>();
      },
    });
    w.addSystem(Update, systemToken1);
  });
});

describe('w7 --- (b) inside a QueryRow loop (AC-02)', () => {
  it('world.get(e, TestName).unwrap().value infers as string from a query callback', () => {
    const w = new World();
    const e = w.spawn({ component: TestName, data: { value: 'Boss' } }).unwrap();

    const systemToken2 = defineSystem({
      name: 'queryReader',
      queries: [{ with: [TestName] }],
      fn: (_world, results) => {
        for (const result of results) {
          for (const _bundle of result) {
            const value = w.get(e, TestName).unwrap().value;
            expectTypeOf(value).toEqualTypeOf<string>();
          }
        }
      },
    });
    w.addSystem(Update, systemToken2);
  });
});

describe('w7 --- (c) top-level direct import (AC-02)', () => {
  it('world.get(e, TestName).unwrap().value infers as string at top-level', () => {
    const w = new World();
    const e = w.spawn({ component: TestName, data: { value: 'Hero' } }).unwrap();
    const value = w.get(e, TestName).unwrap().value;
    expectTypeOf(value).toEqualTypeOf<string>();
  });
});

describe('[w14] AC-4 — 30-second onboarding minimal example', () => {
  it('bundle field access compiles without `as` casts', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });
    const Velocity = defineComponent('Velocity', { dx: { type: 'f32' }, dy: { type: 'f32' } });

    const world = new World();
    const systemToken1 = defineSystem({
      name: 'movement',
      queries: [{ read: [Velocity], write: [Position] }],
      fn: (_world, queryResults, _commands) => {
        for (const row of queryResults[0]) {
          const velocity = row.get(Velocity);
          const position = row.mut(Position);
          expectTypeOf(position.x).toBeNumber();
          expectTypeOf(velocity.dx).toBeNumber();
          position.x += velocity.dx;
        }
      },
    });
    world.addSystem(Update, systemToken1);

    expectTypeOf(world).toMatchTypeOf<World>();
  });
});
