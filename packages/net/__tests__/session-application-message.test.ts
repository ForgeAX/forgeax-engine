import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import type { PeerId } from '../src/endpoint/endpoint';
import { AuthorityCoordinator } from '../src/replication/authority';
import { decodeReplicationPacket, encodeReplicationPacket } from '../src/replication/codec';
import { defineReplication, type ReplicationLimits } from '../src/replication/profile';
import { createReplicaCoordinator } from '../src/replication/replica';
import { NetSession } from '../src/session/net-session';
import { createSessionId } from '../src/session/recovery';

const ApplicationState = defineComponent('SessionApplicationState', { enabled: 'bool' });

function connectedSessions(options: { activate?: boolean; maxRawMessages?: number; limits?: Partial<ReplicationLimits> } = {}) {
  const profile = defineReplication({
    name: 'session-application',
    entities: { with: [ApplicationState] },
    components: [ApplicationState],
    limits: options.limits,
  }).unwrap();
  const world = new World();
  world.spawn({ component: ApplicationState, data: { enabled: true } }).unwrap();
  const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
  const authority = new NetSession({ endpoint: authorityEndpoint, maxRawMessages: options.maxRawMessages ?? 8 });
  const replica = new NetSession({ endpoint: replicaEndpoint, sessionId: 7, maxRawMessages: options.maxRawMessages ?? 8 });
  authority.attachAuthority(new AuthorityCoordinator(world, profile));
  replica.attachReplica(createReplicaCoordinator(new World(), profile), profile.limits);
  expect(authority.receiveEvents()).toEqual([]);
  expect(replica.receiveEvents()).toEqual([]);
  expect(authority.receiveEvents()).toEqual([]);
  if (options.activate !== false) {
    authority.publish().unwrap();
    expect(replica.receiveEvents()).toEqual([]);
    expect(replica.getRecoverySnapshot().state.kind).toBe('active');
    expect(authority.receiveEvents()).toEqual([]);
  }
  const sessionId = replica.getRecoverySnapshot().sessionId;
  return { authority, replica, sessionId, authorityEndpoint, replicaEndpoint, limits: profile.limits };
}

