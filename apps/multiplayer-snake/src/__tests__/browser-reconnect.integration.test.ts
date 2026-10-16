import { describe, expect, it } from 'vitest';
import { validateReconnectTrace } from '../../scripts/browser-e2e.mjs';

function snapshot(kind: string, epoch: number, sequence: number) {
  return {
    sessionId: 7,
    state: { kind, sessionId: 7, epoch, sequence },
    pendingPackets: 0,
    maxPendingPackets: 32,
    acknowledgedSequence: sequence,
    reconnectAttempts: kind === 'recovering' ? 1 : 0,
    epoch,
    sequence,
    ownedResources: { pendingConnects: 0, timers: 0, ledgers: 0, callbacks: 0 },
  };
}

function validTrace() {
  const before = snapshot('active', 3, 18);
  const recovering = snapshot('recovering', 3, 0);
  const resyncing = snapshot('resyncing', 4, 0);
  const active = snapshot('active', 4, 3);
  return {
    schemaVersion: 1,
    targetId: 'multiplayer-snake-reconnect',
    invocationId: 'browser-test',
    recovery: {
      before: { snapshot: before },
      outcome: { kind: 'started', sessionId: 7 },
      lifecycle: [
        { label: 'recovering', snapshot: recovering },
        { label: 'resyncing', snapshot: resyncing },
        { label: 'active-after-baseline', snapshot: active },
      ],
      preBaselineAttempt: {
        state: 'recovering',
        beforeSendCount: 4,
        afterSendCount: 4,
        accepted: false,
      },
      baseline: {
        previousEpoch: 3,
        resyncEpoch: 4,
        freshEpoch: 4,
        firstActive: { sessionId: 7, epoch: 4, sequence: 3 },
        packet: { kind: 'baseline', sessionId: 1, epoch: 4, sequence: 1, tick: 20 },
      },
      convergence: {
        sessionId: 7,
        tick: 42,
        identityCount: 3,
        uniqueIdentityCount: 3,
        playerCount: 3,
        uniquePlayerCount: 3,
        renderedEntities: 9,
        expectedEntities: 9,
      },
      interaction: { accepted: true, beforeSendCount: 4, afterSendCount: 5 },
    },
    cleanup: { allRetired: true, allZeroOwnedResources: true },
  };
}

describe('multiplayer-snake browser reconnect trace', () => {
  it('accepts the public recovery journey with a fresh baseline and cleanup', () => {
    expect(validateReconnectTrace(validTrace())).toEqual({ ok: true, failures: [] });
  });

  it('rejects stale identity, pre-baseline mutation, duplicates, and missing cleanup', () => {
    const trace = validTrace();
    trace.recovery.baseline.packet.sequence = 0;
    trace.recovery.preBaselineAttempt.accepted = true;
    trace.recovery.convergence.uniquePlayerCount = 2;
    trace.cleanup.allZeroOwnedResources = false;
    const result = validateReconnectTrace(trace);
    expect(result.ok).toBe(false);
    expect(result.failures.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'baseline-sequence-not-one',
        'pre-baseline-command-accepted',
        'duplicate-replicated-identity',
        'cleanup-not-proven',
      ]),
    );
  });
});
