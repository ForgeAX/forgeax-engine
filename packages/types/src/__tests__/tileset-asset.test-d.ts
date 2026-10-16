// tileset-asset.test-d - type-level + runtime assertions for the M0 baseline
// `TilesetAsset` POD shape (feat-20260608 M0 baseline rebuild on origin/main
// after the 2026-06-12 feat-20260604 revert chain).
//
// Assertions:
// - TilesetAsset durable fields (kind / atlases / tileWidth / tileHeight /
//   columns / rows / regions / tiles); `atlases` is a plural composite
//   `readonly Handle<'TextureAsset','shared'>[]` (D-7 atlases[] one-cut, no
//   intermediate single-`atlas` form).
// - TilesetRegion 4 required fields (x / y / width / height); M0 schema has
//   no optional `atlasIndex` field (M1 boundary).
// - TilesetTileEntry M0 shape: only `regionIndex: number` (M1 adds the 5
//   optional fields + collider variant).
// - TilesetAsset.kind narrows from the closed `Asset` union (charter P3
//   discriminator literal narrow).
// - `Asset` union exhaustive switch carries a 'tileset' arm that compiles
//   without a default fallback.
// - TagOf<TilesetAsset> resolves to 'TilesetAsset' (AssetTagMap row).
//
// Anchors: requirements §AC-01/03/04/05; plan-strategy §D-5 (M0 baseline)
// + §D-7 (atlases[] one-cut); plan-tasks m0-t1.

import { describe, expectTypeOf, it } from 'vitest';
import type { Asset, TagOf, TilesetAsset, TilesetRegion, TilesetTileEntry } from '../index';

describe('TilesetAsset POD shape (M0 baseline)', () => {
  it('type-level: 9 fields with required types', () => {
    expectTypeOf<TilesetAsset['kind']>().toEqualTypeOf<'tileset'>();
    expectTypeOf<TilesetAsset>().not.toHaveProperty('guid');
    expectTypeOf<TilesetAsset['atlases']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<TilesetAsset['tileWidth']>().toEqualTypeOf<number>();
    expectTypeOf<TilesetAsset['tileHeight']>().toEqualTypeOf<number>();
    expectTypeOf<TilesetAsset['columns']>().toEqualTypeOf<number>();
    expectTypeOf<TilesetAsset['rows']>().toEqualTypeOf<number>();
    expectTypeOf<TilesetAsset['regions']>().toEqualTypeOf<readonly TilesetRegion[]>();
    expectTypeOf<TilesetAsset['tiles']>().toEqualTypeOf<readonly TilesetTileEntry[]>();
  });

  it('type-level: TilesetRegion has 4 required fields', () => {
    expectTypeOf<TilesetRegion['x']>().toEqualTypeOf<number>();
    expectTypeOf<TilesetRegion['y']>().toEqualTypeOf<number>();
    expectTypeOf<TilesetRegion['width']>().toEqualTypeOf<number>();
    expectTypeOf<TilesetRegion['height']>().toEqualTypeOf<number>();
  });

  it('type-level: TilesetTileEntry carries required regionIndex (M0 boundary, M1 extended)', () => {
    expectTypeOf<TilesetTileEntry['regionIndex']>().toEqualTypeOf<number>();
    // M1 schema extension: the M0 boundary "only regionIndex" assertion is
    // superseded by the M1 boundary assertions in
    // packages/types/src/__tests__/tileset-tile-entry.test-d.ts which lock
    // the +5 optional fields (widthCells / heightCells / pivotX / pivotY /
    // collider) + TilesetRegion.atlasIndex? -- see plan-tasks m1-t1 / m1-t2.
    // regionIndex stays the only REQUIRED field on TilesetTileEntry (charter
    // F1: unit-cell `{ regionIndex: 0 }` is still a complete value).
    const entry: TilesetTileEntry = { regionIndex: 0 };
    expectTypeOf(entry).toMatchTypeOf<TilesetTileEntry>();
  });

  it('type-level: Asset union narrows to TilesetAsset on kind="tileset"', () => {
    function narrow(a: Asset): TilesetAsset | undefined {
      if (a.kind === 'tileset') return a;
      return undefined;
    }
    expectTypeOf(narrow).returns.toEqualTypeOf<TilesetAsset | undefined>();
  });

  it('type-level: exhaustive switch on Asset.kind includes "tileset" arm without default', () => {
    function describeKind(a: Asset): string {
      switch (a.kind) {
        case 'plugin':
          return 'plugin';
        case 'mesh':
          return 'mesh';
        case 'texture':
          return 'texture';
        case 'equirect':
          return 'equirect';
        case 'sampler':
          return 'sampler';
        case 'material':
          return 'material';
        case 'scene':
          return 'scene';
        case 'skeleton':
          return 'skeleton';
        case 'skin':
          return 'skin';
        case 'animation-clip':
          return 'animation-clip';
        case 'animation-graph':
          return 'animation-graph';
        case 'audio':
          return 'audio';
        case 'ies-profile':
          return 'ies-profile';
        case 'font':
          return 'font';
        case 'render-pipeline':
          return 'render-pipeline';
        case 'tileset':
          return 'tileset';
        case 'video':
          return 'video';
        case 'navigation-mesh':
        case 'terrain':
          return 'TerrainAsset';
        case 'particle-effect':
          return 'particle-effect';
      }
      // No default branch -- TS guards completeness.
    }
    expectTypeOf(describeKind).returns.toEqualTypeOf<string>();
  });

  it('type-level: TagOf<TilesetAsset> resolves to "TilesetAsset"', () => {
    expectTypeOf<TagOf<TilesetAsset>>().toEqualTypeOf<'TilesetAsset'>();
  });
});
