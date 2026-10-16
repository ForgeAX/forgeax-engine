import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { applyReplicationPacket, createReplicaCoordinator } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';

const NetworkedReplica = defineComponent('NetworkedReplica', { enabled: 'bool' });
const LinkReplica = defineComponent('LinkReplica', {
  target: 'entity',
  targets: 'array<entity>',
});

function profile() {
  const result = defineReplication({
    name: 'replica-validation',
    entities: { with: [NetworkedReplica] },
    components: [NetworkedReplica, LinkReplica],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('replica atomic validation', () => {
  it('rejects stale and duplicate authority ticks before World mutation', () => {
    const world = new World();
    const replica = createReplicaCoordinator(world, profile());
    const packet = { version: 2, kind: 'baseline' as const, sessionId: 17 as never, epoch: 1, sequence: 1, fingerprint: profile().fingerprint, tick: 1, entities: [] };
    expect(applyReplicationPacket(replica, packet).ok).toBe(true);
    const duplicate = applyReplicationPacket(replica, packet);
    expect(duplicate.ok).toBe(true);
    expect(replica.lastPacketOutcome).toBe('duplicate');
    expect(replica.snapshot()).toEqual([]);
  });

  it('rejects zero and unknown identities before allocating ECS entities', () => {
    const world = new World();
    const replica = createReplicaCoordinator(world, profile());
    const result = applyReplicationPacket(replica, {
      version: 2,
      kind: 'baseline',
      sessionId: 17 as never,
      epoch: 1,
      sequence: 1,
      fingerprint: profile().fingerprint,
      tick: 1,
      entities: [{ id: 0, kind: 'upsert' as const, components: [] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('identity-invalid');
    expect(replica.snapshot()).toEqual([]);
  });

  it('allocates all same-batch spawns before remapping forward references', () => {
    const world = new World();
    const replica = createReplicaCoordinator(world, profile());
    const result = applyReplicationPacket(replica, {
      version: 2,
      kind: 'baseline',
      sessionId: 17 as never,
      epoch: 1,
      sequence: 1,
      fingerprint: profile().fingerprint,
      tick: 1,
      entities: [
        { id: 1, kind: 'upsert' as const, components: [{ name: 'LinkReplica', data: { target: 2 } }] },
        { id: 2, kind: 'upsert' as const, components: [{ name: 'NetworkedReplica', data: { enabled: true } }] },
      ],
    });
    expect(result.ok).toBe(true);
    expect(replica.snapshot().map((entry) => entry.id)).toEqual([1, 2]);
  });

  it('rejects unresolved cross-batch references without closing the transport owner', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const world = new World();
    const replica = createReplicaCoordinator(world, profile());
    replicaEndpoint.poll();
    const result = applyReplicationPacket(replica, {
      version: 2,
      kind: 'baseline',
      sessionId: 17 as never,
      epoch: 1,
      sequence: 1,
      fingerprint: profile().fingerprint,
      tick: 1,
      entities: [{ id: 1, kind: 'upsert' as const, components: [{ name: 'LinkReplica', data: { target: 77 } }] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('remap-unresolved-reference');
    expect(replica.snapshot()).toEqual([]);
    expect(authorityEndpoint.send(2 as never, new Uint8Array([7])).ok).toBe(true);
    expect(replicaEndpoint.poll()).toEqual([{ kind: 'message', peerId: 1, data: new Uint8Array([7]) }]);
  });

  it.each([
    { target: 0 },
    { targets: new Uint32Array([0]) },
  ])('rejects zero NetEntityId references before World mutation', (data) => {
    const world = new World();
    const replica = createReplicaCoordinator(world, profile());
    const result = applyReplicationPacket(replica, {
      version: 2,
      kind: 'baseline',
      sessionId: 17 as never,
      epoch: 1,
      sequence: 1,
      fingerprint: profile().fingerprint,
      tick: 1,
      entities: [{ id: 1, kind: 'upsert' as const, components: [{ name: 'LinkReplica', data }] }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('remap-unresolved-reference');
    expect(replica.snapshot()).toEqual([]);
    expect(replica.stopped).toBe(false);
  });

  it('remaps Uint32Array entity references by their elements', () => {
    const world = new World();
    const replica = createReplicaCoordinator(world, profile());
    const result = applyReplicationPacket(replica, {
      version: 2,
      kind: 'baseline',
      sessionId: 17 as never,
      epoch: 1,
      sequence: 1,
      fingerprint: profile().fingerprint,
      tick: 1,
      entities: [
        { id: 1, kind: 'upsert' as const, components: [{ name: 'LinkReplica', data: { targets: new Uint32Array([2]) } }] },
        { id: 2, kind: 'upsert' as const, components: [{ name: 'NetworkedReplica', data: { enabled: true } }] },
      ],
    });

    expect(result.ok).toBe(true);
    const target = replica.entityFor(2);
    expect(Array.from(replica.readComponent(1, LinkReplica)!.targets as Uint32Array)).toEqual([target]);
  });

  it('preserves a null ECS entity field without resolving it as a NetEntityId', () => {
    const world = new World();
    const replica = createReplicaCoordinator(world, profile());
    const result = applyReplicationPacket(replica, {
      version: 2,
      kind: 'baseline',
      sessionId: 17 as never,
      epoch: 1,
      sequence: 1,
      fingerprint: profile().fingerprint,
      tick: 1,
      entities: [{ id: 1, kind: 'upsert' as const, components: [{ name: 'LinkReplica', data: { target: null } }] }],
    });

    expect(result.ok).toBe(true);
    expect(replica.readComponent(1, LinkReplica)).toMatchObject({ target: null });
  });

  it('rejects unknown component fields before allocating an ECS entity', () => {
    const world = new World();
    const replica = createReplicaCoordinator(world, profile());
    const result = applyReplicationPacket(replica, {
      version: 2,
      kind: 'baseline',
      sessionId: 17 as never,
      epoch: 1,
      sequence: 1,
      fingerprint: profile().fingerprint,
      tick: 1,
      entities: [{ id: 1, kind: 'upsert' as const, components: [{ name: 'LinkReplica', data: { forged: true } }] }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('schema-invalid');
    expect(replica.snapshot()).toEqual([]);
  });
});
