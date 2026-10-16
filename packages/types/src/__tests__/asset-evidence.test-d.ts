import { describe, expectTypeOf, it } from 'vitest';
import type {
  ArtifactVerificationStatus,
  AssetEvidence,
  AssetEvidenceError,
  AssetEvidenceErrorCode,
  AssetEvidenceInputs,
  AssetEvidenceStatus,
  CookFreshness,
  CookProduct,
  CookStatus,
  RuntimeEvidenceStatus,
} from '../asset-evidence.js';
import { projectCookProductEvidence } from '../asset-evidence.js';

describe('asset evidence type contract', () => {
  it('keeps every lifecycle dimension closed and independently readable', () => {
    expectTypeOf<CookStatus>().toEqualTypeOf<
      'notRequired' | 'notCooked' | 'failed' | 'ready' | 'unknown'
    >();
    expectTypeOf<CookFreshness>().toEqualTypeOf<
      'notApplicable' | 'current' | 'stale' | 'unknown'
    >();
    expectTypeOf<ArtifactVerificationStatus>().toEqualTypeOf<'notChecked' | 'passed' | 'failed'>();
    expectTypeOf<RuntimeEvidenceStatus>().toEqualTypeOf<
      'ready' | 'provisional' | 'unknown' | 'notChecked'
    >();
    expectTypeOf<AssetEvidenceStatus>().toEqualTypeOf<
      'passed' | 'notChecked' | 'failed' | 'unknown'
    >();
  });

  it('exposes authoritative inputs without a message-parsing surface', () => {
    expectTypeOf<AssetEvidenceInputs['guid']>().toEqualTypeOf<string>();
    expectTypeOf<AssetEvidence['packageUrl']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AssetEvidence['cook']['status']>().toEqualTypeOf<CookStatus>();
    expectTypeOf<AssetEvidence['cook']['freshness']>().toEqualTypeOf<CookFreshness>();
    expectTypeOf<AssetEvidence['artifacts']>().toMatchTypeOf<
      Readonly<Record<string, { readonly verification: ArtifactVerificationStatus }>>
    >();
    expectTypeOf<AssetEvidenceError['code']>().toEqualTypeOf<AssetEvidenceErrorCode>();
  });

  it('projects CookProduct to evidence without a reverse mutation path', () => {
    expectTypeOf(projectCookProductEvidence).returns.toMatchTypeOf<
      import('../result.js').Result<AssetEvidence, AssetEvidenceError>
    >();
    expectTypeOf<CookProduct['receipt']['guid']>().toEqualTypeOf<string>();
  });
});
