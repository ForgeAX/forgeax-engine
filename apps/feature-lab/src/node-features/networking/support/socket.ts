import { createServer } from 'node:net';
import type { EndpointEvent, NetEndpoint } from '@forgeax/engine/net';
import { listenWebSocketEndpoint } from '@forgeax/engine/net-websocket/node';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function listen(): Promise<
  { readonly listener: NetEndpoint; readonly url: string } | string
> {
  const port = await freePort();
  const result = await listenWebSocketEndpoint({ port, host: '127.0.0.1', maxPeers: 4 });
  return result.ok
    ? { listener: result.value, url: `ws://127.0.0.1:${port}` }
    : `${result.error.code}: ${result.error.hint}`;
}

/** Polls an endpoint until `predicate` matches an event, collecting every event seen. */
export async function pollUntil(
  endpoint: NetEndpoint,
  predicate: (event: EndpointEvent) => boolean,
  timeoutMs = 3000,
): Promise<{
  readonly matched: EndpointEvent | undefined;
  readonly seen: readonly EndpointEvent[];
}> {
  const seen: EndpointEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const event of endpoint.poll()) {
      seen.push(event);
      if (predicate(event)) return { matched: event, seen };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { matched: undefined, seen };
}
