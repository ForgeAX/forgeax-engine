import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const sdk = createRequire(require.resolve('@modelcontextprotocol/sdk/package.json'));
const { Hono } = sdk('hono');
const { createAdaptorServer } = sdk('@hono/node-server');
const { serveStatic } = sdk('@hono/node-server/serve-static');

test('MCP HTTP dependency preserves static route admission without a second path decode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-static-admission-'));
  mkdirSync(join(root, 'static/admin'), { recursive: true });
  writeFileSync(join(root, 'static/admin/private.txt'), 'private-sentinel');
  writeFileSync(join(root, 'static/hello world.txt'), 'public-ok');
  const app = new Hono();
  app.use('/static/admin/*', (context) => context.text('Denied', 401));
  app.use('/static/*', serveStatic({ root }));
  const server = createAdaptorServer({ fetch: app.fetch });
  try {
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const { port } = server.address();
    const request = async (path) => {
      const response = await new Promise((resolve, reject) => {
        get(
          { hostname: '127.0.0.1', port, path, agent: false, signal: AbortSignal.timeout(5000) },
          resolve,
        ).on('error', reject);
      });
      response.setEncoding('utf8');
      let body = '';
      for await (const chunk of response) body += chunk;
      return { status: response.statusCode, body };
    };
    assert.deepEqual(await request('/static/hello%20world.txt'), {
      status: 200,
      body: 'public-ok',
    });
    for (const path of ['/static/admin/private.txt', '/static/%61dmin/private.txt'])
      assert.deepEqual(await request(path), { status: 401, body: 'Denied' });
    const malformed = await request('/static/%%36%31dmin/private.txt');
    assert.equal(malformed.status, 404);
    assert.notEqual(malformed.body, 'private-sentinel');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
