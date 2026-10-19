import { defineComponent, World } from '@forgeax/engine-ecs';
import { err, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import type { EndpointEvent, NetEndpoint, PeerId } from '../src/endpoint/endpoint';
import { EndpointError } from '../src/endpoint/errors';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { AuthorityCoordinator } from '../src/replication/authority';
import { defineReplication } from '../src/replication/profile';
import { createReplicaCoordinator } from '../src/replication/replica';
import { NetSession } from '../src/session/net-session';
import { FakeClock } from './fixtures/fake-clock';

const State = defineComponent('SessionCapacityState', { value: 'u32' });
const profile = defineReplication({ name: 'session-capacity', entities: { with: [State] }, components: [State] }).unwrap();

// Only multiplex peer addresses. Bytes, connection events and closure use the
// real Memory endpoints and every baseline/ACK uses NetSession/coordinators.
function listener() {
  const pairs: ReturnType<typeof createMemoryEndpointPair>[] = [];
  const extraEvents: EndpointEvent[] = [];
  const endpoint: NetEndpoint = {
    poll: () => [...extraEvents.splice(0), ...pairs.flatMap(([server], index) =>
      server.poll().map(event => ({ ...event, peerId: (index + 2) as PeerId })))],
    send: (peer, bytes) => pairs[peer - 2]![0].send(2 as PeerId, bytes),
    disconnect: peer => pairs[peer - 2]![0].disconnect(2 as PeerId),
    close: () => { for (const [server] of pairs) server.close(); return ok(undefined); },
  };
  return { endpoint, extraEvents, connect: () => {
    const pair = createMemoryEndpointPair(); pairs.push(pair); return pair[1];
  } };
}

it.each([false, true])('bounds announced and unannounced attachments and releases capacity (visibility=%s)', visibility => {
  const transport = listener(), world = new World();
  const entity = world.spawn({ component: State, data: { value: 42 } }).unwrap();
  const authority = new NetSession({ endpoint: transport.endpoint, maxRawMessages: 8, recovery: { maxSessions: 1 } });
  authority.attachAuthority(new AuthorityCoordinator(world, profile), visibility ? () => true : undefined);
  const healthy = new NetSession({ endpoint: transport.connect(), sessionId: 17, maxRawMessages: 8 });
  const coordinator = createReplicaCoordinator(new World(), profile);
  healthy.attachReplica(coordinator, profile.limits);
  const excess = transport.connect(); // It has not announced any logical identity.
  let replacement: NetSession | undefined;
  try {
    healthy.receiveEvents();
    expect(authority.receiveEvents()).toMatchObject([{ code: 'session-capacity-exceeded',
      detail: { peerId: 3, attachedPeers: 1, maxSessions: 1 } }]);
    expect(authority.getPeerSnapshot().peerIds).toEqual([2]);
    expect(authority.getSessionSnapshot().sessionIds).toEqual([17]);
    expect(excess.send(1 as PeerId, new Uint8Array([99])).ok).toBe(false);
    authority.publish().unwrap(); healthy.receiveEvents(); authority.receiveEvents();
    expect(coordinator.readComponent(1, State)).toEqual({ value: 42 });
    healthy.sendToAuthority(17 as never, new Uint8Array([1, 2])).unwrap();
    authority.receiveEvents(); expect(authority.drainRawMessages().map(message => [...message.data])).toEqual([[1, 2]]);
    world.set(entity, State, { value: 99 }).unwrap();
    authority.publish().unwrap(); healthy.receiveEvents(); authority.receiveEvents();
    expect(coordinator.readComponent(1, State)).toEqual({ value: 99 });
    healthy.dispose(); authority.receiveEvents();
    expect(authority.getPeerSnapshot().peerIds).toEqual([]);
    expect(authority.getReplicationSnapshot()).toEqual([]);
    replacement = new NetSession({ endpoint: transport.connect(), sessionId: 18, maxRawMessages: 8 });
    const nextWorld = createReplicaCoordinator(new World(), profile);
    replacement.attachReplica(nextWorld, profile.limits); replacement.receiveEvents();
    expect(authority.receiveEvents()).toEqual([]);
    authority.publish().unwrap(); replacement.receiveEvents(); authority.receiveEvents();
    expect(authority.getSessionSnapshot().sessionIds).toEqual([18]);
    expect(nextWorld.readComponent(1, State)).toEqual({ value: 99 });
    expect(authority.getReplicationSnapshot()).toMatchObject([{ sessionId: 18, pendingPackets: 0 }]);
  } finally { replacement?.dispose(); healthy.dispose(); excess.close(); authority.dispose(); }
});

it('does not admit raw messages or future queued bytes from a refused attachment', () => {
  const transport = listener(), healthy = transport.connect(), excess = transport.connect();
  const session = new NetSession({ endpoint: transport.endpoint, maxRawMessages: 8, recovery: { maxSessions: 1 } });
  const failure = new EndpointError({ code: 'send-failed', detail: { peerId: 3 as PeerId, cause: 'disconnect refused' } });
  const disconnect = transport.endpoint.disconnect;
  transport.endpoint.disconnect = peer => peer === 3 ? err(failure) : disconnect(peer);
  try {
    healthy.send(1 as PeerId, new Uint8Array([1])).unwrap();
    excess.send(1 as PeerId, new Uint8Array([2])).unwrap();
    expect(session.receiveEvents()).toMatchObject([{ code: 'session-capacity-exceeded' }]);
    expect(session.getRecoverySnapshot().lastError).toBe(failure);
    expect(session.getPeerSnapshot().peerIds).toEqual([2]);
    expect(session.drainRawMessages().map(message => [...message.data])).toEqual([[1]]);
    healthy.close(); session.receiveEvents();
    excess.send(1 as PeerId, new Uint8Array([3])).unwrap();
    expect(session.receiveEvents()).toEqual([]);
    expect(session.drainRawMessages()).toEqual([]);
    expect(session.getPeerSnapshot().peerIds).toEqual([]);
  } finally { healthy.close(); excess.close(); session.dispose(); }
});

it('treats a repeated connection event as the same accepted stream without forcing a new baseline', () => {
  const transport = listener(), world = new World();
  const entity = world.spawn({ component: State, data: { value: 42 } }).unwrap();
  const authority = new NetSession({ endpoint: transport.endpoint, maxRawMessages: 8, recovery: { maxSessions: 1 } });
  const replica = new NetSession({ endpoint: transport.connect(), sessionId: 17, maxRawMessages: 8 });
  const coordinator = createReplicaCoordinator(new World(), profile);
  authority.attachAuthority(new AuthorityCoordinator(world, profile)); replica.attachReplica(coordinator, profile.limits);
  try {
    replica.receiveEvents(); authority.receiveEvents(); authority.publish().unwrap(); replica.receiveEvents(); authority.receiveEvents();
    const before = authority.getReplicationSnapshot()[0]!;
    transport.extraEvents.push({ kind: 'peer-connected', peerId: 2 as PeerId });
    expect(authority.receiveEvents()).toEqual([]);
    expect(authority.getReplicationSnapshot()[0]).toEqual(before);
    world.set(entity, State, { value: 99 }).unwrap(); authority.publish().unwrap();
    expect(authority.getReplicationSnapshot()[0]).toMatchObject({ epoch: before.epoch, sequence: before.sequence + 1 });
    replica.receiveEvents(); authority.receiveEvents();
    expect(coordinator.readComponent(1, State)).toEqual({ value: 99 });
  } finally { replica.dispose(); authority.dispose(); }
});

it('does not recover a healthy replica when the refused extra attachment disconnects', () => {
  const transport = listener(), server = transport.connect(), world = new World();
  const entity = world.spawn({ component: State, data: { value: 42 } }).unwrap();
  const authority = new NetSession({ endpoint: server, maxRawMessages: 8 });
  const replica = new NetSession({ endpoint: transport.endpoint, sessionId: 17, maxRawMessages: 8, recovery: { maxSessions: 1 } });
  const coordinator = createReplicaCoordinator(new World(), profile);
  authority.attachAuthority(new AuthorityCoordinator(world, profile)); replica.attachReplica(coordinator, profile.limits);
  const excess = transport.connect();
  try {
    expect(replica.receiveEvents()).toMatchObject([{ code: 'session-capacity-exceeded' }]);
    authority.receiveEvents(); authority.publish().unwrap();
    expect(replica.receiveEvents()).toEqual([]); authority.receiveEvents();
    expect(replica.getRecoverySnapshot().state.kind).toBe('active');
    expect(replica.getResourceSnapshot().timers).toBe(0);
    world.set(entity, State, { value: 99 }).unwrap(); authority.publish().unwrap();
    expect(replica.receiveEvents()).toEqual([]); authority.receiveEvents();
    expect(coordinator.readComponent(1, State)).toEqual({ value: 99 });
  } finally { excess.close(); replica.dispose(); authority.dispose(); }
});

it('still starts recovery when an endpoint closes before its connection was observed', () => {
  const [server, endpoint] = createMemoryEndpointPair(), clock = new FakeClock();
  server.close();
  const replica = new NetSession({ endpoint: { ...endpoint,
    poll: () => endpoint.poll().filter(event => event.kind !== 'peer-connected'),
    send: endpoint.send.bind(endpoint), disconnect: endpoint.disconnect.bind(endpoint), close: endpoint.close.bind(endpoint),
  }, maxRawMessages: 8, clock: { now: () => clock.nowMs, schedule: clock.schedule.bind(clock) } });
  replica.attachReplica(createReplicaCoordinator(new World(), profile), profile.limits);
  try {
    replica.receiveEvents();
    expect(replica.getRecoverySnapshot().state.kind).toBe('recovering');
    expect(replica.getPeerSnapshot().connected).toBe(false);
  } finally { replica.dispose(); }
  expect(clock.pendingTimerCount).toBe(0);
});
