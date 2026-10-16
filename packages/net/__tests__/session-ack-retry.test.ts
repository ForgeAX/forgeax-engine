import { defineComponent, World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import type { NetEndpoint, PeerId } from '../src/endpoint/endpoint';
import { expect, it } from 'vitest';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { AuthorityCoordinator } from '../src/replication/authority';
import { decodeReplicationPacket, encodeReplicationPacket } from '../src/replication/codec';
import { defineReplication } from '../src/replication/profile';
import { createReplicaCoordinator } from '../src/replication/replica';
import { NetSession } from '../src/session/net-session';
import { FakeClock } from './fixtures/fake-clock';

const State = defineComponent('AckRetryState', { value: 'u32' });
const profile = defineReplication({ name: 'ack-retry', entities: { with: [State] }, components: [State] }).unwrap();

it('isolates a current peer rejection without allowing a foreign session rejection to close the listener', () => {
  const pairs = [createMemoryEndpointPair(), createMemoryEndpointPair()];
  const endpoint: NetEndpoint = {
    poll: () => pairs.flatMap(([server], index) => server.poll().map(event => ({ ...event, peerId: (index + 2) as PeerId }))),
    send: (peer, bytes) => pairs[peer - 2]![0].send(2 as PeerId, bytes),
    disconnect: peer => pairs[peer - 2]![0].disconnect(2 as PeerId),
    close: () => { for (const [server] of pairs) server.close(); return ok(undefined); },
  };
  const world = new World();
  const entity = world.spawn({component: State, data: {value: 42}}).unwrap();
  const authority = new NetSession({endpoint, maxRawMessages: 8});
  authority.attachAuthority(new AuthorityCoordinator(world, profile));
  const clients = pairs.map(([, endpoint], index) => {
    const coordinator = createReplicaCoordinator(new World(), profile);
    const session = new NetSession({endpoint, maxRawMessages: 8, sessionId: index + 17});
    session.attachReplica(coordinator, profile.limits);
    session.receiveEvents();
    return {session, coordinator};
  });
  const reject = (sessionId: number) => pairs[0]![1].send(1 as PeerId, encodeReplicationPacket({
    version: 2, kind: 'rejection', sessionId: sessionId as never, epoch: 0, sequence: 1,
    rejectedKind: 'baseline', reason: 'receiver cannot accept publication',
  }, profile.limits).unwrap()).unwrap();
  try {
    authority.receiveEvents(); authority.publish().unwrap();
    for (const client of clients) client.session.receiveEvents();
    authority.receiveEvents();
    reject(18);
    authority.receiveEvents();
    expect(authority.getPeerSnapshot().peerIds).toEqual([2, 3]);
    reject(17);
    expect(authority.receiveEvents()).toMatchObject([{code: 'recovery-rejected'}]);
    expect(authority.getPeerSnapshot().peerIds).toEqual([3]);
    expect(pairs[0]![1].send(1 as PeerId, new Uint8Array()).ok).toBe(false);
    world.set(entity, State, {value: 99}).unwrap();
    authority.publish().unwrap();
    expect(clients[1]!.session.receiveEvents()).toEqual([]);
    authority.receiveEvents();
    expect(clients[1]!.coordinator.readComponent(1, State)).toEqual({value: 99});
  } finally { for (const client of clients) client.session.dispose(); authority.dispose(); }
});

it('exhausts only the stalled peer and closes its transport while healthy peers continue', () => {
  const clock = new FakeClock();
  const pairs = [createMemoryEndpointPair(), createMemoryEndpointPair()];
  const endpoint: NetEndpoint = {
    poll: () => pairs.flatMap(([server], index) => server.poll().map(event => ({ ...event, peerId: (index + 2) as PeerId }))),
    send: (peer, bytes) => pairs[peer - 2]![0].send(2 as PeerId, bytes),
    disconnect: peer => pairs[peer - 2]![0].disconnect(2 as PeerId),
    close: () => { for (const [server] of pairs) server.close(); return ok(undefined); },
  };
  const world = new World();
  const entity = world.spawn({ component: State, data: { value: 42 } }).unwrap();
  const authority = new NetSession({ endpoint, maxRawMessages: 8,
    clock: { now: () => clock.nowMs, schedule: clock.schedule.bind(clock) },
    recovery: { ackTimeoutMs: 50, maxPacketRetries: 1 } });
  authority.attachAuthority(new AuthorityCoordinator(world, profile));
  const clients = pairs.map(([, endpoint], i) => {
    const coordinator = createReplicaCoordinator(new World(), profile);
    const session = new NetSession({ endpoint, sessionId: i + 17, maxRawMessages: 8,
      clock: { now: () => clock.nowMs, schedule: clock.schedule.bind(clock) } });
    session.attachReplica(coordinator, profile.limits); session.receiveEvents();
    return { coordinator, session };
  });
  try {
    authority.receiveEvents(); authority.publish().unwrap();
    clients[1]!.session.receiveEvents(); authority.receiveEvents();
    clock.advanceBy(50); expect(authority.receiveEvents()).toEqual([]);
    world.set(entity, State, { value: 99 }).unwrap(); authority.publish().unwrap();
    clients[1]!.session.receiveEvents(); authority.receiveEvents();
    clock.advanceBy(50);
    expect(authority.receiveEvents()).toMatchObject([{ code: 'ack-retry-exhausted',
      detail: { peerId: 2, sessionId: 17, sequence: 1, retries: 1, maxRetries: 1 } }]);
    expect(authority.getPeerSnapshot().peerIds).toEqual([3]);
    expect(authority.getReplicationSnapshot()).toMatchObject([{ sessionId: 18, pendingPackets: 0 }]);
    expect(clients[0]!.session.receiveEvents()).toEqual([]);
    expect(clients[0]!.session.getRecoverySnapshot().state.kind).toBe('recovering');
    // No connector: the unchanged recovery deadline must still retire all work.
    clock.advanceBy(10_000);
    expect(clients[0]!.session.getRecoverySnapshot().state).toMatchObject({
      kind: 'failed', error: { code: 'recovery-exhausted' },
    });
    expect(clients[0]!.session.getResourceSnapshot()).toEqual({ pendingConnects: 0, timers: 0, ledgers: 0, callbacks: 0 });
    expect(pairs[0]![1].send(1 as PeerId, new Uint8Array()).ok).toBe(false);
    world.set(entity, State, { value: 123 }).unwrap(); authority.publish().unwrap();
    expect(clients[1]!.session.receiveEvents()).toEqual([]); authority.receiveEvents();
    expect(clients[1]!.coordinator.readComponent(1, State)).toEqual({ value: 123 });
    expect(clients[1]!.session.getRecoverySnapshot().state.kind).toBe('active');
  } finally { for (const {session} of clients) session.dispose(); authority.dispose(); }
});

it('retires retry bytes with their epoch and disposal', () => {
  const clock = new FakeClock();
  const [server, client] = createMemoryEndpointPair();
  const world = new World(); world.spawn({component:State,data:{value:42}}).unwrap();
  const authority = new NetSession({ endpoint:server, maxRawMessages:8,
    clock:{now:()=>clock.nowMs,schedule:clock.schedule.bind(clock)},recovery:{ackTimeoutMs:50,maxPacketRetries:1} });
  const replica = new NetSession({endpoint:client,maxRawMessages:8});
  authority.attachAuthority(new AuthorityCoordinator(world,profile));
  replica.attachReplica(createReplicaCoordinator(new World(),profile),profile.limits);
  try {
    authority.receiveEvents();replica.receiveEvents();authority.receiveEvents();authority.publish().unwrap();
    const initial=client.poll().filter(event=>event.kind==='message')[0]!;
    expect(decodeReplicationPacket(initial.data,profile.limits).unwrap()).toMatchObject({epoch:0});
    clock.advanceBy(40);authority.requestFullBaselineForSession(1 as never);authority.publish().unwrap();
    const replacement=client.poll().filter(event=>event.kind==='message')[0]!;
    expect(decodeReplicationPacket(replacement.data,profile.limits).unwrap()).toMatchObject({epoch:1});
    clock.advanceBy(10);authority.receiveEvents();expect(client.poll()).toEqual([]);
    clock.advanceBy(40);authority.receiveEvents();
    expect(client.poll().filter(event=>event.kind==='message').map(event=>event.data)).toEqual([replacement.data]);
    authority.dispose();clock.advanceBy(500);expect(authority.receiveEvents()).toEqual([]);
    expect(authority.getResourceSnapshot()).toEqual({pendingConnects:0,timers:0,ledgers:0,callbacks:0});
    expect(client.poll().some(event=>event.kind==='message')).toBe(false);
  } finally {replica.dispose();authority.dispose();}
});

it('retries the exact unacknowledged bytes on the configured timeout and stops after a cumulative ACK', () => {
  const clock = new FakeClock();
  const [server, client] = createMemoryEndpointPair();
  const world = new World();
  world.spawn({ component: State, data: { value: 42 } }).unwrap();
  const authority = new NetSession({ endpoint: server, maxRawMessages: 8,
    clock: { now: () => clock.nowMs, schedule: clock.schedule.bind(clock) },
    recovery: { ackTimeoutMs: 50, maxPacketRetries: 2 } });
  const replica = new NetSession({ endpoint: client, maxRawMessages: 8 });
  authority.attachAuthority(new AuthorityCoordinator(world, profile));
  replica.attachReplica(createReplicaCoordinator(new World(), profile), profile.limits);
  try {
    authority.receiveEvents(); replica.receiveEvents(); authority.receiveEvents();
    authority.publish().unwrap();
    const first = client.poll().filter(event => event.kind === 'message');
    expect(first).toHaveLength(1);
    clock.advanceBy(49);
    authority.receiveEvents();
    expect(client.poll()).toEqual([]);
    clock.advanceBy(1);
    authority.receiveEvents();
    const retry = client.poll().filter(event => event.kind === 'message');
    expect(retry).toHaveLength(1);
    expect(retry[0]!.data).toEqual(first[0]!.data);
    expect(decodeReplicationPacket(retry[0]!.data, profile.limits).unwrap()).toMatchObject({ kind: 'baseline', sequence: 1 });
    expect(authority.getReplicationSnapshot()[0]).toMatchObject({ sequence: 1, pendingPackets: 1 });
    // Let the real replica receive the next retry and produce its own ACK.
    clock.advanceBy(50); authority.receiveEvents(); replica.receiveEvents(); authority.receiveEvents();
    expect(replica.getRecoverySnapshot().state.kind).toBe('active');
    expect(authority.getReplicationSnapshot()[0]!.pendingPackets).toBe(0);
    expect(clock.pendingTimerCount).toBe(0);
    clock.advanceBy(500);
    authority.receiveEvents();
    expect(client.poll()).toEqual([]);
  } finally { replica.dispose(); authority.dispose(); }
});


it('recovers the same logical session after ACK exhaustion instead of receiving a terminal rejection', async () => {
  const clock = new FakeClock();
  const timing = { now: () => clock.nowMs, schedule: clock.schedule.bind(clock) };
  const [initialServer, initialClient] = createMemoryEndpointPair();
  const [replacementServer, replacementClient] = createMemoryEndpointPair();
  let server = initialServer;
  let connects = 0;
  const endpoint: NetEndpoint = {
    poll: () => server.poll(),
    send: (peer, bytes) => server.send(peer, bytes),
    disconnect: peer => server.disconnect(peer),
    close: () => server.close(),
  };
  const world = new World();
  const entity = world.spawn({ component: State, data: { value: 42 } }).unwrap();
  const authority = new NetSession({ endpoint, clock: timing, maxRawMessages: 8 });
  authority.attachAuthority(new AuthorityCoordinator(world, profile));
  const projection = createReplicaCoordinator(new World(), profile);
  const replica = new NetSession({ endpoint: initialClient, sessionId: 17, clock: timing,
    maxRawMessages: 8, connector: { async connect() {
      connects++;
      server = replacementServer;
      return ok(replacementClient);
    } } });
  replica.attachReplica(projection, profile.limits);
  try {
    replica.receiveEvents(); authority.receiveEvents(); authority.publish().unwrap();
    // Stall the receiver across the unchanged default 250ms / three-retry bound.
    for (let retry = 0; retry < 3; retry++) {
      clock.advanceBy(250);
      expect(authority.receiveEvents()).toEqual([]);
    }
    clock.advanceBy(250);
    expect(authority.receiveEvents()).toMatchObject([{ code: 'ack-retry-exhausted',
      detail: { sessionId: 17, sequence: 1, retries: 3, maxRetries: 3 } }]);
    expect(authority.getPeerSnapshot().peerIds).toEqual([]);
    expect(authority.getResourceSnapshot().ledgers).toBe(0);
    replica.receiveEvents();
    expect(replica.getRecoverySnapshot().state.kind).toBe('recovering');
    await Promise.resolve();
    expect(connects).toBe(1);
    expect(replica.getRecoverySnapshot().state.kind).toBe('resyncing');
    world.set(entity, State, { value: 99 }).unwrap();
    for (let round = 0; round < 3; round++) {
      replica.receiveEvents(); authority.receiveEvents(); authority.publish().unwrap();
      replica.receiveEvents(); authority.receiveEvents();
    }
    expect(replica.getRecoverySnapshot()).toMatchObject({ sessionId: 17,
      state: { kind: 'active' }, epoch: 1, reconnectAttempts: 1 });
    expect(projection.readComponent(1, State)).toEqual({ value: 99 });
    expect(authority.getReplicationSnapshot()).toMatchObject([{ sessionId: 17, pendingPackets: 0 }]);
    expect(replica.getResourceSnapshot()).toEqual({ pendingConnects: 0, timers: 0, ledgers: 0, callbacks: 0 });
    // A real protocol rejection remains terminal; only transport loss recovers.
    replacementServer.send(2 as PeerId, encodeReplicationPacket({ version: 2,
      kind: 'rejection', sessionId: 17 as never, epoch: 1, sequence: 1,
      rejectedKind: 'baseline', reason: 'invalid schema' }, profile.limits).unwrap()).unwrap();
    expect(replica.receiveEvents()).toMatchObject([{ code: 'recovery-rejected' }]);
    expect(replica.getRecoverySnapshot().state.kind).toBe('failed');
    expect(connects).toBe(1);
    expect(replica.getResourceSnapshot()).toEqual({ pendingConnects: 0, timers: 0, ledgers: 0, callbacks: 0 });
  } finally { replica.dispose(); authority.dispose(); initialServer.close(); replacementServer.close(); }
});
