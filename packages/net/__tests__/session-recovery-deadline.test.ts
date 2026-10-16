import { defineComponent, World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import type { NetEndpoint } from '../src/endpoint/endpoint';
import { createMemoryEndpointPair } from '../src/endpoint/memory';
import { AuthorityCoordinator } from '../src/replication/authority';
import { defineReplication } from '../src/replication/profile';
import { createReplicaCoordinator } from '../src/replication/replica';
import { NetSession } from '../src/session/net-session';
import { FakeClock } from './fixtures/fake-clock';

const State = defineComponent('RecoveryDeadlineState', { value: 'u32' });
const profile = defineReplication({ name: 'recovery-deadline', entities: { with: [State] }, components: [State] }).unwrap();
const adaptClock = (clock: FakeClock) => ({ now: () => clock.nowMs, schedule: clock.schedule.bind(clock) });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

it.each(['baseline', 'delta'] as const)('does not accept an old %s instead of the replacement baseline', async (kind) => {
  const clock = new FakeClock();
  const world = new World();
  const entity = world.spawn({ component: State, data: { value: 42 } }).unwrap();
  const authority = new AuthorityCoordinator(world, profile);
  const baseline = authority.publish().unwrap();
  world.set(entity, State, { value: 99 }).unwrap();
  const delta = authority.publish().unwrap();
  const [first, endpoint] = createMemoryEndpointPair();
  const [replacement, next] = createMemoryEndpointPair();
  const firstPeer = first.poll().find(event => event.kind === 'peer-connected')!;
  const nextPeer = replacement.poll().find(event => event.kind === 'peer-connected')!;
  const replica = createReplicaCoordinator(new World(), profile);
  const session = new NetSession({ endpoint, maxRawMessages: 8, clock: adaptClock(clock),
    recovery: { reconnectDeadlineMs: 50 }, connector: { async connect() { return ok(next); } } });
  session.attachReplica(replica, profile.limits);
  try {
    session.receiveEvents(); first.send(firstPeer.peerId, baseline.bytes).unwrap(); session.receiveEvents();
    expect(replica.readComponent(1, State)).toEqual({ value: 42 });
    session.recover(); session.advanceRecovery(); await settle(); session.receiveEvents();
    replacement.send(nextPeer.peerId, (kind === 'baseline' ? baseline : delta).bytes).unwrap();
    expect(session.receiveEvents()).toEqual([]);
    expect(session.getRecoverySnapshot().state).toMatchObject({ kind: 'resyncing', epoch: 1 });
    expect(replica.snapshot()).toEqual([]);
    expect(clock.pendingTimerCount).toBe(1);
    const fresh = authority.publishFull().unwrap();
    replacement.send(nextPeer.peerId, fresh.bytes).unwrap(); session.receiveEvents();
    expect(session.getRecoverySnapshot().state).toMatchObject({ kind: 'active', epoch: 1 });
    expect(replica.readComponent(authority.idFor(entity), State)).toEqual({ value: 99 });
    expect(clock.pendingTimerCount).toBe(0);
  } finally { session.dispose(); first.close(); replacement.close(); }
});

it.each(['attempts', 'deadline'] as const)('does not renew the %s budget when a replacement drops before its baseline', async (bound) => {
  const clock = new FakeClock(), remotes: NetEndpoint[] = [];
  const session = new NetSession({ sessionId: 17, maxRawMessages: 8, clock: adaptClock(clock),
    recovery: { maxReconnectAttempts: bound === 'attempts' ? 2 : 10, reconnectDeadlineMs: 50, reconnectDelaysMs: [0] },
    connector: { async connect() {
      const [remote, endpoint] = createMemoryEndpointPair(); remotes.push(remote); return ok(endpoint);
    } },
  });
  session.attachReplica(createReplicaCoordinator(new World(), profile), profile.limits);
  try {
    session.recover(); session.advanceRecovery(); await settle(); session.receiveEvents();
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(session.getRecoverySnapshot().state.kind).toBe('resyncing');
      clock.advanceBy(20);
      remotes[cycle]!.close(); session.receiveEvents(); await settle(); session.receiveEvents();
    }
    if (bound === 'deadline') clock.advanceBy(10);
    expect(session.getRecoverySnapshot().state.kind).toBe('failed');
    expect(session.getRecoverySnapshot().lastError?.code).toBe('recovery-exhausted');
    expect(remotes).toHaveLength(bound === 'attempts' ? 2 : 3);
    expect(session.getResourceSnapshot()).toEqual({ pendingConnects: 0, timers: 0, ledgers: 0, callbacks: 0 });
    expect(clock.pendingTimerCount).toBe(0);
  } finally { session.dispose(); for (const remote of remotes) remote.close(); }
});

