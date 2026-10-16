// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch / M1 / w5.
//
// Production assertion for `TileLayer.sortScope` (round-2; replaces the
// round-1 forward-looking type-only lock). The upstream `feat-20260622`
// chunk system has landed in the rebased branch (D-V-3 confirmation in
// verify-decisions.md: PR #502 merged 2026-06-26T07:24Z) so `TileLayer`
// is now an importable runtime component and we can assert the real
// `sortScope: SortScope` field surface instead of a stand-alone type
// alias.
//
// What round-2 changes vs round-1:
//   - The literal-union type `SortScope` now comes from
//     `@forgeax/engine-runtime` (re-exported via the components barrel);
//     the test imports it instead of redeclaring a parallel type alias.
//   - We spawn an actual TileLayer entity with `sortScope: 'per-cell'`
//     and read the bridge u8 (`encodeSortScope('per-cell') === 1`) back
//     from the column. Forward-looking-only `@ts-expect-error`
//     assignment checks are kept for the AI-user surface (closed union
//     remains exhaustive at compile time).
//
// Anchors: requirements AC-02 (breaking change, TS-error-only migration);
// plan-strategy R-NEW-2 (sortScope storage decision); verify-decisions
// D-V-3 (R-NEW-1 fallback graduation: forward-looking -> production
// because upstream landed during merge resolution). Charter F1 (single-
// symbol discovery — `SortScope` grep lands here + `tile-layer.ts`),
// P1 (progressive disclosure — `'layer'` / `'per-cell'` reads directly).

import { World } from '@forgeax/engine-ecs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  decodeSortScope,
  encodeSortScope,
  type SortScope,
  TileLayer,
} from '../../../../render/src/components';

describe('TileLayer.sortScope union lock (w5, round-2 production)', () => {
  it("'layer' is assignable to SortScope", () => {
    const v: SortScope = 'layer';
    expectTypeOf<typeof v>().toMatchTypeOf<SortScope>();
  });

  it("'per-cell' is assignable to SortScope", () => {
    const v: SortScope = 'per-cell';
    expectTypeOf<typeof v>().toMatchTypeOf<SortScope>();
  });

  it('exhaustive switch over SortScope narrows both arms (compile-time)', () => {
    function classify(s: SortScope): 'terrain' | 'object' {
      switch (s) {
        case 'layer':
          return 'terrain';
        case 'per-cell':
          return 'object';
      }
    }
    expectTypeOf(classify).parameter(0).toEqualTypeOf<SortScope>();
  });

  it('union has exactly the 2 literal members (no widening to string)', () => {
    expectTypeOf<SortScope>().toEqualTypeOf<'layer' | 'per-cell'>();
  });

  it('@ts-expect-error: arbitrary strings are not assignable to SortScope', () => {
    // @ts-expect-error 'random' is outside the closed union.
    const wrong1: SortScope = 'random';
    void wrong1;
    // @ts-expect-error legacy 'ySort' u8 literals are not assignable.
    const wrong2: SortScope = 0;
    void wrong2;
    // @ts-expect-error legacy 'ySort' u8 literals are not assignable.
    const wrong3: SortScope = 1;
    void wrong3;
  });
});

describe('TileLayer.sortScope production bridge (w5, round-2)', () => {
  it("encodeSortScope('layer') === 0", () => {
    expect(encodeSortScope('layer')).toBe(0);
  });

  it("encodeSortScope('per-cell') === 1", () => {
    expect(encodeSortScope('per-cell')).toBe(1);
  });

  it("decodeSortScope(0) === 'layer'", () => {
    expect(decodeSortScope(0)).toBe('layer');
  });

  it("decodeSortScope(1) === 'per-cell'", () => {
    expect(decodeSortScope(1)).toBe('per-cell');
  });

  it("decodeSortScope(undefined | out-of-range) defaults to 'layer'", () => {
    expect(decodeSortScope(undefined)).toBe('layer');
    expect(decodeSortScope(2)).toBe('layer');
    expect(decodeSortScope(255)).toBe('layer');
  });

  it('spawn TileLayer with sortScope omitted -> stored u8 = 0 (default layer)', () => {
    const world = new World();
    const entity = world
      .spawn({ component: TileLayer, data: { tiles: new Uint32Array(4) } })
      .unwrap();
    const row = world.get(entity, TileLayer).unwrap();
    expect(row.sortScope).toBe(0);
    expect(decodeSortScope(row.sortScope)).toBe('layer');
  });

  it("spawn TileLayer with sortScope: 'per-cell' bridges to stored u8 = 1", () => {
    const world = new World();
    const entity = world
      .spawn({
        component: TileLayer,
        data: {
          tiles: new Uint32Array(4),
          sortScope: encodeSortScope('per-cell'),
        },
      })
      .unwrap();
    const row = world.get(entity, TileLayer).unwrap();
    expect(row.sortScope).toBe(1);
    expect(decodeSortScope(row.sortScope)).toBe('per-cell');
  });
});
