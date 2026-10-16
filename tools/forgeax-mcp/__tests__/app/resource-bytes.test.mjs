import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { readResourceBytes } from '../../src/app/resource-bytes.ts';

test('decodes concurrent inline and chunked gzip resources with native stream backpressure', async () => {
  const raw = randomFillSync(Buffer.alloc(250000));
  const compressed = gzipSync(raw, { level: 1 });
  const chunk = async ({ offset }) => ({ base64: compressed.subarray(offset, offset + 49152).toString('base64') });
  const results = await Promise.all(Array.from({ length: 32 }, (_, index) =>
    readResourceBytes({ resourceId: 'fixture', bytes: compressed.length, encoding: 'gzip',
      ...(index % 2 === 0 ? { base64: compressed.toString('base64') } : {}) }, chunk)));
  for (const result of results) assert.deepEqual(Buffer.from(result), raw);
});

test('surfaces corrupt gzip without leaving the concurrent reader rejection unhandled', async () => {
  const compressed = gzipSync(Buffer.from('resource'));
  compressed[compressed.length - 1] ^= 255;
  await assert.rejects(readResourceBytes({ bytes: compressed.length, encoding: 'gzip',
    base64: compressed.toString('base64') }, () => { throw new Error('inline data needs no chunks'); }));
});

test('derives sender stride and retains four-way chunk admission across byte window sizes', async () => {
  const raw = randomFillSync(Buffer.alloc(311111));
  for (const stride of [16384, 49152, 196608]) {
    let active = 0, maximum = 0;
    const result = await readResourceBytes({ resourceId: 'stride', bytes: raw.length }, async ({ offset }) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return { base64: raw.subarray(offset, offset + stride).toString('base64') };
    });
    assert.deepEqual(Buffer.from(result), raw);
    assert.ok(maximum <= 4);
  }
});

test('rejects empty or truncated sender chunks instead of leaving zero-filled resource bytes', async () => {
  await assert.rejects(readResourceBytes({ resourceId: 'empty', bytes: 16 }, async () => ({ base64: '' })), /chunk length/);
  await assert.rejects(readResourceBytes({ resourceId: 'short', bytes: 16 }, async ({ offset }) =>
    ({ base64: Buffer.alloc(offset === 0 ? 8 : 7).toString('base64') })), /chunk length/);
});
