import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import { createNetworkBroker } from '../../src/app/broker.mjs';
import { readResourceBytes } from '../../src/app/resource-bytes.ts';

test('large Engine resources retain exact bytes and oversized streams stop at the resource budget', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 97);
  let oversizedBytes = 0;
  let oversizedClosed;
  const closed = new Promise((resolve) => { oversizedClosed = resolve; });
  const server = createServer((request, response) => {
    const oversized = request.url === '/oversized';
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    const input = Readable.from((function* () {
      for (let i = 0; i < (oversized ? 512 : 96); i++) {
        if (oversized) oversizedBytes += chunk.length;
        yield chunk;
      }
    })());
    void pipeline(input, response).catch(() => {}).finally(() => {
      if (oversized) oversizedClosed();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const broker = createNetworkBroker({ viewUrl: origin });
  try {
    const resource = await broker.invoke({ action: 'http', url: `${origin}/engine-resource` });
    assert.equal(resource.decodedBytes, 96 * chunk.length);
    assert.equal(resource.encoding, 'gzip');
    const bytes = await readResourceBytes(resource, (input) => broker.invoke(input));
    const expected = createHash('sha256');
    for (let i = 0; i < 96; i++) expected.update(chunk);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.digest('hex'));
    await assert.rejects(
      broker.invoke({ action: 'http', url: `${origin}/oversized` }),
      /Response exceeds View transport bound/,
    );
    await closed;
    assert.ok(oversizedBytes < 512 * chunk.length,
      'a rejected stream must stop before the producer sends its complete body');
  } finally {
    broker.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
