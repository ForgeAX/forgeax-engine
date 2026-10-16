import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { applyReplicationPacket, createReplicaCoordinator } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';

const NetworkedReference = defineComponent('NetworkedReference', { enabled: 'bool' });
const LinkReference = defineComponent('LinkReference', { target: 'entity' });

function profile() {
  const result = defineReplication({
    name: 'reference-policy-recovery',
    entities: { with: [NetworkedReference] },
    components: [NetworkedReference, LinkReference],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('reference policy during recovery', () => {
  it('rejects unresolved cross-packet references without retained work', () => {
    const replica = createReplicaCoordinator(new World(), profile());
    const result = applyReplicationPacket(replica, {
      version: 2,
      kind: 'baseline',
      sessionId: 17 as never,
      epoch: 1,
      sequence: 1,
      fingerprint: profile().fingerprint,
      tick: 1,
      entities: [
        {
          id: 1,
          kind: 'upsert',
          components: [{ name: 'LinkReference', data: { target: 99 } }],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('remap-unresolved-reference');
    expect(replica.snapshot()).toEqual([]);
    expect(replica.stopped).toBe(false);
    // A later complete baseline must not revive a deferred write from the
    // rejected packet. The first attempted LinkReference is never adopted.
    expect(applyReplicationPacket(replica, {
      version: 2,
      kind: 'baseline',
      sessionId: 17 as never,
      epoch: 1,
      sequence: 1,
      fingerprint: profile().fingerprint,
      tick: 1,
      entities: [{ id: 1, kind: 'upsert', components: [{ name: 'NetworkedReference', data: { enabled: true } }] }],
    }).ok).toBe(true);
    expect(replica.readComponent(1, LinkReference)).toBeUndefined();
    expect(replica.readComponent(1, NetworkedReference)).toEqual({ enabled: true });
  });
});
