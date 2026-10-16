import { describe, expect, it } from 'vitest';
import {
  createWebSocketClientEndpoint,
  type WebSocketConstructor,
  type WebSocketLike,
} from '../src/websocket-client-core';

const invalidMaxQueuedEvents = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

describe('WebSocket client core option preflight', () => {
  it('fulfills structured failures before constructing a WebSocket', async () => {
    let constructions = 0;
    const WebSocket: WebSocketConstructor = class implements WebSocketLike {
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readonly readyState = this.CONNECTING;
      binaryType?: string;
      onopen: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onclose: ((event: unknown) => void) | null = null;

      constructor(_url: string) {
        constructions += 1;
      }

      send(_data: Uint8Array): void {}

      close(): void {}
    };
    const url = 'ws://127.0.0.1:8787';

    for (const maxQueuedEvents of invalidMaxQueuedEvents) {
      const result = await createWebSocketClientEndpoint(WebSocket, {
        url,
        maxQueuedEvents,
        toBytes: () => undefined,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('connection-failed');
        expect(result.error.detail.address).toBe(url);
        expect(result.error.detail.cause).toBe('maxQueuedEvents must be a positive integer');
      }
    }

    expect(constructions).toBe(0);
  });
});

it('bounds bytes waiting for asynchronous conversion before retaining more wire messages', async () => {
  let socket!: WebSocketLike;
  let closes = 0;
  let conversions = 0;
  class Socket implements WebSocketLike {
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readyState = this.OPEN;
    onopen: WebSocketLike['onopen'] = null;
    onmessage: WebSocketLike['onmessage'] = null;
    onerror: WebSocketLike['onerror'] = null;
    onclose: WebSocketLike['onclose'] = null;
    constructor() { socket = this; }
    send() {}
    close() { closes++; this.readyState = this.CLOSED; this.onclose?.({}); }
  }
  const connected = createWebSocketClientEndpoint(Socket, {
    url: 'ws://local',
    toBytes: async () => { conversions++; return new Uint8Array(); },
  });
  socket.onopen?.({});
  const endpoint = (await connected).unwrap();
  endpoint.poll();
  const data = new ArrayBuffer(5 * 1024 * 1024);
  socket.onmessage?.({ data });
  socket.onmessage?.({ data });
  expect(closes).toBe(1);
  expect(endpoint.poll().filter(event => event.kind === 'peer-disconnected')).toHaveLength(1);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(conversions).toBe(0);
  expect(endpoint.poll()).toEqual([]);
});
