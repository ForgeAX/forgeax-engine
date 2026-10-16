import { describe, expect, it } from 'vitest';
import { NetSession } from '../src/session/net-session';
import type { NetRecoverySnapshot } from '../src/session/recovery';
import { RecoveryTransportHarness } from './fixtures/recovery-transport';

type LedgerSessionSurface = NetSession & {
  getRecoverySnapshot(): NetRecoverySnapshot;
  recover(): { readonly kind: string };
};

describe('NetSession bounded ACK ledger', () => {
  it('retains at most the configured packet bound', () => {
    const transport = new RecoveryTransportHarness();
    const session = new NetSession({
      endpoint: undefined as never,
      maxRawMessages: 8,
      connector: transport.connector,
      sessionId: 17,
      recovery: { maxPendingPackets: 2 },
    } as never) as LedgerSessionSurface;

    expect(session.recover().kind).toBe('started');
    const snapshot = session.getRecoverySnapshot();
    expect(snapshot.pendingPackets).toBeLessThanOrEqual(2);
    expect(snapshot.pendingPackets).toBeLessThanOrEqual(snapshot.maxPendingPackets);
  });

  it('does not retain unresolved work after packet rejection', () => {
    const transport = new RecoveryTransportHarness();
    const session = new NetSession({
      endpoint: undefined as never,
      maxRawMessages: 8,
      connector: transport.connector,
      sessionId: 17,
    } as never) as LedgerSessionSurface;

    expect(session.recover().kind).toBe('started');
    const snapshot = session.getRecoverySnapshot();
    expect(snapshot.pendingPackets).toBe(0);
  });
});
