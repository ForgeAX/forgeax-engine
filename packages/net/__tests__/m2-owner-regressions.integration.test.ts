import { describe, expect, it, vi } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { err, ok } from '@forgeax/engine-types';
import type {
  EndpointEvent,
  NetEndpoint,
  NetEndpointConnector,
  PeerId,
} from '../src/endpoint/endpoint';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { EndpointError } from '../src/endpoint/errors';
import { createAuthorityCoordinator } from '../src/replication/authority';
import { decodeReplicationPacket, encodeReplicationPacket } from '../src/replication/codec';
import { createReplicaCoordinator } from '../src/replication/replica';
import type { ReplicationPacket } from '../src/replication/protocol';
import { defineReplication } from '../src/replication/profile';
import { NetSession } from '../src/session/net-session';
import { createSessionId } from '../src/session/recovery';

const NetworkedRegression = defineComponent('NetworkedRegression', { enabled: 'bool' });

function profile() {
  const result = defineReplication({
    name: 'm2-owner-regressions',
    entities: { with: [NetworkedRegression] },
    components: [NetworkedRegression],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function baseline(replication: ReturnType<typeof profile>, epoch: number): ReplicationPacket {
  return {
    version: 2,
    kind: 'baseline',
    sessionId: 1 as ReplicationPacket['sessionId'],
    epoch,
    sequence: 1,
    fingerprint: replication.fingerprint,
    tick: epoch,
    entities: [
      {
        id: 1,
        kind: 'upsert',
        components: [{ name: 'NetworkedRegression', data: { enabled: true } }],
      },
    ],
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function connectionFailure(): EndpointError {
  return new EndpointError({
    code: 'connection-failed',
    detail: { address: 'memory', cause: 'transient failure' },
  });
}

function connectionClosed(peerId: PeerId): EndpointError {
  return new EndpointError({
    code: 'connection-closed',
    detail: { peerId },
  });
}

function createMultiPeerEndpoint(): {
  readonly authority: NetEndpoint;
  readonly addPeer: (peerId: number) => NetEndpoint;
  readonly sentMessages: Array<{ readonly peerId: PeerId; readonly data: Uint8Array }>;
} {
  const authorityEvents: EndpointEvent[] = [];
  const peerInboxes = new Map<PeerId, EndpointEvent[]>();
  const sentMessages: Array<{ readonly peerId: PeerId; readonly data: Uint8Array }> = [];
  const authority: NetEndpoint = {
    poll: () => authorityEvents.splice(0),
    send: (peerId, data) => {
      const inbox = peerInboxes.get(peerId);
      if (inbox === undefined) return err(connectionFailure());
      sentMessages.push({ peerId, data });
      inbox.push({ kind: 'message', peerId: 1 as PeerId, data });
      return ok(undefined);
    },
    disconnect: peerId => {
      const inbox = peerInboxes.get(peerId);
      if (!inbox) return err(connectionFailure());
      peerInboxes.delete(peerId);
      inbox.push({kind:'peer-disconnected',peerId:1 as PeerId});
      authorityEvents.push({kind:'peer-disconnected',peerId});
      return ok(undefined);
    },
    close: () => ok(undefined),
  };
  const addPeer = (peerIdValue: number): NetEndpoint => {
    const peerId = peerIdValue as PeerId;
    const inbox: EndpointEvent[] = [{ kind: 'peer-connected', peerId: 1 as PeerId }];
    peerInboxes.set(peerId, inbox);
    authorityEvents.push({ kind: 'peer-connected', peerId });
    let closed = false;
    return {
      poll: () => (closed ? [] : inbox.splice(0)),
      send: (targetPeerId, data) => {
        if (closed || targetPeerId !== (1 as PeerId)) return err(connectionFailure());
        authorityEvents.push({ kind: 'message', peerId, data });
        return ok(undefined);
      },
      disconnect: target => {
        if (target !== (1 as PeerId)) return err(connectionFailure());
        return authority.disconnect(peerId);
      },
      close: () => {
        if (closed) return err(connectionFailure());
        closed = true;
        peerInboxes.delete(peerId);
        authorityEvents.push({ kind: 'peer-disconnected', peerId });
        return ok(undefined);
      },
    };
  };
  return { authority, addPeer, sentMessages };
}

function sentPackets(
  transport: ReturnType<typeof createMultiPeerEndpoint>,
  start: number,
  replication: ReturnType<typeof profile>,
) {
  return transport.sentMessages.slice(start).map((message) => ({
    peerId: message.peerId,
    packet: decodeReplicationPacket(message.data, replication.limits).unwrap(),
  }));
}

function sendAck(
  endpoint: NetEndpoint,
  replication: ReturnType<typeof profile>,
  epoch: number,
  sequence: number,
  sessionId = 2,
): void {
  const ack = encodeReplicationPacket(
    {
      version: 2,
      kind: 'ack',
      sessionId: sessionId as ReplicationPacket['sessionId'],
      epoch,
      acknowledgedSequence: sequence,
    },
    replication.limits,
  ).unwrap();
  endpoint.send(1 as PeerId, ack).unwrap();
}

function announceMemoryPeer(endpoint: NetEndpoint, session: NetSession, replication: ReturnType<typeof profile>): void {
  endpoint.send(1 as PeerId, encodeReplicationPacket({
    version: 2, kind: 'session-open', sessionId: createSessionId(2).unwrap(), epoch: 0, sequence: 0,
  }, replication.limits).unwrap()).unwrap();
  expect(session.receiveEvents()).toEqual([]);
}

describe('M2 confirmed owner regressions', () => {
  it('drops a peer that closes during publication without failing the authority session', () => {
    const replication = profile();
    const stalePeerId = 2 as PeerId;
    const livePeerId = 3 as PeerId;
    const events: EndpointEvent[] = [
      { kind: 'peer-connected', peerId: stalePeerId },
      { kind: 'peer-connected', peerId: livePeerId },
      ...[stalePeerId, livePeerId].map((peerId): EndpointEvent => ({
        kind: 'message', peerId, data: encodeReplicationPacket({
          version: 2, kind: 'session-open', sessionId: createSessionId(peerId).unwrap(), epoch: 0, sequence: 0,
        }, replication.limits).unwrap(),
      })),
    ];
    const sendAttempts: PeerId[] = [];
    const endpoint: NetEndpoint = {
      poll: () => events.splice(0),
      send: (targetPeerId) => {
        sendAttempts.push(targetPeerId);
        return targetPeerId === stalePeerId ? err(connectionClosed(targetPeerId)) : ok(undefined);
      },
      disconnect: () => ok(undefined),
      close: () => ok(undefined),
    };
    const world = new World();
    world.spawn({ component: NetworkedRegression, data: { enabled: true } });
    const session = new NetSession({ endpoint, maxRawMessages: 8 });
    session.attachAuthority(createAuthorityCoordinator(world, replication));
    session.receiveEvents();

    const published = session.publish();

    expect(published.ok).toBe(true);
    expect(sendAttempts).toEqual([stalePeerId, livePeerId]);
    expect(session.getPeerSnapshot()).toEqual({ peerIds: [livePeerId], connected: true });
    expect(session.getRecoverySnapshot().pendingPackets).toBe(1);
  });

  it('attempts a connector-only recovery while preserving SessionId', async () => {
    const [endpoint] = createMemoryEndpointPair();
    let calls = 0;
    const connector: NetEndpointConnector = {
      connect: () => {
        calls += 1;
        return Promise.resolve(ok(endpoint));
      },
    };
    const session = new NetSession({
      endpoint: undefined,
      connector,
      sessionId: 17,
      maxRawMessages: 8,
      recovery: { reconnectDelaysMs: [0, 0, 0, 0, 0] },
    });
    const sessionId = session.getRecoverySnapshot().sessionId;

    expect(session.getRecoverySnapshot().state.kind).toBe('connecting');
    expect(session.recover().kind).toBe('started');
    session.advanceRecovery();

    expect(calls).toBe(1);
    expect(session.getRecoverySnapshot().state.kind).toBe('recovering');
    await flushMicrotasks();
    expect(session.getRecoverySnapshot().state.kind).toBe('resyncing');
    expect(session.getRecoverySnapshot().sessionId).toBe(sessionId);
  });

  it('retries a transient connector failure and preserves the structured endpoint error', async () => {
    const [endpoint] = createMemoryEndpointPair();
    let calls = 0;
    const connector: NetEndpointConnector = {
      connect: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(err(connectionFailure()))
          : Promise.resolve(ok(endpoint));
      },
    };
    const session = new NetSession({
      connector,
      sessionId: 18,
      maxRawMessages: 8,
      recovery: { reconnectDelaysMs: [0, 0, 0, 0, 0] },
    });

    session.recover();
    session.advanceRecovery();
    await flushMicrotasks();

    expect(calls).toBe(2);
    expect(session.getRecoverySnapshot().state.kind).toBe('resyncing');
    expect(session.getRecoverySnapshot().lastError).toBeUndefined();
  });

  it('starts connector recovery immediately after an active peer disconnects', async () => {
    const [sender, receiver] = createMemoryEndpointPair();
    const [replacementSender, replacement] = createMemoryEndpointPair();
    let calls = 0;
    const connector: NetEndpointConnector = {
      connect: () => {
        calls += 1;
        return Promise.resolve(ok(replacement));
      },
    };
    const replication = profile();
    const replica = createReplicaCoordinator(new World(), replication);
    const session = new NetSession({
      endpoint: receiver,
      connector,
      maxRawMessages: 8,
      recovery: { reconnectDelaysMs: [0, 0, 0, 0, 0] },
    });
    session.attachReplica(replica, replication.limits);
    sender.poll();
    session.receiveEvents();

    sender.send(2 as PeerId, encodeReplicationPacket(baseline(replication, 1), replication.limits).unwrap()).unwrap();
    session.receiveEvents();
    expect(session.getRecoverySnapshot().state.kind).toBe('active');

    sender.close();
    session.receiveEvents();

    expect(session.getRecoverySnapshot().state.kind).toBe('recovering');
    expect(calls).toBe(1);
    await flushMicrotasks();
    expect(session.getRecoverySnapshot().state.kind).toBe('resyncing');

    replacementSender
      .send(2 as PeerId, encodeReplicationPacket(baseline(replication, 2), replication.limits).unwrap())
      .unwrap();
    // A replacement transport can queue its peer-connected and baseline events
    // before the next frame. The first poll must expose resyncing; the next
    // poll applies the fresh sequence-one baseline and becomes active.
    expect(session.receiveEvents()).toEqual([]);
    expect(session.getRecoverySnapshot().state.kind).toBe('resyncing');
    expect(session.receiveEvents()).toEqual([]);
    expect(session.getRecoverySnapshot().state.kind).toBe('active');
  });

  it('isolates the old endpoint when explicit recovery starts', () => {
    const [sender, receiver] = createMemoryEndpointPair();
    const replication = profile();
    const session = new NetSession({ endpoint: receiver, maxRawMessages: 8 });
    session.attachReplica(createReplicaCoordinator(new World(), replication), replication.limits);
    sender.poll();
    session.receiveEvents();

    sender
      .send(2 as PeerId, encodeReplicationPacket(baseline(replication, 1), replication.limits).unwrap())
      .unwrap();
    expect(session.receiveEvents()).toEqual([]);
    expect(session.getRecoverySnapshot().state.kind).toBe('active');

    expect(session.recover().kind).toBe('started');
    expect(session.getRecoverySnapshot().state.kind).toBe('recovering');
    expect(session.getPeerSnapshot()).toEqual({ peerIds: [], connected: false });
    expect(session.receiveEvents()).toEqual([]);
    expect(sender.poll()).toContainEqual({ kind: 'peer-disconnected', peerId: 2 });
  });

  it('reports an invalid numeric sessionId as a structured terminal failure', () => {
    const session = new NetSession({ endpoint: undefined, sessionId: 0, maxRawMessages: 8 });
    const snapshot = session.getRecoverySnapshot();

    expect(snapshot.state.kind).toBe('failed');
    expect(snapshot.lastError).toMatchObject({
      code: 'recovery-policy-invalid',
      detail: { field: 'sessionId' },
    });
  });

  it('consumes a legal ACK as a control packet without applying it as ECS data', () => {
    const replication = profile();
    const [sender, receiver] = createMemoryEndpointPair();
    const replica = createReplicaCoordinator(new World(), replication);
    const session = new NetSession({ endpoint: receiver, maxRawMessages: 8 });
    session.attachReplica(replica, replication.limits);
    sender.poll();
    session.receiveEvents();

    const baselineBytes = encodeReplicationPacket(baseline(replication, 1), replication.limits).unwrap();
    sender.send(2 as PeerId, baselineBytes).unwrap();
    expect(session.receiveEvents()).toEqual([]);
    expect(session.getRecoverySnapshot().state.kind).toBe('active');

    const ackBytes = encodeReplicationPacket(
      { version: 2, kind: 'ack', sessionId: 1 as ReplicationPacket['sessionId'], epoch: 1, acknowledgedSequence: 1 },
      replication.limits,
    ).unwrap();
    sender.send(2 as PeerId, ackBytes).unwrap();

    expect(session.receiveEvents()).toEqual([]);
    expect(session.getRecoverySnapshot().state.kind).toBe('active');
    expect(session.getRecoverySnapshot().acknowledgedSequence).toBe(1);
    expect(replica.snapshot()).toHaveLength(1);
  });

  it('retains published data until a cumulative ACK drains the session ledger', () => {
    const replication = profile();
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: authorityEndpoint, maxRawMessages: 8 });
    session.attachAuthority(createAuthorityCoordinator(new World(), replication));
    session.receiveEvents();
    replicaEndpoint.poll();
    announceMemoryPeer(replicaEndpoint, session, replication);

    expect(session.publish().ok).toBe(true);
    expect(session.getRecoverySnapshot().pendingPackets).toBe(1);

    const ackBytes = encodeReplicationPacket(
      { version: 2, kind: 'ack', sessionId: createSessionId(2).unwrap(), epoch: 0, acknowledgedSequence: 1 },
      replication.limits,
    ).unwrap();
    replicaEndpoint.send(1 as PeerId, ackBytes).unwrap();
    expect(session.receiveEvents()).toEqual([]);
    expect(session.getRecoverySnapshot().acknowledgedSequence).toBe(1);
    expect(session.getRecoverySnapshot().pendingPackets).toBe(0);
  });

  it('does not consume an authority sequence after a full ACK ledger rejection', () => {
    const replication = profile();
    const [authorityEndpoint, peerEndpoint] = createMemoryEndpointPair();
    const session = new NetSession({
      endpoint: authorityEndpoint,
      maxRawMessages: 8,
      recovery: { maxPendingPackets: 1 },
    });
    session.attachAuthority(createAuthorityCoordinator(new World(), replication));
    session.receiveEvents();
    announceMemoryPeer(peerEndpoint, session, replication);

    expect(session.publish().ok).toBe(true);
    expect(session.publish().ok).toBe(false);
    const firstMessage = peerEndpoint
      .poll()
      .find((event) => event.kind === 'message');
    expect(firstMessage?.kind).toBe('message');
    if (firstMessage?.kind !== 'message') return;
    const firstPacket = decodeReplicationPacket(firstMessage.data, replication.limits).unwrap();
    expect(firstPacket.sequence).toBe(1);

    const ack = encodeReplicationPacket(
      { version: 2, kind: 'ack', sessionId: createSessionId(2).unwrap(), epoch: 0, acknowledgedSequence: 1 },
      replication.limits,
    ).unwrap();
    peerEndpoint.send(1 as PeerId, ack).unwrap();
    expect(session.receiveEvents()).toEqual([]);

    expect(session.publish().ok).toBe(true);
    const secondMessage = peerEndpoint
      .poll()
      .find((event) => event.kind === 'message');
    expect(secondMessage?.kind).toBe('message');
    if (secondMessage?.kind !== 'message') return;
    const secondPacket = decodeReplicationPacket(secondMessage.data, replication.limits).unwrap();
    expect(secondPacket.sequence).toBe(2);
  });

  it('clears the old epoch ledger before applying the pending bound', () => {
    const replication = profile();
    const [authorityEndpoint, peerEndpoint] = createMemoryEndpointPair();
    const session = new NetSession({
      endpoint: authorityEndpoint,
      maxRawMessages: 8,
      recovery: { maxPendingPackets: 2 },
    });
    session.attachAuthority(createAuthorityCoordinator(new World(), replication));
    session.receiveEvents();
    announceMemoryPeer(peerEndpoint, session, replication);
    expect(session.publish().ok).toBe(true);
    expect(session.getRecoverySnapshot().pendingPackets).toBe(1);
    peerEndpoint.poll();

    const ack = encodeReplicationPacket(
      { version: 2, kind: 'ack', sessionId: createSessionId(2).unwrap(), epoch: 0, acknowledgedSequence: 1 },
      replication.limits,
    ).unwrap();
    peerEndpoint.send(1 as PeerId, ack).unwrap();
    expect(session.receiveEvents()).toEqual([]);
    expect(session.publish().ok).toBe(true);
    expect(session.getRecoverySnapshot().pendingPackets).toBe(1);
    peerEndpoint.poll();

    session.requestFullBaseline(2 as PeerId);
    expect(session.publish().ok).toBe(true);
    const packets = peerEndpoint
      .poll()
      .filter((event) => event.kind === 'message')
      .map((event) =>
        decodeReplicationPacket(event.data, replication.limits).unwrap(),
      );
    expect(packets.some((packet) => packet.kind === 'baseline' && packet.epoch === 1 && packet.sequence === 1)).toBe(true);
    expect(session.getRecoverySnapshot().pendingPackets).toBeLessThanOrEqual(2);
  });

  it('keeps late-join baselines and deltas independent for every active peer', () => {
    const replication = profile();
    const transport = createMultiPeerEndpoint();
    const authorityWorld = new World();
    authorityWorld.spawn({ component: NetworkedRegression, data: { enabled: true } });
    const authority = createAuthorityCoordinator(authorityWorld, replication);
    const authoritySession = new NetSession({ endpoint: transport.authority, maxRawMessages: 8 });
    authoritySession.attachAuthority(authority);

    const initialEndpoint = transport.addPeer(2);
    const initialReplicaSession = new NetSession({ endpoint: initialEndpoint, sessionId: 2, maxRawMessages: 8 });
    const initialReplica = createReplicaCoordinator(new World(), replication);
    initialReplicaSession.attachReplica(initialReplica, replication.limits);
    initialReplicaSession.receiveEvents();
    authoritySession.receiveEvents();
    const initialStart = transport.sentMessages.length;
    expect(authoritySession.publish().ok).toBe(true);
    const initialPackets = sentPackets(transport, initialStart, replication);
    expect(initialPackets.map(({ packet }) => [packet.kind, packet.epoch, packet.sequence])).toEqual([
      ['baseline', 0, 1],
    ]);
    expect(authoritySession.publish().ok).toBe(true);
    const initialDeltaPackets = sentPackets(transport, initialStart + initialPackets.length, replication);
    expect(initialDeltaPackets.map(({ packet }) => [packet.kind, packet.epoch, packet.sequence])).toEqual([
      ['delta', 0, 2],
    ]);
    expect(initialReplicaSession.receiveEvents()).toEqual([]);
    sendAck(initialEndpoint, replication, 0, 2);
    expect(authoritySession.receiveEvents()).toEqual([]);
    expect(authoritySession.getRecoverySnapshot().pendingPackets).toBe(0);

    const disconnectedEndpoint = transport.addPeer(3);
    disconnectedEndpoint.poll();
    disconnectedEndpoint.close();
    const lateEndpoint = transport.addPeer(4);
    const lateReplicaSession = new NetSession({ endpoint: lateEndpoint, sessionId: 4, maxRawMessages: 8 });
    const lateReplica = createReplicaCoordinator(new World(), replication);
    lateReplicaSession.attachReplica(lateReplica, replication.limits);
    lateReplicaSession.receiveEvents();
    authoritySession.receiveEvents();
    const freshStart = transport.sentMessages.length;
    expect(authoritySession.publish().ok).toBe(true);
    const freshPackets = sentPackets(transport, freshStart, replication);
    const initialFreshPackets = freshPackets.filter(({ peerId }) => peerId === (2 as PeerId));
    const lateFreshPackets = freshPackets.filter(({ peerId }) => peerId === (4 as PeerId));
    expect(freshPackets.every(({ peerId }) => peerId !== (3 as PeerId))).toBe(true);
    expect(initialFreshPackets.map(({ packet }) => [packet.kind, packet.epoch, packet.sequence])).toEqual([
      ['delta', 0, 3],
    ]);
    expect(lateFreshPackets.map(({ packet }) => [packet.kind, packet.epoch, packet.sequence])).toEqual([
      ['baseline', 0, 1],
    ]);
    const initialBaseline = initialFreshPackets[0]?.packet;
    const lateBaseline = lateFreshPackets[0]?.packet;
    expect(initialBaseline).toMatchObject({ kind: 'delta', entities: [] });
    expect(lateBaseline).toMatchObject({ kind: 'baseline', entities: [{ id: 1 }] });
    expect(initialReplicaSession.receiveEvents()).toEqual([]);
    expect(lateReplicaSession.receiveEvents()).toEqual([]);
    expect(initialReplica.snapshot()).toEqual(lateReplica.snapshot());

    const deltaStart = transport.sentMessages.length;
    expect(authoritySession.publish().ok).toBe(true);
    const deltaPackets = sentPackets(transport, deltaStart, replication);
    expect(deltaPackets.filter(({ peerId }) => peerId === (2 as PeerId)).map(({ packet }) => [packet.kind, packet.epoch, packet.sequence])).toEqual([
      ['delta', 0, 4],
    ]);
    expect(deltaPackets.filter(({ peerId }) => peerId === (4 as PeerId)).map(({ packet }) => [packet.kind, packet.epoch, packet.sequence])).toEqual([
      ['delta', 0, 2],
    ]);

    sendAck(initialEndpoint, replication, 0, 4);
    sendAck(lateEndpoint, replication, 0, 2, 4);
    expect(authoritySession.receiveEvents()).toEqual([]);
    expect(authoritySession.getRecoverySnapshot()).toMatchObject({
      epoch: 0,
      sequence: 2,
      acknowledgedSequence: 2,
      pendingPackets: 0,
      ownedResources: { ledgers: 0 },
    });
  });

  it('preserves accepted replica evidence until explicit disposal after terminal failure', () => {
    const replication = profile();
    const [sender, receiver] = createMemoryEndpointPair();
    const replica = createReplicaCoordinator(new World(), replication);
    const session = new NetSession({ endpoint: receiver, maxRawMessages: 8 });
    session.attachReplica(replica, replication.limits);
    sender.poll();
    session.receiveEvents();

    sender.send(2 as PeerId, encodeReplicationPacket(baseline(replication, 1), replication.limits).unwrap()).unwrap();
    expect(session.receiveEvents()).toEqual([]);
    expect(replica.snapshot()).toHaveLength(1);

    sender.send(2 as PeerId, new Uint8Array([0xff])).unwrap();
    const errors = session.receiveEvents();

    expect(errors[0]?.code).toBe('decode-invalid-payload');
    expect(session.getRecoverySnapshot().state.kind).toBe('failed');
    expect(replica.snapshot()).toHaveLength(1);
    session.dispose();
    expect(replica.snapshot()).toEqual([]);
  });

  it('does not regress session accepted state when a replica ignores an old epoch', () => {
    const replication = profile();
    const [sender, receiver] = createMemoryEndpointPair();
    const replica = createReplicaCoordinator(new World(), replication);
    const session = new NetSession({ endpoint: receiver, maxRawMessages: 8 });
    session.attachReplica(replica, replication.limits);
    const apply = vi.spyOn(replica, 'apply');
    sender.poll();
    session.receiveEvents();

    sender.send(2 as PeerId, encodeReplicationPacket(baseline(replication, 2), replication.limits).unwrap()).unwrap();
    expect(session.receiveEvents()).toEqual([]);
    const accepted = session.getRecoverySnapshot();

    sender.send(2 as PeerId, encodeReplicationPacket(baseline(replication, 1), replication.limits).unwrap()).unwrap();
    expect(session.receiveEvents()).toEqual([]);
    const current = session.getRecoverySnapshot();

    expect(apply.mock.results.at(-1)?.value.unwrap()).toBe('ignored-old-epoch');
    apply.mockRestore();
    expect(current.state.kind).toBe('active');
    expect(current.epoch).toBe(accepted.epoch);
    expect(current.sequence).toBe(accepted.sequence);
    expect(current.acknowledgedSequence).toBe(accepted.acknowledgedSequence);
  });
});
