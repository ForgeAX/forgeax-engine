import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { createAuthorityCoordinator } from '../src/replication/authority';
import { createReplicaCoordinator, type ReplicaCoordinator } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';
import { NetSession } from '../src/session/net-session';
import { authoritySemanticSnapshot, replicaSemanticSnapshot } from './fixtures/semantic-snapshot';

const NetworkedConvergence = defineComponent('NetworkedConvergence', { enabled: 'bool' });
const PositionConvergence = defineComponent('PositionConvergence', { x: 'f32' });
const LocalOnly = defineComponent('LocalOnlyConvergence', { value: 'u32' });

function profile() {
  const result = defineReplication({
    name: 'memory-convergence',
    entities: { with: [NetworkedConvergence] },
    components: [NetworkedConvergence, PositionConvergence],
  });
  if (!result.ok) throw result.error;
  return result.value;
}


describe('memory two-World convergence', () => {
  it('converges on initial full, unchanged publication, and a late-join full baseline', () => {
    const replication = profile();
    const authorityWorld = new World();
    authorityWorld.spawn({ component: LocalOnly, data: { value: 1 } }).unwrap();
    authorityWorld.spawn({ component: LocalOnly, data: { value: 3 } }).unwrap();
    const entity = authorityWorld
      .spawn(
        { component: NetworkedConvergence, data: { enabled: true } },
        { component: PositionConvergence, data: { x: 7 } },
      )
      .unwrap();
    const authority = createAuthorityCoordinator(authorityWorld, replication);

    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authoritySession = new NetSession({ endpoint: authorityEndpoint, maxRawMessages: 8 });
    const replicaWorld = new World();
    replicaWorld.spawn({ component: LocalOnly, data: { value: 2 } }).unwrap();
    const replica = createReplicaCoordinator(replicaWorld, replication);
    const replicaSession = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    authoritySession.attachAuthority(authority);
    replicaSession.attachReplica(replica, replication.limits);
    authoritySession.receiveEvents();
    replicaSession.receiveEvents();
    authoritySession.receiveEvents();

    expect(authoritySession.publish().ok).toBe(true);
    expect(replicaSession.receiveEvents()).toEqual([]);
    expect(authority.idFor(entity)).toBe(1);
    expect(replica.entityFor(1)).not.toBe(entity);
    expect(replicaSemanticSnapshot(replicaWorld, replication, replica)).toEqual(
      authoritySemanticSnapshot(authorityWorld, replication, authority),
    );

    expect(authoritySession.publish().ok).toBe(true);
    expect(replicaSession.receiveEvents()).toEqual([]);
    expect(replicaSemanticSnapshot(replicaWorld, replication, replica)).toEqual(
      authoritySemanticSnapshot(authorityWorld, replication, authority),
    );

    const [lateAuthorityEndpoint, lateReplicaEndpoint] = createMemoryEndpointPair();
    const lateAuthoritySession = new NetSession({ endpoint: lateAuthorityEndpoint, maxRawMessages: 8 });
    const lateReplicaWorld = new World();
    const lateReplica = createReplicaCoordinator(lateReplicaWorld, replication);
    const lateReplicaSession = new NetSession({ endpoint: lateReplicaEndpoint, maxRawMessages: 8 });
    lateAuthoritySession.attachAuthority(authority);
    lateReplicaSession.attachReplica(lateReplica, replication.limits);
    lateAuthoritySession.receiveEvents();
    lateReplicaSession.receiveEvents();
    lateAuthoritySession.receiveEvents();

    expect(lateAuthoritySession.publish().ok).toBe(true);
    expect(lateReplicaSession.receiveEvents()).toEqual([]);
    expect(replicaSemanticSnapshot(lateReplicaWorld, replication, lateReplica)).toEqual(
      authoritySemanticSnapshot(authorityWorld, replication, authority),
    );
  });
});
