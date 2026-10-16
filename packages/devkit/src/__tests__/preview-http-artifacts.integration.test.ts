import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type IncomingHttpHeaders, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { type PreviewServer, preview } from 'vite';
import { describe, expect, it } from 'vitest';
import { type DistManifest, verifyDist } from '../dist.js';
import { preparePreviewHttpArtifacts } from '../preview-http-artifacts.js';

function get(server: PreviewServer, headers: Record<string, string> = {}, method = 'GET') {
  const address = server.httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('preview not listening');
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; bytes: Buffer }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: '/game/assets/fixture.bin',
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

async function fixture(
  run: (root: string, manifest: DistManifest, bytes: Buffer) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-preview-http-'));
  const dist = join(root, 'dist');
  const bytes = Buffer.from('production mesh binary '.repeat(8192));
  const files = new Map([
    ['index.html', Buffer.from('<html></html>')],
    ['pack-index.json', Buffer.from('{}')],
    ['shaders/manifest.json', Buffer.from('{}')],
    ['assets/fixture.bin', bytes],
  ]);
  const manifest: DistManifest = {
    schemaVersion: '1.0.0',
    project: { id: 'http-fixture', name: 'HTTP fixture' },
    base: '/game/',
    runtime: { packIndexUrl: 'pack-index.json', shaderManifestUrl: 'shaders/manifest.json' },
    artifacts: [...files].map(([path, body]) => ({
      path,
      mediaType: path.endsWith('.bin')
        ? 'application/octet-stream'
        : path.endsWith('.html')
          ? 'text/html'
          : 'application/json',
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    })),
  };
  try {
    await mkdir(join(dist, 'assets'), { recursive: true });
    await mkdir(join(dist, 'shaders'), { recursive: true });
    for (const [path, body] of files) await writeFile(join(dist, path), body);
    await writeFile(join(dist, 'forgeax-dist.json'), JSON.stringify(manifest));
    const verified = await verifyDist(dist);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw verified.error;
    await run(root, verified.value, bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('verified dist BIN HTTP transport', () => {
  it('uses the official Vite preview hook with identical decoded bytes, correct negotiation and unchanged dist provenance', async () => {
    await fixture(async (root, manifest, bytes) => {
      const plugin = await preparePreviewHttpArtifacts(join(root, 'dist'), manifest);
      const server = await preview({
        root,
        configFile: false,
        base: manifest.base,
        plugins: [plugin],
        build: { outDir: join(root, 'dist') },
        preview: {
          host: '127.0.0.1',
          port: 0,
          strictPort: true,
          headers: { 'Cross-Origin-Resource-Policy': 'cross-origin', Vary: 'Origin' },
        },
      });
      try {
        const compressed = await get(server, { 'Accept-Encoding': 'gzip' });
        expect(compressed.status).toBe(200);
        expect(compressed.headers['content-encoding']).toBe('gzip');
        expect(Number(compressed.headers['content-length'])).toBe(compressed.bytes.length);
        expect(compressed.headers.vary).toContain('Accept-Encoding');
        expect(compressed.headers.vary).toContain('Origin');
        expect(compressed.headers['cross-origin-resource-policy']).toBe('cross-origin');
        expect(gunzipSync(compressed.bytes)).toEqual(bytes);
        for (const value of ['identity', 'gzip;q=0, *;q=1', 'gzip;q=0.1, identity;q=1']) {
          const identity = await get(server, { 'Accept-Encoding': value });
          expect(identity.headers['content-encoding']).toBeUndefined();
          expect(identity.bytes).toEqual(bytes);
          expect(Number(identity.headers['content-length'])).toBe(bytes.length);
        }
        const head = await get(server, { 'Accept-Encoding': 'gzip' }, 'HEAD');
        expect(head.status).toBe(200);
        expect(head.bytes.length).toBe(0);
        expect(Number(head.headers['content-length'])).toBe(bytes.length);
        const etag = head.headers.etag;
        const lastModified = head.headers['last-modified'];
        if (typeof etag !== 'string' || typeof lastModified !== 'string') {
          throw new Error('Vite static HEAD did not publish its ETag and Last-Modified');
        }
        const notModified = await get(server, { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
        expect(notModified.status).toBe(304);
        expect(notModified.bytes.length).toBe(0);
        expect(notModified.headers['content-encoding']).toBeUndefined();
        const staleEtag = await get(server, {
          'Accept-Encoding': 'gzip',
          'If-None-Match': `${etag}-stale`,
        });
        expect(staleEtag.status).toBe(200);
        expect(staleEtag.bytes).toEqual(bytes);
        // Vite's maintained static owner emits Last-Modified but only uses ETag
        // for 304. Preserve its actual date-condition behavior rather than
        // introducing an independent freshness policy in the compression hook.
        const dateCondition = await get(server, {
          'Accept-Encoding': 'gzip',
          'If-Modified-Since': lastModified,
        });
        expect(dateCondition.status).toBe(200);
        expect(dateCondition.bytes).toEqual(bytes);
        expect(dateCondition.headers['last-modified']).toBe(lastModified);
        expect(dateCondition.headers['content-encoding']).toBeUndefined();
        const rejectedHeaders: Record<string, string>[] = [
          { 'Accept-Encoding': 'gzip;q=0, identity;q=0' },
          { 'Accept-Encoding': 'gzip;q=1, identity;q=0', Range: 'bytes=7-23' },
          { 'Accept-Encoding': 'gzip;q=1, identity;q=0', 'If-None-Match': etag },
          { 'Accept-Encoding': 'gzip;q=1, identity;q=0', 'If-Modified-Since': lastModified },
        ];
        for (const headers of rejectedHeaders) {
          const rejected = await get(server, headers);
          expect(rejected.status).toBe(406);
          expect(rejected.bytes.length).toBe(0);
          expect(rejected.headers['content-length']).toBe('0');
          expect(rejected.headers['content-encoding']).toBeUndefined();
        }
        const rejectedHead = await get(
          server,
          { 'Accept-Encoding': 'gzip;q=1, identity;q=0' },
          'HEAD',
        );
        expect(rejectedHead.status).toBe(406);
        expect(rejectedHead.headers['content-length']).toBe('0');
        expect(rejectedHead.bytes.length).toBe(0);
        const gzipOnly = await get(server, { 'Accept-Encoding': 'gzip;q=1, identity;q=0' });
        expect(gzipOnly.status).toBe(200);
        expect(gzipOnly.headers['content-encoding']).toBe('gzip');
        expect(gunzipSync(gzipOnly.bytes)).toEqual(bytes);
        const explicitIdentity = await get(server, { 'Accept-Encoding': '*;q=0, identity;q=1' });
        expect(explicitIdentity.status).toBe(200);
        expect(explicitIdentity.headers['content-encoding']).toBeUndefined();
        expect(explicitIdentity.bytes).toEqual(bytes);
        const range = await get(server, { 'Accept-Encoding': 'gzip', Range: 'bytes=7-23' });
        expect(range.status).toBe(206);
        expect(range.headers['content-encoding']).toBeUndefined();
        expect(range.bytes).toEqual(bytes.subarray(7, 24));
        const openRange = await get(server, {
          'Accept-Encoding': 'gzip',
          Range: `bytes=${bytes.length - 8}-`,
        });
        expect(openRange.status).toBe(206);
        expect(openRange.bytes).toEqual(bytes.subarray(bytes.length - 8));
        const invalid = await get(server, {
          Range: `bytes=${bytes.length + 1}-${bytes.length + 8}`,
        });
        expect(invalid.status).toBe(416);
        expect(invalid.bytes.length).toBe(0);
        const address = server.httpServer.address();
        if (address === null || typeof address === 'string') throw new Error('missing address');
        const browser = await fetch(`http://127.0.0.1:${address.port}/game/assets/fixture.bin`);
        expect(Buffer.from(await browser.arrayBuffer())).toEqual(bytes);
        expect(await verifyDist(join(root, 'dist'))).toEqual({ ok: true, value: manifest });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.httpServer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });

  it('rejects changed BIN bytes between verification and representation preparation', async () => {
    await fixture(async (root, manifest) => {
      await writeFile(join(root, 'dist', 'assets', 'fixture.bin'), 'changed');
      await expect(preparePreviewHttpArtifacts(join(root, 'dist'), manifest)).rejects.toThrow(
        'changed after dist verification',
      );
    });
  });
});
