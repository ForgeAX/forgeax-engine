import { commands } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import type { EndpointEvent, NetEndpoint, NetEndpointConnector, PeerId } from '@forgeax/engine-net';
import { connectWebSocketClientEndpoint } from '../src/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    startWebSocketListener(): Promise<{ id: string; url: string }>;
    pollWebSocketListener(id: string): Promise<SerializedEvent[]>;
    sendWebSocketListener(id: string, peerId: number, data: number[]): Promise<CommandResult>;
    closeWebSocketListener(id: string): Promise<CommandResult>;
  }
}

type SerializedEvent =
  | { readonly kind: 'peer-connected' | 'peer-disconnected'; readonly peerId: number }
  | { readonly kind: 'message'; readonly peerId: number; readonly data: number[] };
type CommandResult = { readonly ok: true } | { readonly ok: false; readonly code: string };

interface ConnectorEntry {
  readonly createWebSocketConnector?: (
    url: string,
    options?: { readonly maxQueuedEvents?: number },
  ) => NetEndpointConnector;
}

describe('browser WebSocket connector contract', () => {
  it('delivers ordered bytes and exposes a new PeerId after replacement', async () => {
    const listener = await commands.startWebSocketListener();
    try {
      const factory = await connectorFactory();
      const connector = factory(listener.url);
      const firstResult = await connector.connect(new AbortController().signal);
      expect(firstResult.ok).toBe(true);
      if (!firstResult.ok) return;
      const first = firstResult.value;
      const firstPeer = await listenerEvent(listener.id, 'peer-connected');
      const firstPeerId = firstPeer.peerId as PeerId;

      expect(await commands.sendWebSocketListener(listener.id, firstPeer.peerId, [8, 6, 7, 5])).toEqual({ ok: true });
      const received = await endpointEvent(first, 'message');
      expect(received.kind).toBe('message');
      if (received.kind === 'message') expect(received.data).toEqual(Uint8Array.of(8, 6, 7, 5));

      expect(first.send(firstPeerId, Uint8Array.of(1, 2, 3)).ok).toBe(true);
      const returned = await listenerEvent(listener.id, 'message');
      expect(returned.kind).toBe('message');
      if (returned.kind === 'message') expect(returned.data).toEqual([1, 2, 3]);

      expect(first.close().ok).toBe(true);
      await listenerEvent(listener.id, 'peer-disconnected');

      const secondResult = await connector.connect(new AbortController().signal);
      expect(secondResult.ok).toBe(true);
      if (!secondResult.ok) return;
      const second = secondResult.value;
      const secondPeer = await listenerEvent(listener.id, 'peer-connected');
      expect(secondPeer.peerId).not.toBe(firstPeer.peerId);
      expect(second.send(secondPeer.peerId as PeerId, Uint8Array.of(0xaa)).ok).toBe(true);
      const replacementMessage = await listenerEvent(listener.id, 'message');
      expect(replacementMessage.kind).toBe('message');
      if (replacementMessage.kind === 'message') expect(replacementMessage.data).toEqual([0xaa]);
      expect(second.close().ok).toBe(true);
    } finally {
      expect((await commands.closeWebSocketListener(listener.id)).ok).toBe(true);
    }
  });

  it('reports invalid queue bounds before opening a browser socket', async () => {
    const listener = await commands.startWebSocketListener();
    try {
      const factory = await connectorFactory();
      const result = await factory(listener.url, { maxQueuedEvents: 0 }).connect(
        new AbortController().signal,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('connection-failed');
        expect(result.error.detail.address).toBe(listener.url);
        expect(result.error.detail.cause).toContain('maxQueuedEvents');
      }
      expect(await commands.pollWebSocketListener(listener.id)).toEqual([]);
    } finally {
      expect((await commands.closeWebSocketListener(listener.id)).ok).toBe(true);
    }
  });
});

async function connectorFactory(): Promise<NonNullable<ConnectorEntry['createWebSocketConnector']>> {
  const entry = (await import('../src/browser')) as unknown as ConnectorEntry;
  expect(entry.createWebSocketConnector).toBeTypeOf('function');
  if (entry.createWebSocketConnector === undefined)
    throw new Error('Browser connector factory is not exported');
  return entry.createWebSocketConnector;
}

async function listenerEvent(id: string, kind: SerializedEvent['kind']): Promise<SerializedEvent> {
  const deadline = Date.now() + 2_000;
  const events: SerializedEvent[] = [];
  while (Date.now() < deadline) {
    events.push(...(await commands.pollWebSocketListener(id)));
    const event = events.find((item) => item.kind === kind);
    if (event !== undefined) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for listener ${kind} event`);
}

async function endpointEvent(endpoint: NetEndpoint, kind: EndpointEvent['kind']): Promise<EndpointEvent> {
  const deadline = Date.now() + 2_000;
  const events: EndpointEvent[] = [];
  while (Date.now() < deadline) {
    events.push(...endpoint.poll());
    const event = events.find((item) => item.kind === kind);
    if (event !== undefined) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for endpoint ${kind} event`);
}
