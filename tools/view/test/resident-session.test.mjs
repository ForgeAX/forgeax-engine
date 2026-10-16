import assert from 'node:assert/strict';
import test from 'node:test';
import { connect } from 'node:net';

import { WebSocket as NodeWebSocket } from 'ws';

import { createHostTransport } from '@forgeax/engine-host/transport';
import { startViewHostServer } from '@forgeax/view-workspace-core/resident';

function openSocket(url) {
  const socket = new NodeWebSocket(url);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function waitForEvent(events, predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = events.find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the resident host event');
}

test('resident host releases an upgraded peer that never acknowledges shutdown', async () => {
  const transport = createHostTransport();
  const server = await startViewHostServer({ transport, accessToken: 'shutdown-test' });
  const url = new URL(server.url);
  const socket = connect(Number(url.port), url.hostname);
  const closed = new Promise(resolve => socket.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', () => socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ));
      socket.once('data', bytes => {
        assert.match(bytes.toString(), /101 Switching Protocols/);
        resolve();
      });
    });
    // Drain the close frame without answering it, like a vanished browser realm.
    socket.on('data', () => {});
    let timer;
    try {
      await Promise.race([
        server.close().then(() => closed),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('resident host retained its upgraded socket')), 1000); }),
      ]);
    } finally { clearTimeout(timer); }
  } finally {
    socket.destroy();
    await server.close();
    transport.close();
  }
});

test('resident host admits every trusted frontend connection of a page', async () => {
  const transport = createHostTransport();
  const events = [];
  const server = await startViewHostServer({
    transport,
    accessToken: 'resident-test-token',
    onClientConnect: (caller) => events.push({ type: 'connect', kind: caller.kind, sourceId: caller.sourceId }),
    onClientDisconnect: (caller) => events.push({ type: 'disconnect', kind: caller.kind, sourceId: caller.sourceId }),
  });
  let first;
  let second;
  try {
    // Independent pages may each own a trusted frontend connection. Neither
    // may be closed just because the other connected.
    first = await openSocket(server.frontendUrl);
    second = await openSocket(server.frontendUrl);
    await waitForEvent(events, (event) => event.type === 'connect'
      && events.filter((entry) => entry.type === 'connect').length === 2);

    const connects = events.filter((event) => event.type === 'connect');
    assert.equal(connects.length, 2);
    assert.ok(connects.every((event) => event.kind === 'frontend' && event.sourceId === 'view-frontend'));
    assert.equal(first.readyState, NodeWebSocket.OPEN);
    assert.equal(second.readyState, NodeWebSocket.OPEN);

    // A refreshed page closes its previous sockets; the loss is still forwarded.
    first.close();
    const disconnect = await waitForEvent(
      events,
      (event) => event.type === 'disconnect' && event.kind === 'frontend' && event.sourceId === 'view-frontend',
    );
    assert.equal(disconnect.sourceId, 'view-frontend');
    assert.equal(second.readyState, NodeWebSocket.OPEN);
  } finally {
    first?.close();
    second?.close();
    await server.close();
  }
});

test('resident host still forwards ordinary CLI disconnects', async () => {
  const transport = createHostTransport();
  const events = [];
  const server = await startViewHostServer({
    transport,
    accessToken: 'resident-test-token',
    onClientConnect: (caller) => events.push({ type: 'connect', kind: caller.kind }),
    onClientDisconnect: (caller) => events.push({ type: 'disconnect', kind: caller.kind }),
  });
  let cli;
  try {
    cli = await openSocket(`${server.endpoint}?token=${encodeURIComponent('resident-test-token')}`);
    cli.close();
    await waitForEvent(events, (event) => event.type === 'disconnect' && event.kind === 'websocket');
    assert.equal(events.some((event) => event.type === 'connect'), false);
  } finally {
    cli?.close();
    await server.close();
  }
});
