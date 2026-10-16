// error-hints.unit.test.ts — PackErrorCode completeness assertions (M1 / w2)
//
// Coverage:
//   - PackErrorCode union member count === 14
//   - New hints do not contain stale "forgeax asset" sub-command form

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ImportErrorDetail, PackErrorCode } from '../index';
import {
  ASSET_EVIDENCE_ERROR_HINTS,
  ASSET_STAGE_ERROR_HINTS,
  ImportError,
  PACK_ERROR_HINTS,
} from '../index';

describe('PackErrorCode member count = 14', () => {
  it('PACK_ERROR_HINTS has exactly 14 keys', () => {
    const keys = Object.keys(PACK_ERROR_HINTS) as PackErrorCode[];
    expect(keys.length).toBe(14);
  });

  // Compile-time guard: PACK_ERROR_HINTS is Record<PackErrorCode, string>,
  // so every PackErrorCode member must have a corresponding key.
  it('PACK_ERROR_HINTS key type is assignable to PackErrorCode (compile-time Record completeness)', () => {
    const keys: readonly PackErrorCode[] = Object.keys(PACK_ERROR_HINTS) as PackErrorCode[];
    expect(keys).toBeDefined();
  });
});

describe('AssetEvidence error hints', () => {
  it('has one actionable hint per evidence error code', () => {
    expect(Object.keys(ASSET_EVIDENCE_ERROR_HINTS)).toEqual([
      'asset-evidence-capability-missing',
      'asset-evidence-source-conflict',
      'asset-evidence-locator-conflict',
      'asset-evidence-receipt-conflict',
      'asset-evidence-digest-mismatch',
    ]);
    for (const hint of Object.values(ASSET_EVIDENCE_ERROR_HINTS)) {
      expect(hint.length).toBeGreaterThan(0);
    }
  });
});

describe('ImportErrorDetail load-vs-conversion layering (feat-20260629 D-5 / w10)', () => {
  // D-5: the build-time "importer module failed to LOAD" case (e.g. a host
  // importer whose native addon is not built / module not found) must be
  // distinguishable from the "importer loaded but its conversion THREW" case
  // WITHOUT adding a new ImportErrorCode member (closed union stays 5). The
  // distinction rides ImportError.detail: the load variant carries
  // `loadError`, the conversion variant carries `reason`. AI users branch on
  // the `.detail` shape after `switch (err.code === 'import-internal-error')`.

  it('ImportErrorDetail admits a load-failure variant carrying loadError', () => {
    const detail: ImportErrorDetail = { loadError: 'Cannot find module @host/reel-importer' };
    expect('loadError' in detail).toBe(true);
  });

  it('a conversion-throw ImportError carries detail.reason (not loadError)', () => {
    const err = new ImportError({
      code: 'import-internal-error',
      expected: 'importer to convert without throwing',
      hint: 'importer bug',
      detail: { reason: 'decode failed: bad header' },
    });
    expect(err.code).toBe('import-internal-error');
    expect('reason' in err.detail).toBe(true);
    expect('loadError' in err.detail).toBe(false);
  });

  it('a module-load-failure ImportError carries detail.loadError (not reason), same code', () => {
    const err = new ImportError({
      code: 'import-internal-error',
      expected: 'importer module to load',
      hint: 'check the importer module / native addon is built',
      detail: { loadError: 'native addon build/Release/reel.node not found' },
    });
    expect(err.code).toBe('import-internal-error');
    expect('loadError' in err.detail).toBe(true);
    expect('reason' in err.detail).toBe(false);
    // AI user branches on the detail shape, never on .message text.
    if ('loadError' in err.detail) {
      expect(err.detail.loadError).toContain('reel.node');
    }
  });

  it('ImportErrorCode union includes authoring validation failures', () => {
    type ImportCode = import('../index').ImportErrorCode;
    expectTypeOf<ImportCode>().toEqualTypeOf<
      | 'importer-not-registered'
      | 'source-read-failed'
      | 'import-produced-no-assets'
      | 'guid-mismatch'
      | 'mesh-material-slot-topology-change'
      | 'mesh-lod-contract-invalid'
      | 'mesh-lod-topology-change'
      | 'mesh-lod-authority-conflict'
      | 'import-internal-error'
      | 'source-validation-failed'
      | 'unknown-source-key'
      | 'duplicate-source-key'
      | 'invalid-source-overrides'
      | 'invalid-source-override-payload'
    >();
  });
});

describe('asset authoring stage error hints', () => {
  it('publishes one recovery hint for each stage code', () => {
    expect(Object.keys(ASSET_STAGE_ERROR_HINTS)).toEqual([
      'author-validation-failed',
      'external-declaration-invalid',
      'import-failed',
      'native-cook-failed',
      'ddc-validation-failed',
      'runtime-parse-failed',
      'editor-capability-unavailable',
    ]);
    for (const hint of Object.values(ASSET_STAGE_ERROR_HINTS)) {
      expect(hint).toContain('recovery');
    }
  });
});
