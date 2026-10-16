import { describe, expect, it } from 'vitest';
import { decodeReplicationPacket } from '../src/replication/codec';
import { REPLICATION_PROTOCOL_PREFIX } from '../src/replication/constants';
import { DEFAULT_REPLICATION_LIMITS } from '../src/replication/profile';

const decode = (value: unknown) =>
  decodeReplicationPacket(
    new TextEncoder().encode(`${REPLICATION_PROTOCOL_PREFIX}\n${JSON.stringify(value)}`),
    DEFAULT_REPLICATION_LIMITS,
  );

describe('protocol-v2 negative matrix', () => {
  it.each([
    ['protocol-v1', { version: 1, kind: 'baseline' }],
    ['unsupported-kind', { version: 2, kind: 'batch' }],
    ['prototype-key-kind', { version: 2, kind: 'toString', sessionId: 1, epoch: 1, sequence: 0 }],
    ['array-wrapped-kind', { version: 2, kind: ['ack'], sessionId: 1, epoch: 1, acknowledgedSequence: 0 }],
    ['prototype-key-rejected-kind', { version: 2, kind: 'rejection', sessionId: 1, epoch: 1, sequence: 1, rejectedKind: 'constructor', reason: 'x' }],
    ['missing-session', { version: 2, kind: 'delta', epoch: 1, sequence: 2 }],
    ['unsafe-epoch', { version: 2, kind: 'delta', sessionId: 1, epoch: Number.MAX_SAFE_INTEGER + 1, sequence: 2 }],
    ['baseline-not-sequence-one', { version: 2, kind: 'baseline', sessionId: 1, epoch: 1, sequence: 2, tick: 1, fingerprint: 'x', entities: [] }],
    ['negative-ack', { version: 2, kind: 'ack', sessionId: 1, epoch: 1, acknowledgedSequence: -1 }],
  ])('rejects %s before packet dispatch', (_name, value) => {
    const result = decode(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toMatch(/decode|protocol/);
      expect(result.error.expected).not.toHaveLength(0);
      expect(result.error.hint).not.toHaveLength(0);
    }
  });

  it('rejects an invalid prefix before attempting JSON decode', () => {
    const result = decodeReplicationPacket(
      new TextEncoder().encode(`WRONG\n${JSON.stringify({ version: 2 })}`),
      DEFAULT_REPLICATION_LIMITS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('decode-invalid-payload');
  });

  it('rejects payloads that exceed existing replication limits', () => {
    const result = decode({
      version: 2,
      kind: 'delta',
      sessionId: 1,
      epoch: 1,
      sequence: 2,
      tick: 1,
      fingerprint: 'x',
      entities: Array.from({ length: DEFAULT_REPLICATION_LIMITS.maxEntities + 1 }, (_, id) => ({
        id: id + 1,
        kind: 'upsert',
        components: [],
      })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('decode-limit-exceeded');
  });
});

