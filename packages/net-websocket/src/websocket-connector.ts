import type { NetEndpointConnector, PeerId } from '@forgeax/engine-net';
import {
  createWebSocketClientEndpoint,
  type WebSocketClientCoreOptions,
  type WebSocketConstructor,
} from './websocket-client-core';

export interface WebSocketConnectorOptions {
  readonly maxQueuedEvents?: number | undefined;
}

export interface WebSocketConnectorRuntime {
  readonly WebSocket: WebSocketConstructor;
  readonly toBytes: WebSocketClientCoreOptions['toBytes'];
}

export function createWebSocketConnectorAdapter(
  runtime: WebSocketConnectorRuntime,
  url: string,
  options: WebSocketConnectorOptions = {},
): NetEndpointConnector {
  let nextPeerId = 1;
  return {
    connect: (signal) => {
      const peerId = nextPeerId++ as PeerId;
      return createWebSocketClientEndpoint(runtime.WebSocket, {
        url,
        maxQueuedEvents: options.maxQueuedEvents,
        peerId,
        signal,
        toBytes: runtime.toBytes,
      });
    },
  };
}
