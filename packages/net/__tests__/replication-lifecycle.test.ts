import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createAuthorityCoordinator } from '../src/replication/authority';
import { createReplicaCoordinator, applyReplicationPacket } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';

const NetworkedLifecycle = defineComponent('NetworkedLifecycle', { enabled: 'bool' });
const LinkLifecycle = defineComponent('LinkLifecycle', { target: 'entity', targets: 'array<entity>' });

function profile() {
  const result = defineReplication({
    name: 'lifecycle-identity',
    entities: { with: [NetworkedLifecycle] },
    components: [NetworkedLifecycle, LinkLifecycle],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('replication lifecycle identity', () => {
  it('aligns Worlds by non-zero NetEntityId rather than local Entity handle', () => {
    const authorityWorld = new World();
    const replicaWorld = new World();
    replicaWorld.spawn({ component: NetworkedLifecycle, data: { enabled: false } });
    authorityWorld.spawn({ component: NetworkedLifecycle, data: { enabled: true } });
    const authority = createAuthorityCoordinator(authorityWorld, profile());
    const replica = createReplicaCoordinator(replicaWorld, profile());

    const batch = authority.publish().unwrap();
    expect(applyReplicationPacket(replica, batch).ok).toBe(true);
    expect(replica.snapshot()).toEqual([{ id: 1, components: ['NetworkedLifecycle'] }]);
  });

  it('applies component replacement, additions, and entity-array remap by network identity', () => {
    const authorityWorld = new World();
    const first = authorityWorld.spawn({ component: NetworkedLifecycle, data: { enabled: true } }).unwrap();
    const second = authorityWorld.spawn({ component: NetworkedLifecycle, data: { enabled: true } }).unwrap();
    authorityWorld.addComponent(first, { component: LinkLifecycle, data: { target: second, targets: [second] } }).unwrap();
    const authority = createAuthorityCoordinator(authorityWorld, profile());
    const replica = createReplicaCoordinator(new World(), profile());
    const publication = authority.publish().unwrap();
    const applied = applyReplicationPacket(replica, publication);
    expect(applied.ok).toBe(true);

    const secondId = authority.idFor(second);
    const holderId = publication.entities.find((entry) =>
      entry.components.some((component) => component.name === 'LinkLifecycle'),
    )?.id;
    expect(secondId).toBeGreaterThan(0);
    expect(holderId).toBeDefined();
    expect(replica.readComponent(holderId!, LinkLifecycle)).toMatchObject({
      target: replica.entityFor(secondId),
    });
  });

  it('removes identity when a despawn is accepted and never reuses it', () => {
    const world = new World();
    const entity = world.spawn({ component: NetworkedLifecycle, data: { enabled: true } }).unwrap();
    const authority = createAuthorityCoordinator(world, profile());
    const replica = createReplicaCoordinator(new World(), profile());
    const first = authority.publish().unwrap();
    expect(applyReplicationPacket(replica, first).ok).toBe(true);
    world.despawn(entity).unwrap();
    const despawn = authority.publish().unwrap();
    expect(applyReplicationPacket(replica, despawn).ok).toBe(true);

    expect(replica.entityFor(first.entities[0]!.id)).toBeUndefined();
    const replacement = world.spawn({ component: NetworkedLifecycle, data: { enabled: true } }).unwrap();
    const after = authority.publish().unwrap();
    expect(authority.idFor(replacement)).toBeGreaterThan(first.entities[0]!.id);
    expect(after.entities.some((record) => record.id === first.entities[0]!.id && record.kind === 'upsert')).toBe(false);
  });

  it('publishes and atomically applies an explicit complete component removal', () => {
    const authorityWorld = new World();
    const entity = authorityWorld
      .spawn(
        { component: NetworkedLifecycle, data: { enabled: true } },
        { component: LinkLifecycle, data: { target: null, targets: [] } },
      )
      .unwrap();
    const authority = createAuthorityCoordinator(authorityWorld, profile());
    const replica = createReplicaCoordinator(new World(), profile());
    expect(applyReplicationPacket(replica, authority.publish().unwrap()).ok).toBe(true);

    authorityWorld.removeComponent(entity, LinkLifecycle).unwrap();
    const delta = authority.publish().unwrap();
    expect(delta.entities[0]!.components).toEqual([{ name: 'LinkLifecycle', operation: 'remove', data: {} }]);
    expect(applyReplicationPacket(replica, delta).ok).toBe(true);
    expect(replica.readComponent(delta.entities[0]!.id, LinkLifecycle)).toBeUndefined();
  });
});
