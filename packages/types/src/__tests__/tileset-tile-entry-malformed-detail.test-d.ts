// tileset-tile-entry-malformed-detail.test-d - type-level assertions for the
// M1 AssetErrorCode growth (20 -> 21) + AssetTilesetTileEntryMalformedDetail
// closed 7-variant `.detail.field` enum + ASSET_ERROR_HINTS completeness
// (feat-20260608-tilemap-object-layer-rendering M1; plan-tasks m1-t3 /
// m1-t4; plan-strategy §D-6; charter P3 + P4).
//
// Assertions:
// - 'tileset-tile-entry-malformed' is a member of AssetErrorCode (M0 = 20,
//   M1 = 21 -- plan-strategy §D-6 absolute count).
// - AssetTilesetTileEntryMalformedDetail (or the discriminated arm in
//   AssetErrorDetail) carries `.field` closed enum of 7 variants:
//     'widthCells' | 'heightCells' | 'pivotX' | 'pivotY' | 'collider' |
//     'atlases' | 'atlasIndex'
//   exhaustive `switch (detail.field)` compiles without default (charter P3).
// - `.scope?` is closed 2-variant 'tileset-asset' | 'tile-entry'.
// - `.tileEntryIndex?: number` optional, `.tilesetGuid: string` required.
// - ASSET_ERROR_HINTS['tileset-tile-entry-malformed'] is a non-empty string
//   with >=3 of the 7 .detail.field tokens + the 'register-time fail-fast'
//   recovery phrase.
//
// RED before m1-t4: AssetErrorCode union missing 'tileset-tile-entry-malformed';
// AssetErrorDetail union missing the new variant; ASSET_ERROR_HINTS missing
// the new key.

import { describe, expect, expectTypeOf, it } from 'vitest';
import { ASSET_ERROR_HINTS, type AssetErrorCode, type AssetErrorDetail } from '../index';

describe('AssetErrorCode 21 members (M1 tileset-tile-entry-malformed)', () => {
  it('type-level: tileset-tile-entry-malformed is a literal of AssetErrorCode', () => {
    expectTypeOf<'tileset-tile-entry-malformed'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('runtime: a code variable accepts the literal', () => {
    const code: AssetErrorCode = 'tileset-tile-entry-malformed';
    expect(code).toBe('tileset-tile-entry-malformed');
  });
});

describe('AssetTilesetTileEntryMalformedDetail .field closed 7-variant enum', () => {
  it('type-level: exhaustive switch on .field covers 7 variants without default', () => {
    type MalformedDetail = Extract<AssetErrorDetail, { code: 'tileset-tile-entry-malformed' }>;
    function describeField(d: MalformedDetail): string {
      switch (d.field) {
        case 'widthCells':
          return 'widthCells';
        case 'heightCells':
          return 'heightCells';
        case 'pivotX':
          return 'pivotX';
        case 'pivotY':
          return 'pivotY';
        case 'collider':
          return 'collider';
        case 'atlases':
          return 'atlases';
        case 'atlasIndex':
          return 'atlasIndex';
      }
      // No default branch -- TS guards completeness (charter P3).
    }
    expectTypeOf(describeField).returns.toEqualTypeOf<string>();
  });

  it('type-level: .scope? closed 2-variant enum (tileset-asset | tile-entry)', () => {
    type MalformedDetail = Extract<AssetErrorDetail, { code: 'tileset-tile-entry-malformed' }>;
    expectTypeOf<MalformedDetail['scope']>().toEqualTypeOf<
      'tileset-asset' | 'tile-entry' | undefined
    >();
  });

  it('type-level: .tilesetGuid required string, .tileEntryIndex optional number', () => {
    type MalformedDetail = Extract<AssetErrorDetail, { code: 'tileset-tile-entry-malformed' }>;
    expectTypeOf<MalformedDetail['tilesetGuid']>().toEqualTypeOf<string>();
    expectTypeOf<MalformedDetail['tileEntryIndex']>().toEqualTypeOf<number | undefined>();
  });
});

describe('ASSET_ERROR_HINTS completeness for tileset-tile-entry-malformed', () => {
  it('type-level: ASSET_ERROR_HINTS is Record<AssetErrorCode, string> (adding a code without a hint fails compile)', () => {
    expectTypeOf(ASSET_ERROR_HINTS).toEqualTypeOf<Readonly<Record<AssetErrorCode, string>>>();
  });

  it('runtime: hint string for tileset-tile-entry-malformed is non-empty', () => {
    const hint = ASSET_ERROR_HINTS['tileset-tile-entry-malformed'];
    expect(typeof hint).toBe('string');
    expect(hint.length).toBeGreaterThan(0);
  });

  it('runtime: hint contains >= 3 of the 7 .detail.field tokens (AI grep affordance)', () => {
    const hint = ASSET_ERROR_HINTS['tileset-tile-entry-malformed'];
    const tokens = [
      'widthCells',
      'heightCells',
      'pivotX',
      'pivotY',
      'collider',
      'atlases',
      'atlasIndex',
    ];
    const hits = tokens.filter((t) => hint.includes(t));
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it('runtime: hint mentions register-time fail-fast recovery phrase', () => {
    const hint = ASSET_ERROR_HINTS['tileset-tile-entry-malformed'];
    expect(hint).toContain('register-time');
  });
});
