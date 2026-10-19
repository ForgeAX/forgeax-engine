import { defineComponent, World, type EntityHandle } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ok } from '@forgeax/engine-types';
import { err } from '@forgeax/engine-types';
import {
  AuthorityCoordinator,
  EndpointError,
  ReplicaCoordinator,
  applyReplicationPacket,
  createMemoryEndpointPair,
  encodeReplicationPacket,
  defineReplication,
  NetSession,
  type NetEndpoint,
  type PeerId,
  type SessionId,
} from '../src';
const Tag = defineComponent('VisibilityTag', { enabled: 'bool' });
const Data = defineComponent('VisibilityData', { secret: 'string', value: 'f32' });
const Link = defineComponent('VisibilityLink', { target: 'entity', targets: 'array<entity>' });
const A = 11 as SessionId;
const B = 22 as SessionId;
function setup() {
  const world = new World();
  const profile = defineReplication({
    name: 'visibility',
    entities: { with: [Tag] },
    components: [Tag, Data, Link],
  }).unwrap();
  const spawn = (secret: string) =>
    world
      .spawn(
        { component: Tag, data: { enabled: true } },
        { component: Data, data: { secret, value: 1 } },
      )
      .unwrap();
  const first = spawn('only-A');
  const second = spawn('only-B');
  const authority = new AuthorityCoordinator(world, profile);
  const visible = new Map<SessionId, Set<EntityHandle>>([
    [A, new Set([first])],
    [B, new Set([second])],
  ]);
  const policy = (entity: EntityHandle, id: SessionId) => visible.get(id)?.has(entity) ?? false;
  return { world, profile, spawn, first, second, authority, visible, policy };
}
function sessions(f: ReturnType<typeof setup>, maxPendingPackets = 2) {
  const pairs = [createMemoryEndpointPair(), createMemoryEndpointPair()];
  const endpoint: NetEndpoint = {
    poll: () =>
      pairs.flatMap(([host], i) =>
        host.poll().map((event) => ({ ...event, peerId: (i + 2) as PeerId })),
      ),
    send: (id, data) => pairs[id - 2]![0].send(2 as PeerId, data),
    disconnect: id => pairs[id - 2]![0].disconnect(2 as PeerId),
    close: () => { for (const [endpoint] of pairs) endpoint.close(); return ok(undefined); },
  };
  const host = new NetSession({ endpoint, maxRawMessages: 8, recovery: { maxPendingPackets } });
  host.attachAuthority(f.authority, f.policy);
  const clients = pairs.map(([, endpoint], i) => {
    const replica = new ReplicaCoordinator(new World(), f.profile);
    const session = new NetSession({ endpoint, sessionId: i === 0 ? A : B, maxRawMessages: 8 });
    session.attachReplica(replica, f.profile.limits);
    return { replica, session, endpoint };
  });
  clients.forEach(({ session }) => session.receiveEvents());
  host.receiveEvents();
  return { host, clients };
}
describe('receiver-local replication visibility', () => {
  it('rejects application bytes carrying another live peer\'s logical identity', () => {
    const f = setup();
    const { host, clients } = sessions(f);
    try {
      host.publish().unwrap();
      clients.forEach(({ session }) => expect(session.receiveEvents()).toEqual([]));
      expect(host.receiveEvents()).toEqual([]);
      const before = host.getReplicationSnapshot();
      const forged = encodeReplicationPacket({ version: 2, kind: 'application',
        sessionId: A, epoch: before[0]!.epoch, payload: [1] }, f.profile.limits).unwrap();
      clients[1]!.endpoint.send(1 as PeerId, forged).unwrap();
      expect(host.receiveEvents()).toEqual([expect.objectContaining({ code: 'recovery-rejected' })]);
      expect(host.drainRawMessages()).toEqual([]);
      expect(host.getReplicationSnapshot()).toEqual(before);
      clients[1]!.session.sendToAuthority(B, new Uint8Array([2])).unwrap();
      expect(host.receiveEvents()).toEqual([]);
      expect(host.drainRawMessages()).toEqual([
        expect.objectContaining({ sessionId: B, peerId: 3, data: new Uint8Array([2]) }),
      ]);
    } finally {
      clients.forEach(({ session }) => session.dispose());
      host.dispose();
    }
  });

  it('never serializes hidden data and independently baselines two receivers', () => {
    const f = setup();
    const a = f.authority.publish(A, f.policy).unwrap();
    const b = f.authority.publish(B, f.policy).unwrap();
    expect(new TextDecoder().decode(a.bytes)).not.toContain('only-B');
    expect(new TextDecoder().decode(b.bytes)).not.toContain('only-A');
    expect(a).toMatchObject({ kind: 'baseline', sessionId: A, sequence: 1 });
    expect(b).toMatchObject({ kind: 'baseline', sessionId: B, sequence: 1 });
    expect(a.entities).toHaveLength(1);
    expect(b.entities).toHaveLength(1);
  });
  it('revokes, stays silent while hidden, and reveals complete current state with a fresh identity', () => {
    const f = setup();
    const replica = new ReplicaCoordinator(new World(), f.profile);
    applyReplicationPacket(replica, f.authority.publish(A, f.policy).unwrap()).unwrap();
    const oldId = f.authority.idFor(f.first, A);
    f.visible.get(A)!.clear();
    const revoke = f.authority.publish(A, f.policy).unwrap();
    expect(revoke.entities).toEqual([{ id: oldId, kind: 'despawn', components: [] }]);
    applyReplicationPacket(replica, revoke).unwrap();
    expect(replica.snapshot()).toEqual([]);
    f.world.set(f.first, Data, { secret: 'updated-hidden', value: 9 }).unwrap();
    const hidden = f.authority.publish(A, f.policy).unwrap();
    expect(hidden.entities).toEqual([]);
    applyReplicationPacket(replica, hidden).unwrap();
    f.visible.get(A)!.add(f.first);
    const reveal = f.authority.publish(A, f.policy).unwrap();
    applyReplicationPacket(replica, reveal).unwrap();
    const id = f.authority.idFor(f.first, A);
    expect(id).toBeGreaterThan(oldId);
    expect(replica.readComponent(id, Data)).toEqual({ secret: 'updated-hidden', value: 9 });
    expect(reveal.entities[0]!.components).toHaveLength(2);
  });
  it('clears hidden references and restores them with the target in the same packet', () => {
    const f = setup();
    f.world
      .addComponent(f.first, {
        component: Link,
        data: { target: f.second, targets: [f.second, f.first] },
      })
      .unwrap();
    const replica = new ReplicaCoordinator(new World(), f.profile);
    const baseline = f.authority.publish(A, f.policy).unwrap();
    expect(baseline.entities[0]!.components.find((c) => c.name === Link.name)!.data).toEqual({
      target: null,
      targets: [1],
    });
    applyReplicationPacket(replica, baseline).unwrap();
    f.visible.get(A)!.add(f.second);
    applyReplicationPacket(replica, f.authority.publish(A, f.policy).unwrap()).unwrap();
    expect(replica.readComponent(1, Link)!.target).toBe(replica.entityFor(2));
    f.visible.get(A)!.delete(f.second);
    applyReplicationPacket(replica, f.authority.publish(A, f.policy).unwrap()).unwrap();
    expect(replica.readComponent(1, Link)).toMatchObject({ target: null });
    expect(replica.entityFor(2)).toBeUndefined();
  });
  it('only narrows the Profile and evaluates the policy once per candidate', () => {
    const f = setup();
    f.world.spawn({ component: Data, data: { secret: 'outside', value: 0 } }).unwrap();
    let calls = 0;
    const packet = f.authority
      .publish(A, () => {
        calls++;
        return true;
      })
      .unwrap();
    expect(packet.entities).toHaveLength(2);
    expect(calls).toBe(2);
  });
  it('isolates ACK capacity so a stalled receiver cannot advance or block a healthy one', () => {
    const f = setup();
    const { host, clients } = sessions(f, 1);
    host.publish().unwrap();
    clients[0]!.session.receiveEvents();
    host.receiveEvents();
    expect(host.getRecoverySnapshot().pendingPackets).toBe(1);
    expect(host.publish()).toMatchObject({ ok: false, error: { code: 'recovery-rejected' } });
    expect(clients[0]!.session.receiveEvents()).toEqual([]);
    expect(clients[0]!.session.getRecoverySnapshot().sequence).toBe(2);
    expect(clients[1]!.session.receiveEvents()).toEqual([]);
    expect(clients[1]!.session.getRecoverySnapshot().sequence).toBe(1);
    host.receiveEvents();
    expect(host.getRecoverySnapshot().pendingPackets).toBe(0);
    host.publish().unwrap();
    clients.forEach(({ session }) => expect(session.receiveEvents()).toEqual([]));
    expect(clients[1]!.session.getRecoverySnapshot().sequence).toBe(2);
    clients.forEach(({ session }) => session.dispose());
    host.dispose();
    expect(f.authority.idFor(f.first, A)).toBe(0);
    expect(host.getResourceSnapshot()).toEqual({
      ledgers: 0,
      timers: 0,
      pendingConnects: 0,
      callbacks: 0,
    });
  });
  it('resyncs only the requested receiver and projects into real replica Worlds', () => {
    const f = setup();
    const { host, clients } = sessions(f);
    host.publish().unwrap();
    clients.forEach(({ session }) => expect(session.receiveEvents()).toEqual([]));
    host.receiveEvents();
    expect(clients[0]!.replica.readComponent(1, Data)!.secret).toBe('only-A');
    expect(clients[1]!.replica.readComponent(1, Data)!.secret).toBe('only-B');
    host.requestFullBaselineForSession(A);
    host.publish().unwrap();
    clients.forEach(({ session }) => expect(session.receiveEvents()).toEqual([]));
    expect(clients[0]!.session.getRecoverySnapshot()).toMatchObject({ epoch: 1, sequence: 1 });
    expect(clients[1]!.session.getRecoverySnapshot()).toMatchObject({ epoch: 0, sequence: 2 });
    host.dispose();
    clients.forEach(({ session }) => session.dispose());
  });
  it('accepts an empty baseline followed by a newly visible entity', () => {
    const f = setup();
    f.visible.get(A)!.clear();
    const replica = new ReplicaCoordinator(new World(), f.profile);
    applyReplicationPacket(replica, f.authority.publish(A, f.policy).unwrap()).unwrap();
    f.visible.get(A)!.add(f.second);
    applyReplicationPacket(replica, f.authority.publish(A, f.policy).unwrap()).unwrap();
    expect(replica.readComponent(1, Data)!.secret).toBe('only-B');
  });
});

