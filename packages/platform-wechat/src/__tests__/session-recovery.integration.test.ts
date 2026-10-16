/// <reference types="node" />
import { createServer } from 'node:net';
import { defineComponent, World } from '@forgeax/engine-ecs';
import {
  createAuthorityCoordinator,
  createReplicaCoordinator,
  decodeReplicationPacket,
  defineReplication,
  type NetError,
  NetSession,
} from '@forgeax/engine-net';
import { listenWebSocketEndpoint } from '@forgeax/engine-net-websocket/node';
import { expect, it } from 'vitest';
import {
  createWechatSocketConnector,
  type WechatSocketSource,
  type WechatSocketTask,
} from '../network.js';

const Networked = defineComponent('WechatRecoveryNetworked', { enabled: 'bool' });
const Position = defineComponent('WechatRecoveryPosition', { x: 'f32' });

function nativeSocket(url: string) {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const received: Uint8Array[] = [];
  const callbacks = {
    open: () => {},
    message: (_event: { readonly data: string | ArrayBuffer }) => {},
    error: (_cause: unknown) => {},
    close: (_event: { readonly code: number; readonly reason: string }) => {},
  };
  const task: WechatSocketTask = {
    onOpen(callback) {
      callbacks.open = callback;
      socket.addEventListener('open', callback);
    },
    onMessage(callback) {
      callbacks.message = callback;
      socket.addEventListener('message', (event) => {
        const data = event.data as ArrayBuffer;
        received.push(new Uint8Array(data).slice());
        callback({ data });
      });
    },
    onError(callback) {
      callbacks.error = callback;
      socket.addEventListener('error', callback);
    },
    onClose(callback) {
      callbacks.close = callback;
      socket.addEventListener('close', callback);
    },
    send({ data, success, fail }) {
      try {
        socket.send(data);
        success();
      } catch (cause) {
        fail(cause);
      }
    },
    close({ code, fail }) {
      try {
        socket.close(code);
      } catch (cause) {
        fail(cause);
      }
    },
  };
  return { socket, received, callbacks, task };
}

