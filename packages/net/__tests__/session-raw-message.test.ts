import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import type { PeerId } from '../src/endpoint/endpoint';
import { AuthorityCoordinator } from '../src/replication/authority';
import { createReplicaCoordinator } from '../src/replication/replica';
import { defineReplication } from '../src/replication/profile';
import { NetSession } from '../src/session/net-session';

const NetworkedSessionRaw = defineComponent('NetworkedSessionRaw', { enabled: 'bool' });

function sessionRawProfile() {
  const result = defineReplication({
    name: 'session-raw-message',
    entities: { with: [NetworkedSessionRaw] },
    components: [NetworkedSessionRaw],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

// ---------------------------------------------------------------------------
// TDD phase: raw message boundary tests.
// Memory pair: epA = peerId 1, epB = peerId 2.
// ---------------------------------------------------------------------------

describe('Session raw message bounds', () => {
  it('drainRawMessages returns empty array when no messages', () => {
    const [epA] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    const raw = session.drainRawMessages();
    expect(raw).toHaveLength(0);
  });

  it('drainRawMessages clears buffer after drain (bounded)', () => {
    const [epA, epB] = createMemoryEndpointPair();
    const sessionA = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    sessionA.receiveEvents();

    // Send two messages from B to A
    epB.send(1 as PeerId, new Uint8Array([1]));
    epB.send(1 as PeerId, new Uint8Array([2]));

    sessionA.receiveEvents();
    const first = sessionA.drainRawMessages();
    expect(first).toHaveLength(2);

    const second = sessionA.drainRawMessages();
    expect(second).toHaveLength(0);
  });

  it('respects max raw message bound', () => {
    const [epA, epB] = createMemoryEndpointPair();
    const sessionA = new NetSession({ endpoint: epA, maxRawMessages: 2 });

    sessionA.receiveEvents();

    for (let i = 0; i < 5; i++) {
      epB.send(1 as PeerId, new Uint8Array([i]));
    }

    sessionA.receiveEvents();
    const raw = sessionA.drainRawMessages();
    expect(raw).toHaveLength(2);
  });

  it('sender identity is endpoint-originated (not forged)', () => {
    const [epA, epB] = createMemoryEndpointPair();
    const sessionA = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    sessionA.receiveEvents();

    epB.send(1 as PeerId, new Uint8Array([77]));

    sessionA.receiveEvents();
    const raw = sessionA.drainRawMessages();
    expect(raw).toHaveLength(1);
    // B's peerId from A's perspective is 2
    expect(raw[0]!.peerId).toBe(2 as PeerId);
    expect(raw[0]!.sessionId).toBe(2);
  });

  it('routes a replica write through its logical SessionId', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authority = new NetSession({ endpoint: authorityEndpoint, maxRawMessages: 256 });
    const replica = new NetSession({ endpoint: replicaEndpoint, sessionId: 7, maxRawMessages: 256 });
    const replication = sessionRawProfile();
    const world = new World();
    world.spawn({ component: NetworkedSessionRaw, data: { enabled: true } }).unwrap();
    authority.attachAuthority(new AuthorityCoordinator(world, replication));
    replica.attachReplica(createReplicaCoordinator(new World(), replication), replication.limits);
    authority.receiveEvents();
    replica.receiveEvents();
    authority.receiveEvents();
    authority.publish().unwrap();
    replica.receiveEvents();
    authority.receiveEvents();

    const sent = replica.sendToAuthority(
      replica.getRecoverySnapshot().sessionId,
      new Uint8Array([7]),
    );
    expect(sent.ok).toBe(true);
    expect(authority.receiveEvents()).toEqual([]);
    const raw = authority.drainRawMessages();
    expect(raw).toEqual([
      expect.objectContaining({ peerId: 2 as PeerId, sessionId: 7, data: new Uint8Array([7]) }),
    ]);
    replica.dispose();
    authority.dispose();
  });

  it('routes an authority write through the mapped logical SessionId', () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authority = new NetSession({ endpoint: authorityEndpoint, maxRawMessages: 256 });
    const replica = new NetSession({ endpoint: replicaEndpoint, sessionId: 8, maxRawMessages: 256 });
    const replication = sessionRawProfile();
    const world = new World();
    world.spawn({ component: NetworkedSessionRaw, data: { enabled: true } }).unwrap();
    authority.attachAuthority(new AuthorityCoordinator(world, replication));
    replica.attachReplica(createReplicaCoordinator(new World(), replication), replication.limits);
    authority.receiveEvents();
    replica.receiveEvents();
    authority.receiveEvents();
    authority.publish().unwrap();
    replica.receiveEvents();
    authority.receiveEvents();

    const sessionId = replica.getRecoverySnapshot().sessionId;
    expect(authority.getSessionSnapshot().sessionIds).toEqual([8]);
    expect(authority.sendToSession(sessionId, new Uint8Array([8])).ok).toBe(true);
    expect(replica.receiveEvents()).toEqual([]);
    expect(replica.drainRawMessages()).toEqual([
      expect.objectContaining({ sessionId, data: new Uint8Array([8]) }),
    ]);
    replica.dispose();
    authority.dispose();
  });

  it('sendRaw to wrong peer returns error', () => {
    const [epA] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    const result = epA.send(999 as PeerId, new Uint8Array([1]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('peer-not-found');
    }
  });

  it('close endpoint prevents further send', () => {
    const [epA] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    session.receiveEvents();

    const closeResult = epA.close();
    expect(closeResult.ok).toBe(true);

    const sendResult = epA.send(2 as PeerId, new Uint8Array([1]));
    expect(sendResult.ok).toBe(false);
  });

  it('session does not expose concrete endpoint to game', () => {
    const [epA] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint: epA, maxRawMessages: 256 });

    expect((session as Record<string, unknown>).endpoint).toBeUndefined();
    expect(typeof session.sendRaw).toBe('function');
    expect(typeof session.drainRawMessages).toBe('function');
  });
});
