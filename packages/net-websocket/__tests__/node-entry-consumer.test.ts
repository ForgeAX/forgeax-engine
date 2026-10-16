import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { EndpointEvent, NetEndpoint, PeerId } from '@forgeax/engine-net';
import {
  connectWebSocketClientEndpoint,
  createWebSocketConnector,
  listenWebSocketEndpoint,
} from '../src/node';

const endpoints: NetEndpoint[] = [];
const invalidMaxQueuedEvents = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

afterEach(() => {
  for (const endpoint of endpoints.splice(0)) endpoint.close();
});

describe('Node WebSocket endpoint entry', () => {
  it('disconnects one actual peer while the listener and another peer stay usable', async () => {
    const port = await reservePort();
    const listener = track((await listenWebSocketEndpoint({ port })).unwrap());
    const first = track((await connectWebSocketClientEndpoint(`ws://127.0.0.1:${port}`)).unwrap());
    const firstPeer = await connectedPeer(listener);
    await connectedPeer(first);
    const second = track((await connectWebSocketClientEndpoint(`ws://127.0.0.1:${port}`)).unwrap());
    const secondPeer = await connectedPeer(listener);
    await connectedPeer(second);
    expect(listener.disconnect(firstPeer).ok).toBe(true);
    expect(await eventOf(first, 'peer-disconnected')).toMatchObject({kind:'peer-disconnected'});
    expect(await eventOf(listener, 'peer-disconnected')).toMatchObject({peerId:firstPeer});
    expect(first.send(1 as PeerId,new Uint8Array([1])).ok).toBe(false);
    const bytes=new Uint8Array([3,1,4]);
    expect(second.send(1 as PeerId,bytes).ok).toBe(true);
    expect(await eventOf(listener,'message')).toMatchObject({peerId:secondPeer,data:bytes});
    expect(listener.send(secondPeer,bytes).ok).toBe(true);
    expect(await eventOf(second,'message')).toMatchObject({data:bytes});
    expect(second.disconnect(1 as PeerId).ok).toBe(true);
    expect(await eventOf(listener,'peer-disconnected')).toMatchObject({peerId:secondPeer});
    const third=track((await connectWebSocketClientEndpoint(`ws://127.0.0.1:${port}`)).unwrap());
    expect(await connectedPeer(listener)).toBeGreaterThan(secondPeer);
    expect((await connectedPeer(third))).toBe(1);
  });

  it('returns bounded structured listener option failures before bind and retries the same port', async () => {
    const port = await reservePort();
    const address = `ws://127.0.0.1:${port}`;

    for (const maxQueuedEvents of invalidMaxQueuedEvents) {
      const result = await listenWebSocketEndpoint({ port, maxQueuedEvents });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('connection-failed');
        expect(result.error.detail.address).toBe(address);
        expect(result.error.detail.cause).toBe('maxQueuedEvents must be a positive integer');
        expect(result.error.detail.cause.length).toBeLessThan(128);
      }
    }

    const repaired = await listenWebSocketEndpoint({ port, maxQueuedEvents: 4 });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    const listener = track(repaired.value);

    expect(listener.close().ok).toBe(true);
    const reused = await listenWebSocketEndpoint({ port, maxQueuedEvents: 4 });
    expect(reused.ok).toBe(true);
    if (reused.ok) {
      track(reused.value);
      expect(reused.value.close().ok).toBe(true);
    }
  });

  it('returns structured client option failures without a peer and retries the same URL', async () => {
    const port = await reservePort();
    const url = `ws://127.0.0.1:${port}`;
    const started = await listenWebSocketEndpoint({ port });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const listener = track(started.value);

    for (const maxQueuedEvents of invalidMaxQueuedEvents) {
      const result = await connectWebSocketClientEndpoint(url, { maxQueuedEvents });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('connection-failed');
        expect(result.error.detail.address).toBe(url);
        expect(result.error.detail.cause).toBe('maxQueuedEvents must be a positive integer');
        expect(result.error.detail.cause.length).toBeLessThan(128);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(listener.poll()).toEqual([]);
    }

    const repaired = await connectWebSocketClientEndpoint(url, { maxQueuedEvents: 4 });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    const client = track(repaired.value);
    const peerId = await connectedPeer(listener);
    const bytes = new Uint8Array([11, 7, 3, 1]);

    expect(client.send(peerId, bytes).ok).toBe(true);
    const received = await eventOf(listener, 'message');
    expect(received.kind).toBe('message');
    if (received.kind === 'message') expect(received.data).toEqual(bytes);

    expect(client.close().ok).toBe(true);
    const repeatedClose = client.close();
    expect(repeatedClose.ok).toBe(false);
    if (!repeatedClose.ok) expect(repeatedClose.error.code).toBe('already-closed');
    expect((await eventOf(listener, 'peer-disconnected')).kind).toBe('peer-disconnected');
  });

  it('reports listener bind failures as connection-failed', async () => {
    const port = await reservePort();
    const holder = createServer();
    await listen(holder, port);

    try {
      const result = await listenWebSocketEndpoint({ port });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('connection-failed');
        expect(result.error.detail.address).toContain(String(port));
      }
    } finally {
      await closeServer(holder);
    }
  });

  it('reports a failed client connection with its URL', async () => {
    const port = await reservePort();
    const url = `ws://127.0.0.1:${port}`;

    const result = await connectWebSocketClientEndpoint(url);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('connection-failed');
      expect(result.error.detail.address).toBe(url);
    }
  });

  it('uses exact Buffer slices for received message bytes', async () => {
    const { listener, client } = await createConnectedEndpoints();
    const peerId = await connectedPeer(listener);
    const data = new Uint8Array([8, 7, 6]).subarray(1);

    expect(client.send(peerId, data).ok).toBe(true);

    const event = await eventOf(listener, 'message');
    expect(event.kind).toBe('message');
    if (event.kind === 'message') expect(event.data).toEqual(new Uint8Array([7, 6]));
  });

  it('closes an overflowing listener queue with a disconnect lifecycle event', async () => {
    const { listener, client } = await createConnectedEndpoints({ maxQueuedEvents: 1 });
    const peerId = await connectedPeer(listener);

    expect(client.send(peerId, new Uint8Array([1])).ok).toBe(true);
    expect(client.send(peerId, new Uint8Array([2])).ok).toBe(true);

    const events = await eventsUntil(listener, (items) =>
      items.some((event) => event.kind === 'peer-disconnected'),
    );
    expect(events.some((event) => event.kind === 'peer-disconnected')).toBe(true);
  });

  it('supports listener lifecycle and multiple WebSocket clients', async () => {
    const port = await reservePort();
    const started = await listenWebSocketEndpoint({ port });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const listener = track(started.value);

    const first = await connectWebSocketClientEndpoint(`ws://127.0.0.1:${port}`);
    const second = await connectWebSocketClientEndpoint(`ws://127.0.0.1:${port}`);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const firstClient = track(first.value);
    track(second.value);

    const connectedPeerIds = await peerIds(listener, 2);
    expect(firstClient.send(connectedPeerIds[0]!, new Uint8Array([5, 4])).ok).toBe(true);
    const message = await eventOf(listener, 'message');
    expect(message.kind).toBe('message');

    expect(listener.close().ok).toBe(true);
  });

  it('creates a ready Node client endpoint that can roundtrip and close', async () => {
    const { listener, client } = await createConnectedEndpoints();
    const peerId = await connectedPeer(listener);

    expect(client.send(peerId, new Uint8Array([3, 2, 1])).ok).toBe(true);
    const received = await eventOf(listener, 'message');
    expect(received.kind).toBe('message');

    expect(client.close().ok).toBe(true);
    expect((await eventOf(listener, 'peer-disconnected')).kind).toBe('peer-disconnected');
  });

  it('aborts a pending Node connection with a structured failure and closes its socket', async () => {
    const server = createServer();
    let acceptedSocket: Socket | undefined;
    const accepted = new Promise<void>((resolve) => {
      server.once('connection', (socket) => {
        acceptedSocket = socket;
        socket.on('error', () => undefined);
        resolve();
      });
    });
    await listen(server, 0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    const url = `ws://127.0.0.1:${address.port}`;

    try {
      expect(createWebSocketConnector).toBeTypeOf('function');
      const controller = new AbortController();
      const pending = createWebSocketConnector(url).connect(controller.signal);
      await accepted;
      controller.abort();
      controller.abort();

      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('connection-failed');
        expect(result.error.detail.address).toBe(url);
        expect(result.error.detail.cause).toMatch(/abort/i);
      }
    } finally {
      acceptedSocket?.destroy();
      await closeServer(server);
    }
  });
});

