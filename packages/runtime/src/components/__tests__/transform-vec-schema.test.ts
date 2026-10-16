// feat-20260709 M2 / w4: Transform TRS scalar->array vec schema (TDD red-first).
//
// AC-05 (schema shape): Transform declares pos: array<f32, 3> / quat:
// array<f32, 4> (order [x,y,z,w]) / scale: array<f32, 3>; the legacy 10
// per-axis f32 scalar columns (posX..scaleZ) are gone -- one cut, no dual
// path (Change stance: Optimal > compatible).
//
// AC-06 (spawn typing, application-point discipline): a real world.spawn
// call-site with the array data shape typechecks green; the legacy 10-scalar
// data shape is locked compile-red via @ts-expect-error (InputShapeOf
// narrowing + excess property check). No standalone *.test-d.ts -- the
// assertions live on real spawn call-sites in this runtime test file.
//
// E1 / D-6 (default equivalence): spawn with data: {} lands the identity
// transform -- pos [0,0,0] / quat [0,0,0,1] / scale [1,1,1]. quat and scale
// carry explicit layer-2 defaults (research Finding 4: the layer-3 fallback
// for array<f32,N> is all-zero, which would produce an invalid zero
// quaternion / zero scale).

import { World } from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';

describe('w4 -- Transform vec schema (AC-05)', () => {
  it('(a) schema declares pos/quat/scale array columns, no per-axis scalars', () => {
    const schema = componentSchema(Transform) as Record<string, string>;
    expect(schema.pos).toBe('array<f32, 3>');
    expect(schema.quat).toBe('array<f32, 4>');
    expect(schema.scale).toBe('array<f32, 3>');

    for (const legacy of [
      'posX',
      'posY',
      'posZ',
      'quatX',
      'quatY',
      'quatZ',
      'quatW',
      'scaleX',
      'scaleY',
      'scaleZ',
    ]) {
      expect(schema[legacy]).toBeUndefined();
    }
  });

  it('(b) world column keeps array<f32, 16> (outside the M2 migration surface)', () => {
    const schema = componentSchema(GlobalTransform) as Record<string, string>;
    expect(schema.world).toBe('array<f32, 16>');
  });
});

describe('w4 -- Transform spawn typing (AC-06, real call-sites)', () => {
  it('array data shape typechecks green and spawns ok', () => {
    const world = new World();
    const r = world.spawn({
      component: Transform,
      data: { pos: [0, 6, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const v = world.get(r.value, Transform);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(Array.from(v.value.pos)).toEqual([0, 6, 0]);
    expect(Array.from(v.value.quat)).toEqual([0, 0, 0, 1]);
    expect(Array.from(v.value.scale)).toEqual([1, 1, 1]);
  });

  it('legacy 10-scalar data shape is compile-red (InputShapeOf narrowing)', () => {
    const world = new World();
    const r = world.spawn({
      component: Transform,
      data: {
        // @ts-expect-error legacy per-axis scalar keys were removed in M2; the
        // narrowed InputShapeOf rejects them at the spawn call-site (AC-06).
        posX: 1,
        posY: 2,
        posZ: 3,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      },
    });
    // Runtime backstop: the same shape fail-fasts through the structured
    // spawn error path (SpawnDataUnknownFieldError), not a silent write.
    expect(r.ok).toBe(false);
  });
});

describe('w4 -- Transform defaults (E1 / D-6)', () => {
  it('spawn with data: {} lands the identity transform', () => {
    const world = new World();
    const e = world.spawn({ component: Transform, data: {} }).unwrap();

    const r = world.get(e, Transform);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.from(r.value.pos)).toEqual([0, 0, 0]);
    expect(Array.from(r.value.quat)).toEqual([0, 0, 0, 1]);
    expect(Array.from(r.value.scale)).toEqual([1, 1, 1]);
  });

  it('partial spawn keeps omitted columns at their defaults', () => {
    const world = new World();
    const e = world.spawn({ component: Transform, data: { pos: [4, 5, 6] } }).unwrap();

    const r = world.get(e, Transform);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.from(r.value.pos)).toEqual([4, 5, 6]);
    expect(Array.from(r.value.quat)).toEqual([0, 0, 0, 1]);
    expect(Array.from(r.value.scale)).toEqual([1, 1, 1]);
  });
});
