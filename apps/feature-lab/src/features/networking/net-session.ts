import { World } from '@forgeax/engine/ecs';
import type { NetEndpoint } from '@forgeax/engine/net';
import {
  createAuthorityCoordinator,
  createReplicaCoordinator,
  NetSession,
} from '@forgeax/engine/net';
import { ok } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import {
  createMemoryHub,
  flushMicrotasks,
  healthProfile,
  NetHealth,
  packetsSince,
} from './support/hub';

export default defineFeature({
  title: 'NetSession lifecycle: baseline, delta, ACK, reconnect, resync',
  catalog: 'NetSession',
  kind: 'headless',
  summary:
    'NetSession owns endpoint polling, a logical SessionId, the bounded ACK ledger, baseline/delta ordering, and connector-driven reconnect with epoch resync. The journey runs one authority and one replica over an in-memory hub transport.',
  expect:
    'All checks pass: baseline then delta reach the replica, the replica auto-ACK drains the authority ledger, a transport drop moves the replica through recovering -> resyncing (epoch+1, same SessionId) -> active on a fresh baseline, and dispose retires the session.',
  async run(checks) {
    const profile = healthProfile();
    if (typeof profile === 'string') {
      checks.ok('replication profile defined', false, profile);
      return;
    }
    const hub = createMemoryHub();
    const authorityWorld = new World();
    authorityWorld.components.register(NetHealth).unwrap();
    const hero = authorityWorld
      .spawn({ component: NetHealth, data: { hp: 100, alive: true } })
      .unwrap();
    const authorityCoordinator = createAuthorityCoordinator(authorityWorld, profile);
    const authority = new NetSession({ endpoint: hub.authority, maxRawMessages: 8 });
    authority.attachAuthority(authorityCoordinator);

    let nextPeer = 3;
    let connects = 0;
    const replicaWorld = new World();
    replicaWorld.components.register(NetHealth).unwrap();
    const replicaCoordinator = createReplicaCoordinator(replicaWorld, profile);
    const replica = new NetSession({
      endpoint: hub.addPeer(2),
      connector: {
        connect: () => {
          connects += 1;
          const endpoint: NetEndpoint = hub.addPeer(nextPeer);
          nextPeer += 1;
          return Promise.resolve(ok(endpoint));
        },
      },
      sessionId: 7,
      maxRawMessages: 8,
      recovery: { reconnectDelaysMs: [0, 0, 0, 0, 0] },
    });
    replica.attachReplica(replicaCoordinator, profile.limits);
    const sessionId = replica.getRecoverySnapshot().sessionId;
    checks.equal(
      'replica starts resyncing at epoch 0',
      replica.getRecoverySnapshot().state.kind,
      'resyncing',
    );

    replica.receiveEvents();
    authority.receiveEvents();
    let mark = hub.sent.length;
    checks.ok('first publish succeeds', authority.publish().ok);
    const first = packetsSince(hub, mark, profile);
    checks.equal(
      'first packet is a baseline (epoch 0, sequence 1)',
      first.map((p) => [p.kind, p.epoch, p.sequence]),
      [['baseline', 0, 1]],
    );
    checks.equal(
      'authority ledger holds the unacknowledged baseline',
      authority.getRecoverySnapshot().pendingPackets,
      1,
    );
    checks.equal('replica applies the baseline without errors', replica.receiveEvents().length, 0);
    checks.equal('replica becomes active', replica.getRecoverySnapshot().state.kind, 'active');
    const replicatedHealth = () =>
      replicaCoordinator.readComponent(authorityCoordinator.idFor(hero, sessionId), NetHealth)?.hp;
    checks.equal('replica World holds the replicated hp', replicatedHealth(), 100);
    authority.receiveEvents();
    checks.equal(
      'replica auto-ACK drains the authority ledger',
      authority.getRecoverySnapshot().pendingPackets,
      0,
    );
    checks.equal(
      'authority acknowledgedSequence is 1',
      authority.getRecoverySnapshot().acknowledgedSequence,
      1,
    );

    authorityWorld.set(hero, NetHealth, { hp: 42, alive: true }).unwrap();
    mark = hub.sent.length;
    checks.ok('second publish succeeds', authority.publish().ok);
    checks.equal(
      'second packet is a delta (sequence 2)',
      packetsSince(hub, mark, profile).map((p) => [p.kind, p.sequence]),
      [['delta', 2]],
    );
    replica.receiveEvents();
    checks.equal('delta updates replica hp', replicatedHealth(), 42);

    hub.dropPeer(2);
    replica.receiveEvents();
    checks.equal(
      'transport drop starts recovery',
      replica.getRecoverySnapshot().state.kind,
      'recovering',
    );
    checks.equal('connector invoked once', connects, 1);
    await flushMicrotasks();
    const resync = replica.getRecoverySnapshot();
    checks.equal(
      'replacement endpoint moves the replica to resyncing',
      resync.state.kind,
      'resyncing',
    );
    checks.equal('resync epoch is previous + 1', resync.epoch, 1);
    checks.ok(
      'SessionId survives reconnect',
      resync.sessionId === sessionId,
      `sessionId=${resync.sessionId}`,
    );

    replica.receiveEvents();
    authority.receiveEvents();
    mark = hub.sent.length;
    checks.ok('publish after reconnect succeeds', authority.publish().ok);
    const fresh = packetsSince(hub, mark, profile);
    checks.ok(
      'authority sends a fresh baseline to the reconnected peer',
      fresh.some((p) => p.peerId === 3 && p.kind === 'baseline' && p.sequence === 1),
      JSON.stringify(fresh),
    );
    checks.ok(
      'no packet targets the dropped peer',
      fresh.every((p) => p.peerId !== 2),
    );
    replica.receiveEvents();
    replica.receiveEvents();
    checks.equal(
      'fresh baseline makes the replica active again',
      replica.getRecoverySnapshot().state.kind,
      'active',
    );
    checks.equal('replica state converges after resync', replicatedHealth(), 42);

    replica.dispose();
    authority.dispose();
    checks.equal(
      'dispose retires the replica',
      replica.getRecoverySnapshot().state.kind,
      'retired',
    );
    checks.equal(
      'retired session owns no ledgers',
      replica.getRecoverySnapshot().ownedResources.ledgers,
      0,
    );
  },
});
