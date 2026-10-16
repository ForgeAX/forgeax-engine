import {
  ENDPOINT_ERROR_HINTS,
  ENDPOINT_EXPECTED,
  EndpointError,
  type EndpointEvent,
  type NetEndpoint,
  type NetEndpointConnector,
  type PeerId,
} from '@forgeax/engine-net';
import { err, ok, type Result } from '@forgeax/engine-types';

/** Task-local API: global wx.onSocket* callbacks cannot isolate attachments. */
export interface WechatSocketTask {
  onOpen(listener: () => void): void;
  onMessage(listener: (event: { readonly data: string | ArrayBuffer }) => void): void;
  onError(listener: (cause: unknown) => void): void;
  onClose(listener: (event: { readonly code: number; readonly reason: string }) => void): void;
  send(options: {
    readonly data: ArrayBuffer;
    readonly success: () => void;
    readonly fail: (cause: unknown) => void;
  }): void;
  close(options: { readonly code: number; readonly fail: (cause: unknown) => void }): void;
}

export interface WechatSocketSource {
  connectSocket(options: {
    readonly url: string;
    readonly header?: Readonly<Record<string, string>>;
    readonly protocols?: readonly string[];
    readonly fail: (cause: unknown) => void;
  }): WechatSocketTask;
}

export interface WechatSocketOptions {
  readonly header?: Readonly<Record<string, string>>;
  readonly protocols?: readonly string[];
  /** Incoming events and, independently, pending native send callbacks. Default 1024. */
  readonly maxQueuedEvents?: number;
  /** Unpolled incoming payload bytes. Default 8 MiB. */
  readonly maxQueuedBytes?: number;
  /** Bytes awaiting native send success/failure. Default 8 MiB. */
  readonly maxBufferedBytes?: number;
}

