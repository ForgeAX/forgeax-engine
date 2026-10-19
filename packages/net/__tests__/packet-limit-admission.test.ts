import { expect, it } from 'vitest';
import { decodeReplicationPacket, encodeReplicationPacket } from '../src/replication/codec';
import { DEFAULT_REPLICATION_LIMITS } from '../src/replication/profile';
import type { ReplicationPacket } from '../src/replication/protocol';

const sessionId = 1 as ReplicationPacket['sessionId'];
const packets: ReplicationPacket[] = [
  { version: 2, kind: 'session-open', sessionId, epoch: 0, sequence: 0 },
  { version: 2, kind: 'session-resume', sessionId, epoch: 1, sequence: 0 },
  { version: 2, kind: 'ack', sessionId, epoch: 1, acknowledgedSequence: 1 },
  { version: 2, kind: 'rejection', sessionId, epoch: 1, sequence: 1, rejectedKind: 'delta', reason: 'gap' },
  { version: 2, kind: 'application', sessionId, epoch: 1, payload: [7] },
  ...(['baseline', 'delta'] as const).map((kind) => ({ version: 2 as const, kind, sessionId, epoch: 1, sequence: 1, tick: 0, fingerprint: 'x', entities: [] })),
];
it.each(packets)('enforces the same byte boundary in both directions for $kind', (packet) => {
  const encoded = encodeReplicationPacket(packet, DEFAULT_REPLICATION_LIMITS).unwrap();
  const exact = { ...DEFAULT_REPLICATION_LIMITS, maxMessageBytes: encoded.byteLength };
  const small = { ...exact, maxMessageBytes: encoded.byteLength - 1 };
  expect(encodeReplicationPacket(packet, exact).ok).toBe(true);
  expect(decodeReplicationPacket(encoded, exact).ok).toBe(true);
  for (const result of [encodeReplicationPacket(packet, small), decodeReplicationPacket(encoded, small)]) {
    expect(result).toMatchObject({ ok: false, error: { code: 'decode-limit-exceeded', detail: { limit: 'maxMessageBytes', actual: encoded.byteLength, maximum: encoded.byteLength - 1 } } });
  }
});
