import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { preview } from 'vite';
import { waitForPreview } from '../../../apps/hello/multithreaded-execution/scripts/preview-readiness.mjs';

test('shader-only transfer fails with its missing executable path, then a complete app serves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'multithread-preview-'));
  mkdirSync(join(root, 'dist/shaders'), { recursive: true });
  writeFileSync(join(root, 'dist/shaders/manifest.json'), '{}');
  const server = await preview({
    root,
    configFile: false,
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  try {
    assert.equal((await fetch(server.resolvedUrls.local[0])).status, 404);
    await assert.rejects(waitForPreview(server), (error) => {
      assert.ok(error.message.includes(join(root, 'dist/index.html')));
      assert.match(error.message, /build the app before browser assertions/);
      return true;
    });
    writeFileSync(join(root, 'dist/index.html'), '<html><body>Built app</body></html>');
    await waitForPreview(server);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('preview HTTP failures preserve status and later transport context, URL and executable path', {
  timeout: 5_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'multithread-preview-http-'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/index.html'), '<html></html>');
  const requests = [];
  const server = await preview({
    root,
    configFile: false,
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
    plugins: [
      {
        name: 'unavailable-preview',
        configurePreviewServer(server) {
          let requestCount = 0;
          server.middlewares.use((_request, response) => {
            if (requestCount++ > 0) {
              requests.push('pending response');
              return;
            }
            requests.push('HTTP 503 response');
            response.statusCode = 503;
            response.end('temporarily unavailable');
          });
        },
      },
    ],
  });
  try {
    // Exercise HTTP diagnostics with enough time for a real response under
    // concurrent CI load; a 100 ms startup race only proves request abortion.
    await assert.rejects(waitForPreview(server, 1_000), (error) => {
      assert.match(error.message, /HTTP 503/);
      assert.match(error.message, /cause=TimeoutError/);
      assert.match(error.message, /timeoutMs=1000/);
      assert.ok(error.message.includes(server.resolvedUrls.local[0]));
      assert.ok(error.message.includes(join(root, 'dist/index.html')));
      assert.deepEqual(requests.slice(0, 2), ['HTTP 503 response', 'pending response']);
      return true;
    });
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('preview reports no response, aborts the pending request, then recovers from HTTP 503 to 200', {
  timeout: 5_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'multithread-preview-recovery-'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/index.html'), '<html></html>');
  const statuses = [undefined, 503, 200];
  let pendingClosed;
  const server = await preview({
    root,
    configFile: false,
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
    plugins: [
      {
        name: 'recovering-preview',
        configurePreviewServer(server) {
          server.middlewares.use((_request, response) => {
            const status = statuses.shift();
            if (status === undefined) {
              pendingClosed = new Promise((resolve) => response.once('close', resolve));
              return;
            }
            response.statusCode = status;
            response.end(status === 200 ? 'ready' : 'temporarily unavailable');
          });
        },
      },
    ],
  });
  try {
    await assert.rejects(waitForPreview(server, 1_000), (error) => {
      assert.match(error.message, /lastResponse=no response/);
      assert.match(error.message, /cause=TimeoutError/);
      assert.match(error.message, /timeoutMs=1000/);
      return true;
    });
    assert.ok(pendingClosed, 'the real HTTP request reached the pending response');
    await pendingClosed;
    await waitForPreview(server, 1_000);
    assert.deepEqual(statuses, []);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
