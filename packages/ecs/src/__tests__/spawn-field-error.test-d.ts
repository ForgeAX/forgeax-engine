// Compile-time type assertions for World.spawn() field-level error signalling
// after the fallback overload is removed (AC-09 historical) + after the M2
// `ComponentData.data` widening to `Partial<ShapeOf<S>>` (AC-01 / AC-02 of
// feat-20260517-spawn-default-fallback).
//
// Anchors: requirements §AC-09 / requirements-decisions §F (AC-09 field-level
// error signal restoration); research §R5.2 (P3 landing — AC-09 must live in
// ECS strict-typed __tests__, not the runtime test files that erase Camera /
// World types via 'unknown'); plan-strategy §2 decision D-4. The historical
// "missing required field" probe migrated to the AC-02 partial-data probe in
// world.test-d.ts §t6.b once M2 widened ComponentData<S>.data to
// Partial<ShapeOf<S>>.
//
// The fallback overload 'spawn(...componentDatas: ComponentData[])' was the
// historical TS escape hatch — calls that supplied a wrong `data.<field>`
// type or omitted a required field landed on the loose overload and emitted
// only a vague 'No overload matches this call'. After T-04 deletes the
// fallback, the only remaining candidate is the mapped-tuple primary, which
// surfaces field-level diagnostics ('Type X is not assignable to type Y') --
// the test below asserts that contract for the wrong-VALUE shape (the
// missing-FIELD shape is now a valid call after M2 / AC-02 and is covered by
// world.test-d.ts §t6.b).

import { describe, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

describe('spawn field-level errors (AC-09 wrong-value shape)', () => {
  it('AC-09 wrong field type: schema {value: string} rejects {value: number}', () => {
    const Name = defineComponent('Name', { value: { type: 'string' } });
    const world = new World();
    world.spawn({
      component: Name,
      data: {
        // @ts-expect-error AC-09 data.value must be string per schema; mapped-
        // tuple primary inference fires field-level TS2322 on the offending key.
        value: 42,
      },
    });
  });
});