it('keeps foreign-session ACKs and duplicate SessionId announcements from taking another peer stream', () => {
  const f = setup();
  const { host, clients } = sessions(f, 1);
  host.publish().unwrap();
  const ack = encodeReplicationPacket(
    { version: 2, kind: 'ack', sessionId: B, epoch: 0, acknowledgedSequence: 1 },
    f.profile.limits,
  ).unwrap();
  clients[0]!.endpoint.send(1 as PeerId, ack).unwrap();
  expect(host.receiveEvents()).toEqual([]);
  expect(host.getReplicationSnapshot().map((peer) => peer.pendingPackets)).toEqual([1, 1]);
  const duplicate = encodeReplicationPacket(
    { version: 2, kind: 'session-open', sessionId: B, epoch: 0, sequence: 0 },
    f.profile.limits,
  ).unwrap();
  clients[0]!.endpoint.send(1 as PeerId, duplicate).unwrap();
  expect(host.receiveEvents()).toMatchObject([{ code: 'recovery-rejected' }]);
  expect(host.getSessionSnapshot().sessionIds).toEqual([A, B]);
  clients.forEach(({ session }) => session.dispose());
  host.dispose();
});

it('waits for receiver identity before invoking visibility or sending any data', () => {
  const f = setup();
  const [endpoint, peer] = createMemoryEndpointPair();
  let calls = 0;
  const host = new NetSession({ endpoint, maxRawMessages: 8 });
  host.attachAuthority(f.authority, (entity, sessionId) => {
    calls++;
    return f.policy(entity, sessionId);
  });
  host.receiveEvents();
  peer.poll();
  host.publish().unwrap();
  expect(peer.poll()).toEqual([]);
  expect(calls).toBe(0);
  expect(host.getReplicationSnapshot()).toEqual([]);
  host.dispose();
  peer.close();
});

