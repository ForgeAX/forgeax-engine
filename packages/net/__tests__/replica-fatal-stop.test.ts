import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import type { PeerId } from '../src/endpoint/endpoint';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { encodeReplicationPacket } from '../src/replication/codec';
import type { ReplicationPacket } from '../src/replication/protocol';
import { applyReplicationPacket, createReplicaCoordinator } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';
import { NetSession } from '../src/session/net-session';

const NetworkedFatal = defineComponent('NetworkedFatal', { enabled: 'bool' });

function profile() {
  const result = defineReplication({
    name: 'replica-fatal-stop',
    entities: { with: [NetworkedFatal] },
    components: [NetworkedFatal],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('replica fatal apply stop', () => {
  it('stops later trusted applies after a real post-validation ECS write invariant failure', () => {
    const replication = profile();
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const replica = createReplicaCoordinator(new World(), replication);
    const session = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    session.attachReplica(replica, replication.limits);
    authorityEndpoint.poll();
    session.receiveEvents();

    const invalidWrite = encodeReplicationPacket(
      {
        version: 2,
        kind: 'baseline',
        sessionId: 17 as ReplicationPacket['sessionId'],
        epoch: 1,
        sequence: 1,
        fingerprint: replication.fingerprint,
        tick: 1,
        entities: [{ id: 1, kind: 'upsert', components: [{ name: 'NetworkedFatal', operation: 'remove', data: {} }] }],
      },
      replication.limits,
    ).unwrap();
    authorityEndpoint.send(2 as PeerId, invalidWrite).unwrap();
    const fatal = session.receiveEvents();
    expect(fatal).toHaveLength(1);
    expect(fatal[0]!.code).toBe('apply-invariant-failed');
    expect(replica.stopped).toBe(true);
    expect(replica.snapshot()).toEqual([{ id: 1, components: [] }]);

    const validLater = encodeReplicationPacket(
      {
        version: 2,
        kind: 'delta',
        sessionId: 17 as ReplicationPacket['sessionId'],
        epoch: 1,
        sequence: 2,
        fingerprint: replication.fingerprint,
        tick: 2,
        entities: [{ id: 1, kind: 'upsert', components: [{ name: 'NetworkedFatal', data: { enabled: true } }] }],
      },
      replication.limits,
    ).unwrap();
    const stopped = applyReplicationPacket(replica, validLater);
    expect(stopped.ok).toBe(false);
    if (stopped.ok) return;
    expect(stopped.error.code).toBe('apply-invariant-failed');
    expect(replica.snapshot()).toEqual([{ id: 1, components: [] }]);
  });
});
