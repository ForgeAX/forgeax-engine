import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import type { ReplicationDataPacket } from '../src/replication/protocol';
import { applyReplicationPacket, createReplicaCoordinator } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';

const NetworkedOrder = defineComponent('NetworkedOrder', { enabled: 'bool' });

function profile() {
  const result = defineReplication({
    name: 'replica-packet-order',
    entities: { with: [NetworkedOrder] },
    components: [NetworkedOrder],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function packet(
  kind: 'baseline' | 'delta',
  epoch: number,
  sequence: 1 | number,
  tick: number,
): ReplicationDataPacket {
  return {
    version: 2,
    kind,
    sessionId: 17 as ReplicationDataPacket['sessionId'],
    epoch,
    sequence: kind === 'baseline' ? 1 : sequence,
    fingerprint: profile().fingerprint,
    tick,
    entities: [],
  } as ReplicationDataPacket;
}

describe('replica epoch and packet order', () => {
  it('re-acks duplicates without mutating and rejects gaps atomically', () => {
    const replica = createReplicaCoordinator(new World(), profile());
    const baseline = packet('baseline', 1, 1, 1);
    expect(applyReplicationPacket(replica, baseline).ok).toBe(true);
    expect(applyReplicationPacket(replica, baseline).ok).toBe(true);
    expect(applyReplicationPacket(replica, packet('delta', 1, 2, 2)).ok).toBe(true);

    const before = replica.snapshot();
    const gap = applyReplicationPacket(replica, packet('delta', 1, 4, 4));
    expect(gap.ok).toBe(false);
    expect(replica.snapshot()).toEqual(before);
  });

  it('ignores old epochs and replaces frozen state only after a valid baseline', () => {
    const replica = createReplicaCoordinator(new World(), profile());
    expect(applyReplicationPacket(replica, packet('baseline', 1, 1, 1)).ok).toBe(true);
    const before = replica.snapshot();

    const oldEpoch = applyReplicationPacket(replica, packet('delta', 0, 2, 2));
    expect(oldEpoch.ok).toBe(true);
    expect(replica.snapshot()).toEqual(before);
    expect((replica as unknown as { lastPacketOutcome: string }).lastPacketOutcome).toBe(
      'ignored-old-epoch',
    );
    expect(applyReplicationPacket(replica, packet('baseline', 2, 1, 3)).ok).toBe(true);
  });

  it('does not let a duplicate baseline swallow the next epoch baseline', () => {
    const replica = createReplicaCoordinator(new World(), profile());
    const firstEpoch = packet('baseline', 1, 1, 1);
    expect(applyReplicationPacket(replica, firstEpoch).ok).toBe(true);
    expect(applyReplicationPacket(replica, firstEpoch).ok).toBe(true);

    const nextEpoch = packet('baseline', 2, 1, 2);
    expect(applyReplicationPacket(replica, nextEpoch).ok).toBe(true);
    expect(applyReplicationPacket(replica, packet('delta', 2, 2, 3)).ok).toBe(true);
    expect(replica.lastPacketOutcome).toBe('accepted');
  });
});
