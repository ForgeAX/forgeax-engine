import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { NetEndpoint } from '@forgeax/engine-net';
import { connectWebSocketClientEndpoint, listenWebSocketEndpoint } from '@forgeax/engine-net-websocket/node';
import { expect, test } from 'vitest';

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No TCP address');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function scenario(overflow: boolean): Promise<unknown[]> {
  const port = await reservePort();
  const listener = (await listenWebSocketEndpoint({ port, maxQueuedEvents: 2 })).unwrap();
  const clients: NetEndpoint[] = [];
  try {
    const offender = (await connectWebSocketClientEndpoint(`ws://127.0.0.1:${port}`)).unwrap();
    clients.push(offender);
    listener.poll();
    const healthy = (await connectWebSocketClientEndpoint(`ws://127.0.0.1:${port}`)).unwrap();
    clients.push(healthy);
    const healthyConnected = listener.poll().find((event) => event.kind === 'peer-connected');
    expect(healthyConnected).toBeDefined();
    if (overflow) {
      for (let i = 0; i < 3; i++) offender.send(1 as never, Uint8Array.of(i)).unwrap();
      await expect.poll(() => offender.poll().some((event) => event.kind === 'peer-disconnected')).toBe(true);
      listener.poll();
    }
    healthy.send(1 as never, Uint8Array.of(42)).unwrap();
    const observed: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      observed.push(...listener.poll());
      if (observed.length > 0) break;
      await delay(10);
    }
    console.log(JSON.stringify({ case: 'healthy-peer-after-overflow', overflow, observed }));
    return observed;
  } finally {
    for (const endpoint of clients) endpoint.close();
    listener.close();
    await delay(20);
  }
}

test('control: a healthy peer delivers bytes without overflow', async () => {
  expect(await scenario(false)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'message', data: Uint8Array.of(42) })]));
});

test('R2-N1: overflowing one socket must not poison a different healthy peer', async () => {
  expect(await scenario(true)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'message', data: Uint8Array.of(42) })]));
});

test('retirement is single-shot, new peers recover, and listener churn frees its bounded slots', async () => {
  const port = await reservePort();
  const listener = (await listenWebSocketEndpoint({ port, maxPeers: 2, maxQueuedEvents: 2, maxQueuedBytes: 2, maxBufferedBytes: 2 })).unwrap();
  const clients: NetEndpoint[] = [];
  try {
    for (let round = 0; round < 20; round++) {
      const client = (await connectWebSocketClientEndpoint(`ws://127.0.0.1:${port}`)).unwrap();
      clients.push(client);
      const connected = listener.poll().find(event => event.kind === 'peer-connected');
      expect(connected).toBeDefined();
      if (connected === undefined) throw new Error('peer not admitted');
      expect(listener.send(connected.peerId, Uint8Array.of(1, 2, 3))).toMatchObject({ ok: false, error: { code: 'send-failed' } });
      listener.send(connected.peerId, Uint8Array.of(42)).unwrap();
      await expect.poll(() => client.poll().some(event => event.kind === 'message' && event.data[0] === 42)).toBe(true);
      client.close();
      const terminals: unknown[] = [];
      await expect.poll(() => { terminals.push(...listener.poll().filter(event => event.kind === 'peer-disconnected')); return terminals.length; }).toBe(1);
      expect(listener.poll()).toEqual([]);
      expect(listener.send(connected.peerId, Uint8Array.of(1))).toMatchObject({ ok: false, error: { code: 'connection-closed' } });
    }
  } finally {
    for (const client of clients) client.close();
    listener.close();
  }
});
