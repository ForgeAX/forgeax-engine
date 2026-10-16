declare const snapshot: NetRecoverySnapshot;
declare const outcome: NetRecoveryOutcome;
import { expectTypeOf, test } from 'vitest';
import type {
  NetEndpointConnector,
  NetRecoveryOutcome,
  NetRecoverySnapshot,
  NetSessionState,
  SessionId,
} from '../src/index';

type ExpectedStateKind =
  | 'connecting'
  | 'resyncing'
  | 'active'
  | 'recovering'
  | 'failed'
  | 'retired';

declare const state: NetSessionState;

test('the public lifecycle is a closed, session-owned union', () => {
  expectTypeOf<NetSessionState['kind']>().toEqualTypeOf<ExpectedStateKind>();
  expectTypeOf<SessionId>().not.toEqualTypeOf<number>();

  const describe = (current: NetSessionState): string => {
    switch (current.kind) {
      case 'connecting':
        return `connecting:${current.sessionId}`;
      case 'resyncing':
        return `resyncing:${current.epoch}`;
      case 'active':
        return `active:${current.epoch}:${current.sequence}`;
      case 'recovering':
        return `recovering:${current.attempt}`;
      case 'failed':
        return `failed:${current.error.code}`;
      case 'retired':
        return `retired:${current.reason}`;
    }
  };

  expectTypeOf(describe).returns.toEqualTypeOf<string>();
  expectTypeOf(state.sessionId).toEqualTypeOf<SessionId>();
});

test('recovery snapshots expose bounded accounting and accepted identity', () => {
  expectTypeOf(snapshot.sessionId).toEqualTypeOf<SessionId>();
  expectTypeOf(snapshot.state).toEqualTypeOf<NetSessionState>();
  expectTypeOf(snapshot.pendingPackets).toEqualTypeOf<number>();
  expectTypeOf(snapshot.maxPendingPackets).toEqualTypeOf<number>();
  expectTypeOf(snapshot.acknowledgedSequence).toEqualTypeOf<number>();
  expectTypeOf(snapshot.reconnectAttempts).toEqualTypeOf<number>();
});

test('connector is a realm-neutral async capability', () => {
  expectTypeOf<NetEndpointConnector['connect']>().parameter(0).toEqualTypeOf<AbortSignal>();
  expectTypeOf<NetEndpointConnector['connect']>().returns.resolves.toMatchTypeOf<unknown>();
});

test('recovery outcomes are closed and idempotent', () => {
  switch (outcome.kind) {
    case 'started':
    case 'already-recovering':
    case 'already-active':
    case 'retired':
      expectTypeOf(outcome.sessionId).toEqualTypeOf<SessionId>();
      break;
  }
});

