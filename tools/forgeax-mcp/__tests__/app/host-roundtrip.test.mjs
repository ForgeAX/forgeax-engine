import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createNetworkBroker } from '../../src/app/broker.mjs';
import { WebSocketServer } from 'ws';
import { createHostTransport, attachHostWebSocketServer } from '@forgeax/engine-host/transport';
const compiled = await build({
  entryPoints: [new URL('../../src/app/tool-queue.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { createToolQueue } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
);
test('bounded MCP admission lets dependent Host replies complete while three queries wait', async () => {
  const socketServer = new WebSocketServer({ port: 0 });
  await once(socketServer, 'listening');
  const transport = createHostTransport();
  const waiting = [];
  let queriesReceived;
  const queriesReady = new Promise((resolve) => (queriesReceived = resolve));
  transport.register('query', () => new Promise((resolve) => {
    waiting.push(resolve);
    if (waiting.length === 3) queriesReceived();
  }));
  transport.register('reply', async () => {
    // A service can accept a request before its native response reaches MCP.
    await new Promise((resolve) => setTimeout(resolve, 60));
    for (const resolve of waiting.splice(0)) resolve('scene');
    return 'replied';
  });
  socketServer.on('connection', (socket) => attachHostWebSocketServer(socket, transport));
  const port = socketServer.address().port;
  const broker = createNetworkBroker({ viewUrl: `http://127.0.0.1:${port}/` });
  const queue = createToolQueue((input, signal) => broker.invoke(input, { signal }));
  const { connectionId } = await queue.call({
    action: 'host-open',
    url: `ws://127.0.0.1:${port}/`,
  });
  const requests = Array.from({ length: 3 }, (_, i) =>
    queue.call({ action: 'host-request', connectionId, service: 'query', requestId: `query-${i}` }),
  );
  const results = Promise.allSettled(requests);
  try {
    await Promise.race([
      queriesReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Host queries were not received')), 500)),
    ]);
    assert.equal(waiting.length, 3);
    const replyDeadline = performance.now() + 500;
    const reply = queue.call({
      action: 'host-request',
      connectionId,
      service: 'reply',
      requestId: 'reply',
    });
    await Promise.race([
      reply,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('dependent reply starved behind waiting queries')), 500),
      ),
    ]);
    await results;
    const events = [];
    while (events.length < 4) {
      assert.ok(performance.now() < replyDeadline, 'dependent Host responses must arrive within the original 500 ms reply bound');
      const ref = await broker.invoke({ action: 'host-read', connectionId });
      events.push(...JSON.parse(Buffer.from(ref.base64, 'base64')).events);
      if (events.length < 4) await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(events.map((event) => event.requestId).sort(), [
      'query-0',
      'query-1',
      'query-2',
      'reply',
    ]);
    for (const event of events) {
      assert.equal(JSON.parse(Buffer.from(event.response.base64, 'base64')).ok, true);
    }
  } finally {
    queue.close();
    broker.close();
    transport.close();
    await new Promise((resolve) => socketServer.close(resolve));
    await results;
  }
});

test('Host cancellation after MCP admission reaches the owning request', async () => {
  const socketServer = new WebSocketServer({ port: 0 });
  await once(socketServer, 'listening');
  const transport = createHostTransport();
  let admitted;
  const admission = new Promise((resolve) => (admitted = resolve));
  let cancelled;
  const observed = new Promise((resolve) => (cancelled = resolve));
  transport.register(
    'pending',
    ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            cancelled();
            reject(new Error('cancelled'));
          },
          { once: true },
        );
        admitted();
      }),
  );
  socketServer.on('connection', (socket) => attachHostWebSocketServer(socket, transport));
  const port = socketServer.address().port;
  const broker = createNetworkBroker({ viewUrl: `http://127.0.0.1:${port}/` });
  try {
    const { connectionId } = await broker.invoke({
      action: 'host-open',
      url: `ws://127.0.0.1:${port}/`,
    });
    await broker.invoke({
      action: 'host-request',
      connectionId,
      requestId: 'cancel-me',
      service: 'pending',
    });
    await Promise.race([
      admission,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Host request was not admitted')), 500),
      ),
    ]);
    await broker.invoke({ action: 'host-cancel', connectionId, requestId: 'cancel-me' });
    await Promise.race([
      observed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Host request was not cancelled')), 500),
      ),
    ]);
  } finally {
    broker.close();
    transport.close();
    await new Promise((resolve) => socketServer.close(resolve));
  }
});

test('service retirement closes a socket still waiting for Host admission', async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const broker = createNetworkBroker({ viewUrl: `http://127.0.0.1:${server.address().port}/` });
  const opened = once(server, 'connection');
  const result = broker
    .invoke({ action: 'host-open', url: `ws://127.0.0.1:${server.address().port}/` })
    .catch((error) => error);
  const [socket] = await opened;
  try {
    const closed = once(socket, 'close');
    broker.close();
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Pending admission socket survived service retirement')),
          300,
        ),
      ),
    ]);
    assert.equal(server.clients.size, 0);
    assert.ok((await result) instanceof Error);
  } finally {
    for (const client of server.clients) client.terminate();
    broker.close();
    await result;
    await new Promise((resolve) => server.close(resolve));
  }
});
