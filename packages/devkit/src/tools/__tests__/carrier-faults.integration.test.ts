import { describe, expect, it } from 'vitest';
import { createCarrierStateMachine } from '../../../../tool-runtime/src/carrier.js';
import { createAuthenticatedCarrierTransport } from '../../../../tool-runtime/src/transport.js';
import { createCarrierProviderService } from '../carrier-provider.js';

const descriptorDigest = 'sha256:fault-descriptor';
const recipeDigest = 'sha256:fault-recipe';

describe('authenticated carrier fault matrix', () => {
  it('rejects invalid bearer and descriptor/recipe digests before provider start', async () => {
    const machine = createCarrierStateMachine({
      projectId: 'faults',
      consumerId: 'consumer',
      endpoint: 'http://127.0.0.1:0/carrier',
      now: 1,
      ttlMs: 1000,
      descriptorDigest,
      recipeDigest,
    });
    const provider = await createCarrierProviderService({
      machine,
      descriptorDigest,
      recipeDigest,
      execute: async () => ({ outcome: 'succeeded' as const, result: {}, artifacts: [] }),
    });
    await expect(
      createAuthenticatedCarrierTransport({
        endpoint: provider.endpoint,
        bearerToken: 'invalid-token',
      }).lease({
        consumerId: 'consumer',
        bearerToken: 'invalid-token',
        now: 2,
        descriptorDigest,
        recipeDigest,
      }),
    ).rejects.toMatchObject({ code: 'carrier-token-invalid' });
    const transport = createAuthenticatedCarrierTransport({
      endpoint: provider.endpoint,
      bearerToken: machine.offer.bearerToken,
    });
    await expect(
      transport.lease({
        consumerId: 'consumer',
        bearerToken: machine.offer.bearerToken,
        now: 2,
        descriptorDigest: 'sha256:wrong',
        recipeDigest,
      }),
    ).rejects.toMatchObject({ code: 'carrier-descriptor-mismatch' });
    await expect(
      transport.lease({
        consumerId: 'consumer',
        bearerToken: machine.offer.bearerToken,
        now: 2,
        descriptorDigest,
        recipeDigest: 'sha256:wrong',
      }),
    ).rejects.toMatchObject({ code: 'carrier-recipe-mismatch' });
    await provider.close();
  });

  it('allows fallback only before start and never executes a started provider twice after exit', async () => {
    const machine = createCarrierStateMachine({
      projectId: 'faults',
      consumerId: 'consumer',
      endpoint: 'http://127.0.0.1:0/carrier',
      now: 1,
      ttlMs: 1000,
      descriptorDigest,
      recipeDigest,
    });
    expect(machine.fallback()).toMatchObject({ ok: true, state: 'fallback' });
    const startedMachine = createCarrierStateMachine({
      projectId: 'started-faults',
      consumerId: 'consumer',
      endpoint: 'http://127.0.0.1:0/carrier',
      now: 1,
      ttlMs: 1000,
      descriptorDigest,
      recipeDigest,
    });
    const provider = await createCarrierProviderService({
      machine: startedMachine,
      descriptorDigest,
      recipeDigest,
      execute: async () => ({ outcome: 'succeeded' as const, result: {}, artifacts: [] }),
    });
    const transport = createAuthenticatedCarrierTransport({
      endpoint: provider.endpoint,
      bearerToken: startedMachine.offer.bearerToken,
    });
    const lease = await transport.lease({
      consumerId: 'consumer',
      bearerToken: startedMachine.offer.bearerToken,
      now: 2,
      descriptorDigest,
      recipeDigest,
    });
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    expect((await transport.started({ leaseId: lease.value.leaseId })).ok).toBe(true);
    await provider.close();
    await expect(
      transport.execute({ leaseId: lease.value.leaseId, descriptorDigest, recipeDigest, args: {} }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/carrier-provider-exit|carrier-exited/),
    });
    expect(startedMachine.fallback()).toMatchObject({
      ok: false,
      error: { code: 'carrier-started' },
    });
  });
});
