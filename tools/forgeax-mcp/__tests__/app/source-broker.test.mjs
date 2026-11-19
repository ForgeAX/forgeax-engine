import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { attachHostWebSocketServer, createHostTransport } from '@forgeax/engine-host/transport';
import { createWorkspaceRequest, VIEW_WORKSPACE_SERVICES } from '@forgeax/view/workspace/contract';
import { SOURCE_OPEN_TOPIC, SOURCE_REPLY_SERVICE } from '../../src/contract.ts';
import { createNetworkBroker } from '../../src/app/broker.mjs';

const file = { projectRoot: '/owned-consumer', sourcePath: 'assets/archway.scene.pack.json' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const transport = createHostTransport();
  const snapshots = new Map(), calls = [], admissions = new Map();
  let admission;
  transport.onClientConnect(caller => {
    assert.ok(admission, 'The fixture records the actual server admission synchronously');
    admissions.set(admission, caller);
  });
  transport.register(VIEW_WORKSPACE_SERVICES.call, ({ payload, caller }) => {
    calls.push({ operation: payload.operation, caller });
    if (payload.operation === 'project.present' && caller.sourceId !== 'view-frontend')
      throw new Error('Only the top-level frontend may present this project');
    return snapshots.get(caller.connectionId) ?? { projectDocumentPresentation: 'observer' };
  });
  server.on('connection', (socket, request) => {
    const url = new URL(request.url, 'http://test');
    admission = url.searchParams.get('admission');
    attachHostWebSocketServer(socket, transport, { kind: 'frontend', sourceId: url.searchParams.get('source') });
    admission = undefined;
  });
  const broker = createNetworkBroker({ viewUrl: `http://127.0.0.1:${server.address().port}/` });
  t.after(async () => {
    broker.close(); transport.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  const open = async (appDocumentId, source = 'view-frontend', mode = 'fullscreen', presentation = 'presenter', admitted = true, subscribe = true) => {
    const nonce = randomUUID();
    const result = await broker.invoke({ action: 'host-open', appDocumentId, displayMode: mode,
      url: `ws://127.0.0.1:${server.address().port}/?token=owned-test-token&source=${source}&admission=${nonce}` });
    const caller = admissions.get(nonce);
    assert.ok(caller);
    assert.notEqual(caller.connectionId, result.caller.connectionId, 'WebSocket observation is not the server-issued identity');
    assert.equal(result.caller.sourceId, undefined);
    snapshots.set(caller.connectionId, { projectDocumentPresentation: presentation });
    const host = { appDocumentId, connectionId: result.connectionId, caller };
    if (subscribe) await broker.invoke({ ...host, action: 'host-subscribe', topic: SOURCE_OPEN_TOPIC });
    if (admitted && source === 'view-frontend' && mode === 'fullscreen' && presentation === 'presenter') await present(host);
    return host;
  };
  const read = async host => JSON.parse(Buffer.from((await broker.invoke({ ...host, action: 'host-read' })).base64, 'base64')).events;
  const unread = new Map();
  const event = async (host, accepts) => {
    const end = performance.now() + 1000;
    while (performance.now() < end) {
      const events = [...(unread.get(host.connectionId) ?? []), ...await read(host)];
      const index = events.findIndex(accepts);
      if (index >= 0) { const [found] = events.splice(index, 1); unread.set(host.connectionId, events); return found; }
      unread.set(host.connectionId, events);
      await pause(5);
    }
    assert.fail('Expected exact Host queue event within 1 second');
  };
  const request = async (host, service, payload) => {
    const requestId = randomUUID();
    await broker.invoke({ ...host, action: 'host-request', requestId, service, payload });
    const response = await event(host, item => item.requestId === requestId);
    return JSON.parse(Buffer.from(response.response.base64, 'base64'));
  };
  const ack = (host, requestId, ok = true) => request(host, SOURCE_REPLY_SERVICE, { requestId, ok, ...(!ok ? { error: 'Owner lost presentation' } : {}) });
  const present = host => request(host, VIEW_WORKSPACE_SERVICES.call, createWorkspaceRequest('project.present', {}, { clientId: 'regression', token: 'owned-test-token' }));
  return { broker, open, read, event, ack, present, snapshots, calls };
}

test('only the exact fullscreen top-level presenter receives a source and can acknowledge it', async t => {
  const f = await fixture(t);
  const presenter = await f.open(randomUUID());
  const inline = await f.open(randomUUID(), 'view-frontend', 'inline');
  const embedded = await f.open(randomUUID(), 'view-canvas');
  const observer = await f.open(randomUUID(), 'view-frontend', 'fullscreen', 'observer');
  const selected = f.broker.selectSource(file, { appDocumentId: inline.appDocumentId, reuse: true });
  selected.catch(() => {});
  const delivered = await f.event(presenter, item => item.topic === SOURCE_OPEN_TOPIC);
  assert.deepEqual(delivered.value.file, file);
  assert.deepEqual((await f.ack(observer, delivered.value.requestId)).value, { accepted: false });
  let completed = false; selected.then(() => { completed = true; });
  await pause(15); assert.equal(completed, false, 'A different socket cannot release a successful receipt');
  assert.deepEqual(await f.read(inline), []); assert.deepEqual(await f.read(embedded), []);
  assert.deepEqual((await f.ack(presenter, delivered.value.requestId)).value, { accepted: true });
  assert.deepEqual(await selected, { disposition: 'reused' });
  assert.deepEqual((await f.ack(presenter, delivered.value.requestId)).value, { accepted: false }, 'Late ack cannot complete another action');
});

test('first concurrent card admission waits for successful presenter response, not subscription or observer', async t => {
  const f = await fixture(t), first = randomUUID(), second = randomUUID();
  assert.deepEqual(await f.broker.selectSource(file, { appDocumentId: first }), { disposition: 'open' });
  let finished = false;
  const pending = f.broker.selectSource(file, { appDocumentId: second }).finally(() => { finished = true; });
  pending.catch(() => {});
  const host = await f.open(first, 'view-frontend', 'fullscreen', 'observer', false);
  await pause(20); assert.equal(finished, false, 'Subscribing while observer must not release admission');
  await f.present(host); await pause(20); assert.equal(finished, false, 'Observer project.present is not admission');
  f.snapshots.set(host.caller.connectionId, { projectDocumentPresentation: 'presenter' });
  await f.present(host);
  const delivered = await f.event(host, item => item.topic === SOURCE_OPEN_TOPIC);
  await f.ack(host, delivered.value.requestId);
  assert.deepEqual(await pending, { disposition: 'reused' });
});

test('denied fullscreen cancellation is reservation-owned and allows a later retry', async t => {
  const f = await fixture(t), first = randomUUID();
  await f.broker.selectSource(file, { appDocumentId: first });
  const pending = f.broker.selectSource(file, { appDocumentId: randomUUID() });
  const outcome = pending.then(value => value, error => error);
  f.broker.cancelSourceOpening(randomUUID());
  assert.equal(await Promise.race([outcome, pause(20).then(() => 'pending')]), 'pending');
  f.broker.cancelSourceOpening(first);
  assert.equal((await outcome).code, 'view-source-open-cancelled');
  assert.deepEqual(await f.broker.selectSource(file, { appDocumentId: randomUUID() }), { disposition: 'open' });
});

test('present-before-subscribe also waits until both initial admission conditions are true', async t => {
  const f = await fixture(t), first = randomUUID();
  await f.broker.selectSource(file, { appDocumentId: first });
  const host = await f.open(first, 'view-frontend', 'fullscreen', 'presenter', true, false);
  const outcome = f.broker.selectSource(file, { appDocumentId: randomUUID() }); outcome.catch(() => {});
  assert.equal(await Promise.race([outcome, pause(20).then(() => 'pending')]), 'pending');
  await f.broker.invoke({ ...host, action: 'host-subscribe', topic: SOURCE_OPEN_TOPIC });
  const delivered = await f.event(host, value => value.topic === SOURCE_OPEN_TOPIC && value.value.file);
  await f.ack(host, delivered.value.requestId);
  assert.deepEqual(await outcome, { disposition: 'reused' });
});

test('dispatch failure, caller timeout, and receiver retirement never fall back to another page', async t => {
  const f = await fixture(t), host = await f.open(randomUUID());
  for (const reason of ['owner-error', 'cancel', 'unsubscribe']) {
    const controller = new AbortController();
    const selected = f.broker.selectSource(file, { appDocumentId: randomUUID() }, { signal: controller.signal });
    const outcome = selected.then(value => value, error => error);
    const delivered = await f.event(host, item => item.topic === SOURCE_OPEN_TOPIC && item.value.file);
    if (reason === 'owner-error') await f.ack(host, delivered.value.requestId, false);
    else if (reason === 'cancel') controller.abort(new Error('Caller deadline'));
    else await f.broker.invoke({ ...host, action: 'host-unsubscribe', topic: SOURCE_OPEN_TOPIC });
    assert.equal((await outcome).code, reason === 'owner-error' ? 'view-source-open-failed' : reason === 'cancel' ? 'view-source-cancelled' : 'view-source-disconnected');
    assert.deepEqual((await f.ack(host, delivered.value.requestId)).value, { accepted: false });
  }
  await f.broker.invoke({ ...host, action: 'host-subscribe', topic: SOURCE_OPEN_TOPIC });
  const outcome = f.broker.selectSource(file, { appDocumentId: randomUUID() }).catch(error => error);
  await f.event(host, item => item.topic === SOURCE_OPEN_TOPIC && item.value.file);
  f.broker.closeDocument(host.appDocumentId);
  assert.equal((await outcome).code, 'view-source-disconnected');
});

test('ambiguous presenters reject and explicit direct entry does not dispatch to another App', async t => {
  const f = await fixture(t);
  await f.open(randomUUID()); await f.open(randomUUID());
  await assert.rejects(f.broker.selectSource(file, { appDocumentId: randomUUID() }), { code: 'view-source-page-ambiguous' });
  assert.deepEqual(await f.broker.selectSource(file, { appDocumentId: randomUUID(), reuse: false }), { disposition: 'open' });
});
