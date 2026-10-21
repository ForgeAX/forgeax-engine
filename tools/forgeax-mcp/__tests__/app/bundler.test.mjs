import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createRemoteBundler } from '../../src/app/bundler.mjs';

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
