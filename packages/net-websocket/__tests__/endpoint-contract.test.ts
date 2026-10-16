import { createServer } from 'node:net';
import { describe } from 'vitest';
import type { NetEndpoint } from '@forgeax/engine-net';
import { runEndpointBehaviorSuite } from '../../net/__tests__/endpoint-behavior.contract';
import {
  connectWebSocketClientEndpoint,
  listenWebSocketEndpoint,
} from '../src/node';

describe('Node WebSocket listener endpoint', () => {
  runEndpointBehaviorSuite(createListenerHarness);
});

describe('Node WebSocket client endpoint', () => {
  runEndpointBehaviorSuite(createClientHarness);
});

async function createListenerHarness(): Promise<{
  endpoints: [NetEndpoint, NetEndpoint];
  cleanup: () => Promise<void>;
}> {
  const { listener, client } = await createPair();
  return { endpoints: [listener, client], cleanup: () => closePair(listener, client) };
}

async function createClientHarness(): Promise<{
  endpoints: [NetEndpoint, NetEndpoint];
  cleanup: () => Promise<void>;
}> {
  const { listener, client } = await createPair();
  return { endpoints: [client, listener], cleanup: () => closePair(listener, client) };
}

async function createPair(): Promise<{ listener: NetEndpoint; client: NetEndpoint }> {
  const port = await reservePort();
  const listenerResult = await listenWebSocketEndpoint({ port });
  if (!listenerResult.ok) throw listenerResult.error;
  const clientResult = await connectWebSocketClientEndpoint(`ws://127.0.0.1:${port}`);
  if (!clientResult.ok) {
    listenerResult.value.close();
    throw clientResult.error;
  }
  return { listener: listenerResult.value, client: clientResult.value };
}

async function closePair(listener: NetEndpoint, client: NetEndpoint): Promise<void> {
  client.close();
  listener.close();
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