it('expires an unresolved connector and closes its late successful endpoint', async () => {
  const clock = new FakeClock();
  let signal: AbortSignal | undefined;
  let complete: (endpoint: NetEndpoint) => void = () => { throw new Error('No pending connect'); };
  const session = new NetSession({ sessionId: 17, maxRawMessages: 8, clock: adaptClock(clock),
    recovery: { reconnectDeadlineMs: 50 }, connector: { connect(abort) {
      signal = abort;
      return new Promise(resolve => { complete = endpoint => resolve(ok(endpoint)); });
    } },
  });
  const [remote, late] = createMemoryEndpointPair();
  remote.poll();
  try {
    session.recover(); session.advanceRecovery();
    clock.advanceBy(49);
    expect(session.getRecoverySnapshot().state.kind).toBe('recovering');
    clock.advanceBy(1);
    expect(session.getRecoverySnapshot()).toMatchObject({ state: { kind: 'failed' },
      lastError: { code: 'recovery-exhausted', detail: { deadlineMs: 50 } } });
    expect(signal?.aborted).toBe(true);
    expect(session.getResourceSnapshot()).toEqual({ pendingConnects: 0, timers: 0, ledgers: 0, callbacks: 0 });
    complete(late); await settle();
    expect(remote.poll()).toContainEqual(expect.objectContaining({ kind: 'peer-disconnected' }));
    expect(session.getRecoverySnapshot().state.kind).toBe('failed');
    expect(clock.pendingTimerCount).toBe(0);
  } finally { session.dispose(); remote.close(); late.close(); }
});

it('keeps the same deadline until the replacement baseline is accepted', async () => {
  const clock = new FakeClock();
  const [remote, endpoint] = createMemoryEndpointPair();
  const session = new NetSession({ sessionId: 17, maxRawMessages: 8, clock: adaptClock(clock),
    recovery: { reconnectDeadlineMs: 50 }, connector: { async connect() { return ok(endpoint); } },
  });
  session.attachReplica(createReplicaCoordinator(new World(), profile), profile.limits);
  try {
    session.recover(); session.advanceRecovery(); await settle(); session.receiveEvents();
    expect(session.getRecoverySnapshot().state.kind).toBe('resyncing');
    clock.advanceBy(50);
    expect(session.getRecoverySnapshot()).toMatchObject({ state: { kind: 'failed' }, lastError: { code: 'recovery-exhausted' } });
    expect(session.getResourceSnapshot()).toEqual({ pendingConnects: 0, timers: 0, ledgers: 0, callbacks: 0 });
  } finally { session.dispose(); remote.close(); }
});

it('starts a fresh attempt budget for each recovery and cancels the accepted deadline', async () => {
  const clock = new FakeClock(), authorities: NetSession[] = [];
  const world = new World();
  world.spawn({ component: State, data: { value: 42 } }).unwrap();
  const replica = createReplicaCoordinator(new World(), profile);
  const session = new NetSession({ sessionId: 17, maxRawMessages: 8, clock: adaptClock(clock),
    recovery: { maxReconnectAttempts: 1, reconnectDeadlineMs: 50, reconnectDelaysMs: [0] },
    connector: { async connect() {
      const [remote, endpoint] = createMemoryEndpointPair();
      const authority = new NetSession({ endpoint: remote, maxRawMessages: 8 });
      authority.attachAuthority(new AuthorityCoordinator(world, profile)); authorities.push(authority);
      return ok(endpoint);
    } },
  });
  session.attachReplica(replica, profile.limits);
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      session.recover(); session.advanceRecovery(); await settle();
      expect(authorities).toHaveLength(cycle + 1);
      const authority = authorities[cycle]!;
      expect(session.receiveEvents()).toEqual([]); expect(authority.receiveEvents()).toEqual([]);
      authority.publish().unwrap(); expect(session.receiveEvents()).toEqual([]);
      expect(authority.receiveEvents()).toEqual([]);
      expect(session.getRecoverySnapshot()).toMatchObject({ state: { kind: 'active', epoch: cycle }, reconnectAttempts: 1 });
      expect(replica.readComponent(1, State)).toEqual({ value: 42 });
      expect(clock.pendingTimerCount).toBe(0);
      clock.advanceBy(100);
      expect(session.getRecoverySnapshot().state.kind).toBe('active');
    }
  } finally { session.dispose(); for (const authority of authorities) authority.dispose(); }
});
