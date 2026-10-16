import { describe, expect, it } from 'vitest';
import {
  decodeReplicationPacket,
  encodeReplicationPacket,
} from '../src/replication/codec';
import { REPLICATION_PROTOCOL_PREFIX, REPLICATION_PROTOCOL_VERSION } from '../src/replication/constants';
import type { ReplicationPacket } from '../src/replication/protocol';
import { DEFAULT_REPLICATION_LIMITS } from '../src/replication/profile';

const sessionId = 17 as ReplicationPacket['sessionId'];
const baseline: ReplicationPacket = {
  version: REPLICATION_PROTOCOL_VERSION,
  kind: 'baseline',
  sessionId,
  epoch: 3,
  sequence: 1,
  tick: 42,
  fingerprint: 'profile-v2',
  entities: [
    {
      id: 1,
      kind: 'upsert',
      components: [{ name: 'PositionCodec', data: { x: 1, y: 2 } }],
    },
  ],
};

describe('protocol-v2 packet codec', () => {
  it('emits the fixed v2 prefix and stable bytes', () => {
    const first = encodeReplicationPacket(baseline, DEFAULT_REPLICATION_LIMITS);
    const second = encodeReplicationPacket({ ...baseline }, DEFAULT_REPLICATION_LIMITS);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const text = new TextDecoder().decode(first.value);
    expect(text.startsWith(`${REPLICATION_PROTOCOL_PREFIX}\n`)).toBe(true);
    expect(first.value).toEqual(second.value);
  });

  it.each<ReplicationPacket>([
    baseline,
    { version: 2, kind: 'session-open', sessionId, epoch: 0, sequence: 0 },
    { version: 2, kind: 'session-resume', sessionId, epoch: 3, sequence: 0 },
    { ...baseline, kind: 'delta', sequence: 2 },
    { version: 2, kind: 'ack', sessionId, epoch: 3, acknowledgedSequence: 1 },
    {
      version: 2,
      kind: 'rejection',
      sessionId,
      epoch: 3,
      sequence: 2,
      rejectedKind: 'delta',
      reason: 'gap',
    },
  ])('round-trips every packet kind: $kind', (packet) => {
    const encoded = encodeReplicationPacket(packet, DEFAULT_REPLICATION_LIMITS);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(decodeReplicationPacket(encoded.value, DEFAULT_REPLICATION_LIMITS)).toEqual({
      ok: true,
      value: packet,
    });
  });

  it('preserves typed-array entity payloads in data packets', () => {
    const packet = {
      ...baseline,
      entities: [{ ...baseline.entities[0]!, components: [{ name: 'PositionCodec', data: { values: new Float32Array([1.5, 2.5]) } }] }],
    } satisfies ReplicationPacket;
    const encoded = encodeReplicationPacket(packet, DEFAULT_REPLICATION_LIMITS);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeReplicationPacket(encoded.value, DEFAULT_REPLICATION_LIMITS);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.value.kind === 'ack' || decoded.value.kind === 'rejection') return;
    expect(decoded.value.entities[0]!.components[0]!.data.values).toEqual(
      new Float32Array([1.5, 2.5]),
    );
  });
});

