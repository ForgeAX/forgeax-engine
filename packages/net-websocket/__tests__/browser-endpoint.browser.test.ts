import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import type { EndpointEvent, PeerId } from '@forgeax/engine-net';
import { connectWebSocketClientEndpoint } from '../src/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    startWebSocketListener(port?: number): Promise<{ id: string; url: string }>;
    pollWebSocketListener(id: string): Promise<SerializedEvent[]>;
    sendWebSocketListener(id: string, peerId: number, data: number[]): Promise<CommandResult>;
    closeWebSocketListener(id: string): Promise<CommandResult>;
  }
}

type SerializedEvent =
  | { kind: 'peer-connected' | 'peer-disconnected'; peerId: number }
  | { kind: 'message'; peerId: number; data: number[] };
type CommandResult = { ok: true } | { ok: false; code: string };

const invalidMaxQueuedEvents = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

describe('browser WebSocket endpoint', () => {
  it('returns connection-failed when no listener accepts the connection', async () => {
    const url = 'ws://127.0.0.1:1';
    const result = await connectWebSocketClientEndpoint(url);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('connection-failed');
      expect(result.error.detail.address).toBe(url);
    }
  });

  it('returns structured option failures before connect and retries the same URL', async () => {
    const listener = await commands.startWebSocketListener();
    try {
      for (const maxQueuedEvents of invalidMaxQueuedEvents) {
        const result = await connectWebSocketClientEndpoint(listener.url, { maxQueuedEvents });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('connection-failed');
          expect(result.error.detail.address).toBe(listener.url);
          expect(result.error.detail.cause).toBe('maxQueuedEvents must be a positive integer');
          expect(result.error.detail.cause.length).toBeLessThan(128);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await commands.pollWebSocketListener(listener.id)).toEqual([]);
      }

      const repaired = await connectWebSocketClientEndpoint(listener.url, { maxQueuedEvents: 4 });
      expect(repaired.ok).toBe(true);
      if (!repaired.ok) return;

      const connected = await listenerEvent(listener.id, 'peer-connected');
      const peerId = connected.peerId as PeerId;
      const browserBytes = new Uint8Array([21, 13, 8, 5]);
      const nodeBytes = new Uint8Array([3, 5, 8, 13]);

      expect(repaired.value.send(peerId, browserBytes).ok).toBe(true);
      const receivedByNode = await listenerEvent(listener.id, 'message');
      expect(receivedByNode.kind).toBe('message');
      if (receivedByNode.kind === 'message') {
        expect(receivedByNode.data).toEqual([...browserBytes]);
      }

      expect(await commands.sendWebSocketListener(listener.id, peerId, [...nodeBytes])).toEqual({ ok: true });
      const receivedByBrowser = await endpointEvent(repaired.value, 'message');
      expect(receivedByBrowser.kind).toBe('message');
      if (receivedByBrowser.kind === 'message') expect(receivedByBrowser.data).toEqual(nodeBytes);

      expect(repaired.value.close().ok).toBe(true);
      const repeatedClose = repaired.value.close();
      expect(repeatedClose.ok).toBe(false);
      if (!repeatedClose.ok) expect(repeatedClose.error.code).toBe('already-closed');
      expect((await listenerEvent(listener.id, 'peer-disconnected')).kind).toBe('peer-disconnected');
    } finally {
      expect((await commands.closeWebSocketListener(listener.id)).ok).toBe(true);
    }
  });
});

async function listenerEvent(id: string, kind: EndpointEvent['kind']): Promise<SerializedEvent> {
  const deadline = Date.now() + 2_000;
  const events: SerializedEvent[] = [];
  while (Date.now() < deadline) {
    events.push(...(await commands.pollWebSocketListener(id)));
    const event = events.find((item) => item.kind === kind);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for listener ${kind} event`);
}

async function endpointEvent(endpoint: { poll(): EndpointEvent[] }, kind: EndpointEvent['kind']): Promise<EndpointEvent> {
  const deadline = Date.now() + 2_000;
  const events: EndpointEvent[] = [];
  while (Date.now() < deadline) {
    events.push(...endpoint.poll());
    const event = events.find((item) => item.kind === kind);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for endpoint ${kind} event`);
}
