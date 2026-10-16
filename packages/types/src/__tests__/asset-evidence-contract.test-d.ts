import { describe, expectTypeOf, it } from 'vitest';
import type {
  ArtifactVerificationStatus,
  AssetEvidence,
  CookFreshness,
  CookProduct,
  CookStatus,
  RuntimeEvidenceStatus,
} from '../asset.js';

describe('asset evidence contract', () => {
  it('makes lifecycle states explicit and enumerable', () => {
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
  });

  it('exposes locator, cook, artifact, and runtime evidence without message parsing', () => {
    expectTypeOf<AssetEvidence['guid']>().toBeString();
    expectTypeOf<AssetEvidence['packageUrl']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AssetEvidence['cook']['status']>().toEqualTypeOf<CookStatus>();
    expectTypeOf<AssetEvidence['cook']['freshness']>().toEqualTypeOf<CookFreshness>();
    expectTypeOf<AssetEvidence['artifacts']>().toMatchTypeOf<
      Readonly<Record<string, { readonly verification: ArtifactVerificationStatus }>>
    >();
  });

  it('keeps one shared CookProduct shape for payload, refs, artifacts, and receipt', () => {
    expectTypeOf<CookProduct>().toHaveProperty('payload');
    expectTypeOf<CookProduct>().toHaveProperty('refs');
    expectTypeOf<CookProduct>().toHaveProperty('artifacts');
    expectTypeOf<CookProduct>().toHaveProperty('receipt');
    expectTypeOf<CookProduct['digest']>().toEqualTypeOf<string>();
  });
});
