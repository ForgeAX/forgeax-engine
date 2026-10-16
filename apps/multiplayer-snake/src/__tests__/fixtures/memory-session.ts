import { World } from '@forgeax/engine-ecs';
import {
  createMemoryEndpointPair,
  createReplicaCoordinator,
  type EndpointEvent,
  type NetEndpoint,
  NetSession,
  type PeerId,
} from '@forgeax/engine-net';
import { ok } from '@forgeax/engine-types';
import { createServerWorld } from '../../server';
import { encodeCommand, type SnakeCommand } from '../../shared/commands';
import { snakeProfile } from '../../shared/components';

/** Real memory transports and coordinators; commands follow accepted baseline ACKs. */
export async function createMemorySnake(ids: readonly number[] = []) {
  const clients = new Map<
    number,
    {
      host: NetEndpoint;
      endpoint: NetEndpoint;
      session: NetSession;
      replica: ReturnType<typeof createReplicaCoordinator>;
    }
  >();
  const injected: EndpointEvent[] = [];
  const sent: { peerId: number; data: Uint8Array }[] = [];
  const client = (id: number) => {
    const value = clients.get(id);
    if (value === undefined) throw new Error(`Unknown memory fixture peer ${id}`);
    return value;
  };
  const endpoint: NetEndpoint = {
    poll: () =>
      [...clients]
        .flatMap(([id, value]) =>
          value.host.poll().map((event) => ({
            ...event,
            peerId: id as PeerId,
          })),
        )
        .concat(injected.splice(0)),
    send: (peerId, data) => {
      sent.push({ peerId, data });
      return client(peerId).host.send(2 as PeerId, data);
    },
    disconnect: (peerId) => client(peerId).host.disconnect(2 as PeerId),
    close: () => {
      for (const value of clients.values()) value.host.close();
      return ok(undefined);
    },
  };
  const server = await createServerWorld(endpoint);
  const authority = server.world.getResource<NetSession>('net-session');
  const connect = (id: number) => {
    if (clients.has(id)) throw new Error(`Duplicate memory fixture peer ${id}`);
    const [host, endpoint] = createMemoryEndpointPair();
    const session = new NetSession({ endpoint, sessionId: id, maxRawMessages: 32 });
    const replica = createReplicaCoordinator(new World(), snakeProfile);
    session.attachReplica(replica, snakeProfile.limits);
    clients.set(id, { host, endpoint, session, replica });
    session.receiveEvents();
  };
  const update = (delta = 1 / 60): ReturnType<World['update']> => {
    const result = server.world.update(delta);
    if (!result.ok) return result;
    for (const value of clients.values()) {
      const errors = value.session.receiveEvents();
      if (errors.length) throw errors[0];
    }
    const errors = authority.receiveEvents();
    if (errors.length) throw errors[0];
    return result;
  };
  const send = (id: number, data: Uint8Array) => {
    const session = client(id).session;
    return session.sendToAuthority(session.getRecoverySnapshot().sessionId, data);
  };
  const command = (id: number, command: SnakeCommand) => {
    const encoded = encodeCommand(command);
    if (!encoded.ok) throw encoded.error;
    send(id, encoded.value).unwrap();
  };
  for (const id of ids) connect(id);
  update().unwrap();
  return {
    server,
    client,
    sent,
    connect,
    update,
    send,
    command,
    inject: (event: EndpointEvent) => injected.push(event),
    async dispose() {
      for (const value of clients.values()) value.session.dispose();
      await server.host.dispose();
    },
  };
}
