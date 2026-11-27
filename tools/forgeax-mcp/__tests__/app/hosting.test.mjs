import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createViewService } from '../../src/app/service.mjs';
import { readResourceBytes } from '../../src/app/resource-bytes.ts';
import { createAppHosting } from '../../src/app/hosting.mjs';

test('a static App opens and transfers its View before any backend request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-app-static-'));
  await writeFile(join(directory, 'full-view.html'), '<html>__FX_VIEW_CONFIG__</html>');
  let requests = 0;
  let starts = 0;
  const service = createViewService({ root: '/host', async request() {
    requests++;
    throw new Error('Backend is offline');
  } }, {
    artifactRoot: pathToFileURL(`${directory}/`),
    hosting: {
      async open() { return { url: 'http://127.0.0.1:41000/', presentationId: 'static' }; },
      start() { starts++; return { phase: 'preparing' }; },
      close() {},
    },
  });
  try {
    const opened = await service.open();
    assert.equal(opened.presentationId, 'static');
    const reference = await service.invoke({ action: 'view-document' });
    const html = new TextDecoder().decode(await readResourceBytes(reference, args => service.invoke(args)));
    assert.match(html, /"launcher":true/);
    assert.equal(requests, 0);
    assert.equal(starts, 0);
    assert.deepEqual(await service.invoke({ action: 'backend-start' }), { phase: 'preparing' });
    assert.equal(starts, 1);
    assert.equal(requests, 0);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reopening a healthy bootstrap avoids restart, while unavailable bootstrap uses owner startup', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-app-reopen-hosting-'));
  let healthy = true;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(healthy ? JSON.stringify({ endpoint: 'ws://localhost:1234/', token: 'test' }) : 'unavailable');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const bootstrapUrl = `http://127.0.0.1:${server.address().port}/`;
  const probes = new EventEmitter();
  const readBody = Response.prototype.json;
  context.mock.method(Response.prototype, 'json', function () {
    const body = readBody.call(this);
    if (healthy && this.url === bootstrapUrl) {
      // The next loop turn follows the owner's JSON and coalescing continuations.
      void body.then(() => setImmediate(() => probes.emit('healthy')), () => {});
    }
    return body;
  });
  await mkdir(join(directory, 'dist/modules'), { recursive: true });
  await writeFile(join(directory, 'dist/modules/service.mjs'), `
    export const service = { server: { viewerUrl: 'http://localhost/', bootstrapUrl: '${bootstrapUrl}' },
      calls: [], start(project) { this.calls.push(project); }, close() {} };
    export async function createViewService() { return service; }
  `);
  const { service: observed } = await import(pathToFileURL(join(directory, 'dist/modules/service.mjs')).href);
  const binding = { root: directory, viewRoot: directory, enginePackage: directory, hostPack: '/test/host.pack.json' };
  const hosting = createAppHosting(binding);
  try {
    await hosting.open();
    const healthyProbe = once(probes, 'healthy', { signal: AbortSignal.timeout(1000) });
    hosting.start();
    await healthyProbe;
    assert.deepEqual(observed.calls, []);
    healthy = false;
    hosting.start();
    const deadline = performance.now() + 1000;
    while (observed.calls.length === 0 && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(observed.calls, [undefined], 'invalid bootstrap still calls the installed startup owner');
  } finally {
    await hosting.close();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