async function createConnectedEndpoints(options: { maxQueuedEvents?: number } = {}): Promise<{
  listener: NetEndpoint;
  client: NetEndpoint;
}> {
  const port = await reservePort();
  const started = await listenWebSocketEndpoint({ port, ...options });
  if (!started.ok) throw started.error;
  const listener = track(started.value);
  const connected = await connectWebSocketClientEndpoint(`ws://127.0.0.1:${port}`, options);
  if (!connected.ok) throw connected.error;
  return { listener, client: track(connected.value) };
}

function track(endpoint: NetEndpoint): NetEndpoint {
  endpoints.push(endpoint);
  return endpoint;
}

async function connectedPeer(endpoint: NetEndpoint): Promise<PeerId> {
  const event = await eventOf(endpoint, 'peer-connected');
  if (event.kind !== 'peer-connected') throw new Error('Expected peer-connected event');
  return event.peerId;
}

async function peerIds(endpoint: NetEndpoint, count: number): Promise<PeerId[]> {
  const events = await eventsUntil(
    endpoint,
    (items) => items.filter((event) => event.kind === 'peer-connected').length >= count,
  );
  return events
    .filter((event): event is Extract<EndpointEvent, { kind: 'peer-connected' }> => event.kind === 'peer-connected')
    .map((event) => event.peerId);
}

async function eventOf(endpoint: NetEndpoint, kind: EndpointEvent['kind']): Promise<EndpointEvent> {
  const events = await eventsUntil(endpoint, (items) => items.some((event) => event.kind === kind));
  const event = events.find((item) => item.kind === kind);
  if (!event) throw new Error(`Expected ${kind} event`);
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

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