it('does not adopt failed encoding or consume receiver sequence and identity', () => {
  const f = setup();
  const profile = defineReplication({
    name: 'small',
    entities: f.profile.entities,
    components: f.profile.components,
    limits: { maxStringBytes: 8 },
  }).unwrap();
  const authority = new AuthorityCoordinator(f.world, profile);
  f.world.set(f.first, Data, { secret: 'oversized-private-string', value: 0 }).unwrap();
  expect(authority.publish(A, f.policy).ok).toBe(false);
  expect(authority.idFor(f.first, A)).toBe(0);
  f.world.set(f.first, Data, { secret: 'short', value: 0 }).unwrap();
  expect(authority.publish(A, f.policy).unwrap()).toMatchObject({
    kind: 'baseline',
    sequence: 1,
    entities: [{ id: 1 }],
  });
});

it('sends a fresh epoch baseline after a rejected transport write instead of a gapped delta', () => {
  const f = setup();
  const [sender, receiver] = createMemoryEndpointPair();
  let reject = false;
  const endpoint: NetEndpoint = {
    poll: () => sender.poll(),
    disconnect: (peerId) => sender.disconnect(peerId),
    close: () => sender.close(),
    send: (peerId, data) => {
      if (!reject) return sender.send(peerId, data);
      reject = false;
      return err(
        new EndpointError({
          code: 'send-failed',
          detail: { peerId, cause: 'deterministic rejected write' },
        }),
      );
    },
  };
  const host = new NetSession({ endpoint, maxRawMessages: 8 });
  host.attachAuthority(f.authority, f.policy);
  const replica = new ReplicaCoordinator(new World(), f.profile);
  const client = new NetSession({ endpoint: receiver, sessionId: A, maxRawMessages: 8 });
  client.attachReplica(replica, f.profile.limits);
  client.receiveEvents();
  host.receiveEvents();
  host.publish().unwrap();
  client.receiveEvents();
  host.receiveEvents();
  f.world.set(f.first, Data, { value: 7 }).unwrap();
  reject = true;
  expect(host.publish()).toMatchObject({ ok: false, error: { code: 'send-failed' } });
  expect(client.receiveEvents()).toEqual([]);
  host.publish().unwrap();
  expect(client.receiveEvents()).toEqual([]);
  expect(client.getRecoverySnapshot()).toMatchObject({ epoch: 1, sequence: 1 });
  expect(replica.readComponent(1, Data)!.value).toBe(7);
  client.dispose();
  host.dispose();
});


