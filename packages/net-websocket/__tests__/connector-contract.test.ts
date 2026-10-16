import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import type {
  EndpointError,
  EndpointEvent,
  NetEndpoint,
  NetEndpointConnector,
  PeerId,
} from '@forgeax/engine-net';
import { listenWebSocketEndpoint } from '../src/node';

interface ConnectorEntry {
  readonly createWebSocketConnector?: (
    url: string,
    options?: { readonly maxQueuedEvents?: number },
  ) => NetEndpointConnector;
}

describe('Node WebSocket connector contract', () => {
  it('delivers ordered bytes and assigns a new PeerId after replacement', async () => {
    const port = await reservePort();
    const address = `ws://127.0.0.1:${port}`;
    const listenerResult = await listenWebSocketEndpoint({ port });
    expect(listenerResult.ok).toBe(true);
    if (!listenerResult.ok) return;
    const listener = listenerResult.value;

    try {
      const factory = await connectorFactory();
      const connector = factory(address);
      const firstResult = await connector.connect(new AbortController().signal);
      expect(firstResult.ok).toBe(true);
      if (!firstResult.ok) return;
      const first = firstResult.value;
      const firstPeer = await eventOf(listener, 'peer-connected');
      expect(firstPeer.kind).toBe('peer-connected');
      if (firstPeer.kind !== 'peer-connected') return;

      const outbound = Uint8Array.of(0x03, 0x01, 0x04, 0x01, 0x05);
      expect(first.send(firstPeer.peerId, outbound).ok).toBe(true);
      const received = await eventOf(listener, 'message');
      expect(received.kind).toBe('message');
      if (received.kind === 'message') expect(received.data).toEqual(outbound);

      expect(listener.send(firstPeer.peerId, Uint8Array.of(0x09, 0x02)).ok).toBe(true);
      const returned = await eventOf(first, 'message');
      expect(returned.kind).toBe('message');
      if (returned.kind === 'message') expect(returned.data).toEqual(Uint8Array.of(0x09, 0x02));

      expect(first.close().ok).toBe(true);
      await eventOf(listener, 'peer-disconnected');

      const secondResult = await connector.connect(new AbortController().signal);
      expect(secondResult.ok).toBe(true);
      if (!secondResult.ok) return;
      const second = secondResult.value;
      const secondPeer = await eventOf(listener, 'peer-connected');
      expect(secondPeer.kind).toBe('peer-connected');
      if (secondPeer.kind !== 'peer-connected') return;
      expect(secondPeer.peerId).not.toBe(firstPeer.peerId);
      expect(second.send(secondPeer.peerId, Uint8Array.of(0xaa)).ok).toBe(true);
      const replacementMessage = await eventOf(listener, 'message');
      expect(replacementMessage.kind).toBe('message');
      if (replacementMessage.kind === 'message')
        expect(replacementMessage.data).toEqual(Uint8Array.of(0xaa));
      expect(second.close().ok).toBe(true);
    } finally {
      listener.close();
    }
  });

  it('closes the client endpoint when its bounded queue overflows', async () => {
    const port = await reservePort();
    const listenerResult = await listenWebSocketEndpoint({ port });
    expect(listenerResult.ok).toBe(true);
    if (!listenerResult.ok) return;
    const listener = listenerResult.value;

    try {
      const factory = await connectorFactory();
      const result = await factory(`ws://127.0.0.1:${port}`, { maxQueuedEvents: 1 }).connect(
        new AbortController().signal,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const client = result.value;
      const connected = await eventOf(listener, 'peer-connected');
      expect(connected.kind).toBe('peer-connected');
      if (connected.kind !== 'peer-connected') return;

      expect(listener.send(connected.peerId, Uint8Array.of(1)).ok).toBe(true);
      expect(listener.send(connected.peerId, Uint8Array.of(2)).ok).toBe(true);
      const events = await eventsUntil(client, (items) =>
        items.some((event) => event.kind === 'peer-disconnected'),
      );
      expect(events.some((event) => event.kind === 'peer-disconnected')).toBe(true);
    } finally {
      listener.close();
    }
  });

  it('returns a structured preflight failure for an invalid queue bound', async () => {
    const factory = await connectorFactory();
    const result = await factory('ws://127.0.0.1:1', { maxQueuedEvents: 0 }).connect(
      new AbortController().signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('connection-failed');
      expect(result.error.detail.address).toBe('ws://127.0.0.1:1');
      expect(result.error.detail.cause).toContain('maxQueuedEvents');
    }
  });
});

async function connectorFactory(): Promise<NonNullable<ConnectorEntry['createWebSocketConnector']>> {
  const entry = (await import('../src/node')) as unknown as ConnectorEntry;
  expect(entry.createWebSocketConnector).toBeTypeOf('function');
  if (entry.createWebSocketConnector === undefined)
    throw new Error('Node connector factory is not exported');
  return entry.createWebSocketConnector;
}

async function eventOf(endpoint: NetEndpoint, kind: EndpointEvent['kind']): Promise<EndpointEvent> {
  const events = await eventsUntil(endpoint, (items) => items.some((event) => event.kind === kind));
  const event = events.find((item) => item.kind === kind);
  if (event === undefined) throw new Error(`Expected ${kind} event`);
  return event;
}

async function eventsUntil(
  endpoint: NetEndpoint,
  predicate: (events: EndpointEvent[]) => boolean,
): Promise<EndpointEvent[]> {
  const events: EndpointEvent[] = [];
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    events.push(...endpoint.poll());
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for endpoint events');
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  await closeServer(server);
  return address.port;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
