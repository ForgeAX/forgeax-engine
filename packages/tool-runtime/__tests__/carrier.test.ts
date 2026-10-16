import { describe, expect, it } from 'vitest';
import { createCarrierStateMachine } from '../src/carrier.js';

describe('ephemeral carrier state machine', () => {
  it('authenticates a project-scoped lease and exposes only POD offer data', () => {
    const machine = createCarrierStateMachine({
      projectId: 'game',
      consumerId: 'preview',
      endpoint: 'http://127.0.0.1:5740/carrier',
      now: 100,
      ttlMs: 1_000,
    });
    const offer = machine.offer;
    expect(offer).toMatchObject({
      projectId: 'game',
      consumerId: 'preview',
      endpoint: 'http://127.0.0.1:5740/carrier',
      state: 'offered',
    });
    expect(offer.bearerToken).not.toBe(offer.livenessToken);
    expect(offer).not.toHaveProperty('world');
    expect(offer).not.toHaveProperty('renderer');
    expect(machine.lease({ consumerId: 'other', bearerToken: offer.bearerToken, now: 101 })).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'carrier-consumer-mismatch' }),
      }),
    );
    const lease = machine.lease({
      consumerId: 'preview',
      bearerToken: offer.bearerToken,
      now: 101,
    });
    expect(lease).toMatchObject({ ok: true });
  });

  it('rejects expiry, payload injection, and started-state retry', () => {
    expect(() =>
      createCarrierStateMachine({
        projectId: 'game',
        consumerId: 'preview',
        endpoint: 'http://127.0.0.1:5740/carrier',
        now: 0,
        ttlMs: 100,
        payload: { world: { liveHandle: true } },
      }),
    ).toThrow('carrier-payload-live-state');

    const machine = createCarrierStateMachine({
      projectId: 'game',
      consumerId: 'preview',
      endpoint: 'http://127.0.0.1:5740/carrier',
      now: 0,
      ttlMs: 100,
    });
    const expired = machine.lease({
      consumerId: 'preview',
      bearerToken: machine.offer.bearerToken,
      now: 100,
    });
    expect(expired).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'carrier-offer-expired' }),
    });
    expect(machine.fallback()).toMatchObject({ ok: true, state: 'fallback' });

    const started = createCarrierStateMachine({
      projectId: 'game',
      consumerId: 'preview',
      endpoint: 'http://127.0.0.1:5740/carrier',
      now: 0,
      ttlMs: 100,
    });
    const valid = started.lease({
      consumerId: 'preview',
      bearerToken: started.offer.bearerToken,
      now: 1,
    });
    if (!valid.ok) return;
    expect(started.started(valid.value.leaseId)).toMatchObject({ ok: true, state: 'started' });
    expect(started.fallback()).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'carrier-started' }),
    });
    expect(started.exit(valid.value.leaseId)).toMatchObject({ ok: true, state: 'exited' });
    expect(started.lease(valid.value.leaseId, {
      consumerId: 'preview', bearerToken: started.offer.bearerToken, now: 2,
    })).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'carrier-exited' }),
    });
  });
});