it('keeps an announced logical identity when a new transport peer has the same numeric id', () => {
  const f = setup();
  const [endpoint, peer] = createMemoryEndpointPair();
  let connected = false;
  const host = new NetSession({
    endpoint: {
      send: (id, data) => endpoint.send(id, data),
      disconnect: (peerId) => endpoint.disconnect(peerId),
      close: () => endpoint.close(),
      poll: () => connected ? [{ kind: 'peer-connected', peerId: A as unknown as PeerId }] : endpoint.poll(),
    },
    maxRawMessages: 8,
  });
  host.attachAuthority(f.authority, f.policy);
  const replica = new ReplicaCoordinator(new World(), f.profile);
  const client = new NetSession({ endpoint: peer, sessionId: A, maxRawMessages: 8 });
  client.attachReplica(replica, f.profile.limits);
  client.receiveEvents();
  host.receiveEvents();
  host.publish().unwrap();
  client.receiveEvents();
  host.receiveEvents();
  connected = true;
  host.receiveEvents();
  host.publish().unwrap();
  expect(host.getSessionSnapshot().sessionIds).toEqual([A]);
  expect(host.getReplicationSnapshot()).toMatchObject([{ sessionId: A, peerId: 2, sequence: 2 }]);
  client.receiveEvents();
  expect(replica.readComponent(replica.snapshot()[0]!.id, Data)?.secret).toBe('only-A');
  client.dispose();
  host.dispose();
});

it.each([false, true])(
  'revokes visible state at a newer epoch when rebinding authority (replacement=%s)',
  (replacement) => {
    const f = setup();
    const { host, clients } = sessions(f);
    host.publish().unwrap();
    clients.forEach(({ session }) => session.receiveEvents());
    host.receiveEvents();
    host.requestFullBaselineForSession(A);
    host.publish().unwrap();
    clients.forEach(({ session }) => session.receiveEvents());
    host.receiveEvents();
    f.visible.get(A)!.clear();
    host.attachAuthority(
      replacement ? new AuthorityCoordinator(f.world, f.profile) : f.authority,
      f.policy,
    );
    host.publish().unwrap();
    clients.forEach(({ session }) => session.receiveEvents());
    expect(clients[0]!.replica.snapshot()).toEqual([]);
    expect(clients[1]!.replica.snapshot()).toHaveLength(1);
    expect(host.getReplicationSnapshot()).toMatchObject([
      { sessionId: A, epoch: 2, sequence: 1 },
      { sessionId: B, epoch: 1, sequence: 1 },
    ]);
    clients.forEach(({ session }) => session.dispose());
    host.dispose();
  },
);
