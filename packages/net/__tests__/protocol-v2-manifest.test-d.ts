import type { SessionId } from '../src/index';
import { expectTypeOf, test } from 'vitest';
import type {
  ReplicationPacket,
  ReplicationPacketKind,
} from '../src/replication/protocol';

type ExpectedPacketKind =
  | 'session-open'
  | 'session-resume'
  | 'baseline'
  | 'delta'
  | 'ack'
  | 'application'
  | 'rejection';

declare const packet: ReplicationPacket;
declare const sessionId: SessionId;

test('ReplicationPacket is the single closed protocol-v2 manifest', () => {
  expectTypeOf<ReplicationPacketKind>().toEqualTypeOf<ExpectedPacketKind>();
  expectTypeOf<ReplicationPacketKind>().toEqualTypeOf<ReplicationPacket['kind']>();
  expectTypeOf<ReplicationPacket['version']>().toEqualTypeOf<2>();
  expectTypeOf<ReplicationPacket['sessionId']>().toEqualTypeOf<SessionId>();

  const describe = (current: ReplicationPacket): string => {
    switch (current.kind) {
      case 'session-open':
      case 'session-resume':
        return `${current.kind}:${current.sessionId}`;
      case 'baseline':
        expectTypeOf(current.sequence).toEqualTypeOf<1>();
        return `baseline:${current.tick}:${current.entities.length}`;
      case 'delta':
        return `delta:${current.sequence}:${current.entities.length}`;
      case 'ack':
        return `ack:${current.acknowledgedSequence}`;
      case 'application':
        expectTypeOf(current.payload).toEqualTypeOf<readonly number[]>();
        return `application:${current.payload.length}`;
      case 'rejection':
        return `rejection:${current.rejectedKind}:${current.reason}`;
    }
  };

  expectTypeOf(describe).returns.toEqualTypeOf<string>();
  expectTypeOf(packet.sessionId).toEqualTypeOf<SessionId>();
});

test('packet identity and payload fields remain safe and explicit', () => {
  const dataPacket: Extract<ReplicationPacket, { kind: 'delta' }> = {
    version: 2,
    kind: 'delta',
    sessionId,
    epoch: 1,
    sequence: 2,
    tick: 10,
    fingerprint: 'profile-v2',
    entities: [],
  };
  expectTypeOf(dataPacket.epoch).toEqualTypeOf<number>();
  expectTypeOf(dataPacket.sequence).toEqualTypeOf<number>();
  expectTypeOf(dataPacket.entities).toMatchTypeOf<readonly unknown[]>();
  // @ts-expect-error Protocol v1 is not part of the public packet manifest.
  const unsupported: ReplicationPacket = { ...dataPacket, version: 1 };
  void unsupported;
});

