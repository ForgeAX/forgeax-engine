import { describe, expect, it } from 'vitest';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { NetSession } from '../src/session/net-session';
import type { NetRecoverySnapshot } from '../src/session/recovery';
import { RecoveryTransportHarness } from './fixtures/recovery-transport';

type RetirementSessionSurface = NetSession & {
  dispose(): void;
  getRecoverySnapshot(): NetRecoverySnapshot;
  retireWithFailure(): void;
};

describe('NetSession terminal retirement', () => {
  it('disposes idempotently and leaves a retired session', () => {
    const [endpoint] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint, maxRawMessages: 8 }) as RetirementSessionSurface;

    session.dispose();
    session.dispose();

    expect(session.getRecoverySnapshot().state.kind).toBe('retired');
    expect(session.getRecoverySnapshot().pendingPackets).toBe(0);
  });

  it('retires after fatal failure and cannot resurrect recovery', () => {
    const [endpoint] = createMemoryEndpointPair();
    const session = new NetSession({
      endpoint,
      maxRawMessages: 8,
      recovery: { maxPendingPackets: 0 },
    }) as RetirementSessionSurface;

    expect(session.getRecoverySnapshot().state.kind).toBe('failed');
    session.dispose();

    expect(session.getRecoverySnapshot().state.kind).toBe('retired');
    expect(session.getRecoverySnapshot().lastError?.code).toBe('recovery-policy-invalid');
  });

  it('aborts a pending connector when disposal races connect', async () => {
    const transport = new RecoveryTransportHarness();
    const session = new NetSession({
      endpoint: undefined as never,
      maxRawMessages: 8,
      connector: transport.connector,
      sessionId: 17,
    } as never) as RetirementSessionSurface;

    session.recover();
    session.advanceRecovery();
    session.dispose();

    expect(transport.pendingConnectCount).toBe(0);
    expect(transport.resources.snapshot()).toEqual({
      timers: 0,
      listeners: 0,
      sockets: 0,
      pendingConnects: 0,
      ledgers: 0,
      deferredCallbacks: 0,
    });
  });
});
