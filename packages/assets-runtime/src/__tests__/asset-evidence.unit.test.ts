import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '../index.js';

const guid = '11111111-1111-4111-8111-111111111111';

describe('AssetRegistry evidence', () => {
  it('uses injected runtime state and leaves missing capability explicit', async () => {
    const assets = new AssetRegistry();
    expect(await assets.inspect(guid)).toMatchObject({
      ok: false,
      error: { code: 'asset-evidence-capability-missing' },
    });
    let runtime: { status: 'ready' } | undefined;
    assets.configureAssetEvidence({
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
        ...(runtime === undefined ? {} : { runtime }),
      }),
    });

    const result = await assets.inspect(guid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.guid).toBe(guid);
    expect(result.value.runtime.status).toBe('unknown');
    expect(result.value.cook.freshness).toBe('current');

    runtime = { status: 'ready' };
    expect(await assets.inspect(guid)).toMatchObject({
      ok: true,
      value: { guid, runtime: { status: 'ready' }, cook: { freshness: 'current' } },
    });
    assets.dispose();
  });
});
