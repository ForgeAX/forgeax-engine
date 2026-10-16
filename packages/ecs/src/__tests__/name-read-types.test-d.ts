import { Update } from '../schedule-token';
// w7 --- 3-point AC-02: world.get(e, C).unwrap().value infers as `string`.
//
// Locks AC-02 from requirements: AI users see a native JS `string` value
// (not StringView, not a wrapper) when reading a `'string'` schema-vocab
// field at three application points:
//
//   (a) inside `world.addSystem(Update, { fn })` callback;
//   (b) inside a QueryRow loop;
//   (c) at top-level after a direct import.
//
// All three sites pass through the same `FieldValueType<'string'> = string`
// derivation locked by w9 / w12; this file pins the inference at the
// observable read shape, with zero `as` assertions.
//
// Uses an inline `defineComponent('TestName', { value: 'string' })` instead
// of the public `Name` token: `Name` was migrated to `@forgeax/engine-runtime`
// (tweak-20260612-ecs-concept-compression -- it is a built-in component, not
// part of the ECS framework itself). The ECS-internal type test exercises the
// `'string'` schema-vocab keyword directly to avoid an upstream import
// dependency on the runtime sibling.

import { describe, expectTypeOf, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

const TestName = defineComponent('TestName', { value: { type: 'string' } });

describe('w7 --- (a) inside world.addSystem fn callback (AC-02)', () => {
  it('world.get(e, TestName).unwrap().value infers as string', () => {
    const w = new World();
    const e = w.spawn({ component: TestName, data: { value: 'Player' } }).unwrap();

    w.addSystem(Update, {
      name: 'reader',
      queries: [],
      fn: () => {
        const value = w.get(e, TestName).unwrap().value;
        expectTypeOf(value).toEqualTypeOf<string>();
      },
    });
  });
});

describe('w7 --- (b) inside a QueryRow loop (AC-02)', () => {
  it('world.get(e, TestName).unwrap().value infers as string from a query callback', () => {
    const w = new World();
    const e = w.spawn({ component: TestName, data: { value: 'Boss' } }).unwrap();

    w.addSystem(Update, {
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
