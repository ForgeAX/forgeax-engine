import { expectTypeOf, test } from 'vitest';
import type {
  NetEndpointConnector,
  NetRecoveryOutcome,
  NetRecoveryPolicy,
  NetRecoverySnapshot,
  NetSessionState,
  ReplicationPacket,
  SessionId,
} from '@forgeax/engine-net';

test('the public barrel owns recovery inference', () => {
  expectTypeOf<SessionId>().not.toEqualTypeOf<number>();
  expectTypeOf<NetRecoveryPolicy['maxPendingPackets']>().toEqualTypeOf<number>();
  expectTypeOf<NetRecoverySnapshot['state']>().toEqualTypeOf<NetSessionState>();
  expectTypeOf<NetEndpointConnector['connect']>().parameter(0).toEqualTypeOf<AbortSignal>();
  expectTypeOf<Extract<ReplicationPacket, { kind: 'baseline' }>['sequence']>().toEqualTypeOf<1>();

  const outcomeKind = (outcome: NetRecoveryOutcome): NetRecoveryOutcome['kind'] => outcome.kind;
  expectTypeOf(outcomeKind).returns.toEqualTypeOf<NetRecoveryOutcome['kind']>();
});