it('recovers real WeChat socket replication through NetSession and rejects retired input', async () => {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing TCP port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const listener = (await listenWebSocketEndpoint({ port, host: '127.0.0.1' })).unwrap();
  const attachments: ReturnType<typeof nativeSocket>[] = [];
  const source: WechatSocketSource = {
    connectSocket({ url }) {
      // This supplies only the SocketTask shape; every publication crosses real TCP.
      const attachment = nativeSocket(url);
      attachments.push(attachment);
      return attachment.task;
    },
  };
  const connector = createWechatSocketConnector(source, `ws://127.0.0.1:${port}`);
  const replication = defineReplication({
    name: 'wechat-session-recovery',
    entities: { with: [Networked] },
    components: [Networked, Position],
  }).unwrap();
  const authorityWorld = new World();
  const entity = authorityWorld
    .spawn(
      { component: Networked, data: { enabled: true } },
      { component: Position, data: { x: 7 } },
    )
    .unwrap();
  const replicaWorld = new World();
  const authority = createAuthorityCoordinator(authorityWorld, replication);
  const replica = createReplicaCoordinator(replicaWorld, replication);
  const authoritySession = new NetSession({ endpoint: listener, maxRawMessages: 8 });
  const replicaSession = new NetSession({
    connector,
    sessionId: 42,
    recovery: { reconnectDelaysMs: [0] },
    maxRawMessages: 8,
  });
  authoritySession.attachAuthority(authority);
  replicaSession.attachReplica(replica, replication.limits);
  const sessionId = replicaSession.getRecoverySnapshot().sessionId;
  const errors: NetError[] = [];
  const receive = () => {
    errors.push(...authoritySession.receiveEvents(), ...replicaSession.receiveEvents());
  };
  const x = () => {
    const target = replica.entityFor(authority.idFor(entity, sessionId));
    return target === undefined ? undefined : replicaWorld.get(target, Position).unwrap().x;
  };
  const drainAck = async () => {
    await expect
      .poll(() => {
        receive();
        return authoritySession.getRecoverySnapshot().pendingPackets;
      })
      .toBe(0);
    expect(errors).toEqual([]);
  };

  try {
    expect(replicaSession.getRecoverySnapshot().state.kind).toBe('connecting');
    // The session invokes the connector for initial attachment and every recovery.
    expect(replicaSession.recover().kind).toBe('started');
    replicaSession.advanceRecovery();
    await expect.poll(() => replicaSession.getRecoverySnapshot().state.kind).toBe('resyncing');
    await expect
      .poll(() => {
        receive();
        return authoritySession.getSessionSnapshot().sessionIds;
      })
      .toEqual([42]);
    expect(replicaSession.getRecoverySnapshot().state.kind).toBe('resyncing');
    expect(replica.snapshot()).toEqual([]);
    const firstPeer = replicaSession.getPeerSnapshot().peerIds[0];
    const first = attachments[0];
    if (!first || firstPeer === undefined) throw new Error('Missing first native attachment');

    authoritySession.publish().unwrap();
    await expect
      .poll(() => {
        receive();
        return x();
      })
      .toBe(7);
    const baseline = first.received[0];
    if (!baseline) throw new Error('Missing real baseline bytes');
    const initial = decodeReplicationPacket(baseline, replication.limits).unwrap();
    expect(initial).toMatchObject({ kind: 'baseline', sessionId, sequence: 1 });
    expect(replicaSession.getRecoverySnapshot().state).toMatchObject({ kind: 'active' });
    await drainAck();

    authorityWorld.set(entity, Position, { x: 11 }).unwrap();
    authoritySession.publish().unwrap();
    await expect
      .poll(() => {
        receive();
        return x();
      })
      .toBe(11);
    const delta = first.received[1];
    if (!delta) throw new Error('Missing real delta bytes');
    expect(decodeReplicationPacket(delta, replication.limits).unwrap()).toMatchObject({
      kind: 'delta',
      sessionId,
      epoch: initial.epoch,
      sequence: 2,
    });
    await drainAck();

    // Close the real transport. No fixture code calls the connector or invents retries.
    first.socket.close(1000, 'transport interrupted');
    await expect
      .poll(() => {
        receive();
        return replicaSession.getRecoverySnapshot().state.kind;
      })
      .toBe('recovering');
    expect(replica.snapshot()).toEqual([]);
    expect(replicaSession.getRecoverySnapshot().sessionId).toBe(sessionId);
    await expect.poll(() => replicaSession.getRecoverySnapshot().state.kind).toBe('resyncing');
    await expect
      .poll(() => {
        receive();
        const peer = replicaSession.getPeerSnapshot().peerIds[0];
        return peer !== undefined && peer !== firstPeer;
      })
      .toBe(true);
    expect(attachments).toHaveLength(2);
    const replacement = attachments[1];
    if (!replacement) throw new Error('Missing replacement native attachment');
    expect(replacement.socket.readyState).toBe(WebSocket.OPEN);
    expect(replicaSession.getRecoverySnapshot()).toMatchObject({
      sessionId,
      state: { kind: 'resyncing' },
      epoch: initial.epoch + 1,
      sequence: 0,
    });

    // Explicitly inject late native callbacks, separately from actual socket traffic.
    first.callbacks.message({ data: new Uint8Array(baseline).buffer });
    first.callbacks.open();
    first.callbacks.error(new Error('late retired SocketTask error'));
    first.callbacks.close({ code: 1006, reason: 'late retired SocketTask close' });
    receive();
    expect(replicaSession.getRecoverySnapshot().state.kind).toBe('resyncing');
    expect(replica.snapshot()).toEqual([]);
    expect(replacement.received).toEqual([]);
    await expect
      .poll(() => {
        receive();
        return authoritySession.getSessionSnapshot().sessionIds;
      })
      .toEqual([sessionId]);

    authorityWorld.set(entity, Position, { x: 23 }).unwrap();
    authoritySession.publish().unwrap();
    await expect
      .poll(() => {
        receive();
        return x();
      })
      .toBe(23);
    const resumed = replacement.received[0];
    if (!resumed) throw new Error('Missing resumed baseline bytes');
    expect(decodeReplicationPacket(resumed, replication.limits).unwrap()).toMatchObject({
      kind: 'baseline',
      sessionId,
      epoch: initial.epoch + 1,
      sequence: 1,
    });
    await drainAck();

    // An old epoch delivered over the new real socket must not roll back the World.
    const remotePeer = authoritySession.getPeerSnapshot().peerIds[0];
    if (remotePeer === undefined) throw new Error('Missing resumed authority peer');
    listener.send(remotePeer, delta).unwrap();
    await expect
      .poll(() => {
        receive();
        return replica.lastPacketOutcome;
      })
      .toBe('ignored-old-epoch');
    expect(x()).toBe(23);
    expect(replicaSession.getRecoverySnapshot().state).toMatchObject({
      kind: 'active',
      epoch: initial.epoch + 1,
      sequence: 1,
    });

    authorityWorld.set(entity, Position, { x: 29 }).unwrap();
    authoritySession.publish().unwrap();
    await expect
      .poll(() => {
        receive();
        return x();
      })
      .toBe(29);
    await drainAck();
    expect(attachments).toHaveLength(2);
    expect(errors).toEqual([]);
    replicaSession.dispose();
    authoritySession.dispose();
    for (const session of [replicaSession, authoritySession]) {
      expect(session.getRecoverySnapshot()).toMatchObject({
        state: { kind: 'retired' },
        pendingPackets: 0,
        ownedResources: { pendingConnects: 0, timers: 0, ledgers: 0, callbacks: 0 },
      });
    }
    await expect
      .poll(() => attachments.every(({ socket }) => socket.readyState === WebSocket.CLOSED))
      .toBe(true);
    expect(replica.snapshot()).toEqual([]);
  } finally {
    replicaSession.dispose();
    authoritySession.dispose();
    for (const { socket } of attachments) socket.close();
    listener.close();
  }
});
