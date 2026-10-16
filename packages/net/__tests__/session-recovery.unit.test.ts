import { describe, expect, it } from 'vitest';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import type {
  NetRecoveryOutcome,
  NetRecoverySnapshot,
  SessionId,
} from '../src/session/recovery';
import { NetSession } from '../src/session/net-session';

type RecoverySessionSurface = NetSession & {
  getRecoverySnapshot(): NetRecoverySnapshot;
  recover(): NetRecoveryOutcome;
  advanceRecovery(): void;
};

function recoverySession(): RecoverySessionSurface {
  const [endpoint] = createMemoryEndpointPair();
  return new NetSession({
    endpoint,
    maxRawMessages: 8,
    recovery: { reconnectDelaysMs: [0, 0, 0, 0, 0] },
  }) as RecoverySessionSurface;
}

describe('NetSession recovery owner', () => {
  it('starts non-authoritative before a complete baseline', () => {
    const session = recoverySession();
    const snapshot = session.getRecoverySnapshot();

    expect(snapshot.state.kind).toBe('resyncing');
    expect(snapshot.pendingPackets).toBe(0);
    expect(session.sendRaw(1 as never, new Uint8Array([1])).ok).toBe(false);
  });

  it('exposes bounded state and deterministic retry exhaustion', () => {
    const session = recoverySession();
    const started = session.recover();
    expect(started.kind).toBe('started');

    for (let attempt = 0; attempt < 5; attempt += 1) session.advanceRecovery();

    const snapshot = session.getRecoverySnapshot();
    expect(snapshot.state.kind).toBe('failed');
    expect(snapshot.reconnectAttempts).toBe(5);
    expect(snapshot.pendingPackets).toBeLessThanOrEqual(snapshot.maxPendingPackets);
    expect(snapshot.lastError?.code).toBe('recovery-exhausted');
  });

  it('keeps application identity stable across recovery', () => {
    const session = recoverySession();
    const first = session.getRecoverySnapshot().sessionId;
    const result = session.recover();
    const second = session.getRecoverySnapshot().sessionId;

    expect(result.kind).toBe('started');
    expect(first).toEqual(second);
    expect(second).not.toEqual(0 as SessionId);
  });
});
