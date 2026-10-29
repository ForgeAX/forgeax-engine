import { createServer, type ServerResponse } from 'node:http';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { type CatalogEntry, ok, snapshotLoadTimeline } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry.js';
import { bytesOf, readPackage } from '../internal/package-read.js';
import { readArtifact } from '../registry/artifact-io.js';

const GUID = '11111111-1111-4111-8111-111111111111';
const PACK = {
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [{ guid: GUID, kind: 'review-value', payload: { kind: 'review-value', value: 'a' } }],
};
const kind = defineAssetKind<{ value: string }>('review-value');

type Reply = 'ok' | 'reset-body' | number;

// A real socket reproduces the gateway failure: headers arrive, then the
// stream is destroyed mid-body, which only surfaces while reading the body.
async function server(initial: string, replies: readonly Reply[]) {
  let body = initial;
  let catalog: readonly CatalogEntry[] = [];
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
      res.end(JSON.stringify(catalog));
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
    publish(next: string, rows: readonly CatalogEntry[]) {
      body = next;
      catalog = rows;
    },
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function loadPack(replies: readonly Reply[]) {
  const s = await server('', replies);
  const packageUrl = `${s.origin}/value.pack.json`;
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'retry.pack',
    sourceRevision: '1',
    packageUrl,
    pack: { assets: PACK.assets.map((entry) => ({ ...entry, refs: [], artifacts: {} })) },
  });
  s.publish(JSON.stringify(publication.pack), [
    {
      guid: GUID,
      kind: kind.kind,
      packageUrl,
      sourcePath: 'retry.pack',
      publication: publication.publication,
    },
  ]);
  const registry = new AssetRegistry();
  registry.configurePackIndex(`${s.origin}/catalog.json`);
  const lease = registry.installDecoder(kind, {
    decode: async ({ envelope }) => ok(envelope.payload),
    prepare: (value) => ok(value),
  });
  try {
    return { result: await registry.load(GUID, kind), requests: s.requests };
  } finally {
    lease.dispose();
    registry.dispose();
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
  expect(result.error.code).toBe('asset-fetch-failed');
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

it('records each completed package read and asset decode on the load timeline', async () => {
  const before = snapshotLoadTimeline().records.length;
  const { result } = await loadPack(['reset-body']);
  expect(result.ok).toBe(true);
  const rows = snapshotLoadTimeline().records.slice(before);
  const pack = rows.find((r) => r.kind === 'fetch' && r.name.endsWith('/value.pack.json'));
  // One record for the recovered read; the interrupted first attempt is in `attempts`.
  expect(pack?.detail).toMatchObject({ attempts: 2 });
  expect(pack?.end).toBeGreaterThanOrEqual(pack?.start ?? Number.POSITIVE_INFINITY);
  expect(rows).toContainEqual(
    expect.objectContaining({
      kind: 'decode',
      name: GUID,
      detail: { stage: 'asset', kind: kind.kind, ok: true },
    }),
  );
  const bytes = new TextEncoder().encode('payload');
  const read = await readPackage(
    async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }),
    'memory://artifact.bin',
    bytesOf,
  );
  expect(read.ok).toBe(true);
  expect(snapshotLoadTimeline().records.at(-1)).toMatchObject({
    kind: 'fetch',
    name: 'memory://artifact.bin',
    bytes: bytes.length,
    detail: { attempts: 1, contentLength: bytes.length },
  });
  // Fetchers without a headers object (tests, native hosts) still read and record.
  const headerless = await readPackage(
    async () =>
      ({
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer,
        json: async () => null,
        text: async () => '',
      }) as unknown as Response,
    'memory://headerless.bin',
    bytesOf,
  );
  expect(headerless.ok).toBe(true);
  expect(snapshotLoadTimeline().records.at(-1)).toMatchObject({
    name: 'memory://headerless.bin',
    detail: { attempts: 1 },
  });
  expect(snapshotLoadTimeline().records.at(-1)?.detail).not.toHaveProperty('contentLength');
});
