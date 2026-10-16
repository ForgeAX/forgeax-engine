import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import type { ReplicationDataPacket } from '../src/replication/protocol';
import { applyReplicationPacket, createReplicaCoordinator } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';
import { NetSession } from '../src/session/net-session';
import { RecoveryTransportHarness } from './fixtures/recovery-transport';

const NetworkedRecovery = defineComponent('NetworkedRecovery', { enabled: 'bool' });

function profile() {
  const result = defineReplication({
    name: 'recovery-red-falsifiers',
    entities: { with: [NetworkedRecovery] },
    components: [NetworkedRecovery],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function packet(
  fingerprint: string,
  values: Pick<ReplicationDataPacket, 'tick' | 'kind' | 'entities'>,
): ReplicationDataPacket {
  return {
    version: 2,
    sessionId: 17 as ReplicationDataPacket['sessionId'],
    epoch: 1,
    sequence: values.kind === 'baseline' ? 1 : values.tick,
    fingerprint,
    ...values,
  };
}

const redFalsifiers = [
  {
    id: 'pre-baseline-mutation',
    acceptanceId: 'AC-02',
    protectedReason: 'A delta must not mutate a replica before a complete baseline.',
    expectedOutcome: 'structured rejection with unchanged World state',
  },
  {
    id: 'stale-authority-after-reconnect',
    acceptanceId: 'AC-04',
    protectedReason: 'A reopened socket must not make frozen local state authoritative.',
    expectedOutcome: 'resyncing state until a fresh baseline is accepted',
  },
  {
    id: 'duplicate-mutation',
    acceptanceId: 'AC-07',
    protectedReason: 'The same accepted packet identity must not apply a mutation twice.',
    expectedOutcome: 'idempotent no-mutation duplicate outcome',
  },
  {
    id: 'out-of-order-regression',
    acceptanceId: 'AC-07',
    protectedReason: 'A delayed packet must not regress the accepted projection.',
    expectedOutcome: 'deterministic no-mutation outcome with preserved projection',
  },
  {
    id: 'ack-retry-over-bound',
    acceptanceId: 'AC-03',
    protectedReason: 'ACK and retry retention must stay within the public finite bound.',
    expectedOutcome: 'observable pending usage at or below maxPendingPackets',
  },
  {
    id: 'retry-masks-fatal-apply',
    acceptanceId: 'AC-06',
    protectedReason: 'Transport retry must not hide a terminal replication apply failure.',
    expectedOutcome: 'failed state with structured fatal apply error',
  },
  {
    id: 'unresolved-reference-retention',
    acceptanceId: 'AC-05',
    protectedReason: 'An unresolved reference must reject immediately without deferred work.',
    expectedOutcome: 'structured rejection and zero retained unresolved references',
  },
  {
    id: 'dispose-pending-connect',
    acceptanceId: 'AC-12',
    protectedReason: 'Disposal must retire a pending connection and every owned resource.',
    expectedOutcome: 'retired state and zero resource counters',
  },
] as const;

describe('M16 recovery red falsifiers', () => {
  it('pre-baseline-mutation: rejects a delta before baseline', () => {
    const replication = profile();
    const replica = createReplicaCoordinator(new World(), replication);
    const result = applyReplicationPacket(
      replica,
      packet(replication.fingerprint, {
        tick: 1,
        kind: 'delta',
        entities: [
          {
            id: 1,
            kind: 'upsert',
            components: [{ name: 'NetworkedRecovery', data: { enabled: true } }],
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(replica.snapshot()).toEqual([]);
  });

  it('stale-authority-after-reconnect: exposes a non-authoritative recovery state', () => {
    const [endpoint] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint, maxRawMessages: 8 });
    const recoverySession = session as unknown as {
      getRecoverySnapshot(): { readonly kind: string };
    };

    expect(recoverySession.getRecoverySnapshot().state.kind).toBe('resyncing');
  });

  it('duplicate-mutation: accepts the same packet identity idempotently', () => {
    const replication = profile();
    const replica = createReplicaCoordinator(new World(), replication);
    const baseline = packet(replication.fingerprint, {
      tick: 1,
      kind: 'baseline',
      entities: [
        {
          id: 1,
          kind: 'upsert',
          components: [{ name: 'NetworkedRecovery', data: { enabled: true } }],
        },
      ],
    });

    expect(applyReplicationPacket(replica, baseline).ok).toBe(true);
    expect(applyReplicationPacket(replica, baseline).ok).toBe(true);
    expect(replica.snapshot()).toEqual([{ id: 1, components: ['NetworkedRecovery'] }]);
  });

  it('out-of-order-regression: preserves the accepted projection', () => {
    const replication = profile();
    const replica = createReplicaCoordinator(new World(), replication);
    const baseline = packet(replication.fingerprint, { tick: 1, kind: 'baseline', entities: [] });
    const delayed = packet(replication.fingerprint, {
      tick: 3,
      kind: 'delta',
      entities: [],
    });

    expect(applyReplicationPacket(replica, baseline).ok).toBe(true);
    expect(applyReplicationPacket(replica, delayed).ok).toBe(false);
    expect(replica.snapshot()).toEqual([]);
  });

  it('ack-retry-over-bound: reports bounded pending packet usage', () => {
    const [endpoint] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint, maxRawMessages: 8 });
    const recoverySession = session as unknown as {
      getRecoverySnapshot(): {
        readonly pendingPackets: number;
        readonly maxPendingPackets: number;
      };
    };
    const snapshot = recoverySession.getRecoverySnapshot();

    expect(snapshot.pendingPackets).toBeLessThanOrEqual(snapshot.maxPendingPackets);
    expect(snapshot.maxPendingPackets).toBe(32);
  });

  it('retry-masks-fatal-apply: exposes a terminal fatal apply state', () => {
    const replication = profile();
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    const replica = createReplicaCoordinator(new World(), replication);
    session.attachReplica(replica, replication.limits);
    authorityEndpoint.poll();
    session.receiveEvents();

    authorityEndpoint.send(2 as never, new Uint8Array([0xff]));
    session.receiveEvents();
    const recoverySession = session as unknown as {
      getRecoverySnapshot(): { readonly state: { readonly kind: string }; readonly lastError?: { readonly code: string } };
    };
    const snapshot = recoverySession.getRecoverySnapshot();

    expect(snapshot.state.kind).toBe('failed');
    expect(snapshot.lastError?.code).toBe('decode-invalid-payload');
  });

  it('unresolved-reference-retention: rejects without retained deferred work', () => {
    const Link = defineComponent('UnresolvedRecoveryLink', { target: 'entity' });
    const replication = defineReplication({
      name: 'unresolved-red-falsifier',
      entities: { with: [NetworkedRecovery] },
      components: [NetworkedRecovery, Link],
    });
    if (!replication.ok) throw replication.error;
    const replica = createReplicaCoordinator(new World(), replication.value);
    const refused = applyReplicationPacket(replica, packet(replication.value.fingerprint, {
      tick: 1,
      kind: 'baseline',
      entities: [{ id: 1, kind: 'upsert', components: [{ name: Link.name, data: { target: 99 } }] }],
    }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('remap-unresolved-reference');
    expect(replica.snapshot()).toEqual([]);
    expect(replica.stopped).toBe(false);
    expect(applyReplicationPacket(replica, packet(replication.value.fingerprint, {
      tick: 1,
      kind: 'baseline',
      entities: [{ id: 1, kind: 'upsert', components: [{ name: NetworkedRecovery.name, data: { enabled: true } }] }],
    })).ok).toBe(true);
    expect(replica.readComponent(1, Link)).toBeUndefined();
    expect(replica.readComponent(1, NetworkedRecovery)).toEqual({ enabled: true });
  });

  it('dispose-pending-connect: retires pending connection resources', async () => {
    const transport = new RecoveryTransportHarness();
    const session = new NetSession({
      endpoint: undefined as never,
      maxRawMessages: 8,
      connector: transport.connector as never,
    });

    try {
      const recoverySession = session as unknown as { dispose(): void };
      recoverySession.recover();
      recoverySession.advanceRecovery();
      recoverySession.dispose();
      expect(transport.pendingConnectCount).toBe(0);
      expect(transport.resources.snapshot()).toEqual({
        timers: 0,
        listeners: 0,
        sockets: 0,
        pendingConnects: 0,
        ledgers: 0,
        deferredCallbacks: 0,
      });
    } finally {
      transport.closeAll();
    }
  });

  it('records every protected reason and expected structured outcome', () => {
    expect(redFalsifiers).toHaveLength(8);
    expect(redFalsifiers.every((entry) => entry.protectedReason.length > 0)).toBe(true);
    expect(redFalsifiers.every((entry) => entry.expectedOutcome.length > 0)).toBe(true);
  });
});
