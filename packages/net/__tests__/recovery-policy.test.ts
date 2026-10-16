import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NET_RECOVERY_POLICY,
  isLegalNetSessionTransition,
  isTerminalNetSessionState,
  type NetSessionStateKind,
  resolveNetRecoveryPolicy,
  validateNetRecoveryPolicy,
} from '../src/index';

describe('NetRecoveryPolicy contract', () => {
  it('publishes finite deterministic defaults', () => {
    expect(DEFAULT_NET_RECOVERY_POLICY).toMatchObject({
      maxSessions: 64,
      maxPendingPackets: 32,
      ackTimeoutMs: 250,
      maxPacketRetries: 3,
      maxReconnectAttempts: 5,
      reconnectDeadlineMs: 10_000,
      reconnectDelaysMs: [0, 100, 200, 400, 800],
    });
  });

  it.each([
    { maxSessions: 0 },
    { maxPendingPackets: 0 },
    { ackTimeoutMs: 0 },
    { maxPacketRetries: -1 },
    { maxReconnectAttempts: 0 },
    { reconnectDeadlineMs: 0 },
    { reconnectDelaysMs: [0, -1] },
  ])('rejects invalid policy bounds: %j', (invalid) => {
    const result = validateNetRecoveryPolicy({
      ...DEFAULT_NET_RECOVERY_POLICY,
      ...invalid,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('recovery-policy-invalid');
  });

  it('resolves a partial policy without creating an unbounded retry ledger', () => {
    const result = resolveNetRecoveryPolicy({ maxPendingPackets: 8 });
    expect(result).toEqual({
      ok: true,
      value: { ...DEFAULT_NET_RECOVERY_POLICY, maxPendingPackets: 8 },
    });
  });
});


describe('NetSessionState terminal predicate', () => {
  const kinds: readonly NetSessionStateKind[] = [
    'connecting',
    'resyncing',
    'active',
    'recovering',
    'failed',
    'retired',
  ];

  it.each(kinds)('%s is terminal exactly when retirement is its only legal exit', (kind) => {
    const onlyRetires = kinds.every(
      (to) => isLegalNetSessionTransition(kind, to) === (to === 'retired'),
    );
    expect(isTerminalNetSessionState({ kind })).toBe(onlyRetires);
  });
});
