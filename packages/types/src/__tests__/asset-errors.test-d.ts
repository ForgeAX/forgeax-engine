// asset-errors.test-d - type-level (test-d) assertions for the 5-member closed
// `AssetErrorCode` union and `ASSET_ERROR_HINTS` Record completeness
// (feat-20260518-pbr-direct-lighting-mvp / M1 / w1; minor evolution add 5th
// member 'asset-invalid-value' per plan-strategy D-1).
//
// Assertions:
// - Type-level: AssetErrorCode union contains 'asset-invalid-value' (5th member).
// - Type-level: ASSET_ERROR_HINTS is Record<AssetErrorCode, string> -- adding a
//   new union member without hint entry is a TS compile error here.
// - Type-level: exhaustive switch on AssetErrorCode covers all 5 cases without
//   default fallback (charter proposition 4 explicit failure; noImplicitReturns
//   guards drift).
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

describe('AssetErrorCode closed union - 22 members (feat-20260608 M0 +tileset-region-index-out-of-range + M1 +tileset-tile-entry-malformed; feat-20260621 +asset-invalidated)', () => {
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

  it('type-level: exhaustive switch covers all 22 members without default', () => {
    function describeCode(code: AssetErrorCode): string {
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
        // === 1 new code (feat-20260523-shader-template-instance-split M1-T02) ===
        case 'material-shader-ref-broken':
          return 'ref-broken';
        // === 1 new code (feat-20260526-material-asset-multipass-renderstate M1 / w6) ===
        case 'material-circular-inheritance':
          return 'circular-inheritance';
        // === 2 new codes (feat-20260603-asset-import-loader-injection M1 / w1) ===
        case 'loader-not-registered':
          return 'loader-not-registered';
        case 'asset-not-imported':
          return 'asset-not-imported';
        // === 1 new code (feat-20260604-hdr-equirect-cube-importer-loader M2 / w4) ===
        case 'texture-source-not-imported':
          return 'texture-source-not-imported';
        case 'source-not-imported':
          return 'source-not-imported';
        // === 3 new codes (feat-20260608-mesh-multi-section-primitive-multi-material-slot M1 / w2) ===
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
        // === 1 new code (feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild) ===
        case 'tileset-region-index-out-of-range':
          return 'tileset-region-index-out-of-range';
        // === 1 new code (feat-20260608-tilemap-object-layer-rendering M1 schema extension) ===
        case 'tileset-tile-entry-malformed':
          return 'tileset-tile-entry-malformed';
        // === 1 new code (feat-20260621-asset-registry-robustness-invalidate-inflight-cach M2 / w4) ===
        case 'asset-invalidated':
          return 'asset-invalidated';
        // === 1 new code (feat-20260629-multi-uv-set-support M2 / m2-w5) ===
        case 'mesh-bin-contract-violation':
          return 'mesh-bin-contract-violation';
        // === 1 new code (feat-20260707-texture-block-compression M5 / w35) ===
        case 'mipgen-unsupported-compressed-format':
          return 'mipgen-unsupported-compressed-format';
      }
      // No default - TS guards union drift at compile time.
    }
    expectTypeOf(describeCode).returns.toEqualTypeOf<string>();
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
