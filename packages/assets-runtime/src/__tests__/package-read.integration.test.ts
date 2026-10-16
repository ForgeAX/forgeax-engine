import { createServer, type ServerResponse } from 'node:http';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import { bytesOf, readPackage } from '../internal/package-read.js';
import { readArtifact } from '../registry/artifact-io.js';

const GUID = '11111111-1111-4111-8111-111111111111';
const PACK = JSON.stringify({
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [{ guid: GUID, kind: 'review-value', payload: { kind: 'review-value', value: 'a' } }],
});

type Reply = 'ok' | 'reset-body' | number;

// A real socket reproduces the gateway failure: headers arrive, then the
// stream is destroyed mid-body, which only surfaces while reading the body.
async function server(body: string, replies: readonly Reply[]) {
  const requests: string[] = [];
  const answer = (res: ServerResponse, reply: Reply) => {
    if (reply === 'ok') return void res.end(body);
    if (reply === 'reset-body') {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.write(body.slice(0, 4));
      return void setTimeout(() => res.destroy(), 10);
    }
    res.statusCode = reply;
    res.end('unavailable');
  };
  const http = createServer((req, res) => {
    if (req.url === '/catalog.json') {
      res.end(
        JSON.stringify([{ guid: GUID, kind: 'review-value', packageUrl: '/value.pack.json' }]),
      );
      return;
    }
    requests.push(req.url ?? '');
    answer(res, replies[requests.length - 1] ?? 'ok');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('listener unavailable');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function loadPack(replies: readonly Reply[]) {
  const s = await server(PACK, replies);
  const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  registry.configurePackIndex(`${s.origin}/catalog.json`);
  const release = registry.loaders.registerPackLoader({
    kind: 'review-value',
    load: (input) => input.payload,
  });
  try {
    return { result: await registry.loadByGuid(registry.parseGuid(GUID)), requests: s.requests };
  } finally {
    release();
    registry.invalidateAll();
    await s.close();
  }
}

it('recovers a Pack whose response body is reset mid-transfer', async () => {
  const { result, requests } = await loadPack(['reset-body']);
  expect(result.ok).toBe(true);
  expect(requests).toHaveLength(2);
});

it('retries transient Pack statuses within the bound', async () => {
  const { result, requests } = await loadPack([503, 502]);
  expect(result.ok).toBe(true);
  expect(requests).toHaveLength(3);
});

it('reports a permanent shipped Pack failure once with its request diagnostic', async () => {
  const { result, requests } = await loadPack([404]);
  expect(requests).toHaveLength(1);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe('asset-not-imported');
  expect(result.error.hint).toContain('HTTP 404 after 1 request(s)');
});

it('stops after three transient Pack failures', async () => {
  const { result, requests } = await loadPack([503, 503, 503, 'ok']);
  expect(requests).toHaveLength(3);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.hint).toContain('HTTP 503 after 3 request(s)');
});

it('recovers an artifact whose response body is reset mid-transfer', async () => {
  const s = await server('artifact-bytes', ['reset-body']);
  try {
    const result = await readArtifact({
      packageUrl: `${s.origin}/value.pack.json`,
      guid: GUID,
      artifactKey: 'body',
      descriptor: { path: 'body.bin', mediaType: 'application/octet-stream' },
    });
    expect(result).toEqual({ ok: true, value: new TextEncoder().encode('artifact-bytes') });
    expect(s.requests).toHaveLength(2);
  } finally {
    await s.close();
  }
});

it('never retries an aborted read', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(async () => {
    controller.abort();
    throw new DOMException('aborted', 'AbortError');
  });
  const result = await readPackage(fetcher, 'https://example.test/a.pack.json', bytesOf, {
    signal: controller.signal,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result).toEqual({
    ok: false,
    error: { observed: 'AbortError: aborted', attempts: 1, malformed: false },
  });
});
