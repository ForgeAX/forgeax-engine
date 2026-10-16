/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ReplicationEntityRecord as PublicReplicationEntityRecord,
  ReplicationPacket,
} from '../src/index';
import { decodeReplicationPacket, encodeReplicationPacket } from '../src/replication/codec';
import type { ReplicationEntityRecord as CodecReplicationEntityRecord } from '../src/replication/codec';
import { REPLICATION_PROTOCOL_VERSION } from '../src/replication/constants';
import { DEFAULT_REPLICATION_LIMITS } from '../src/replication/profile';

type EntityKind = PublicReplicationEntityRecord['kind'];
type CodecEntityKind = CodecReplicationEntityRecord['kind'];
type ExpectedEntityKind = 'upsert' | 'despawn';

const codecSource = readFileSync(new URL('../src/replication/codec.ts', import.meta.url), 'utf8');

describe('replication entity kind owner', () => {
  it('keeps the public and protocol declarations bilaterally exact', () => {
    expectTypeOf<EntityKind>().toEqualTypeOf<ExpectedEntityKind>();
    expectTypeOf<ExpectedEntityKind>().toEqualTypeOf<EntityKind>();
    expectTypeOf<CodecEntityKind>().toEqualTypeOf<EntityKind>();
    expectTypeOf<EntityKind>().toEqualTypeOf<CodecEntityKind>();

    const acceptsEntityKind = (kind: EntityKind): EntityKind => kind;
    acceptsEntityKind('upsert');
    acceptsEntityKind('despawn');
    // @ts-expect-error Unknown entity kinds remain outside the public wire vocabulary.
    acceptsEntityKind('replace');
  });

  it('derives the decoder guard from ReplicationEntityRecord.kind', () => {
    expect(codecSource).toContain(
      "const REPLICATION_ENTITY_KINDS = [\n  'upsert',\n  'despawn',\n] as const satisfies readonly ReplicationEntityRecord['kind'][];",
    );
    expect(codecSource).toContain(
      "function isReplicationEntityKind(value: unknown): value is ReplicationEntityRecord['kind']",
    );
    expect(codecSource).toContain(
      'return REPLICATION_ENTITY_KINDS.some((kind) => kind === value);',
    );
    expect(codecSource).toContain('!isReplicationEntityKind(entity.kind)');
    expect(codecSource).not.toContain(
      "(entity.kind !== 'upsert' && entity.kind !== 'despawn')",
    );
  });

  it('preserves both wire kinds and rejects an unknown kind at decode time', () => {
    const packet: ReplicationPacket = {
      version: REPLICATION_PROTOCOL_VERSION,
      kind: 'baseline',
      sessionId: 17 as ReplicationPacket['sessionId'],
      epoch: 1,
      sequence: 1,
      fingerprint: 'entity-kind-owner',
      tick: 7,
      entities: [
        { id: 1, kind: 'upsert', components: [] },
        { id: 2, kind: 'despawn', components: [] },
      ],
    };
    const encoded = encodeReplicationPacket(packet, DEFAULT_REPLICATION_LIMITS);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(new TextDecoder().decode(encoded.value)).toContain('"kind":"baseline"');
    expect(decodeReplicationPacket(encoded.value, DEFAULT_REPLICATION_LIMITS)).toEqual({
      ok: true,
      value: packet,
    });

    const unknown = {
      ...packet,
      entities: [{ id: 1, kind: 'replace', components: [] }],
    };
    const decodedUnknown = decodeReplicationPacket(
      new TextEncoder().encode(`FXRP2\n${JSON.stringify(unknown)}`),
      DEFAULT_REPLICATION_LIMITS,
    );
    expect(decodedUnknown).toMatchObject({
      ok: false,
      error: { code: 'decode-invalid-payload' },
    });
  });
});
