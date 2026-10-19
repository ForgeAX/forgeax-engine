import type { NetEndpointConnector, PeerId } from '@forgeax/engine-net';
import {
  createWebSocketClientEndpoint,
  type WebSocketClientCoreOptions,
  type WebSocketConstructor,
} from './websocket-client-core';

export type ConnectWebSocketClientEndpointOptions = Pick<
  WebSocketClientCoreOptions,
  'maxQueuedEvents'
>;

interface WebSocketConnectorRuntime {
  readonly WebSocket: WebSocketConstructor;
  readonly toBytes: WebSocketClientCoreOptions['toBytes'];
}

export function createWebSocketConnectorAdapter(
  runtime: WebSocketConnectorRuntime,
  url: string,
  options: ConnectWebSocketClientEndpointOptions = {},
): NetEndpointConnector {
  let nextPeerId = 1;
  return {
    connect: (signal) => {
      const peerId = nextPeerId++ as PeerId;
      return createWebSocketClientEndpoint(runtime.WebSocket, {
        ...options,
        url,
        peerId,
        signal,
        toBytes: runtime.toBytes,
      });
    },
  };
}
