import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createRemoteBundler } from '../../src/app/bundler.mjs';

test('retiring a document cancels its source read without evicting its replacement', { timeout: 5000 }, async (t) => {
  let reads = 0;
  let started;
  let closed;
  const reading = new Promise(resolve => { started = resolve; });
  const retired = new Promise(resolve => { closed = resolve; });
  const server = createServer((_request, response) => {
    reads++;
    if (reads === 1) {
      response.once('close', closed);
      started();
    } else response.end('export const value = 42;');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/entry.mjs`;
  const bundle = createRemoteBundler(input => new URL(input));
  const controller = new AbortController();
  const first = assert.rejects(bundle(url, 'module', undefined, controller.signal), /source fetch failed|document retired/);
  await reading;
  controller.abort(new Error('document retired'));
  const replacement = bundle(url);
  await first;
  await retired;
  const result = await replacement;
  const module = await import(`data:text/javascript,${encodeURIComponent(result.source)}`);
  assert.equal(module.value, 42);
  assert.equal(await bundle(url), result, 'late retirement must retain the replacement cache entry');
  assert.equal(reads, 2);
});

for (const scenario of ['reset before headers', 'reset during body', 'persistent reset', 'HTTP error']) {
  test(`remote source reads handle ${scenario} without replaying HTTP failures`, async () => {
    let reads = 0;
    const server = createServer((request, response) => {
      reads++;
      if (scenario === 'HTTP error') {
        response.writeHead(503).end('unavailable');
      } else if (scenario === 'persistent reset' || reads === 1) {
        if (scenario === 'reset during body') {
          response.writeHead(200, { 'content-type': 'text/javascript', 'content-length': 1000 });
          response.write('export const value = ');
          setTimeout(() => response.destroy(), 10);
        } else request.socket.destroy();
      } else response.end('export const value = 42;');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/entry.mjs`;
    const bundle = createRemoteBundler((input) => {
      assert.equal(input, url);
      return new URL(input);
    });
    try {
      if (scenario === 'persistent reset' || scenario === 'HTTP error') {
        await assert.rejects(bundle(url), scenario === 'HTTP error' ? /HTTP 503/ : /source fetch failed/);
      } else {
        const result = await bundle(url);
        const module = await import(`data:text/javascript,${encodeURIComponent(result.source)}`);
        assert.equal(module.value, 42);
      }
      assert.equal(reads, scenario === 'HTTP error' ? 1 : 2);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test('wide document graphs share bounded source reads and retain every module', async () => {
  let active = 0;
  let peak = 0;
  let reads = 0;
  const server = createServer((request, response) => {
    active++;
    reads++;
    peak = Math.max(peak, active);
    response.setHeader('content-type', 'text/javascript');
    const path = new URL(request.url, 'http://localhost').pathname;
    const entry = /^\/(first|second)\.mjs$/.exec(path);
    const source = entry
      ? Array.from({ length: 24 }, (_, i) => `import n${i} from './${entry[1]}/${i}.mjs';`).join('\n') +
        `\nexport const sum = ${Array.from({ length: 24 }, (_, i) => `n${i}`).join('+')};`
      : `export default ${Number(path.split('/').at(-1).replace('.mjs', ''))};`;
    setTimeout(() => {
      active--;
      response.end(source);
    }, 10);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bundle = createRemoteBundler((input) => {
    const url = new URL(input);
    assert.equal(url.origin, origin);
    return url;
  });
  try {
    const results = await Promise.all([
      bundle(`${origin}/first.mjs`),
      bundle(`${origin}/second.mjs`),
    ]);
    for (const result of results) {
      const module = await import(`data:text/javascript,${encodeURIComponent(result.source)}`);
      assert.equal(module.sum, 276);
    }
    assert.equal(reads, 50);
    assert.ok(peak > 1, 'source reads should retain useful concurrency');
    assert.ok(peak <= 4, `two document graphs opened ${peak} concurrent source reads`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
