import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { applyReplicationPacket, createReplicaCoordinator } from '../src/replication/replica';
import type { ReplicationDataPacket } from '../src/replication/protocol';
import { defineReplication } from '../src/replication/profile';
import { NetSession } from '../src/session/net-session';
import { RecoveryTransportHarness } from './fixtures/recovery-transport';

const NetworkedCleanup = defineComponent('NetworkedCleanup', { enabled: 'bool' });

function createProfile() {
  const result = defineReplication({
    name: 'recovery-cleanup-red',
    entities: { with: [NetworkedCleanup] },
    components: [NetworkedCleanup],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('M16 terminal cleanup red reproducers', () => {
  it('does not leave stale replica state after explicit recovery', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const replication = createProfile();
    const world = new World();
    const replica = createReplicaCoordinator(world, replication);
    const session = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    session.attachReplica(replica, replication.limits);
    authorityEndpoint.poll();
    session.receiveEvents();

    const baseline = {
      version: 2,
      kind: 'baseline',
      sessionId: 17 as ReplicationDataPacket['sessionId'],
      epoch: 1,
      sequence: 1,
      fingerprint: replication.fingerprint,
      tick: 1,
      entities: [
        {
          id: 1,
          kind: 'upsert' as const,
          components: [{ name: 'NetworkedCleanup', data: { enabled: true } }],
        },
      ],
    };
    expect(applyReplicationPacket(replica, baseline).ok).toBe(true);
    replicaEndpoint.close();
    session.recover();

    const recoverySession = session as unknown as {
      getRecoverySnapshot(): { readonly state: { readonly kind: string }; readonly sequence: number };
    };
    const snapshot = recoverySession.getRecoverySnapshot();
    expect(snapshot.state.kind).toBe('recovering');
    expect(snapshot.sequence).toBe(0);
  });

  it('cleans every resource when disposal races pending connect', async () => {
    const transport = new RecoveryTransportHarness();
    const session = new NetSession({
      endpoint: undefined as never,
      maxRawMessages: 8,
      connector: transport.connector as never,
    });

    try {
      const recoverySession = session as unknown as {
        recover(): void;
        advanceRecovery(): void;
        dispose(): void;
      };
      recoverySession.recover();
      recoverySession.advanceRecovery();
      recoverySession.dispose();
      expect(transport.pendingConnectCount).toBe(0);
      transport.resources.assertZero();
    } finally {
      transport.closeAll();
    }
  });
});
