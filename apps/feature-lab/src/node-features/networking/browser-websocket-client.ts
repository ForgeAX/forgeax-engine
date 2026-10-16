import type { PeerId } from '@forgeax/engine/net';
import {
  connectWebSocketClientEndpoint,
  createWebSocketConnector,
} from '@forgeax/engine/net-websocket/browser';
import { defineFeature } from '../../lab/feature';
import { listen, pollUntil } from './support/socket';

export default defineFeature({
  title: 'Browser WebSocket client',
  catalog: 'Browser WebSocket client',
  kind: 'headless',
  summary:
    'The browser entry maps the platform global WebSocket onto NetEndpoint bytes and lifecycle, with no retry or prediction. This runs the browser adapter against the Node listener through the WHATWG WebSocket global (Node 24), because a browser page has no listener to talk to.',
  expect:
    'All checks pass: the browser adapter connects, exchanges binary messages both ways, reports close as peer-disconnected on the listener, and an aborted connector signal fails as connection-failed without opening a socket.',
  async run(checks) {
    checks.ok('platform WebSocket global exists', typeof globalThis.WebSocket === 'function');
    const opened = await listen();
    if (typeof opened === 'string') {
      checks.ok('listener starts', false, opened);
      return;
    }
    const { listener, url } = opened;
    const client = await connectWebSocketClientEndpoint(url);
    checks.ok('browser adapter connects', client.ok, client.ok ? undefined : client.error.code);
    if (client.ok) {
      const joined = await pollUntil(listener, (event) => event.kind === 'peer-connected');
      const peer = joined.matched?.peerId ?? (0 as PeerId);
      const clientJoin = await pollUntil(client.value, (event) => event.kind === 'peer-connected');
      const server = clientJoin.matched?.peerId ?? (0 as PeerId);
      checks.ok(
        'both sides observe peer-connected',
        joined.matched !== undefined && clientJoin.matched !== undefined,
      );
      checks.ok('send ok', client.value.send(server, Uint8Array.of(1, 2)).ok);
      const inbound = await pollUntil(listener, (event) => event.kind === 'message');
      checks.equal(
        'listener receives the bytes',
        inbound.matched?.kind === 'message' ? Array.from(inbound.matched.data) : [],
        [1, 2],
      );
      listener.send(peer, Uint8Array.of(3, 4, 5));
      const outbound = await pollUntil(client.value, (event) => event.kind === 'message');
      checks.equal(
        'client receives binary bytes (ArrayBuffer or Blob decoded)',
        outbound.matched?.kind === 'message' ? Array.from(outbound.matched.data) : [],
        [3, 4, 5],
      );
      client.value.close();
      const left = await pollUntil(listener, (event) => event.kind === 'peer-disconnected');
      checks.ok('close reaches the listener as peer-disconnected', left.matched?.peerId === peer);
    }
    const aborted = new AbortController();
    aborted.abort();
    const refused = await createWebSocketConnector(url).connect(aborted.signal);
    checks.ok(
      'aborted signal fails as connection-failed',
      !refused.ok && refused.error.code === 'connection-failed',
      refused.ok ? 'ok' : refused.error.code,
    );
    listener.close();
  },
});