/** Each connect creates one attachment. NetSession owns reconnect and replication. */
export function createWechatSocketConnector(
  wx: WechatSocketSource,
  url: string,
  options: WechatSocketOptions = {},
): NetEndpointConnector {
  let nextPeerId = 1;
  return {
    connect(signal) {
      const maxQueuedEvents = options.maxQueuedEvents ?? 1024;
      const maxQueuedBytes = options.maxQueuedBytes ?? 8 * 1024 * 1024;
      const maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024;
      for (const [name, value] of Object.entries({
        maxQueuedEvents,
        maxQueuedBytes,
        maxBufferedBytes,
      })) {
        if (!Number.isSafeInteger(value) || value < 1)
          return Promise.resolve(
            err(connectionFailure(url, `${name} must be a positive safe integer`)),
          );
      }
      if (signal.aborted)
        return Promise.resolve(err(connectionFailure(url, signal.reason ?? 'Connection aborted')));
      if (typeof wx?.connectSocket !== 'function')
        return Promise.resolve(err(connectionFailure(url, 'wx.connectSocket is unavailable')));

      const peerId = nextPeerId++ as PeerId;
      return new Promise<Result<NetEndpoint, EndpointError>>((resolve) => {
        let state: 'connecting' | 'open' | 'remote-closed' | 'locally-closed' = 'connecting';
        let socket: WechatSocketTask | undefined;
        let terminalError: EndpointError | undefined;
        const events: EndpointEvent[] = [];
        let queuedBytes = 0;
        let pendingBytes = 0;
        let pendingSends = 0;
        let subscribing = true;
        let opened = false;

        const closed = () => state === 'remote-closed' || state === 'locally-closed';
        const closeTask = () => {
          try {
            socket?.close({
              code: 1000,
              fail: (cause) => {
                if (state === 'locally-closed') terminalError = alreadyClosed(cause);
              },
            });
          } catch (cause) {
            if (state === 'locally-closed') terminalError = alreadyClosed(cause);
          }
        };
        const retire = (failure: EndpointError, closeNative = true) => {
          if (closed()) return;
          const connecting = state === 'connecting';
          state = 'remote-closed';
          terminalError = failure;
          signal.removeEventListener('abort', abort);
          pendingBytes = pendingSends = 0;
          if (connecting) resolve(err(failure));
          else events.push({ kind: 'peer-disconnected', peerId });
          if (closeNative) closeTask();
        };
        const abort = () => {
          if (state === 'connecting')
            retire(connectionFailure(url, signal.reason ?? 'Connection aborted'));
        };
        const endpoint: NetEndpoint = {
          poll() {
            queuedBytes = 0;
            return events.splice(0);
          },
          send(target, data) {
            if (terminalError) return err(terminalError);
            if (target !== peerId) return err(peerNotFound(target));
            if (
              pendingSends >= maxQueuedEvents ||
              pendingBytes + data.byteLength > maxBufferedBytes
            )
              return err(
                sendFailure(
                  peerId,
                  'Native send buffer limit exceeded; wait for sends to complete',
                ),
              );
            // Snapshot exactly this view: native callbacks may outlive the caller's buffer.
            const bytes = new Uint8Array(data).buffer;
            pendingBytes += bytes.byteLength;
            pendingSends++;
            let settled = false;
            const complete = (failure?: EndpointError) => {
              if (settled) return;
              settled = true;
              if (state !== 'open') return;
              pendingBytes -= bytes.byteLength;
              pendingSends--;
              if (failure) retire(failure);
            };
            try {
              socket?.send({
                data: bytes,
                success: () => complete(),
                fail: (cause) => complete(sendFailure(peerId, cause)),
              });
            } catch (cause) {
              complete(sendFailure(peerId, cause));
            }
            return terminalError ? err(terminalError) : ok(undefined);
          },
          disconnect(target) {
            if (target !== peerId) return err(peerNotFound(target));
            if (closed()) return err(connectionClosed(peerId));
            retire(connectionClosed(peerId));
            return ok(undefined);
          },
          close() {
            if (closed())
              return err(
                terminalError?.code === 'already-closed' ? terminalError : alreadyClosed(),
              );
            const failure = alreadyClosed();
            events.length = 0;
            queuedBytes = 0;
            retire(failure, false);
            state = 'locally-closed';
            closeTask();
            return terminalError && terminalError !== failure ? err(terminalError) : ok(undefined);
          },
        };
        const admit = () => {
          if (closed()) {
            // Some native hosts cannot cancel before open. A late open never revives it.
            closeTask();
            return;
          }
          if (state !== 'connecting') return;
          opened = true;
          if (subscribing) return;
          state = 'open';
          signal.removeEventListener('abort', abort);
          events.push({ kind: 'peer-connected', peerId });
          resolve(ok(endpoint));
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        try {
          socket = wx.connectSocket({
            url,
            ...(options.header ? { header: options.header } : {}),
            ...(options.protocols ? { protocols: options.protocols } : {}),
            fail: (cause) => retire(connectionFailure(url, cause)),
          });
          socket.onOpen(admit);
          socket.onError((cause) => retire(connectionFailure(url, cause)));
          socket.onClose(({ code, reason }) => {
            retire(
              state === 'connecting'
                ? connectionFailure(url, `Socket closed before open (${code}): ${reason}`)
                : connectionClosed(peerId),
              false,
            );
          });
          socket.onMessage(({ data }) => {
            if (state !== 'open') return;
            if (!(data instanceof ArrayBuffer)) {
              retire(connectionFailure(url, 'SocketTask received a non-binary message'));
              return;
            }
            if (
              events.length >= maxQueuedEvents ||
              queuedBytes + data.byteLength > maxQueuedBytes
            ) {
              retire(connectionFailure(url, 'SocketTask incoming queue limit exceeded'));
              return;
            }
            queuedBytes += data.byteLength;
            events.push({ kind: 'message', peerId, data: new Uint8Array(data).slice() });
          });
          subscribing = false;
          if (closed()) closeTask();
          else if (signal.aborted) abort();
          else if (opened) admit();
        } catch (cause) {
          if (closed()) closeTask();
          else retire(connectionFailure(url, cause));
        }
      });
    },
  };
}

function nativeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  if (cause && typeof cause === 'object' && 'errMsg' in cause) return String(cause.errMsg);
  return String(cause);
}

function connectionFailure(address: string, cause: unknown): EndpointError {
  return new EndpointError({
    code: 'connection-failed',
    expected: ENDPOINT_EXPECTED['connection-failed'],
    hint: ENDPOINT_ERROR_HINTS['connection-failed'],
    detail: { address, cause: nativeCause(cause) },
  });
}

function sendFailure(peerId: PeerId, cause: unknown): EndpointError {
  return new EndpointError({
    code: 'send-failed',
    expected: ENDPOINT_EXPECTED['send-failed'],
    hint: ENDPOINT_ERROR_HINTS['send-failed'],
    detail: { peerId, cause: nativeCause(cause) },
  });
}

function peerNotFound(peerId: PeerId): EndpointError {
  return new EndpointError({
    code: 'peer-not-found',
    expected: ENDPOINT_EXPECTED['peer-not-found'],
    hint: ENDPOINT_ERROR_HINTS['peer-not-found'],
    detail: { peerId },
  });
}

function connectionClosed(peerId: PeerId): EndpointError {
  return new EndpointError({
    code: 'connection-closed',
    expected: ENDPOINT_EXPECTED['connection-closed'],
    hint: ENDPOINT_ERROR_HINTS['connection-closed'],
    detail: { peerId },
  });
}

function alreadyClosed(cause: unknown = 'Endpoint is closed'): EndpointError {
  return new EndpointError({
    code: 'already-closed',
    expected: ENDPOINT_EXPECTED['already-closed'],
    hint: ENDPOINT_ERROR_HINTS['already-closed'],
    detail: { cause: nativeCause(cause) },
  });
}
