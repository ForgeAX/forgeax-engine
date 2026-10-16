import { describe, expectTypeOf, it } from 'vitest';
import {
  ASSET_EVIDENCE_ERROR_HINTS,
  type AssetEvidenceError,
  type AssetEvidenceErrorCode,
} from '../asset-errors.js';

describe('AssetEvidenceErrorCode derives from the public hint map', () => {
  it('keeps the public alias equal to the map key union', () => {
    expectTypeOf<AssetEvidenceErrorCode>().toEqualTypeOf<keyof typeof ASSET_EVIDENCE_ERROR_HINTS>();
    expectTypeOf(ASSET_EVIDENCE_ERROR_HINTS).toMatchTypeOf<
      Readonly<Record<AssetEvidenceErrorCode, string>>
    >();
  });

  it('retains all five valid members and rejects unknown codes', () => {
    expectTypeOf<'asset-evidence-capability-missing'>().toExtend<AssetEvidenceErrorCode>();
    expectTypeOf<'asset-evidence-source-conflict'>().toExtend<AssetEvidenceErrorCode>();
    expectTypeOf<'asset-evidence-locator-conflict'>().toExtend<AssetEvidenceErrorCode>();
    expectTypeOf<'asset-evidence-receipt-conflict'>().toExtend<AssetEvidenceErrorCode>();
    expectTypeOf<'asset-evidence-digest-mismatch'>().toExtend<AssetEvidenceErrorCode>();
    expectTypeOf<'asset-evidence-unknown'>().not.toExtend<AssetEvidenceErrorCode>();
  });

  it('keeps representative error construction and detail narrowing intact', () => {
    const error: AssetEvidenceError = {
      code: 'asset-evidence-capability-missing',
      expected: 'an injected evidence capability',
      hint: ASSET_EVIDENCE_ERROR_HINTS['asset-evidence-capability-missing'],
      detail: { capability: 'runtime evidence source', stage: 'guid:test' },
    };

    if ('capability' in error.detail) {
      expectTypeOf(error.detail.capability).toEqualTypeOf<string>();
      expectTypeOf(error.detail.stage).toEqualTypeOf<string>();
    } else {
      expectTypeOf(error.detail.guid).toEqualTypeOf<string>();
      expectTypeOf(error.detail.observed).toEqualTypeOf<string>();
      expectTypeOf(error.detail.expected).toEqualTypeOf<string>();
    }
  });
});
