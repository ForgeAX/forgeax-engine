import { describe, expect, it } from 'vitest';
import { createCarrierStateMachine } from '../../../../tool-runtime/src/carrier.js';
import { createCarrierProviderService } from '../carrier-provider.js';

describe('carrier provider process boundary', () => {
  it('does not expose a provider before authenticated lease/start and cleans up on close', async () => {
    const machine = createCarrierStateMachine({
      projectId: 'provider-project',
      consumerId: 'provider-consumer',
      endpoint: 'http://127.0.0.1:0/carrier',
      now: 10,
      ttlMs: 1000,
      descriptorDigest: 'sha256:d',
      recipeDigest: 'sha256:r',
    });
    const provider = await createCarrierProviderService({
      machine,
      descriptorDigest: 'sha256:d',
      recipeDigest: 'sha256:r',
      execute: async () => ({
        outcome: 'succeeded' as const,
        result: { visible: true },
        artifacts: [],
      }),
    });
    expect(provider.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/carrier$/);
    expect(
      (
        await fetch(`${provider.endpoint}/execute`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${machine.offer.bearerToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            leaseId: 'none',
            descriptorDigest: 'sha256:d',
            recipeDigest: 'sha256:r',
            args: {},
          }),
        })
      ).status,
    ).toBe(409);
    await provider.close();
    await expect(fetch(`${provider.endpoint}/lease`)).rejects.toThrow();
  });
});
