import { World } from '@forgeax/engine/ecs';
import {
  createAuthorityCoordinator,
  createReplicaCoordinator,
  NetSession,
} from '@forgeax/engine/net';
import { defineFeature } from '../../lab/feature';
import { createMemoryHub, healthProfile, NetHealth } from './support/hub';

export default defineFeature({
  title: 'Per-session replication visibility',
  catalog: 'Per-session replication visibility',
  kind: 'headless',
  summary:
    'Each logical SessionId receives its own permitted entities and stream; hiding an entity removes it from that receiver.',
  expect:
    'Two replicas see different health entities. Revoking visibility despawns only the first receiver while the second remains unchanged.',
  run(checks) {
    const profile = healthProfile('feature-lab-session-visibility');
    if (typeof profile === 'string') {
      checks.ok('profile defined', false, profile);
      return;
    }
    const hub = createMemoryHub(),
      world = new World();
    world.components.register(NetHealth).unwrap();
    const one = world.spawn({ component: NetHealth, data: { hp: 10 } }).unwrap();
    const two = world.spawn({ component: NetHealth, data: { hp: 20 } }).unwrap();
    const coordinator = createAuthorityCoordinator(world, profile),
      authority = new NetSession({ endpoint: hub.authority, maxRawMessages: 8 });
    let visible = true;
    authority.attachAuthority(coordinator, (entity, session) =>
      session === 7 ? visible && entity === one : entity === two,
    );
    const replicas = [7, 8].map((sessionId, index) => {
      const world = new World();
      world.components.register(NetHealth).unwrap();
      const coordinator = createReplicaCoordinator(world, profile),
        session = new NetSession({
          endpoint: hub.addPeer(index + 2),
          sessionId,
          maxRawMessages: 8,
        });
      session.attachReplica(coordinator, profile.limits);
      session.receiveEvents();
      return { world, session };
    });
    const [first, second] = replicas;
    if (first === undefined || second === undefined) throw new Error('Expected two replicas');
    try {
      authority.receiveEvents();
      authority.publish().unwrap();
      for (const replica of replicas) replica.session.receiveEvents();
      checks.equal(
        'first receiver health',
        Array.from(
          first.world.query({ read: [NetHealth] }).unwrap(),
          (row) => row.get(NetHealth).hp,
        ),
        [10],
      );
      checks.equal(
        'second receiver health',
        Array.from(
          second.world.query({ read: [NetHealth] }).unwrap(),
          (row) => row.get(NetHealth).hp,
        ),
        [20],
      );
      authority.receiveEvents();
      visible = false;
      authority.publish().unwrap();
      for (const replica of replicas) replica.session.receiveEvents();
      checks.equal(
        'revoked receiver is empty',
        Array.from(first.world.query({ read: [NetHealth] }).unwrap()).length,
        0,
      );
      checks.equal(
        'other receiver remains isolated',
        Array.from(
          second.world.query({ read: [NetHealth] }).unwrap(),
          (row) => row.get(NetHealth).hp,
        ),
        [20],
      );
    } finally {
      for (const replica of replicas) replica.session.dispose();
      authority.dispose();
    }
  },
});
