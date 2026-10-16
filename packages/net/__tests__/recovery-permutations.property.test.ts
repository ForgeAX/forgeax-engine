import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { applyReplicationPacket, createReplicaCoordinator } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';

const NetworkedPermutation = defineComponent('NetworkedPermutation', { enabled: 'bool' });

function profile() {
  const result = defineReplication({
    name: 'recovery-permutations',
    entities: { with: [NetworkedPermutation] },
    components: [NetworkedPermutation],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('recovery packet permutations', () => {
  it('produces the same accepted projection for every finite order', () => {
    const replication = profile();
    const baseline = {
      version: 2 as const,
      kind: 'baseline' as const,
      sessionId: 17 as never,
      epoch: 1,
      sequence: 1 as const,
      fingerprint: replication.fingerprint,
      tick: 1,
      entities: [{ id: 1, kind: 'upsert' as const, components: [{ name: 'NetworkedPermutation', data: { enabled: true } }] }],
    };
    const delta = { ...baseline, kind: 'delta' as const, sequence: 2, tick: 2 };
    const orders = [[baseline, delta], [baseline, delta, delta], [delta, baseline]];

    const outcomes = orders.map((packets) => {
      const replica = createReplicaCoordinator(new World(), replication);
      return packets.map((packet) => applyReplicationPacket(replica, packet).ok).join(',');
    });

    expect(outcomes).toEqual(['true,true', 'true,true,true', 'false,true']);
  });
});