describe('application messages on a replicated logical session', () => {
  it('never exposes replica data packets as authority application messages', () => {
    const { authority, replica, replicaEndpoint, limits } = connectedSessions({ activate: false });
    try {
      for (const kind of ['baseline', 'delta']) {
        authority.publish().unwrap();
        const event = replicaEndpoint.poll().find((event) => event.kind === 'message');
        if (event?.kind !== 'message') throw new Error('Expected the real published packet');
        const packet = decodeReplicationPacket(event.data, limits).unwrap();
        expect(packet.kind).toBe(kind);
        if (packet.kind === 'baseline') expect(packet.entities).not.toHaveLength(0);
        // Re-send a valid Engine packet from the replica side before baseline ACK.
        replicaEndpoint.send(1 as PeerId, event.data).unwrap();
        expect(authority.receiveEvents()).toEqual([
          expect.objectContaining({ code: 'recovery-rejected' }),
        ]);
        expect(authority.drainRawMessages()).toEqual([]);
      }
    } finally { replica.dispose(); authority.dispose(); }
  });

  it('delivers opaque application bytes in both directions after the accepted baseline', () => {
    const { authority, replica, sessionId, limits } = connectedSessions();
    try {
      const nestedControl = encodeReplicationPacket({ version: 2, kind: 'session-open',
        sessionId: createSessionId(999).unwrap(), epoch: 0, sequence: 0 }, limits).unwrap();
      for (const data of [new Uint8Array([0, 7, 255]), new TextEncoder().encode('FXRP2\nnot a packet'), nestedControl]) {
        authority.sendToSession(sessionId, data).unwrap();
        expect(replica.receiveEvents()).toEqual([]);
        expect(replica.drainRawMessages()).toEqual([
          expect.objectContaining({ sessionId, data }),
        ]);
        expect(replica.getRecoverySnapshot().state.kind).toBe('active');
        replica.sendToAuthority(sessionId, data).unwrap();
        expect(authority.receiveEvents()).toEqual([]);
        expect(authority.drainRawMessages()).toEqual([
          expect.objectContaining({ sessionId, data }),
        ]);
      }
      expect(authority.getReplicationSnapshot()[0]?.pendingPackets).toBe(0);
      expect(authority.getSessionSnapshot().sessionIds).toEqual([sessionId]);
      expect(replica.getSessionSnapshot().sessionIds).toEqual([sessionId]);
    } finally {
      replica.dispose();
      authority.dispose();
    }
  });

  it('admits sends only after baseline acceptance and the authority ACK', () => {
    const { authority, replica, sessionId } = connectedSessions({ activate: false });
    try {
      const data = new Uint8Array([7]);
      expect(replica.sendToAuthority(sessionId, data).ok).toBe(false);
      expect(authority.sendToSession(sessionId, data).ok).toBe(false);
      authority.publish().unwrap();
      expect(authority.sendToSession(sessionId, data).ok).toBe(false);
      expect(replica.receiveEvents()).toEqual([]);
      expect(authority.sendToSession(sessionId, data).ok).toBe(false);
      expect(authority.receiveEvents()).toEqual([]);
      expect(replica.sendToAuthority(sessionId, data).ok).toBe(true);
      expect(authority.sendToSession(sessionId, data).ok).toBe(true);
      expect(replica.sendToAuthority(createSessionId(99).unwrap(), data).ok).toBe(false);
    } finally { replica.dispose(); authority.dispose(); }
  });

  it('rejects foreign sessions and old epochs without retiring the accepted stream', () => {
    const { authority, replica, sessionId, authorityEndpoint, replicaEndpoint, limits } = connectedSessions();
    try {
      const oldEpoch = replica.getRecoverySnapshot().epoch;
      authority.requestFullBaselineForSession(sessionId);
      authority.publish().unwrap();
      expect(replica.receiveEvents()).toEqual([]);
      expect(authority.receiveEvents()).toEqual([]);
      const epoch = replica.getRecoverySnapshot().epoch;
      expect(epoch).toBeGreaterThan(oldEpoch);
      for (const fields of [{ sessionId: createSessionId(99).unwrap(), epoch }, { sessionId, epoch: oldEpoch }]) {
        const bytes = encodeReplicationPacket({ version: 2, kind: 'application', payload: [1], ...fields }, limits).unwrap();
        authorityEndpoint.send(2 as PeerId, bytes).unwrap();
        replicaEndpoint.send(1 as PeerId, bytes).unwrap();
        expect(replica.receiveEvents()).toEqual([expect.objectContaining({ code: 'recovery-rejected' })]);
        expect(authority.receiveEvents()).toEqual([expect.objectContaining({ code: 'recovery-rejected' })]);
        expect(replica.drainRawMessages()).toEqual([]);
        expect(authority.drainRawMessages()).toEqual([]);
        expect(replica.getRecoverySnapshot().state.kind).toBe('active');
      }
      expect(authority.getReplicationSnapshot()[0]?.pendingPackets).toBe(0);
      authority.sendToSession(sessionId, new Uint8Array([9])).unwrap();
      expect(replica.receiveEvents()).toEqual([]);
      expect(replica.drainRawMessages()[0]?.data).toEqual(new Uint8Array([9]));
    } finally { replica.dispose(); authority.dispose(); }
  });

  it('keeps application payloads bounded and snapshots caller bytes', () => {
    const { authority, replica, sessionId, limits } = connectedSessions({ maxRawMessages: 2,
      limits: { maxBufferBytes: 8, maxArrayElements: 8 } });
    try {
      const data = new Uint8Array([7]);
      for (let i = 0; i < 3; i++) authority.sendToSession(sessionId, data).unwrap();
      data[0] = 9;
      expect(replica.receiveEvents()).toEqual([]);
      expect(replica.drainRawMessages().map(message => [...message.data])).toEqual([[7], [7]]);
      expect(replica.drainRawMessages()).toEqual([]);
      expect(authority.sendToSession(sessionId, new Uint8Array(9)).ok).toBe(false);
      expect(replica.sendToAuthority(sessionId, new Uint8Array(9)).ok).toBe(false);
      const packet = { version: 2, kind: 'application', sessionId, epoch: 0, payload: [1] } as const;
      const bytes = encodeReplicationPacket(packet, limits).unwrap();
      const short = { ...limits, maxMessageBytes: bytes.byteLength - 1 };
      expect(encodeReplicationPacket(packet, short).ok).toBe(false);
      expect(decodeReplicationPacket(bytes, short).ok).toBe(false);
      for (const payload of [[-1], [256], [0.5], ['7'], null]) {
        const wire = new TextEncoder().encode(`FXRP2\n${JSON.stringify({ ...packet, payload })}`);
        expect(decodeReplicationPacket(wire, limits).ok).toBe(false);
      }
    } finally { replica.dispose(); authority.dispose(); }
  });

  it('does not deliver malformed replication wire as authority application data', () => {
    const { authority, replica, replicaEndpoint, sessionId } = connectedSessions();
    try {
      replicaEndpoint.send(1 as PeerId, new TextEncoder().encode('FXRP2\nnot a packet')).unwrap();
      expect(authority.receiveEvents()).toEqual([expect.objectContaining({ code: 'decode-invalid-payload' })]);
      expect(authority.drainRawMessages()).toEqual([]);
      authority.sendToSession(sessionId, new Uint8Array([7])).unwrap();
      expect(replica.receiveEvents()).toEqual([]);
      expect(replica.drainRawMessages()).toHaveLength(1);
    } finally { replica.dispose(); authority.dispose(); }
  });

  it('drops queued application bytes on recovery and never enters the replication retry ledger', () => {
    const { authority, replica, sessionId } = connectedSessions();
    try {
      authority.sendToSession(sessionId, new Uint8Array([7])).unwrap();
      expect(replica.receiveEvents()).toEqual([]);
      expect(authority.getReplicationSnapshot()[0]?.pendingPackets).toBe(0);
      replica.recover();
      expect(replica.drainRawMessages()).toEqual([]);
      expect(replica.sendToAuthority(sessionId, new Uint8Array([7])).ok).toBe(false);
      expect(replica.getRecoverySnapshot().ownedResources.ledgers).toBe(0);
    } finally { replica.dispose(); authority.dispose(); }
  });

  it('discards queued application bytes when a newer baseline replaces their epoch', () => {
    const { authority, replica, sessionId } = connectedSessions();
    try {
      authority.sendToSession(sessionId, new Uint8Array([1])).unwrap();
      replica.sendToAuthority(sessionId, new Uint8Array([2])).unwrap();
      expect(replica.receiveEvents()).toEqual([]);
      expect(authority.receiveEvents()).toEqual([]);
      authority.requestFullBaselineForSession(sessionId);
      authority.publish().unwrap();
      expect(replica.receiveEvents()).toEqual([]);
      expect(authority.receiveEvents()).toEqual([]);
      expect(authority.drainRawMessages()).toEqual([]);
      expect(replica.drainRawMessages()).toEqual([]);
    } finally { replica.dispose(); authority.dispose(); }
  });

  it('retires queued application bytes with a disconnected authority peer', () => {
    const { authority, replica, sessionId } = connectedSessions();
    try {
      replica.sendToAuthority(sessionId, new Uint8Array([2])).unwrap();
      expect(authority.receiveEvents()).toEqual([]);
      replica.dispose();
      expect(authority.receiveEvents()).toEqual([]);
      expect(authority.drainRawMessages()).toEqual([]);
    } finally { replica.dispose(); authority.dispose(); }
  });
});
