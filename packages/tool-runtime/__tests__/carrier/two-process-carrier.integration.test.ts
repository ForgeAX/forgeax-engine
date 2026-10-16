// @perf-budget-skip: the contract intentionally pays for a real child process and two HTTP hops;
// the two assertions are not a throughput benchmark and cannot be amortized without changing the proof.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  createAuthenticatedCarrierTransport,
  type CarrierExecutionRequest,
} from '../../src/transport.js';
import { createCarrierStateMachine } from '../../src/carrier.js';
import { createCarrierProviderService } from '../../../devkit/src/tools/carrier-provider.js';

const descriptorDigest = 'sha256:carrier-descriptor';
const recipeDigest = 'sha256:carrier-recipe';

describe('authenticated visible carrier across two processes', () => {
  it('requires auth, leases and starts the provider before executing POD', async () => {
    const machine = createCarrierStateMachine({
      projectId: 'two-process-project',
      consumerId: 'editor-consumer',
      endpoint: 'http://127.0.0.1:0/carrier',
      now: 100,
      ttlMs: 10_000,
      descriptorDigest,
      recipeDigest,
    });
    const provider = await createCarrierProviderService({
      machine,
      descriptorDigest,
      recipeDigest,
      execute: async (request: CarrierExecutionRequest) => ({
        outcome: 'succeeded' as const,
        result: { process: process.pid, args: request.args },
        artifacts: [{ kind: 'carrier-frame', ref: 'artifact://frame/1' }],
      }),
    });
    const transport = createAuthenticatedCarrierTransport({ endpoint: provider.endpoint, bearerToken: machine.offer.bearerToken });
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const response = await fetch(${JSON.stringify(provider.endpoint + '/lease')}, { method: 'POST', headers: { authorization: 'Bearer ${machine.offer.bearerToken}', 'content-type': 'application/json' }, body: JSON.stringify({ consumerId: 'editor-consumer', now: 101, descriptorDigest: ${JSON.stringify(descriptorDigest)}, recipeDigest: ${JSON.stringify(recipeDigest)} }) });
      const lease = await response.json();
      if (!lease.ok) process.exit(2);
      const started = await fetch(${JSON.stringify(provider.endpoint + '/start')}, { method: 'POST', headers: { authorization: 'Bearer ${machine.offer.bearerToken}', 'content-type': 'application/json' }, body: JSON.stringify({ leaseId: lease.value.leaseId }) });
      if (!(await started.json()).ok) process.exit(3);
      const result = await fetch(${JSON.stringify(provider.endpoint + '/execute')}, { method: 'POST', headers: { authorization: 'Bearer ${machine.offer.bearerToken}', 'content-type': 'application/json' }, body: JSON.stringify({ leaseId: lease.value.leaseId, descriptorDigest: ${JSON.stringify(descriptorDigest)}, recipeDigest: ${JSON.stringify(recipeDigest)}, args: { frame: 1 } }) });
      if (!(await result.json()).ok) process.exit(4);
    `], { stdio: 'ignore' });
    await once(child, 'exit');
    expect(child.exitCode).toBe(0);
    expect((await transport.execute({ leaseId: machine.snapshot().leaseId ?? '', descriptorDigest, recipeDigest, args: { frame: 2 } })).ok).toBe(true);
    await provider.close();
  });

  it('returns structured auth and post-start provider-exit errors without fallback', async () => {
    const machine = createCarrierStateMachine({ projectId: 'fault-project', consumerId: 'consumer', endpoint: 'http://127.0.0.1:0/carrier', now: 0, ttlMs: 1000, descriptorDigest, recipeDigest });
    const provider = await createCarrierProviderService({ machine, descriptorDigest, recipeDigest, execute: async () => ({ outcome: 'succeeded' as const, result: {}, artifacts: [] }) });
    const transport = createAuthenticatedCarrierTransport({ endpoint: provider.endpoint, bearerToken: 'wrong-token' });
    await expect(transport.lease({ consumerId: 'consumer', now: 1, descriptorDigest, recipeDigest })).rejects.toMatchObject({ code: 'carrier-token-invalid' });
    const authorized = createAuthenticatedCarrierTransport({ endpoint: provider.endpoint, bearerToken: machine.offer.bearerToken });
    const lease = await authorized.lease({ consumerId: 'consumer', now: 1, descriptorDigest, recipeDigest });
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    expect((await authorized.started({ leaseId: lease.value.leaseId })).ok).toBe(true);
    expect((await authorized.exit({ leaseId: lease.value.leaseId })).ok).toBe(true);
    await expect(authorized.execute({ leaseId: lease.value.leaseId, descriptorDigest, recipeDigest, args: {} })).rejects.toMatchObject({ code: 'carrier-exited' });
    await provider.close();
  });
});
