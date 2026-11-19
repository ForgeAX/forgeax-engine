import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import {
  ArtifactRangesUnavailable,
  tryDownloadArtifactRanges,
} from '../artifact-range-download.mjs';
import { downloadArtifact, isRetryableTransportError } from '../download-artifact-with-retry.mjs';

const bytes = Buffer.from(Array.from({ length: 128 * 1024 }, (_, index) => index % 251));
const etag = '"immutable-object"';
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function fixture(t, behavior = 'valid') {
  const requests = [];
  const server = createServer((request, response) => {
    if (!request.headers.range) {
      response.writeHead(200, {
        'Content-Length': bytes.length,
        ETag: etag,
        'Accept-Ranges': 'bytes',
      });
      response.end(bytes);
      return;
    }
    requests.push(request.headers);
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (behavior === 'headers-stall') return;
    if (behavior === 'ignored') {
      response.writeHead(200);
      response.end(bytes);
      return;
    }
    const headers = {
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      ETag: etag,
    };
    if (behavior === 'etag') headers.ETag = '"changed-object"';
    if (behavior === 'range')
      headers['Content-Range'] = `bytes ${start + 1}-${end}/${bytes.length}`;
    if (behavior === 'length') headers['Content-Length']++;
    if (behavior === 'encoding') headers['Content-Encoding'] = 'gzip';
    response.writeHead(206, headers);
    if (behavior === 'body-stall') {
      response.flushHeaders();
      response.write(bytes.subarray(start, start + 4));
      return;
    }
    const body = Buffer.from(bytes.subarray(start, end + 1));
    if (behavior === 'digest') body[0] ^= 1;
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'artifact-ranges-'));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/immutable.zip`, {
    signal: controller.signal,
  });
  return {
    options: {
      response,
      controller,
      metadata: { size_in_bytes: bytes.length, digest },
      destination: join(directory, 'payload.zip'),
      minimumBytes: 1,
      requestTimeoutMs: 3000,
      idleTimeoutMs: 3000,
    },
    requests,
  };
}

test('four disjoint immutable ranges reconstruct exact bytes and the complete artifact digest', async (t) => {
  const { options, requests } = await fixture(t);
  assert.equal(await tryDownloadArtifactRanges(options), bytes.length);
  assert.deepEqual(await readFile(options.destination), bytes);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map((row) => row.range).sort(), [
    'bytes=0-32767',
    'bytes=32768-65535',
    'bytes=65536-98303',
    'bytes=98304-131071',
  ]);
  for (const headers of requests) {
    assert.equal(headers['if-match'], etag);
    assert.deepEqual(
      [...new Set(headers['accept-encoding'].split(',').map((value) => value.trim()))],
      ['identity'],
    );
    assert.equal(headers.authorization, undefined);
  }
});

test('small transfers retain the original live stream', async (t) => {
  const { options, requests } = await fixture(t);
  options.minimumBytes = bytes.length + 1;
  assert.equal(await tryDownloadArtifactRanges(options), null);
  assert.equal(options.controller.signal.aborted, false);
  assert.deepEqual(Buffer.from(await options.response.arrayBuffer()), bytes);
  assert.equal(requests.length, 0);
});

test('ignored advertised ranges request a fresh sequential fallback after all writers retire', async (t) => {
  const { options } = await fixture(t, 'ignored');
  await assert.rejects(tryDownloadArtifactRanges(options), ArtifactRangesUnavailable);
  await writeFile(options.destination, 'fresh full response');
  assert.equal(await readFile(options.destination, 'utf8'), 'fresh full response');
});

for (const behavior of ['etag', 'range', 'length', 'encoding', 'digest']) {
  test(`rejects ${behavior} corruption instead of accepting assembled bytes`, async (t) => {
    const { options } = await fixture(t, behavior);
    await assert.rejects(tryDownloadArtifactRanges(options), /identity mismatch|digest mismatch/);
    await writeFile(options.destination, 'retired');
  });
}

for (const behavior of ['headers-stall', 'body-stall']) {
  test(`bounds ${behavior} and preserves common transport retry classification`, async (t) => {
    const { options } = await fixture(t, behavior);
    options.requestTimeoutMs = 100;
    options.idleTimeoutMs = 100;
    await assert.rejects(tryDownloadArtifactRanges(options), (error) => {
      assert.equal(isRetryableTransportError(error), true);
      return /timeout/.test(error.message);
    });
    await writeFile(options.destination, 'retired');
  });
}

test('the public downloader falls back once when a large immutable server ignores Range', async (t) => {
  const total = 128 * 1024 * 1024;
  const chunk = Buffer.alloc(64 * 1024);
  const hash = createHash('sha256');
  for (let offset = 0; offset < total; offset += chunk.length) hash.update(chunk);
  const metadata = {
    size_in_bytes: total,
    digest: `sha256:${hash.digest('hex')}`,
    expired: false,
    workflow_run: { head_sha: process.env.FORGEAX_ARTIFACT_EXPECTED_SHA ?? 'fixture' },
  };
  let fullRequests = 0;
  let rangeRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/metadata') {
      response.end(JSON.stringify(metadata));
      return;
    }
    if (request.headers.range) rangeRequests++;
    else fullRequests++;
    response.writeHead(200, { 'Content-Length': total, ETag: etag, 'Accept-Ranges': 'bytes' });
    const source = Readable.from(
      (function* () {
        for (let offset = 0; offset < total; offset += chunk.length) yield chunk;
      })(),
    );
    void pipeline(source, response).catch(() => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'artifact-range-fallback-'));
  const token = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'local-fixture-token';
  t.after(async () => {
    if (token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = token;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const prefix = 'https://api.github.com/repos/fixture/repo/actions/artifacts/1';
    const target = String(url).startsWith(prefix)
      ? `http://127.0.0.1:${server.address().port}/${String(url).endsWith('/zip') ? 'zip' : 'metadata'}`
      : url;
    return nativeFetch(target, options);
  });
  const destination = join(directory, 'archive.zip');
  assert.equal(await downloadArtifact('fixture/repo', '1', destination), total);
  assert.equal((await stat(destination)).size, total);
  assert.equal(fullRequests, 2);
  assert.ok(rangeRequests >= 1 && rangeRequests <= 4);
  await writeFile(destination, 'no live partial writers');
});
