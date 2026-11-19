import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createViewService, serveView } from '../src/view-service.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'view-service-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Retained Shell</title>');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, hostPack: join(root, 'host.pack.json'), staticRoot: root };
}

async function backend(t, body = JSON.stringify({ configured: true, token: 'owner' })) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(body);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const close = () => new Promise(done => server.close(done));
  t.after(close);
  return { url: `http://127.0.0.1:${server.address().port}/`, close };
}

test('synchronous ensure failure publishes offline and admits a retry', async t => {
  const options = await fixture(t);
  const host = await backend(t);
  let calls = 0;
  const service = await createViewService({ ...options, ensure() {
    if (++calls === 1) throw new Error('owner sync failure');
    return Promise.resolve({ ok: true, value: { view: { url: host.url } } });
  } });
  t.after(service.close);
  assert.deepEqual(await service.start(), { ok: false, error: { code: 'view-launch-failed', hint: 'owner sync failure' } });
  const failed = await fetch(service.server.bootstrapUrl);
  assert.deepEqual(await failed.json(), { configured: false, phase: 'offline', launcher: true, reason: 'owner sync failure' });
  assert.equal((await service.start()).ok, true);
  assert.equal((await (await fetch(service.server.bootstrapUrl)).json()).configured, true);
});

test('presentation remains reachable after backend termination and mounts a replacement', async t => {
  const options = await fixture(t);
  let host = await backend(t);
  const service = await createViewService({ ...options, ensure: async () => ({ ok: true, value: { view: { url: host.url } } }) });
  t.after(service.close);
  await service.start();
  const url = service.server.viewerUrl;
  await host.close();
  const offline = await fetch(service.server.bootstrapUrl);
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).launcher, true);
  assert.equal((await fetch(url)).status, 200);
  host = await backend(t);
  const launched = await fetch(new URL('/__forgeax/view/launch', url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin }, body: '{}',
  });
  assert.equal((await launched.json()).ok, true);
  assert.equal(service.server.viewerUrl, url);
  assert.equal((await (await fetch(service.server.bootstrapUrl)).json()).configured, true);
});

test('malformed upstream bootstrap becomes offline without an unhandled rejection', async t => {
  const host = await backend(t, '{invalid');
  const service = await createViewService({ ...await fixture(t), ensure: async () => ({ ok: true, value: { view: { url: host.url } } }) });
  t.after(service.close);
  await service.start();
  const response = await fetch(service.server.bootstrapUrl);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).phase, 'offline');
});

test('launcher rejects concurrent calls and foreign origin or invalid input', async t => {
  let finish;
  let calls = 0;
  const service = await createViewService({ ...await fixture(t), ensure: () => {
    calls++;
    return new Promise(done => { finish = done; });
  } });
  t.after(service.close);
  const first = service.start('/project-a');
  await Promise.resolve();
  assert.equal((await service.start('/project-b')).error.code, 'view-launch-busy');
  const url = new URL('/__forgeax/view/launch', service.server.viewerUrl);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://foreign.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"project":42}' })).status, 400);
  finish({ ok: false, error: { code: 'owner-failure', hint: 'retained owner error' } });
  assert.equal((await first).error.code, 'owner-failure');
  assert.equal(calls, 1);
});

test('foreground close cancels preparation and removes its signal listeners', async t => {
  const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
  let signal;
  let finish;
  const service = await serveView({ ...await fixture(t), ensure: (_project, callerSignal) => {
    signal = callerSignal;
    return new Promise(done => { finish = done; });
  } });
  await Promise.resolve();
  assert.equal(signal.aborted, false);
  await service.close();
  assert.equal(signal.aborted, true);
  assert.equal(process.listenerCount('SIGINT'), before.int);
  assert.equal(process.listenerCount('SIGTERM'), before.term);
  finish({ ok: true, value: { view: { url: 'http://127.0.0.1:1/' } } });
  await assert.rejects(fetch(service.url));
});
