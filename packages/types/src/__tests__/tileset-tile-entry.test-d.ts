// tileset-tile-entry.test-d - type-level + runtime assertions for the M1
// schema extension of `TilesetTileEntry` (feat-20260608-tilemap-object-layer
// -rendering M1; plan-tasks m1-t1; plan-strategy §M1 + §D-4).
//
// M1 boundary additions (all optional; charter F1 compatibility):
// - TilesetTileEntry +5 optional: widthCells / heightCells / pivotX / pivotY /
//   collider (collider 3-variant closed union: 'none' | 'rect' | 'polygon').
// - TilesetRegion +atlasIndex?: number (multi-atlas routing; default 0).
//
// Assertions:
// - Unit-cell call site `{ regionIndex: 0 }` still type-checks (charter F1).
// - Variable-size + custom-pivot call site narrows directly without `as`.
// - `collider?.type` switch with the three variants exhausts the union (no
//   default) -- charter P3 closed enum.
// - rect variant carries `rect: readonly [number, number, number, number]`.
// - polygon variant carries `points: readonly (readonly [number, number])[]`.
// - TilesetRegion.atlasIndex? is optional `number`.
// - `assets.register<TilesetAsset>` input form accepts both unit-cell and
//   variable-size + collider together (mixed array element types coexist).
//
// Anchors: requirements §AC-01 / §AC-02 / §AC-04 / §AC-05 type-level
// falsifier; plan-strategy §M1; charter F1 + P3 + P4.

import { describe, expectTypeOf, it } from 'vitest';
import type { TilesetAsset, TilesetRegion, TilesetTileCollider, TilesetTileEntry } from '../index';

describe('TilesetTileEntry POD shape (M1 schema extension)', () => {
  it('type-level: unit-cell call site {regionIndex: 0} still typechecks (charter F1)', () => {
    const entry: TilesetTileEntry = { regionIndex: 0 };
    expectTypeOf(entry).toMatchTypeOf<TilesetTileEntry>();
  });

  it('type-level: 5 optional fields narrow without `as` (variable-size + pivot)', () => {
    const entry: TilesetTileEntry = {
      regionIndex: 0,
      widthCells: 3,
      heightCells: 4,
      pivotX: 0.5,
      pivotY: 0.2,
    };
    expectTypeOf(entry.widthCells).toEqualTypeOf<number | undefined>();
    expectTypeOf(entry.heightCells).toEqualTypeOf<number | undefined>();
    expectTypeOf(entry.pivotX).toEqualTypeOf<number | undefined>();
    expectTypeOf(entry.pivotY).toEqualTypeOf<number | undefined>();
  });

  it('type-level: collider 3-variant closed union exhausts without default', () => {
    function describeCollider(c: TilesetTileCollider): string {
      switch (c.type) {
        case 'none':
          return 'none';
        case 'rect':
          return 'rect';
        case 'polygon':
          return 'polygon';
      }
      // No default branch -- TS guards completeness (charter P3).
    }
    expectTypeOf(describeCollider).returns.toEqualTypeOf<string>();
  });

  it('type-level: rect variant carries 4-tuple of numbers', () => {
    const rect: TilesetTileCollider = { type: 'rect', rect: [0, 0, 1, 1] };
    if (rect.type === 'rect') {
      expectTypeOf(rect.rect).toEqualTypeOf<readonly [number, number, number, number]>();
    }
  });

  it('type-level: polygon variant carries readonly array of 2-tuples', () => {
    const poly: TilesetTileCollider = {
      type: 'polygon',
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    };
    if (poly.type === 'polygon') {
      expectTypeOf(poly.points).toEqualTypeOf<readonly (readonly [number, number])[]>();
    }
  });

  it('type-level: TilesetTileEntry with full 5 fields + collider rect', () => {
    const entry: TilesetTileEntry = {
      regionIndex: 0,
      widthCells: 3,
      heightCells: 4,
      pivotX: 0.5,
      pivotY: 0.2,
      collider: { type: 'rect', rect: [0, 0, 1, 1] },
    };
    expectTypeOf(entry.collider).toEqualTypeOf<TilesetTileCollider | undefined>();
  });

  it('type-level: TilesetTileEntry with collider polygon', () => {
    const entry: TilesetTileEntry = {
      regionIndex: 0,
      collider: {
        type: 'polygon',
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      },
    };
    expectTypeOf(entry.collider).toEqualTypeOf<TilesetTileCollider | undefined>();
  });

  it('type-level: TilesetTileEntry with collider none', () => {
    const entry: TilesetTileEntry = {
      regionIndex: 0,
      collider: { type: 'none' },
    };
    expectTypeOf(entry.collider).toEqualTypeOf<TilesetTileCollider | undefined>();
  });
});

describe('TilesetRegion POD shape (M1 schema extension)', () => {
  it('type-level: TilesetRegion has 4 required fields + atlasIndex? optional', () => {
    expectTypeOf<TilesetRegion['x']>().toEqualTypeOf<number>();
    expectTypeOf<TilesetRegion['y']>().toEqualTypeOf<number>();
    expectTypeOf<TilesetRegion['width']>().toEqualTypeOf<number>();
    expectTypeOf<TilesetRegion['height']>().toEqualTypeOf<number>();
    expectTypeOf<TilesetRegion['atlasIndex']>().toEqualTypeOf<number | undefined>();
  });

  it('type-level: TilesetRegion without atlasIndex still typechecks (charter F1)', () => {
    const r: TilesetRegion = { x: 0, y: 0, width: 16, height: 16 };
    expectTypeOf(r).toMatchTypeOf<TilesetRegion>();
  });

  it('type-level: TilesetRegion with atlasIndex narrows', () => {
    const r: TilesetRegion = { x: 0, y: 0, width: 16, height: 16, atlasIndex: 1 };
    expectTypeOf(r.atlasIndex).toEqualTypeOf<number | undefined>();
  });
});

describe('TilesetAsset accepts both unit-cell and full-shape entries together', () => {
  it('type-level: mixed tiles[] array compiles (charter F1 backward compat)', () => {
    type MixedAssetShape = Pick<TilesetAsset, 'tiles'>;
    const tiles: MixedAssetShape['tiles'] = [
      { regionIndex: 0 },
      {
        regionIndex: 1,
        widthCells: 3,
        heightCells: 4,
        pivotX: 0.5,
        pivotY: 0.2,
        collider: { type: 'rect', rect: [0, 0, 1, 1] },
      },
      {
        regionIndex: 2,
        collider: {
          type: 'polygon',
          points: [
            [0, 0],
            [1, 0],
            [0.5, 1],
          ],
        },
      },
    ];
    expectTypeOf(tiles).toMatchTypeOf<MixedAssetShape['tiles']>();
  });
});
