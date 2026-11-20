// asset-errors.test-d - type-level (test-d) assertions for the 5-member closed
// `AssetErrorCode` union and `ASSET_ERROR_HINTS` Record completeness
// (feat-20260518-pbr-direct-lighting-mvp / M1 / w1; minor evolution add 5th
// member 'asset-invalid-value' per plan-strategy D-1).
//
// Assertions:
// - Type-level: AssetErrorCode union contains 'asset-invalid-value' (5th member).
// - Type-level: ASSET_ERROR_HINTS is Record<AssetErrorCode, string> -- adding a
//   new union member without hint entry is a TS compile error here.
// - Runtime smoke: ASSET_ERROR_HINTS['asset-invalid-value'] hint literal matches
//   the generalized register-time-validation hint (covers MaterialAsset clamp +
//   strip-topology MeshAsset index-buffer cases; feat-20260604-mesh-topology-debug-draw
//   verify-hotfix generalized the feat-20260518 plan-decisions L-1 single-case lock-in).
//
// Anchors: requirements AC-02 (verbatim 'asset-invalid-value');
//          plan-strategy D-1 (4 -> 5 minor evolution);
//          plan-decisions §2.1 (L-1 hint literal lock-in).

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AssetStageError,
  AuthorValidationError,
  DdcValidationError,
  EditorCapabilityError,
  ExternalDeclarationError,
  ImportStageError,
  NativeCookError,
  RuntimeParseError,
} from '../asset-errors.js';
import {
  ASSET_ERROR_HINTS,
  type AssetErrorCode,
  type MeshAsset,
  type VertexAttributeMap,
} from '../index';

describe('AssetErrorCode closed union', () => {
  it('type-level: vertex color is the optional linear RGBA runtime attribute', () => {
    expectTypeOf<VertexAttributeMap['color']>().toEqualTypeOf<Float32Array | undefined>();
    expectTypeOf<MeshAsset['attributes']['color']>().toEqualTypeOf<Float32Array | undefined>();
  });
  it('type-level: contains cubemap-handle-missing as a new member', () => {
    expectTypeOf<'cubemap-handle-missing'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('type-level: contains tileset-region-index-out-of-range as the M0 baseline-restored member', () => {
    expectTypeOf<'tileset-region-index-out-of-range'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('type-level: contains tileset-tile-entry-malformed as the M1 new member', () => {
    expectTypeOf<'tileset-tile-entry-malformed'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('type-level: contains asset-invalidated as the feat-20260621 new member', () => {
    expectTypeOf<'asset-invalidated'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('type-level: contains the Mesh CPU residency error', () => {
    expectTypeOf<'asset-cpu-data-unavailable'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('type-level: ASSET_ERROR_HINTS is Record<AssetErrorCode, string>', () => {
    expectTypeOf(ASSET_ERROR_HINTS).toEqualTypeOf<Readonly<Record<AssetErrorCode, string>>>();
  });
});

describe('ASSET_ERROR_HINTS - new asset-invalid-value entry (M1 w1)', () => {
  it('asset-invalid-value hint matches plan-decisions L-1 lock-in literal', () => {
    expect(ASSET_ERROR_HINTS['asset-invalid-value']).toBe(
      'a register-time value failed validation; read err.hint for the case-specific fix (e.g. clamp a MaterialAsset param to [0,1], or give a strip-topology MeshAsset an index buffer) and err.detail for the offending field/value',
    );
  });

  it('hint string is non-empty', () => {
    expect(typeof ASSET_ERROR_HINTS['asset-invalid-value']).toBe('string');
    expect(ASSET_ERROR_HINTS['asset-invalid-value'].length).toBeGreaterThan(0);
  });
});

describe('ASSET_ERROR_HINTS - texture-source-not-imported entry (feat-20260604 M2 w4)', () => {
  it('texture-source-not-imported hint is non-empty and references the recovery path', () => {
    const hint = ASSET_ERROR_HINTS['texture-source-not-imported'];
    expect(typeof hint).toBe('string');
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain('import');
  });
});

describe('asset contract errors', () => {
  it('keeps artifact, pack, and evidence errors closed', () => {
    expectTypeOf<'asset-artifact-path-invalid'>().toExtend<
      import('../asset-errors.js').AssetArtifactErrorCode
    >();
    expectTypeOf<'asset-artifact-integrity-mismatch'>().toExtend<
      import('../asset-errors.js').AssetArtifactErrorCode
    >();
    expectTypeOf<'pack-v2-duplicate-guid'>().toExtend<
      import('../asset-errors.js').PackV2ErrorCode
    >();
    expectTypeOf<'pack-v2-duplicate-artifact-key'>().toExtend<
      import('../asset-errors.js').PackV2ErrorCode
    >();
    expectTypeOf<'asset-evidence-capability-missing'>().toExtend<
      import('../asset-errors.js').AssetEvidenceErrorCode
    >();
    expectTypeOf<'asset-evidence-digest-mismatch'>().toExtend<
      import('../asset-errors.js').AssetEvidenceErrorCode
    >();
  });

  it('uses code, expected, hint, and detail as machine fields', () => {
    expectTypeOf<import('../asset-errors.js').AssetArtifactError>().toMatchTypeOf<{
      readonly code: import('../asset-errors.js').AssetArtifactErrorCode;
      readonly expected: string;
      readonly hint: string;
      readonly detail: object;
    }>();
    expectTypeOf<import('../asset-errors.js').PackV2Error>().toMatchTypeOf<{
      readonly code: import('../asset-errors.js').PackV2ErrorCode;
      readonly expected: string;
      readonly hint: string;
      readonly detail: object;
    }>();
    expectTypeOf<import('../asset-errors.js').AssetEvidenceError>().toMatchTypeOf<{
      readonly code: import('../asset-errors.js').AssetEvidenceErrorCode;
      readonly expected: string;
      readonly hint: string;
      readonly detail: object;
    }>();
  });
});

describe('asset authoring seven-stage errors', () => {
  it('keeps every stage closed and structurally recoverable', () => {
    type Stages = AssetStageError['stage'];
    expectTypeOf<Stages>().toEqualTypeOf<
      | 'author-validation'
      | 'external-declaration'
      | 'import'
      | 'native-cook'
      | 'ddc-validation'
      | 'runtime-parse'
      | 'editor-capability'
    >();
    expectTypeOf<AuthorValidationError['recovery']>().toHaveProperty('action');
    expectTypeOf<ExternalDeclarationError['detail']>().toHaveProperty('sourceKey');
    expectTypeOf<ImportStageError['code']>().toEqualTypeOf<'import-failed'>();
    expectTypeOf<NativeCookError['code']>().toEqualTypeOf<'native-cook-failed'>();
    expectTypeOf<DdcValidationError['code']>().toEqualTypeOf<'ddc-validation-failed'>();
    expectTypeOf<RuntimeParseError['code']>().toEqualTypeOf<'runtime-parse-failed'>();
    expectTypeOf<EditorCapabilityError['code']>().toEqualTypeOf<'editor-capability-unavailable'>();
  });
});
