import { describe, expect, it } from 'vitest';
import { decodeReplicationPacket, encodeReplicationPacket } from '../src/replication/codec';
import { REPLICATION_PROTOCOL_VERSION } from '../src/replication/constants';
import type { ReplicationPacket } from '../src/replication/protocol';
import { DEFAULT_REPLICATION_LIMITS } from '../src/replication/profile';

describe('canonical replication packet codec', () => {
  const packet: ReplicationPacket = {
    version: REPLICATION_PROTOCOL_VERSION,
    kind: 'baseline',
    sessionId: 17 as ReplicationPacket['sessionId'],
    epoch: 1,
    sequence: 1,
    fingerprint: 'a1b2c3d4',
    tick: 7,
    entities: [
      {
        id: 1,
        kind: 'upsert',
        components: [{ name: 'PositionCodec', data: { x: 1, y: 2 } }],
      },
    ],
  };

  it('emits stable bytes for an equivalent ordered packet', () => {
    const first = encodeReplicationPacket(packet, DEFAULT_REPLICATION_LIMITS);
    const second = encodeReplicationPacket({ ...packet }, DEFAULT_REPLICATION_LIMITS);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toEqual(second.value);
  });

  it('round-trips version, identity, tick, and ordered records', () => {
    const encoded = encodeReplicationPacket(packet, DEFAULT_REPLICATION_LIMITS);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(decodeReplicationPacket(encoded.value, DEFAULT_REPLICATION_LIMITS)).toEqual({
      ok: true,
      value: packet,
    });
  });

  it('round-trips allowlisted buffer and numeric typed-array payloads', () => {
    const typedPacket: ReplicationPacket = {
      ...packet,
      entities: [
        {
          ...packet.entities[0]!,
          components: [
            {
              name: 'PositionCodec',
              data: {
                bytes: new Uint8Array([1, 2]),
                coords: new Float32Array([1.5, 2.5]),
                signed: new Int8Array([-1, 1]),
                clamped: new Uint8ClampedArray([0, 255]),
              },
            },
          ],
        },
      ],
    };
    const encoded = encodeReplicationPacket(typedPacket, DEFAULT_REPLICATION_LIMITS);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    const decoded = decodeReplicationPacket(encoded.value, DEFAULT_REPLICATION_LIMITS);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.value.kind === 'ack' || decoded.value.kind === 'rejection') return;
    const data = decoded.value.entities[0]!.components[0]!.data;
    expect(data.bytes).toEqual(new Uint8Array([1, 2]));
    expect(data.coords).toEqual(new Float32Array([1.5, 2.5]));
    expect(data.signed).toEqual(new Int8Array([-1, 1]));
    expect(data.clamped).toEqual(new Uint8ClampedArray([0, 255]));
  });

  it('rejects malformed typed-array tags before yielding a packet', () => {
    const malformed = {
      ...packet,
      entities: [
        {
          ...packet.entities[0]!,
          components: [
            {
              name: 'PositionCodec',
              data: { bytes: { $typedArray: 'Uint8Array', values: [1, 'bad'] } },
            },
          ],
        },
      ],
    };
    const decoded = decodeReplicationPacket(
      new TextEncoder().encode(`FXRP2\n${JSON.stringify(malformed)}`),
      DEFAULT_REPLICATION_LIMITS,
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.code).toBe('decode-invalid-payload');
  });

  it.each(['constructor', 'toString', 'unknown'])(
    'rejects non-own or unknown typed-array label %s',
    (label) => {
      const malformed = {
        ...packet,
        entities: [
          {
            ...packet.entities[0]!,
            components: [
              {
                name: 'PositionCodec',
                data: { nested: { $typedArray: label, values: [1, 2, 3] } },
              },
            ],
          },
        ],
      };
      const decoded = decodeReplicationPacket(
        new TextEncoder().encode(`FXRP2\n${JSON.stringify(malformed)}`),
        DEFAULT_REPLICATION_LIMITS,
      );
      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.error.code).toBe('decode-invalid-payload');
    },
  );

  it('rejects a component removal that carries replacement data', () => {
    const malformed = {
      ...packet,
      entities: [
        {
          id: 1,
          kind: 'upsert' as const,
          components: [{ name: 'PositionCodec', operation: 'remove' as const, data: { x: 1 } }],
        },
      ],
    };
    const decoded = decodeReplicationPacket(
      new TextEncoder().encode(`FXRP2\n${JSON.stringify(malformed)}`),
      DEFAULT_REPLICATION_LIMITS,
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.code).toBe('decode-invalid-payload');
  });

  it('enforces declared message, entity, component, string, buffer, and array limits', () => {
    const limits = {
      maxMessageBytes: 4096,
      maxEntities: 0,
      maxComponentOperations: 0,
      maxStringBytes: 1,
      maxBufferBytes: 1,
      maxArrayElements: 0,
    };
    const encoded = encodeReplicationPacket(packet, limits);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.error.code).toBe('decode-limit-exceeded');
    expect(encoded.error.detail.limit).toBe('maxEntities');
  });
});
