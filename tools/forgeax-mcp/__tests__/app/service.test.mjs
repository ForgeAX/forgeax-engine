import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createViewService } from '../../src/app/service.mjs';
import { readResourceBytes } from '../../src/app/resource-bytes.ts';
import { loadDocumentReference } from '../../src/app/document-reference.ts';

test('cold document compilation releases its transport request before source readiness', async () => {
  let release;
  let reads = 0;
  const held = new Promise(resolve => { release = resolve; });
  const server = createServer(async (_request, response) => {
    reads++;
    await held;
    response.setHeader('content-type', 'text/html');
    response.end('<html><head></head><body><script type="module">globalThis.coldDocument = 42;</script></body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/`;
  const service = createViewService({ root: '/cold', async request() {
    return { ok: true, value: { url, presentationId: 'cold' } };
  } });
  let timer;
  try {
    const result = await Promise.race([
      service.invoke({ action: 'document', url }),
      new Promise(resolve => { timer = setTimeout(() => resolve('request-blocked-on-source'), 100); }),
    ]);
    assert.deepEqual(result, { phase: 'pending' });
    assert.deepEqual(await service.invoke({ action: 'document', url }), { phase: 'pending' });
    release();
    const reference = await loadDocumentReference(args => service.invoke(args), url);
    const html = new TextDecoder().decode(await readResourceBytes(reference, args => service.invoke(args)));
    assert.match(html, /coldDocument\s*=\s*42/);
    assert.equal(reads, 1, 'polling must share the original cold compilation');
  } finally {
    clearTimeout(timer);
    release();
    service.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('document polling stops on cancellation and rejects an invalid phase', async () => {
  const controller = new AbortController();
  let calls = 0;
  const waiting = loadDocumentReference(async () => {
    calls++;
    controller.abort(new Error('frame retired'));
    return { phase: 'pending' };
  }, 'http://localhost/', { signal: controller.signal });
  await assert.rejects(waiting, /frame retired/);
  assert.equal(calls, 1);
  await assert.rejects(loadDocumentReference(async () => ({ phase: 'invalid' }), 'http://localhost/'), /Invalid MCP document phase/);
});

test('presentation retirement cancels pending document work and bounds its task roster', async () => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/`;
  let presentationId = 'first';
  const service = createViewService({ root: '/bounded', async request() {
    return { ok: true, value: { url, presentationId } };
  } });
  try {
    for (let i = 0; i < 32; i++)
      assert.deepEqual(await service.invoke({ action: 'document', url: `${url}?entry=${i}` }), { phase: 'pending' });
    await assert.rejects(service.invoke({ action: 'document', url: `${url}?entry=33` }), /task bound/);
    assert.deepEqual(await service.invoke({ action: 'document-cancel', url: `${url}?entry=0` }), { cancelled: true });
    assert.deepEqual(await service.invoke({ action: 'document', url: `${url}?entry=33` }), { phase: 'pending' });
    assert.deepEqual(await service.invoke({ action: 'document-cancel', url: `${url}?entry=0` }), { cancelled: false });
    await assert.rejects(service.invoke({ action: 'document', url: 'http://example.com/' }), /outside selected/);
    presentationId = 'replacement';
    await service.open();
    assert.deepEqual(await service.invoke({ action: 'document', url }), { phase: 'pending' });
  } finally {
    service.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('document source failures remain failures after asynchronous admission', async () => {
  const server = createServer((_request, response) => response.writeHead(503).end('unavailable'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/`;
  const service = createViewService({ root: '/failed', async request() {
    return { ok: true, value: { url, presentationId: 'failed' } };
  } });
  try {
    await assert.rejects(loadDocumentReference(args => service.invoke(args), url), /document HTTP 503/);
  } finally {
    service.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('an old frame can acknowledge cancellation after its presentation changes origin', async () => {
  let url = 'http://localhost:41001/';
  const oldUrl = url;
  const service = createViewService({ root: '/replaced', async request() {
    return { ok: true, value: { url, presentationId: url } };
  } });
  try {
    await service.open();
    url = 'http://localhost:41002/';
    await service.open();
    assert.deepEqual(await service.invoke({ action: 'document-cancel', url: oldUrl }), { cancelled: false });
    await assert.rejects(service.invoke({ action: 'document', url: oldUrl }), /outside selected/);
  } finally {
    service.close();
  }
});

test('public presentation identity retires source bytes even when its URL stays fixed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-view-service-'));
  await writeFile(join(directory, 'full-view.html'), `<script>__FX_VIEW_CONFIG__</script>${randomBytes(100000).toString('hex')}`);
  let presentationId = '1'.repeat(64);
  const service = createViewService({ root: '/project', async request(operation) {
    assert.equal(operation, 'view.start');
    return { ok: true, value: { phase: 'ready', url: 'http://localhost:4000/', presentationId } };
  } }, { artifactRoot: pathToFileURL(`${directory}/`) });
  try {
    await service.open();
    const first = await service.invoke({ action: 'view-document' });
    assert.equal(first.encoding, 'gzip');
    assert.ok(first.bytes > 49152);
    const bytes = await readResourceBytes(first, input => service.invoke(input));
    assert.ok(new TextDecoder().decode(bytes).includes(presentationId));
    await service.open();
    assert.equal((await service.invoke({ action: 'view-document' })).resourceId, first.resourceId);
    presentationId = '2'.repeat(64);
    await service.open();
    const replacement = await service.invoke({ action: 'view-document' });
    assert.notEqual(replacement.resourceId, first.resourceId);
    assert.ok(new TextDecoder().decode(await readResourceBytes(replacement, input => service.invoke(input))).includes(presentationId));
    await assert.rejects(service.invoke({ action: 'chunk', resourceId: first.resourceId, offset: 0 }), /Expired resource/);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
