import {
  ENDPOINT_ERROR_HINTS,
  ENDPOINT_EXPECTED,
  EndpointError,
  type EndpointEvent,
  type NetEndpoint,
  type PeerId,
} from '@forgeax/engine-net';
import { err, ok, type Result } from '@forgeax/engine-types';
import WebSocket, { WebSocketServer } from 'ws';
import { alreadyClosed, connectionClosed, connectionFailed, normalizeCause } from './errors';
import {
  BoundedEventQueue,
  DEFAULT_MAX_QUEUED_BYTES,
  DEFAULT_MAX_QUEUED_EVENTS,
} from './event-queue';
import type { WebSocketConstructor } from './websocket-client-core';
import { createWebSocketConnectorAdapter } from './websocket-connector';

export interface ListenWebSocketEndpointOptions {
  readonly port: number;
  readonly host?: string;
  readonly maxPeers?: number;
  readonly maxQueuedBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly maxQueuedEvents?: number | undefined;
}

export interface ConnectWebSocketClientEndpointOptions {
  readonly maxQueuedEvents?: number | undefined;
}

/**
 * Creates the Node WebSocket adapter for the public NetEndpointConnector.
 * Each connect call accepts an AbortSignal and creates one replacement-capable
 * NetEndpoint. Transport lifecycle and EndpointError results stay here;
 * authoritative resync and replication policy stay with NetSession.
 */
export function createWebSocketConnector(
  url: string,
  options: ConnectWebSocketClientEndpointOptions = {},
): import('@forgeax/engine-net').NetEndpointConnector {
  return createWebSocketConnectorAdapter(
    {
      WebSocket: WebSocket as unknown as WebSocketConstructor,
      toBytes,
    },
    url,
    options,
  );
}

/**
 * Connects one Node WebSocket with the default one-shot AbortSignal.
 * Use createWebSocketConnector when the caller must cancel or replace an
 * endpoint through an explicit signal.
 */
export function connectWebSocketClientEndpoint(
  url: string,
  options: ConnectWebSocketClientEndpointOptions = {},
): Promise<Result<NetEndpoint, EndpointError>> {
  return createWebSocketConnector(url, options).connect(new AbortController().signal);
}

/**
 * Starts a Node WebSocket listener that exposes NetEndpoint peer events and
 * binary messages without owning NetSession or replication policy.
 */
export function listenWebSocketEndpoint(
  options: ListenWebSocketEndpointOptions,
): Promise<Result<NetEndpoint, EndpointError>> {
  return new Promise((resolve) => {
    const host = options.host ?? '127.0.0.1';
    const address = `ws://${host}:${options.port}`;
    const maxQueuedEvents = options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS;
    const maxPeers = options.maxPeers ?? 128;
    const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    try {
      new BoundedEventQueue(maxQueuedEvents, maxQueuedBytes);
      if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1)
        throw new RangeError('maxBufferedBytes must be a positive safe integer');
      if (!Number.isSafeInteger(maxPeers) || maxPeers < 1) {
        throw new RangeError('maxPeers must be a positive safe integer');
      }
    } catch (cause) {
      resolve(connectionFailed(address, cause));
      return;
    }

    // A disconnected peer occupies its slot until its terminal event is polled.
    // This bounds both data and unconsumed terminal notifications by maxPeers.
    const peers = new Map<PeerId, { socket: WebSocket; queue: BoundedEventQueue }>();
    let nextPeerId = 1;
    let settled = false;
    let closed = false;
    const server = new WebSocketServer({
      host,
      port: options.port,
      perMessageDeflate: false,
      maxPayload: maxQueuedBytes,
    });

    const endpoint: NetEndpoint = {
      poll: () => {
        const events: EndpointEvent[] = [];
        for (const [peerId, peer] of peers) {
          events.push(...peer.queue.drain());
          if (peer.queue.closed && peer.socket.readyState === peer.socket.CLOSED) {
            events.push({ kind: 'peer-disconnected', peerId });
            peers.delete(peerId);
          }
        }
        return events;
      },
      send: (peerId, data) => {
        if (closed) return alreadyClosed('The WebSocket listener endpoint is closed.');
        const peer = peers.get(peerId);
        const socket = peer?.socket;
        if (
          peer?.queue.closed ||
          (!socket && Number.isInteger(peerId) && peerId > 0 && peerId < nextPeerId)
        )
          return connectionClosed(peerId);
        if (!socket)
          return err(
            new EndpointError({
              code: 'peer-not-found',
              expected: ENDPOINT_EXPECTED['peer-not-found'],
              hint: ENDPOINT_ERROR_HINTS['peer-not-found'],
              detail: { peerId },
            }),
          );
        if (socket.readyState !== socket.OPEN) return connectionClosed(peerId);
        try {
          if (socket.bufferedAmount + data.byteLength > maxBufferedBytes)
            throw new Error('maxBufferedBytes exceeded; retry after the socket drains');
          socket.send(data, { binary: true });
          return ok(undefined);
        } catch (cause) {
          return err(
            new EndpointError({
              code: 'send-failed',
              expected: ENDPOINT_EXPECTED['send-failed'],
              hint: ENDPOINT_ERROR_HINTS['send-failed'],
              detail: { peerId, cause: normalizeCause(cause) },
            }),
          );
        }
      },
      disconnect: (peerId) => {
        if (closed) return alreadyClosed('The WebSocket listener endpoint is closed.');
        const peer = peers.get(peerId);
        if (!peer)
          return err(
            new EndpointError({
              code: 'peer-not-found',
              expected: ENDPOINT_EXPECTED['peer-not-found'],
              hint: ENDPOINT_ERROR_HINTS['peer-not-found'],
              detail: { peerId },
            }),
          );
        if (peer.queue.closed) return connectionClosed(peerId);
        peer.queue.close('Peer disconnect requested.');
        peer.socket.close();
        return ok(undefined);
      },
      close: () => {
        if (closed) return alreadyClosed('The WebSocket listener endpoint is already closed.');
        closed = true;
        for (const peer of peers.values()) {
          peer.queue.close('Listener closed.');
          peer.socket.close();
        }
        server.close();
        return ok(undefined);
      },
    };

    server.on('connection', (socket) => {
      if (closed || peers.size >= maxPeers) {
        socket.close();
        return;
      }
      const peerId = nextPeerId++ as PeerId;
      const queue = new BoundedEventQueue(maxQueuedEvents, maxQueuedBytes);
      peers.set(peerId, { socket, queue });
      queue.enqueue({ kind: 'peer-connected', peerId });
      socket.on('message', (data, isBinary) => {
        if (queue.closed) return;
        if (!isBinary) {
          socket.close();
          return;
        }
        const bytes = toBytes(data);
        if (!bytes) {
          socket.close();
          return;
        }
        if (!queue.enqueue({ kind: 'message', peerId, data: bytes })) socket.close();
      });
      socket.on('close', () => queue.close('Socket closed.'));
      socket.on('error', () => socket.close());
    });
    server.on('error', (cause) => {
      if (settled) return;
      settled = true;
      resolve(connectionFailed(address, cause));
    });
    server.on('listening', () => {
      if (settled) return;
      settled = true;
      resolve(ok(endpoint));
    });
  });
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array)
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return undefined;
}
