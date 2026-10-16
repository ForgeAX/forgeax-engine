import type { EndpointError, NetEndpoint, NetEndpointConnector } from '@forgeax/engine-net';
import type { Result } from '@forgeax/engine-types';
import type { WebSocketConstructor } from './websocket-client-core';
import {
  createWebSocketConnectorAdapter,
  type WebSocketConnectorOptions,
} from './websocket-connector';

export interface ConnectWebSocketClientEndpointOptions {
  readonly maxQueuedEvents?: number | undefined;
}

/**
 * Creates the browser WebSocket adapter for the public NetEndpointConnector.
 * Each connect call accepts an AbortSignal and creates one replacement-capable
 * NetEndpoint. Transport lifecycle and EndpointError results stay here;
 * authoritative resync and replication policy stay with NetSession.
 */
export function createWebSocketConnector(
  url: string,
  options: WebSocketConnectorOptions = {},
): NetEndpointConnector {
  return createWebSocketConnectorAdapter(
    { WebSocket: WebSocket as unknown as WebSocketConstructor, toBytes },
    url,
    options,
  );
}

/**
 * Connects one browser WebSocket with the default one-shot AbortSignal.
 * Use createWebSocketConnector when the caller must cancel or replace an
 * endpoint through an explicit signal.
 */
export function connectWebSocketClientEndpoint(
  url: string,
  options: ConnectWebSocketClientEndpointOptions = {},
): Promise<Result<NetEndpoint, EndpointError>> {
  return createWebSocketConnector(url, options).connect(new AbortController().signal);
}

function toBytes(data: unknown): Uint8Array | Promise<Uint8Array | undefined> | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return undefined;
}
