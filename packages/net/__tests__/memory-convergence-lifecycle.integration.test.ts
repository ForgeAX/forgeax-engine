import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { createAuthorityCoordinator } from '../src/replication/authority';
import { createReplicaCoordinator } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';
import { NetSession } from '../src/session/net-session';
import { authoritySemanticSnapshot, replicaSemanticSnapshot } from './fixtures/semantic-snapshot';

const NetworkedModel = defineComponent('NetworkedModel', { enabled: 'bool' });
const ScalarModel = defineComponent('ScalarModel', { value: 'f32' });
const LinkModel = defineComponent('LinkModel', { target: 'entity', targets: 'array<entity>' });
const AddedModel = defineComponent('AddedModel', { label: 'string' });

function profile() {
  const result = defineReplication({
    name: 'memory-lifecycle-convergence',
    entities: { with: [NetworkedModel] },
    components: [NetworkedModel, ScalarModel, LinkModel, AddedModel],
  });
  if (!result.ok) throw result.error;
  return result.value;
}


describe('memory lifecycle and remap convergence', () => {
  it('converges after scalar and array remap, component replacement/add/remove, spawn, and despawn', () => {
    const replication = profile();
    const authorityWorld = new World();
    const first = authorityWorld
      .spawn(
        { component: NetworkedModel, data: { enabled: true } },
        { component: ScalarModel, data: { value: 1 } },
      )
      .unwrap();
    const second = authorityWorld
      .spawn(
        { component: NetworkedModel, data: { enabled: true } },
        { component: ScalarModel, data: { value: 2 } },
      )
      .unwrap();
    authorityWorld.addComponent(first, { component: LinkModel, data: { target: second, targets: [second] } }).unwrap();

    const authority = createAuthorityCoordinator(authorityWorld, replication);
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authoritySession = new NetSession({ endpoint: authorityEndpoint, maxRawMessages: 8 });
    const replicaWorld = new World();
    const replica = createReplicaCoordinator(replicaWorld, replication);
    const replicaSession = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    authoritySession.attachAuthority(authority);
    replicaSession.attachReplica(replica, replication.limits);
    authoritySession.receiveEvents();
    replicaSession.receiveEvents();
    authoritySession.receiveEvents();

    const publish = () => {
      expect(authoritySession.publish().ok).toBe(true);
      expect(replicaSession.receiveEvents()).toEqual([]);
      expect(replicaSemanticSnapshot(replicaWorld, replication, replica)).toEqual(
        authoritySemanticSnapshot(authorityWorld, replication, authority),
      );
    };

    publish();
    const replicatedLink = replica.readComponent(authority.idFor(first), LinkModel)!;
    expect(replicatedLink.target).toBe(replica.entityFor(authority.idFor(second)));
    expect(Array.from(replicatedLink.targets)).toEqual([replica.entityFor(authority.idFor(second))]);

    authorityWorld.set(first, ScalarModel, { value: 3 }).unwrap();
    authorityWorld.removeComponent(first, LinkModel).unwrap();
    authorityWorld.addComponent(second, { component: AddedModel, data: { label: 'second' } }).unwrap();
    publish();

    const third = authorityWorld
      .spawn(
        { component: NetworkedModel, data: { enabled: true } },
        { component: ScalarModel, data: { value: 4 } },
        { component: LinkModel, data: { target: first, targets: [first, second] } },
      )
      .unwrap();
    publish();

    const secondId = authority.idFor(second);
    authorityWorld.despawn(second).unwrap();
    authorityWorld.set(third, LinkModel, { target: first, targets: [first] }).unwrap();
    publish();
    expect(replica.entityFor(secondId)).toBeUndefined();
  });
});
