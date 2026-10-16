import { describe, expect, it } from 'vitest';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { createAuthorityCoordinator } from '../src/replication/authority';
import { defineReplication } from '../src/replication/profile';
import { createReplicaCoordinator } from '../src/replication/replica';
import { NetSession } from '../src/session/net-session';
import { defineComponent, World } from '@forgeax/engine-ecs';

const NetworkedMemoryRecovery = defineComponent('NetworkedMemoryRecovery', { enabled: 'bool' });

function profile() {
  const result = defineReplication({
    name: 'memory-recovery',
    entities: { with: [NetworkedMemoryRecovery] },
    components: [NetworkedMemoryRecovery],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('memory recovery integration', () => {
  it('keeps the session identity and freezes until a fresh baseline', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const replication = profile();
    const authorityWorld = new World();
    authorityWorld.spawn({ component: NetworkedMemoryRecovery, data: { enabled: true } });
    const authoritySession = new NetSession({ endpoint: authorityEndpoint, maxRawMessages: 8 });
    const replicaSession = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    const replica = createReplicaCoordinator(new World(), replication);
    authoritySession.attachAuthority(createAuthorityCoordinator(authorityWorld, replication));
    replicaSession.attachReplica(replica, replication.limits);
    authoritySession.receiveEvents();
    replicaSession.receiveEvents();
    authoritySession.receiveEvents();
    const sessionId = replicaSession.getRecoverySnapshot().sessionId;

    expect(authoritySession.publish().ok).toBe(true);
    expect(replicaSession.receiveEvents()).toEqual([]);
    expect(replicaSession.getRecoverySnapshot().state.kind).toBe('active');
    replicaEndpoint.close();
    replicaSession.recover();

    expect(replicaSession.getRecoverySnapshot().state.kind).toBe('recovering');
    expect(replicaSession.getRecoverySnapshot().sessionId).toBe(sessionId);
    expect(replicaSession.getRecoverySnapshot().ownedResources.ledgers).toBe(0);
  });
});
