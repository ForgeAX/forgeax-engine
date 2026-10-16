import { createServer } from 'node:net';
import { defineComponent, World } from '@forgeax/engine-ecs';
import {
  AuthorityCoordinator,
  ReplicaCoordinator,
  defineReplication,
  NetSession,
  type NetEndpoint,
  type SessionId,
} from '@forgeax/engine-net';
import { describe, expect, it } from 'vitest';
import {
  connectWebSocketClientEndpoint,
  createWebSocketConnector,
  listenWebSocketEndpoint,
} from '../src/node';

const Value = defineComponent('SocketVisibility', { owner: 'u32', secret: 'string' });
async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No TCP address');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
describe('WebSocket receiver visibility', () => {
  it('isolates two live peers, revokes/reveals state, and re-evaluates visibility after transport replacement', async () => {
    const port = await reservePort();
    const url = `ws://127.0.0.1:${port}`;
    const listener = (await listenWebSocketEndpoint({ port })).unwrap();
    const world = new World();
    const first = world.spawn({ component: Value, data: { owner: 11, secret: 'alpha' } }).unwrap();
    world.spawn({ component: Value, data: { owner: 22, secret: 'beta' } }).unwrap();
    const profile = defineReplication({
      name: 'socket-visibility',
      entities: { with: [Value] },
      components: [Value],
    }).unwrap();
    const authority = new AuthorityCoordinator(world, profile);
    let hideA = false;
    const host = new NetSession({ endpoint: listener, maxRawMessages: 8 });
    host.attachAuthority(
      authority,
      (entity, sessionId) =>
        world.get(entity, Value).unwrap().owner === sessionId &&
        !(hideA && sessionId === (11 as SessionId)),
    );
    const endpoints: NetEndpoint[] = [];
    const clients: Array<{ session: NetSession; replica: ReplicaCoordinator }> = [];
    try {
      for (const sessionId of [11, 22]) {
        const endpoint = (await connectWebSocketClientEndpoint(url)).unwrap();
        endpoints.push(endpoint);
        const replica = new ReplicaCoordinator(new World(), profile);
        const session = new NetSession({
          endpoint,
          sessionId,
          connector: createWebSocketConnector(url),
          recovery: { reconnectDelaysMs: [0] },
          maxRawMessages: 8,
        });
        session.attachReplica(replica, profile.limits);
        clients.push({ session, replica });
        session.receiveEvents();
      }
      await expect
        .poll(() => {
          expect(host.receiveEvents()).toEqual([]);
          return host.getSessionSnapshot().sessionIds;
        })
        .toEqual([11, 22]);
      const converge = async (counts: readonly number[]) => {
        host.publish().unwrap();
        await expect
          .poll(() => {
            clients.forEach(({ session }) => expect(session.receiveEvents()).toEqual([]));
            expect(host.receiveEvents()).toEqual([]);
            return clients.map(({ replica }) => replica.snapshot().length);
          })
          .toEqual(counts);
        await expect
          .poll(() => {
            clients.forEach(({ session }) => expect(session.receiveEvents()).toEqual([]));
            host.receiveEvents();
            return host.getRecoverySnapshot().pendingPackets;
          })
          .toBe(0);
      };
      await converge([1, 1]);
      expect(clients[0]!.replica.readComponent(1, Value)).toMatchObject({ secret: 'alpha' });
      expect(clients[1]!.replica.readComponent(1, Value)).toMatchObject({ secret: 'beta' });
      hideA = true;
      await converge([0, 1]);
      world.set(first, Value, { owner: 11, secret: 'changed-hidden' }).unwrap();
      await converge([0, 1]);
      hideA = false;
      await converge([1, 1]);
      expect(clients[0]!.replica.readComponent(2, Value)).toMatchObject({
        secret: 'changed-hidden',
      });
      const oldPeer = host
        .getReplicationSnapshot()
        .find((peer) => peer.sessionId === (11 as SessionId))!.peerId;
      hideA = true;
      endpoints[0]!.close();
      await expect
        .poll(() => {
          host.receiveEvents();
          return host.getPeerSnapshot().peerIds.includes(oldPeer);
        })
        .toBe(false);
      expect(authority.idFor(first, 11 as SessionId)).toBe(0);
      await expect
        .poll(() => {
          clients[0]!.session.receiveEvents();
          return clients[0]!.session.getRecoverySnapshot().state.kind;
        })
        .toBe('resyncing');
      await expect
        .poll(() => {
          clients[0]!.session.receiveEvents();
          host.receiveEvents();
          return host.getSessionSnapshot().sessionIds;
        })
        .toEqual([11, 22]);
      await converge([0, 1]);
      expect(clients[0]!.session.getRecoverySnapshot()).toMatchObject({ state: { kind: 'active' }, epoch: 1 });
      expect(
        host.getReplicationSnapshot().find((peer) => peer.sessionId === (11 as SessionId))!.peerId,
      ).not.toBe(oldPeer);
      hideA = false;
      await converge([1, 1]);
      expect(clients[0]!.replica.readComponent(1, Value)).toMatchObject({
        secret: 'changed-hidden',
      });
    } finally {
      clients.forEach(({ session }) => session.dispose());
      endpoints.forEach((endpoint) => endpoint.close());
      host.dispose();
      listener.close();
    }
    expect(host.getResourceSnapshot()).toEqual({
      ledgers: 0,
      timers: 0,
      pendingConnects: 0,
      callbacks: 0,
    });
    expect(host.getReplicationSnapshot()).toEqual([]);
  });
});
