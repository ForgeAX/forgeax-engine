import { describe, expect, it, vi } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { createAuthorityCoordinator } from '../src/replication/authority';
import * as codec from '../src/replication/codec';
import { createReplicaCoordinator } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';
import { NetSession } from '../src/session/net-session';
import { createSessionId } from '../src/session/recovery';

const NetworkedSession = defineComponent('NetworkedSession', { enabled: 'bool' });
const PositionSession = defineComponent('PositionSession', { x: 'f32' });

function profile() {
  const result = defineReplication({
    name: 'session-replication',
    entities: { with: [NetworkedSession] },
    components: [NetworkedSession, PositionSession],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('NetSession replication integration', () => {
  it('waits for a delayed logical resume before sending the first replacement baseline', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const replication = profile();
    const session = new NetSession({ endpoint: authorityEndpoint, maxRawMessages: 8 });
    session.attachAuthority(createAuthorityCoordinator(new World(), replication));
    try {
      session.receiveEvents();
      replicaEndpoint.poll();
      expect(session.publish().ok).toBe(true);
      expect(replicaEndpoint.poll()).toEqual([]);
      expect(session.getRecoverySnapshot().pendingPackets).toBe(0);
      const resume = codec.encodeReplicationPacket({
        version: 2, kind: 'session-resume', sessionId: createSessionId(42).unwrap(), epoch: 7, sequence: 0,
      }, replication.limits).unwrap();
      expect(replicaEndpoint.send(1 as PeerId, resume).ok).toBe(true);
      expect(session.receiveEvents()).toEqual([]);
      expect(session.publish().ok).toBe(true);
      const packets = replicaEndpoint.poll();
      expect(packets).toHaveLength(1);
      const message = packets[0];
      if (message?.kind !== 'message') throw new Error('missing announced baseline');
      expect(codec.decodeReplicationPacket(message.data, replication.limits).unwrap()).toMatchObject({
        kind: 'baseline', epoch: 7, sequence: 1,
      });
    } finally {
      session.dispose();
      replicaEndpoint.close();
    }
  });

  it('waits for a delayed resume announcement before publishing the first replacement baseline', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authorityWorld = new World();
    authorityWorld.spawn(
      { component: NetworkedSession, data: { enabled: true } },
      { component: PositionSession, data: { x: 7 } },
    ).unwrap();
    const replication = profile();
    const authoritySession = new NetSession({ endpoint: authorityEndpoint });
    authoritySession.attachAuthority(createAuthorityCoordinator(authorityWorld, replication));
    try {
      authoritySession.receiveEvents();
      const connected = replicaEndpoint.poll().find((event) => event.kind === 'peer-connected');
      if (connected?.kind !== 'peer-connected') throw new Error('missing authority peer');
      // A real socket can open before its client's session-resume message arrives.
      // Transport identity must not reserve a provisional epoch-zero publication.
      for (let frame = 0; frame < 3; frame++) {
        expect(authoritySession.publish().ok).toBe(true);
        expect(replicaEndpoint.poll().filter((event) => event.kind === 'message')).toEqual([]);
        expect(authoritySession.getRecoverySnapshot().pendingPackets).toBe(0);
      }
      const resume = codec.encodeReplicationPacket({
        version: 2, kind: 'session-resume', sessionId: createSessionId(17).unwrap(), epoch: 1, sequence: 0,
      }, replication.limits).unwrap();
      replicaEndpoint.send(connected.peerId, resume).unwrap();
      expect(authoritySession.receiveEvents()).toEqual([]);
      expect(authoritySession.publish().ok).toBe(true);
      const first = replicaEndpoint.poll().find((event) => event.kind === 'message');
      if (first?.kind !== 'message') throw new Error('missing resumed baseline');
      expect(codec.decodeReplicationPacket(first.data, replication.limits).unwrap()).toMatchObject({
        kind: 'baseline', sessionId: 17, epoch: 1, sequence: 1,
      });
    } finally {
      authoritySession.dispose();
      replicaEndpoint.close();
    }
  });

  it('does not reserve an authority publication before the first peer connects', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authorityWorld = new World();
    authorityWorld.spawn(
      { component: NetworkedSession, data: { enabled: true } },
      { component: PositionSession, data: { x: 7 } },
    );
    const replication = profile();
    const authoritySession = new NetSession({ endpoint: authorityEndpoint, maxRawMessages: 8 });
    authoritySession.attachAuthority(createAuthorityCoordinator(authorityWorld, replication));

    expect(authoritySession.publish().ok).toBe(true);
    expect(authoritySession.getRecoverySnapshot().pendingPackets).toBe(0);

    const replicaSession = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    const replica = createReplicaCoordinator(new World(), replication);
    replicaSession.attachReplica(replica, replication.limits);
    authoritySession.receiveEvents();
    replicaSession.receiveEvents();
    authoritySession.receiveEvents(); // Adopt the replica's logical announcement.
    expect(authoritySession.getPeerSnapshot().connected).toBe(true);

    expect(authoritySession.publish().ok).toBe(true);
    expect(replicaSession.receiveEvents()).toEqual([]);
    expect(replica.snapshot()).toEqual([
      { id: 1, components: ['NetworkedSession', 'PositionSession'] },
    ]);
  });

  it('tracks actual peers, publishes canonical bytes, and applies them through a replica attachment', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authorityWorld = new World();
    authorityWorld.spawn(
      { component: NetworkedSession, data: { enabled: true } },
      { component: PositionSession, data: { x: 7 } },
    );
    const replicaWorld = new World();
    const authoritySession = new NetSession({ endpoint: authorityEndpoint, maxRawMessages: 8 });
    const replicaSession = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    const replication = profile();
    const replica = createReplicaCoordinator(replicaWorld, replication);

    authoritySession.receiveEvents();
    replicaSession.receiveEvents();
    expect(authoritySession.getPeerSnapshot()).toEqual({ connected: true, peerIds: [2] });
    authoritySession.attachAuthority(createAuthorityCoordinator(authorityWorld, replication));
    replicaSession.attachReplica(replica, replication.limits);
    authoritySession.receiveEvents();

    expect(authoritySession.publish().ok).toBe(true);
    expect(replicaSession.receiveEvents()).toEqual([]);
    expect(replica.snapshot()).toEqual([
      { id: 1, components: ['NetworkedSession', 'PositionSession'] },
    ]);
    expect(replicaSession.drainRawMessages()).toEqual([]);
    expect(authoritySession.receiveEvents()).toEqual([]);
    expect(authoritySession.getRecoverySnapshot().pendingPackets).toBe(0);
  });

  it('decodes each received data packet once while preserving duplicate ACKs and ordered deltas', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authorityWorld = new World();
    const entity = authorityWorld.spawn(
      { component: NetworkedSession, data: { enabled: true } },
      { component: PositionSession, data: { x: 7 } },
    ).unwrap();
    const replicaWorld = new World();
    const replication = profile();
    const authority = createAuthorityCoordinator(authorityWorld, replication);
    const session = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    const replica = createReplicaCoordinator(replicaWorld, replication);
    session.attachReplica(replica, replication.limits);
    const remotePeer = authorityEndpoint.poll().find((event) => event.kind === 'peer-connected');
    if (remotePeer?.kind !== 'peer-connected') throw new Error('missing connected peer');
    session.receiveEvents();
    authorityEndpoint.poll(); // Drain the session announcement before inspecting ACKs.

    const baseline = authority.publish().unwrap();
    const encoded = codec.encodeReplicationPacket(baseline, replication.limits).unwrap();
    const decode = vi.spyOn(codec, 'decodeReplicationPacket');
    try {
      for (const expectedOutcome of ['accepted', 'duplicate']) {
        expect(authorityEndpoint.send(remotePeer.peerId, encoded).ok).toBe(true);
        expect(session.receiveEvents()).toEqual([]);
        expect(replica.lastPacketOutcome).toBe(expectedOutcome);
        const acknowledgements = authorityEndpoint.poll().filter((event) => event.kind === 'message');
        expect(acknowledgements).toHaveLength(1);
        const acknowledgement = acknowledgements[0];
        if (acknowledgement?.kind !== 'message') throw new Error('missing ACK');
        expect(codec.decodeReplicationPacket(acknowledgement.data, replication.limits).unwrap())
          .toMatchObject({ kind: 'ack', epoch: baseline.epoch, acknowledgedSequence: 1 });
      }
      expect(replica.snapshot()).toHaveLength(1);
      expect(session.getRecoverySnapshot().state).toMatchObject({ kind: 'active', sequence: 1 });
      expect(decode).toHaveBeenCalledTimes(4); // Two received packets and two ACK inspections.
      decode.mockClear();

      authorityWorld.set(entity, PositionSession, { x: 11 }).unwrap();
      const delta = authority.publish().unwrap();
      expect(authorityEndpoint.send(
        remotePeer.peerId,
        codec.encodeReplicationPacket(delta, replication.limits).unwrap(),
      ).ok).toBe(true);
      expect(session.receiveEvents()).toEqual([]);
      expect(decode).toHaveBeenCalledTimes(1);
      expect(session.getRecoverySnapshot().state).toMatchObject({ kind: 'active', sequence: 2 });
      const replicatedEntity = replica.entityFor(authority.idFor(entity));
      if (replicatedEntity === undefined) throw new Error('missing replica entity');
      expect(replicaWorld.get(replicatedEntity, PositionSession).unwrap().x).toBe(11);
    } finally {
      decode.mockRestore();
      session.dispose();
    }
  });

  it.each(['maxMessageBytes', 'maxEntities'] as const)(
    'enforces attached %s before applying the decoded packet',
    (limit) => {
      const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
      const authorityWorld = new World();
      for (let i = 0; i < 2; i++)
        authorityWorld.spawn({ component: NetworkedSession, data: { enabled: true } }).unwrap();
      const replication = profile();
      const baseline = createAuthorityCoordinator(authorityWorld, replication).publish().unwrap();
      const encoded = codec.encodeReplicationPacket(baseline, replication.limits).unwrap();
      const replica = createReplicaCoordinator(new World(), replication);
      const session = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
      session.attachReplica(replica, {
        ...replication.limits,
        [limit]: limit === 'maxMessageBytes' ? encoded.byteLength - 1 : 1,
      });
      const peer = authorityEndpoint.poll().find((event) => event.kind === 'peer-connected');
      if (peer?.kind !== 'peer-connected') throw new Error('missing connected peer');
      session.receiveEvents();
      authorityEndpoint.poll();
      try {
        expect(authorityEndpoint.send(peer.peerId, encoded).ok).toBe(true);
        expect(session.receiveEvents()).toMatchObject([
          { code: 'decode-limit-exceeded', detail: { limit } },
        ]);
        expect(replica.snapshot()).toEqual([]);
        expect(session.getRecoverySnapshot().state.kind).toBe('failed');
        expect(authorityEndpoint.poll()).not.toContainEqual(expect.objectContaining({ kind: 'message' }));
      } finally {
        session.dispose();
      }
    },
  );

  it('publishes a full current baseline when a later session peer connects', () => {
    const [initialAuthorityEndpoint, initialReplicaEndpoint] = createMemoryEndpointPair();
    const authorityWorld = new World();
    authorityWorld.spawn(
      { component: NetworkedSession, data: { enabled: true } },
      { component: PositionSession, data: { x: 7 } },
    );
    const replication = profile();
    const authority = createAuthorityCoordinator(authorityWorld, replication);
    const initialAuthoritySession = new NetSession({
      endpoint: initialAuthorityEndpoint,
      maxRawMessages: 8,
    });
    const initialReplicaSession = new NetSession({
      endpoint: initialReplicaEndpoint,
      maxRawMessages: 8,
    });
    const initialReplica = createReplicaCoordinator(new World(), replication);
    initialAuthoritySession.attachAuthority(authority);
    initialReplicaSession.attachReplica(initialReplica, replication.limits);
    initialAuthoritySession.receiveEvents();
    initialReplicaSession.receiveEvents();
    initialAuthoritySession.receiveEvents();

    expect(initialAuthoritySession.publish().ok).toBe(true);
    expect(initialReplicaSession.receiveEvents()).toEqual([]);
    expect(initialReplica.snapshot()).toEqual([
      { id: 1, components: ['NetworkedSession', 'PositionSession'] },
    ]);

    const [lateAuthorityEndpoint, lateReplicaEndpoint] = createMemoryEndpointPair();
    const lateAuthoritySession = new NetSession({ endpoint: lateAuthorityEndpoint, maxRawMessages: 8 });
    const lateReplicaSession = new NetSession({ endpoint: lateReplicaEndpoint, maxRawMessages: 8 });
    const lateReplica = createReplicaCoordinator(new World(), replication);
    lateAuthoritySession.attachAuthority(authority);
    lateReplicaSession.attachReplica(lateReplica, replication.limits);
    lateAuthoritySession.receiveEvents();
    lateReplicaSession.receiveEvents();
    lateAuthoritySession.receiveEvents();
    const latePeer = lateAuthoritySession.getPeerSnapshot().peerIds[0];
    expect(latePeer).toBeDefined();
    if (latePeer === undefined) return;
    lateAuthoritySession.requestFullBaseline(latePeer);

    expect(lateAuthoritySession.publish().ok).toBe(true);
    expect(lateReplicaSession.receiveEvents()).toEqual([]);
    expect(lateReplicaSession.getRecoverySnapshot()).toMatchObject({
      state: { kind: 'active', epoch: 1, sequence: 1 },
      epoch: 1,
      sequence: 1,
    });
    expect(lateReplica.snapshot()).toEqual(initialReplica.snapshot());
    expect(lateAuthoritySession.receiveEvents()).toEqual([]);
    expect(lateAuthoritySession.getRecoverySnapshot().pendingPackets).toBe(0);
  });

  it('disconnects a sender when attached replica decoding rejects malformed bytes', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: replicaEndpoint, maxRawMessages: 8 });
    const replication = profile();
    session.attachReplica(createReplicaCoordinator(new World(), replication), replication.limits);
    authorityEndpoint.poll();
    session.receiveEvents();
    authorityEndpoint.poll();

    authorityEndpoint.send(2 as never, new Uint8Array([0xff]));
    const errors = session.receiveEvents();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('decode-invalid-payload');
    expect(authorityEndpoint.poll()).toContainEqual({ kind: 'peer-disconnected', peerId: 2 });
  });
});
