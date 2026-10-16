import { describe, expect, it } from 'vitest';
import { createRuntimeAssetEvidenceAdapter } from '../registry/asset-evidence.js';

const guid = '11111111-1111-4111-8111-111111111111';

describe('runtime AssetEvidence adapter', () => {
  it('uses injected runtime state and leaves missing capability explicit', async () => {
    const adapter = createRuntimeAssetEvidenceAdapter({
      evidence: async (requestedGuid) => ({
        guid: requestedGuid,
        source: { origin: 'sourceMeta', inputFingerprint: 'fp-1' },
        locator: { packageUrl: '/assets/data.pack.json' },
        receipt: {
          guid: requestedGuid,
          origin: 'sourceMeta',
          status: 'succeeded',
          inputFingerprint: 'fp-1',
          outputDigest: 'digest-1',
        },
        packageVerification: { status: 'passed', digest: 'digest-1' },
        artifacts: {},
      }),
    });

    const result = await adapter.verifyByGuid(guid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.guid).toBe(guid);
    expect(result.value.runtime.status).toBe('unknown');
    expect(result.value.cook.freshness).toBe('current');
  });
});
