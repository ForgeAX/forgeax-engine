import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { createHostTransport, attachHostWebSocketServer } from '@forgeax/engine-host/transport';
import { createNetworkBroker } from '../../src/app/broker.mjs';

test('a vanished App reader retires its Node socket while another App keeps polling', async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const transport = createHostTransport();
  server.on('connection', socket => attachHostWebSocketServer(socket, transport));
  const broker = createNetworkBroker({ viewUrl: `http://127.0.0.1:${server.address().port}/` }, { hostIdleMs: 100 });
  let keepAlive;
  try {
    const open = () => broker.invoke({ action: 'host-open', url: `ws://127.0.0.1:${server.address().port}/` });
    const abandoned = await open();
    const healthy = await open();
    keepAlive = setInterval(() => void broker.invoke({ action: 'host-read', connectionId: healthy.connectionId }), 20);
    const deadline = performance.now() + 1000;
    while (server.clients.size !== 1 && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(server.clients.size, 1, 'only the live sibling retains a socket');
    const healthyRead = await broker.invoke({ action: 'host-read', connectionId: healthy.connectionId });
    assert.equal(JSON.parse(Buffer.from(healthyRead.base64, 'base64')).closed, false);
    const read = await broker.invoke({ action: 'host-read', connectionId: abandoned.connectionId });
    assert.equal(JSON.parse(Buffer.from(read.base64, 'base64')).closed, true);
    await assert.rejects(broker.invoke({ action: 'host-request', connectionId: abandoned.connectionId, service: 'query', requestId: 'late' }), /retired/);
  } finally {
    clearInterval(keepAlive);
    broker.close();
    transport.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('closing one App document revokes only its sockets and denies sibling access', async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const transport = createHostTransport();
  server.on('connection', socket => attachHostWebSocketServer(socket, transport));
  const url = `ws://127.0.0.1:${server.address().port}/`;
  const broker = createNetworkBroker({ viewUrl: url.replace('ws:', 'http:') });
  try {
    const first = await broker.invoke({ action: 'host-open', url, appDocumentId: 'first' });
    const second = await broker.invoke({ action: 'host-open', url, appDocumentId: 'second' });
    await assert.rejects(broker.invoke({ action: 'host-close', connectionId: first.connectionId, appDocumentId: 'second' }), /another App/);
    await assert.rejects(broker.invoke({ action: 'host-read', connectionIds: [first.connectionId], appDocumentId: 'second' }), /another App/);
    broker.closeDocument('first');
    const read = await broker.invoke({ action: 'host-read', connectionId: second.connectionId, appDocumentId: 'second' });
    assert.equal(JSON.parse(Buffer.from(read.base64, 'base64')).closed, false);
    await assert.rejects(broker.invoke({ action: 'host-request', connectionId: first.connectionId, appDocumentId: 'first', service: 'query', requestId: 'late' }), /retired/);
  } finally { broker.close(); transport.close(); await new Promise(resolve => server.close(resolve)); }
});

test('a broker event-loop stall grants live readers a new polling interval', async () => {
  const server = new WebSocketServer({
    port: 0,
    // Allow a reader-idle tick to run before the first reader can exist.
    verifyClient(_info, accept) {
      setTimeout(() => accept(true), 75);
    },
  });
  await once(server, 'listening');
  const transport = createHostTransport();
  server.on('connection', socket => attachHostWebSocketServer(socket, transport));
  const url = `ws://127.0.0.1:${server.address().port}/`;
  const broker = createNetworkBroker({ viewUrl: url.replace('ws:', 'http:') }, { hostIdleMs: 50 });
  try {
    const host = await broker.invoke({ action: 'host-open', url, appDocumentId: 'busy' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    await new Promise(resolve => setTimeout(resolve, 10));
    const read = await broker.invoke({ action: 'host-read', connectionId: host.connectionId, appDocumentId: 'busy' });
    assert.equal(JSON.parse(Buffer.from(read.base64, 'base64')).closed, false);
  } finally { broker.close(); transport.close(); await new Promise(resolve => server.close(resolve)); }
});

test('separate backend brokers cannot reuse each other\'s connection or admitted origins', async () => {
  const servers = [new WebSocketServer({ port: 0 }), new WebSocketServer({ port: 0 })];
  await Promise.all(servers.map(server => once(server, 'listening')));
  const transports = servers.map(server => {
    const transport = createHostTransport();
    server.on('connection', socket => attachHostWebSocketServer(socket, transport));
    return transport;
  });
  const urls = servers.map(server => `ws://127.0.0.1:${server.address().port}/`);
  const brokers = urls.map(url => createNetworkBroker({ viewUrl: url.replace('ws:', 'http:') }));
  try {
    const [first, second] = await Promise.all(brokers.map((broker, index) => broker.invoke({ action: 'host-open', url: urls[index], appDocumentId: 'same-document-label' })));
    assert.notEqual(first.connectionId, second.connectionId);
    await assert.rejects(brokers[0].invoke({ action: 'host-request', connectionId: second.connectionId, appDocumentId: 'same-document-label', service: 'foreign', requestId: 'foreign' }), /retired/);
    assert.throws(() => brokers[0].allow(urls[1]), /outside selected/);
    brokers[0].closeDocument('same-document-label');
    const read = await brokers[1].invoke({ action: 'host-read', connectionId: second.connectionId, appDocumentId: 'same-document-label' });
    assert.equal(JSON.parse(Buffer.from(read.base64, 'base64')).closed, false);
  } finally {
    brokers.forEach(broker => broker.close());
    transports.forEach(transport => transport.close());
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
});
