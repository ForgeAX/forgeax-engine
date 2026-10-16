import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNetworkBroker } from '../../src/app/broker.mjs';
import { readResourceBytes } from '../../src/app/resource-bytes.ts';

test('HTTP batches retain independent status, bytes, admission and read-only bounds', async () => {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/missing' ? 404 : 200, { 'content-type': 'text/javascript' });
    response.end(request.url);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const broker = createNetworkBroker({ viewUrl: base });
  const read = url => ({ action: 'http', method: 'GET', headers: {}, url });
  try {
    const ref = await broker.invoke({ action: 'http-batch', requests: [read(`${base}/a`), read(`${base}/missing`), read('http://localhost:1/private')] });
    const replies = JSON.parse(new TextDecoder().decode(await readResourceBytes(ref, input => broker.invoke(input))));
    assert.equal(replies[0].value.status, 200);
    assert.equal(replies[1].value.status, 404);
    assert.equal(new TextDecoder().decode(await readResourceBytes(replies[1].value, input => broker.invoke(input))), '/missing');
    assert.equal(replies[2].ok, false);
    assert.match(replies[2].error, /outside selected/);
    await assert.rejects(broker.invoke({ action: 'http-batch', requests: Array(17).fill(read(`${base}/a`)) }), /16/);
    await assert.rejects(broker.invoke({ action: 'http-batch', requests: [{ ...read(`${base}/a`), method: 'POST' }] }), /reads only/);
  } finally {
    broker.close();
    await new Promise(resolve => server.close(resolve));
  }
});


test('binary-MIME shader reads retain exact bytes without per-artifact chunk round trips', async () => {
  const shader = await readFile(new URL('../../../../packages/shader/src/default-standard-pbr.wgsl', import.meta.url));
  assert.ok(shader.length > 49152, 'exercise a real shader larger than one MCP chunk');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(shader);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const broker = createNetworkBroker({ viewUrl: base });
  let chunks = 0;
  const invoke = input => {
    if (input.action === 'chunk') chunks++;
    return broker.invoke(input);
  };
  try {
    const ref = await invoke({ action: 'http-batch', requests: Array.from({ length: 8 }, (_, index) => ({
      method: 'GET', url: `${base}/shader-${index}`, headers: {},
    })) });
    const replies = JSON.parse(new TextDecoder().decode(await readResourceBytes(ref, invoke)));
    for (const reply of replies) {
      assert.equal(reply.ok, true);
      assert.deepEqual(Buffer.from(await readResourceBytes(reply.value, invoke)), shader);
    }
    assert.equal(chunks, 0, 'compressible binary artifacts should fit inline instead of multiplying bridge calls');
    assert.equal(replies[0].value.encoding, 'gzip');
    assert.equal(replies[0].value.headers['content-type'], 'application/octet-stream');
  } finally {
    broker.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('large independent artifact reads retain bytes within sixteen bounded bridge chunks', async () => {
  const { randomFillSync } = await import('node:crypto');
  const source = randomFillSync(Buffer.alloc(300 * 1024));
  const bodies = Array.from({ length: 8 }, (_, index) => {
    const body = Buffer.from(source); body[0] = index; return body;
  });
  let requests = 0, chunks = 0, largestChunk = 0;
  const server = createServer((request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-path': request.url });
    response.end(bodies[Number(request.url.slice(1))]);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const broker = createNetworkBroker({ viewUrl: base });
  const invoke = async input => {
    const result = await broker.invoke(input);
    if (input.action === 'chunk') { chunks++; largestChunk = Math.max(largestChunk, Buffer.from(result.base64, 'base64').length); }
    return result;
  };
  try {
    const ref = await invoke({ action: 'http-batch', requests: bodies.map((_, index) => ({ method: 'GET', url: `${base}/${index}`, headers: {} })) });
    const replies = JSON.parse(new TextDecoder().decode(await readResourceBytes(ref, invoke)));
    await Promise.all(replies.map(async (reply, index) => {
      assert.equal(reply.value.status, 200);
      assert.equal(reply.value.headers['x-path'], `/${index}`);
      assert.deepEqual(Buffer.from(await readResourceBytes(reply.value, invoke)), bodies[index]);
    }));
    assert.equal(requests, 8, 'every original URL must still be fetched independently');
    assert.ok(chunks <= 16, `large artifact reads require at most sixteen chunks, got ${chunks}`);
    assert.ok(largestChunk <= 192 * 1024, 'each bridge result retains its bounded byte window');
  } finally { broker.close(); await new Promise(resolve => server.close(resolve)); }
});
