import { describe, expect, it } from 'vitest';
import { createRuntimeAssetEvidenceAdapter } from '../registry/asset-evidence.js';

const guid = '11111111-1111-4111-8111-111111111111';

describe('AssetEvidence SDK integration', () => {
  it('uses the same projector shape for inspect and verifyByGuid', async () => {
    const adapter = createRuntimeAssetEvidenceAdapter({
      evidence: async () => ({
        guid,
        source: { origin: 'sourceMeta', inputFingerprint: 'fp-1' },
        locator: { packageUrl: '/assets/config.pack.json' },
        receipt: {
          guid,
          origin: 'sourceMeta',
          status: 'succeeded',
          inputFingerprint: 'fp-1',
          outputDigest: 'digest-1',
        },
        packageVerification: { status: 'passed', digest: 'digest-1' },
        artifacts: {},
        runtime: { status: 'ready' },
      }),
    });

    const inspected = await adapter.inspect(guid);
    const verified = await adapter.verifyByGuid(guid);
    expect(inspected.ok).toBe(true);
    expect(verified.ok).toBe(true);
    expect(inspected).toEqual(verified);
  });
});
