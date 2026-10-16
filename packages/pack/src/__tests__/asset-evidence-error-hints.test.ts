import { ASSET_EVIDENCE_ERROR_HINTS, projectAssetEvidence } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const guid = '11111111-1111-4111-8111-111111111111';

describe('AssetEvidence structured recovery hints', () => {
  it('provides non-empty hints for every closed evidence error code', () => {
    const codes = [
      'asset-evidence-capability-missing',
      'asset-evidence-source-conflict',
      'asset-evidence-locator-conflict',
      'asset-evidence-receipt-conflict',
      'asset-evidence-digest-mismatch',
    ] as const;

    for (const code of codes) {
      expect(ASSET_EVIDENCE_ERROR_HINTS[code]).toBeTruthy();
      expect(ASSET_EVIDENCE_ERROR_HINTS[code]).not.toContain('message');
      expect(ASSET_EVIDENCE_ERROR_HINTS[code]).toMatch(
        /inspect|repair|retry|refresh|capability|rerun|source|rebuild|verify|catalog|package/,
      );
    }
  });

  it('keeps mismatch errors distinct from unknown capability', () => {
    const result = projectAssetEvidence({
      guid,
      source: { origin: 'sourceMeta', inputFingerprint: 'fp-1' },
      locator: { packageUrl: '/assets/data.pack.json' },
      receipt: {
        guid,
        origin: 'sourceMeta',
        status: 'succeeded',
        inputFingerprint: 'fp-1',
        outputDigest: 'receipt-digest',
      },
      packageVerification: { status: 'passed', digest: 'package-digest' },
      artifacts: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('asset-evidence-digest-mismatch');
    expect(result.error.detail).toMatchObject({ guid });
  });
});
