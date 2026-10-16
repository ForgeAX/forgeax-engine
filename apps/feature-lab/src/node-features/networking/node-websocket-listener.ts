import type { PeerId } from '@forgeax/engine/net';
import {
  connectWebSocketClientEndpoint,
  listenWebSocketEndpoint,
} from '@forgeax/engine/net-websocket/node';
import { defineFeature } from '../../lab/feature';
import { freePort, listen, pollUntil } from './support/socket';

export default defineFeature({
  title: 'Node WebSocket client and listener',
  catalog: 'Node WebSocket client/listener',
  kind: 'headless',
  summary:
    'listenWebSocketEndpoint({ port }) exposes a ws server as a NetEndpoint (each socket becomes a PeerId); connectWebSocketClientEndpoint(url) is the Node client. Only bytes and lifecycle cross; NetSession and profiles stay above.',
  expect:
    'All checks pass: the listener sees peer-connected, binary messages round-trip both ways intact, client close becomes peer-disconnected, an occupied port and an unreachable URL fail as connection-failed.',
  async run(checks) {
    const opened = await listen();
    if (typeof opened === 'string') {
      checks.ok('listener starts', false, opened);
      return;
    }
    const { listener, url } = opened;
    const client = await connectWebSocketClientEndpoint(url);
    checks.ok('Node client connects', client.ok, client.ok ? undefined : client.error.code);
    if (!client.ok) {
      listener.close();
      return;
    }
    const joined = await pollUntil(listener, (event) => event.kind === 'peer-connected');
    checks.ok('listener observes peer-connected', joined.matched !== undefined);
    const peer = joined.matched?.peerId ?? (0 as PeerId);
    const clientJoin = await pollUntil(client.value, (event) => event.kind === 'peer-connected');
    const server = clientJoin.matched?.peerId ?? (0 as PeerId);
    checks.ok('client observes the listener as a peer', clientJoin.matched !== undefined);
    checks.ok('client -> listener send ok', client.value.send(server, Uint8Array.of(7, 8, 9)).ok);
    const inbound = await pollUntil(listener, (event) => event.kind === 'message');
    checks.equal(
      'binary bytes arrive intact at the listener',
      inbound.matched?.kind === 'message' ? Array.from(inbound.matched.data) : [],
      [7, 8, 9],
    );
    checks.ok('listener -> client send ok', listener.send(peer, Uint8Array.of(255, 0, 1)).ok);
    const outbound = await pollUntil(client.value, (event) => event.kind === 'message');
    checks.equal(
      'binary bytes arrive intact at the client',
      outbound.matched?.kind === 'message' ? Array.from(outbound.matched.data) : [],
      [255, 0, 1],
    );
    const unknown = listener.send(999 as PeerId, Uint8Array.of(1));
    checks.ok(
      'send to an unknown peer is peer-not-found',
      !unknown.ok && unknown.error.code === 'peer-not-found',
      unknown.ok ? 'ok' : unknown.error.code,
    );
    client.value.close();
    const left = await pollUntil(listener, (event) => event.kind === 'peer-disconnected');
    checks.ok('client close becomes peer-disconnected', left.matched?.peerId === peer);
    const port = Number(new URL(url).port);
    const clash = await listenWebSocketEndpoint({ port, host: '127.0.0.1' });
    checks.ok(
      'occupied port fails as connection-failed',
      !clash.ok && clash.error.code === 'connection-failed',
      clash.ok ? 'ok' : clash.error.code,
    );
    if (clash.ok) clash.value.close();
    checks.ok('listener close ok', listener.close().ok);
    const unreachable = await connectWebSocketClientEndpoint(`ws://127.0.0.1:${await freePort()}`);
    checks.ok(
      'unreachable URL fails as connection-failed',
      !unreachable.ok && unreachable.error.code === 'connection-failed',
      unreachable.ok ? 'ok' : unreachable.error.code,
    );
  },
});
