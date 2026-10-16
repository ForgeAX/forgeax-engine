// error-exhaustive.test - locks the AssetErrorCode 23-member exhaustive
// switch with the M1 +`tileset-tile-entry-malformed` arm
// (feat-20260608-tilemap-object-layer-rendering M1; plan-tasks m1-t3 /
// m1-t4; plan-strategy §D-6 closed union + .detail.field 7-variant enum;
// charter P3 explicit failure + P4 consistent abstraction).
//
// Why a new focused file?
//   The pre-existing `errors.unit.test.ts` is a merged super-file that
//   covers many error codes; this file scopes the M1 contract for
//   tileset-tile-entry-malformed so AI users grep `error-exhaustive`
//   to land on the closed-union assertions without paging the larger
//   merged file (charter F1 single-import affordance).
//
// RED before m1-t4: 'tileset-tile-entry-malformed' is not yet a member
// of AssetErrorCode; the exhaustive `switch (code)` body fails TS narrow
// + the `const code: AssetErrorCode = '...'` assignment fails compile.

import {
  ASSET_ERROR_HINTS,
  AssetError,
  type AssetErrorCode,
  type AssetErrorDetail,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('ASSET_ERROR_HINTS runtime guard (28-member key set)', () => {
  it('ASSET_ERROR_HINTS includes the tileset-tile-entry-malformed key with non-empty hint', () => {
    expect(ASSET_ERROR_HINTS).toHaveProperty('tileset-tile-entry-malformed');
    const hint: string = ASSET_ERROR_HINTS['tileset-tile-entry-malformed'];
    expect(typeof hint).toBe('string');
    expect(hint.length).toBeGreaterThan(0);
  });

  it('ASSET_ERROR_HINTS includes the asset-invalidated key with non-empty hint', () => {
    expect(ASSET_ERROR_HINTS).toHaveProperty('asset-invalidated');
    const hint: string = ASSET_ERROR_HINTS['asset-invalidated'];
    expect(typeof hint).toBe('string');
    expect(hint.length).toBeGreaterThan(0);
  });

  it('ASSET_ERROR_HINTS includes the mesh-bin-contract-violation key with non-empty hint', () => {
    expect(ASSET_ERROR_HINTS).toHaveProperty('mesh-bin-contract-violation');
    const hint: string = ASSET_ERROR_HINTS['mesh-bin-contract-violation'];
    expect(typeof hint).toBe('string');
    expect(hint.length).toBeGreaterThan(0);
  });

  it('Object.keys(ASSET_ERROR_HINTS) length is 28', () => {
    const keys = Object.keys(ASSET_ERROR_HINTS);
    expect(keys.length).toBe(28);
  });

  it('hint contains >= 3 of the 7 .detail.field tokens', () => {
    const hint: string = ASSET_ERROR_HINTS['tileset-tile-entry-malformed'];
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
});

describe('AssetErrorCode 28-member exhaustive switch', () => {
  it('exhaustive switch over the 28 members compiles without a default branch', () => {
    function classify(code: AssetErrorCode): string {
      switch (code) {
        case 'asset-not-found':
          return 'not-found';
        case 'asset-parse-failed':
          return 'parse-failed';
        case 'asset-format-unsupported':
          return 'format-unsupported';
        case 'asset-fetch-failed':
          return 'fetch-failed';
        case 'catalog-source-unconfigured':
          return 'catalog-source-unconfigured';
        case 'asset-invalid-value':
          return 'invalid-value';
        case 'cubemap-handle-missing':
          return 'cubemap-handle-missing';
        case 'invalid-source-format':
          return 'invalid-source-format';
        case 'load-failed':
          return 'load-failed';
        case 'device-unsupported':
          return 'device-unsupported';
        case 'ibl-precompute-not-dispatched':
          return 'ibl-precompute-not-dispatched';
        case 'mesh-vertex-stride-mismatch':
          return 'mesh-vertex-stride-mismatch';
        case 'material-shader-ref-broken':
          return 'material-shader-ref-broken';
        case 'material-circular-inheritance':
          return 'material-circular-inheritance';
        case 'loader-not-registered':
          return 'loader-not-registered';
        case 'asset-not-imported':
          return 'asset-not-imported';
        case 'texture-source-not-imported':
          return 'texture-source-not-imported';
        case 'source-not-imported':
          return 'source-not-imported';
        case 'mesh-renderer-material-override-invalid':
          return 'mesh-renderer-material-override-invalid';
        case 'mesh-renderer-material-override-overflow':
          return 'mesh-renderer-material-override-overflow';
        case 'mesh-asset-submeshes-empty':
          return 'mesh-asset-submeshes-empty';
        case 'mesh-asset-material-slot-index-out-of-range':
          return 'mesh-asset-material-slot-index-out-of-range';
        case 'mesh-submesh-index-range-out-of-bounds':
          return 'mesh-submesh-index-range-out-of-bounds';
        case 'tileset-region-index-out-of-range':
          return 'tileset-region-index-out-of-range';
        case 'tileset-tile-entry-malformed':
          return 'tileset-tile-entry-malformed';
        case 'asset-invalidated':
          return 'asset-invalidated';
        // === 1 new code (feat-20260629-multi-uv-set-support M2 / m2-w5) ===
        case 'mesh-bin-contract-violation':
          return 'mesh-bin-contract-violation';
        // === 1 new code (feat-20260707-texture-block-compression M5 / w35) ===
        case 'mipgen-unsupported-compressed-format':
          return 'mipgen-unsupported-compressed-format';
      }
      // No default -- TS proves completeness (charter P3).
    }
    expect(classify('tileset-tile-entry-malformed')).toBe('tileset-tile-entry-malformed');
    expect(classify('tileset-region-index-out-of-range')).toBe('tileset-region-index-out-of-range');
    expect(classify('asset-invalidated')).toBe('asset-invalidated');
    expect(classify('asset-not-found')).toBe('not-found');
  });
});

describe('AssetTilesetTileEntryMalformedDetail discriminated narrow (.field 7 + .scope 2 + .tileEntryIndex?)', () => {
  it('narrowing on code surfaces the .field closed 7-variant enum without `as`', () => {
    type MalformedDetail = Extract<AssetErrorDetail, { code: 'tileset-tile-entry-malformed' }>;
    function isFieldName(d: MalformedDetail): string {
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
      // No default -- TS proves completeness over the 7-variant union.
    }
    const detail: MalformedDetail = {
      code: 'tileset-tile-entry-malformed',
      field: 'widthCells',
      scope: 'tile-entry',
      tileEntryIndex: 3,
      tilesetGuid: 'test/sample',
    };
    expect(isFieldName(detail)).toBe('widthCells');
  });

  it('AssetError can be constructed with the new code and round-trips .detail.field', () => {
    const err = new AssetError({
      code: 'tileset-tile-entry-malformed',
      expected: 'tile entry widthCells in (0, 64]',
      hint: 'register-time fail-fast',
      detail: {
        code: 'tileset-tile-entry-malformed',
        field: 'widthCells',
        scope: 'tile-entry',
        tileEntryIndex: 0,
        tilesetGuid: 'test/sample',
      },
    });
    expect(err.code).toBe('tileset-tile-entry-malformed');
    expect(err).toBeInstanceOf(AssetError);
    const d = err.detail;
    if (d !== undefined && 'code' in d && d.code === 'tileset-tile-entry-malformed') {
      expect(d.field).toBe('widthCells');
      expect(d.scope).toBe('tile-entry');
      expect(d.tileEntryIndex).toBe(0);
      expect(d.tilesetGuid).toBe('test/sample');
    } else {
      expect.fail('expected tileset-tile-entry-malformed detail narrow');
    }
  });

  it('asset-scope variant carries .scope = "tileset-asset" + omits tileEntryIndex', () => {
    const err = new AssetError({
      code: 'tileset-tile-entry-malformed',
      expected: 'atlases.length >= 1',
      hint: 'register-time fail-fast',
      detail: {
        code: 'tileset-tile-entry-malformed',
        field: 'atlases',
        scope: 'tileset-asset',
        tilesetGuid: 'test/sample',
      },
    });
    const d = err.detail;
    if (d !== undefined && 'code' in d && d.code === 'tileset-tile-entry-malformed') {
      expect(d.field).toBe('atlases');
      expect(d.scope).toBe('tileset-asset');
      expect(d.tileEntryIndex).toBeUndefined();
    } else {
      expect.fail('expected tileset-tile-entry-malformed detail narrow');
    }
  });
});
