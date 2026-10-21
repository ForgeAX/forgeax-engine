import {
  EndpointError,
  type EndpointEvent,
  type NetEndpoint,
  type PeerId,
} from '@forgeax/engine-net';
import { err, ok, type Result } from '@forgeax/engine-types';
import { alreadyClosed, connectionClosed, connectionFailed, normalizeCause } from './errors';
import {
  BoundedEventQueue,
  DEFAULT_MAX_QUEUED_BYTES,
  DEFAULT_MAX_QUEUED_EVENTS,
} from './event-queue';

export interface WebSocketLike {
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
  readonly readyState: number;
  readonly bufferedAmount?: number;
  binaryType?: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export interface WebSocketConstructor {
  new (url: string): WebSocketLike;
}

export interface WebSocketClientCoreOptions {
  readonly url: string;
  readonly maxQueuedEvents?: number | undefined;
  readonly peerId?: PeerId;
  readonly signal?: AbortSignal;
  readonly toBytes: (data: unknown) => Uint8Array | Promise<Uint8Array | undefined> | undefined;
}

type ClientState = 'connecting' | 'open' | 'failed' | 'remote-closed' | 'locally-closed';

const CLIENT_PEER_ID = 1 as PeerId;

export function createWebSocketClientEndpoint(
  WebSocket: WebSocketConstructor,
  options: WebSocketClientCoreOptions,
): Promise<Result<NetEndpoint, EndpointError>> {
  return new Promise((resolve) => {
    const clientPeerId = options.peerId ?? CLIENT_PEER_ID;
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) {
      resolve(connectionFailed(options.url, 'WebSocket connection aborted.'));
      return;
    }

    let queue: BoundedEventQueue;
    try {
      queue = new BoundedEventQueue(options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS);
    } catch (cause) {
      resolve(connectionFailed(options.url, cause));
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = new WebSocket(options.url);
    } catch (cause) {
      resolve(connectionFailed(options.url, cause));
      return;
    }

    const terminalEvents: EndpointEvent[] = [];
    let state: ClientState = 'connecting';
    const closed = (): boolean => state !== 'connecting' && state !== 'open';
    let messageTail = Promise.resolve();
    let pendingMessages = 0;
    let pendingBytes = 0;

    const removeAbortListener = (): void => {
      signal.removeEventListener('abort', abortPendingConnection);
    };

    const releaseSocket = (): void => {
      removeAbortListener();
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      // Node ws can emit an asynchronous error while closing a connecting
      // socket. Keep a capture-free sink after releasing endpoint callbacks.
      socket.onerror = () => {};
      if (socket.readyState !== socket.CLOSED && socket.readyState !== socket.CLOSING) {
        try {
          socket.close();
        } catch {
          /* Platform retirement is best effort. */
        }
      }
    };

    const failConnection = (cause: unknown): void => {
      if (state !== 'connecting') return;
      state = 'failed';
      releaseSocket();
      resolve(connectionFailed(options.url, cause));
    };
    const abortPendingConnection = (): void => failConnection('WebSocket connection aborted.');

    signal.addEventListener('abort', abortPendingConnection, { once: true });
    if (signal.aborted) {
      abortPendingConnection();
      return;
    }

    const disconnect = (
      reason: string,
      terminal: 'remote-closed' | 'locally-closed' = 'remote-closed',
    ): void => {
      if (closed()) return;
      state = terminal;
      queue.close(reason);
      terminalEvents.push({ kind: 'peer-disconnected', peerId: clientPeerId });
      releaseSocket();
    };

    try {
      socket.binaryType = 'arraybuffer';
    } catch (cause) {
      failConnection(cause);
      return;
    }

    const endpoint: NetEndpoint = {
      poll: () => [...queue.drain(), ...terminalEvents.splice(0)],
      send: (peerId, data) => {
        if (closed())
          return state === 'locally-closed' ? alreadyClosed() : connectionClosed(peerId);
        if (peerId !== clientPeerId)
          return err(
            new EndpointError({
              code: 'peer-not-found',
              detail: { peerId },
            }),
          );
        if (socket.readyState !== socket.OPEN) return connectionClosed(peerId);
        try {
          if ((socket.bufferedAmount ?? 0) + data.byteLength > DEFAULT_MAX_QUEUED_BYTES)
            throw new Error('send buffer limit exceeded; retry after the socket drains');
          socket.send(data);
          return ok(undefined);
        } catch (cause) {
          return err(
            new EndpointError({
              code: 'send-failed',
              detail: { peerId, cause: normalizeCause(cause) },
            }),
          );
        }
      },
      disconnect: (peerId) => {
        if (peerId !== clientPeerId)
          return err(
            new EndpointError({
              code: 'peer-not-found',
              detail: { peerId },
            }),
          );
        if (closed()) return connectionClosed(peerId);
        disconnect('Peer disconnect requested.');
        return ok(undefined);
      },
      close: () => {
        if (closed()) return alreadyClosed('The WebSocket endpoint is already closed.');
        disconnect('Endpoint close requested.', 'locally-closed');
        return ok(undefined);
      },
    };

    socket.onopen = () => {
      if (state !== 'connecting') return;
      removeAbortListener();
      state = 'open';
      queue.enqueue({ kind: 'peer-connected', peerId: clientPeerId });
      resolve(ok(endpoint));
    };
    socket.onmessage = ({ data }) => {
      if (closed() || queue.closed) return;
      const byteLength =
        data instanceof ArrayBuffer || ArrayBuffer.isView(data)
          ? data.byteLength
          : typeof Blob !== 'undefined' && data instanceof Blob
            ? data.size
            : 0;
      if (
        pendingMessages >= queue.maxQueuedEvents ||
        pendingBytes + byteLength > queue.maxQueuedBytes
      ) {
        disconnect('Message conversion queue overflow.');
        return;
      }
      pendingMessages += 1;
      pendingBytes += byteLength;
      // Blob.arrayBuffer() is asynchronous. Serialize conversion so that
      // ordered WebSocket messages retain their wire order after decoding.
      messageTail = messageTail
        .then(async () => {
          if (closed() || queue.closed) return;
          const bytes = await options.toBytes(data);
          if (!bytes || closed()) return;
          if (!queue.enqueue({ kind: 'message', peerId: clientPeerId, data: bytes })) {
            disconnect(queue.disconnectReason ?? 'Message queue overflow.');
          }
        })
        .catch(() => undefined)
        .finally(() => {
          pendingMessages -= 1;
          pendingBytes -= byteLength;
        });
    };
    socket.onerror = (cause) => {
      if (state === 'open') disconnect(`WebSocket error: ${normalizeCause(cause)}`);
      else failConnection(cause);
    };
    socket.onclose = (cause) => {
      if (state === 'connecting') failConnection(cause);
      else disconnect(`WebSocket closed: ${normalizeCause(cause)}`);
    };
  });
}
