import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import { gunzipSync, type ZlibOptions } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDevSession } from '../dev/dev-session.js';
import { createTransportRouteHandler } from '../dev/transport-routes.js';
import { type HttpArtifact, HttpArtifactCompression } from '../http-artifact.js';
import { createProductionSession } from '../production/session.js';

const artifactPath = '/__forgeax-ddc/fixture/body.bin';
const scopedArtifactPath = `/__pack/scopes/http-fixture/1/asset${artifactPath}`;

const encoder = vi.hoisted(() => ({ calls: 0, active: 0, peak: 0, fail: '' }));
vi.mock('node:zlib', async () => {
  const actual = await vi.importActual<typeof import('node:zlib')>('node:zlib');
  return {
    ...actual,
    gzip(
      bytes: Uint8Array,
      options: ZlibOptions,
      callback: (error: Error | null, body: Buffer) => void,
    ) {
      encoder.calls++;
      if (encoder.fail === 'throw') throw new Error('encoder unavailable');
      if (encoder.fail === 'callback')
        return callback(new Error('encoder unavailable'), Buffer.alloc(0));
      encoder.peak = Math.max(encoder.peak, ++encoder.active);
      actual.gzip(bytes, options, (error, body) => {
        encoder.active--;
        callback(error, body);
      });
    },
  };
});

function get(server: Server, headers: Record<string, string> = {}, method = 'GET') {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('HTTP server not listening');
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; bytes: Buffer }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: scopedArtifactPath,
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

async function serve(
  compression: HttpArtifactCompression,
  artifact: HttpArtifact,
  run: (server: Server) => Promise<void>,
  encoded = false,
  devRoute = false,
) {
  const productionSession = createProductionSession({
    initialGeneration: 1,
    inventory: async () => [],
    produce: async () => {},
    publish: async () => {},
  });
  const devSession = createDevSession({
    generation: 1,
    productionSession,
    startup: async () => {
      const result = await productionSession.start();
      if (result.status !== 'accepted') throw new Error('fixture production failed');
      return { generation: 1, catalog: [], authority: 'authoritative', diagnostics: [] };
    },
  });
  devSession.bindRuntime({
    schemaVersion: 'runtime-asset-binding-v1',
    gameId: 'http-fixture',
    scopeId: 'http-fixture',
    generation: 1,
    status: 'unbound',
    catalogUrl: '/__pack/scopes/http-fixture/1/catalog.json',
    importUrlBase: '/__pack/scopes/http-fixture/1/import',
    packageUrlBase: '/__pack/scopes/http-fixture/1/asset',
  });
  await devSession.start();
  const route = createTransportRouteHandler({
    startupReady: Promise.resolve(),
    state: {
      artifactCompression: compression,
      catalogProjection: {
        schemaVersion: 'catalog-legacy-v1',
        entries: [],
        authority: 'authoritative',
        diagnostics: [],
        declarations: new Map(),
        sourceDeclarations: new Map(),
      },
      importedGuids: new Set(),
      metaPackBodies: new Map(),
      devArtifactBodies: new Map([[artifactPath, artifact]]),
    },
    callbacks: {
      materializeAsset: async () => [],
      rebuildAsset: async () => [],
      ensureMetaPackBody: async () => undefined,
    },
    devSession,
    scopedPackageUrl: (_binding, url) => url,
    scopedCatalogBody: () => '',
  });
  const server = createServer((req, res) => {
    res.setHeader('Vary', 'Origin');
    if (encoded) res.setHeader('Content-Encoding', 'gzip');
    if (devRoute) {
      Promise.resolve(
        route(req, res, () => {
          res.statusCode = 404;
          res.end();
        }),
      ).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    } else compression.send(req, res, artifact);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await devSession.close();
  }
}

const artifact = (): HttpArtifact => ({
  bytes: Buffer.from('mesh vertex bytes '.repeat(8192)),
  mimeType: 'application/x-forgeax-mesh',
});

describe('published HTTP artifact representations', () => {
  beforeEach(() => {
    encoder.calls = 0;
    encoder.active = 0;
    encoder.peak = 0;
    encoder.fail = '';
  });

  it('serves actual gzip HTTP bytes with byte-identical decoded SHA and no request-time encoding', async () => {
    const compression = new HttpArtifactCompression(),
      body = artifact();
    await compression.prepare([body]);
    await serve(
      compression,
      body,
      async (server) => {
        const result = await get(server, { 'Accept-Encoding': 'gzip' });
        expect(result.status).toBe(200);
        expect(result.headers['content-encoding']).toBe('gzip');
        expect(Number(result.headers['content-length'])).toBe(result.bytes.length);
        expect(result.headers.vary).toBe('Origin, Accept-Encoding');
        expect(gunzipSync(result.bytes)).toEqual(Buffer.from(body.bytes));
        const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
        expect(sha(gunzipSync(result.bytes))).toBe(sha(body.bytes));
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('missing address');
        const fetched = await fetch(`http://127.0.0.1:${address.port}${scopedArtifactPath}`);
        expect(Buffer.from(await fetched.arrayBuffer())).toEqual(Buffer.from(body.bytes));
        await get(server, { 'Accept-Encoding': 'gzip' });
        expect(encoder.calls).toBe(1);
      },
      false,
      true,
    );
  });

  it('honors q=0, explicit identity preference, malformed q, HEAD, and absent negotiation', async () => {
    const compression = new HttpArtifactCompression(),
      body = artifact();
    await compression.prepare([body]);
    await serve(compression, body, async (server) => {
      for (const value of [
        '',
        'gzip;q=0',
        'gzip;q=0, *;q=1',
        'gzip;q=0.2, identity;q=1',
        'identity',
        'gzip;q=bad',
      ]) {
        const result = await get(server, { 'Accept-Encoding': value });
        expect(result.headers['content-encoding'], value).toBeUndefined();
        expect(result.bytes, value).toEqual(Buffer.from(body.bytes));
        expect(Number(result.headers['content-length'])).toBe(body.bytes.length);
      }
      expect(
        (await get(server, { 'Accept-Encoding': '*;q=0.8' })).headers['content-encoding'],
      ).toBe('gzip');
      const head = await get(server, { 'Accept-Encoding': 'gzip' }, 'HEAD');
      expect(head.bytes.length).toBe(0);
      expect(head.headers['content-encoding']).toBeUndefined();
      expect(Number(head.headers['content-length'])).toBe(body.bytes.length);
    });
  });

  it('preserves decoded-byte Range and rejects malformed or out-of-bounds ranges', async () => {
    const compression = new HttpArtifactCompression(),
      body = artifact();
    await compression.prepare([body]);
    await serve(compression, body, async (server) => {
      const result = await get(server, { 'Accept-Encoding': 'gzip', Range: 'bytes=7-23' });
      expect(result.status).toBe(206);
      expect(result.headers['content-encoding']).toBeUndefined();
      expect(result.headers['content-range']).toBe(`bytes 7-23/${body.bytes.length}`);
      expect(result.bytes).toEqual(Buffer.from(body.bytes.subarray(7, 24)));
      for (const range of ['bytes=4-2', 'bytes=0-99999999', 'bytes=0-2,4-8', 'invalid']) {
        const invalid = await get(server, { 'Accept-Encoding': 'gzip', Range: range });
        expect(invalid.status).toBe(416);
        expect(invalid.bytes.length).toBe(0);
        expect(invalid.headers['content-range']).toBe(`bytes */${body.bytes.length}`);
      }
    });
  });

  it('returns HTTP 406 for forbidden identity instead of silently falling back, including HEAD and Range', async () => {
    const compression = new HttpArtifactCompression(),
      body = artifact();
    await serve(
      compression,
      body,
      async (server) => {
        for (const value of ['gzip;q=0, identity;q=0', 'gzip;q=1, identity;q=0', '*;q=0']) {
          const rejected = await get(server, { 'Accept-Encoding': value });
          expect(rejected.status).toBe(406);
          expect(rejected.bytes.length).toBe(0);
          expect(rejected.headers['content-length']).toBe('0');
          expect(rejected.headers['content-encoding']).toBeUndefined();
        }
        expect(encoder.calls).toBe(0);
      },
      false,
      true,
    );
    await compression.prepare([body]);
    await serve(
      compression,
      body,
      async (server) => {
        const gzipOnly = await get(server, { 'Accept-Encoding': 'gzip;q=1, identity;q=0' });
        expect(gzipOnly.status).toBe(200);
        expect(gzipOnly.headers['content-encoding']).toBe('gzip');
        expect(gunzipSync(gzipOnly.bytes)).toEqual(Buffer.from(body.bytes));
        const explicitIdentity = await get(server, { 'Accept-Encoding': '*;q=0, identity;q=1' });
        expect(explicitIdentity.status).toBe(200);
        expect(explicitIdentity.headers['content-encoding']).toBeUndefined();
        expect(explicitIdentity.bytes).toEqual(Buffer.from(body.bytes));
        const head = await get(server, { 'Accept-Encoding': 'gzip;q=1, identity;q=0' }, 'HEAD');
        const range = await get(server, {
          'Accept-Encoding': 'gzip;q=1, identity;q=0',
          Range: 'bytes=7-23',
        });
        for (const rejected of [head, range]) {
          expect(rejected.status).toBe(406);
          expect(rejected.bytes.length).toBe(0);
          expect(rejected.headers['content-length']).toBe('0');
          expect(rejected.headers['content-encoding']).toBeUndefined();
        }
      },
      false,
      true,
    );
  });

  it('does not encode unprepared bodies or replace an existing HTTP encoding', async () => {
    const compression = new HttpArtifactCompression(),
      body = artifact();
    await serve(compression, body, async (server) => {
      const result = await get(server, { 'Accept-Encoding': 'gzip' });
      expect(result.headers['content-encoding']).toBeUndefined();
      expect(result.bytes).toEqual(Buffer.from(body.bytes));
      expect(encoder.calls).toBe(0);
    });
    await compression.prepare([body]);
    const encoded = (await import('node:zlib')).gzipSync(body.bytes);
    await serve(
      compression,
      { ...body, bytes: encoded },
      async (server) => {
        const result = await get(server, { 'Accept-Encoding': 'gzip' });
        expect(result.bytes).toEqual(encoded);
        expect(gunzipSync(result.bytes)).toEqual(Buffer.from(body.bytes));
        expect(encoder.calls).toBe(1);
        const rejected = await get(server, { 'Accept-Encoding': 'gzip;q=0, identity;q=1' });
        expect(rejected.status).toBe(406);
        expect(rejected.bytes.length).toBe(0);
        expect(rejected.headers['content-length']).toBe('0');
        expect(rejected.headers['content-encoding']).toBeUndefined();
        const noNegotiation = await get(server);
        expect(noNegotiation.status).toBe(200);
        expect(noNegotiation.headers['content-encoding']).toBe('gzip');
        expect(gunzipSync(noNegotiation.bytes)).toEqual(Buffer.from(body.bytes));
      },
      true,
    );
  });

  it('serializes preparation and keys representations by raw body rather than GUID history', async () => {
    const compression = new HttpArtifactCompression(),
      first = artifact(),
      replacement = artifact();
    await Promise.all([compression.prepare([first, replacement]), compression.prepare([first])]);
    await compression.prepare([first]);
    expect(encoder.calls).toBe(2);
    expect(encoder.peak).toBe(1);
  });

  it.each([
    'callback',
    'throw',
  ])('retains observable %s encoding failure and identity without retrying in requests', async (mode) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const compression = new HttpArtifactCompression(),
        body = artifact();
      encoder.fail = mode;
      await compression.prepare([body]);
      await compression.prepare([body]);
      await serve(compression, body, async (server) => {
        const result = await get(server, { 'Accept-Encoding': 'gzip' });
        expect(result.headers['content-encoding']).toBeUndefined();
        expect(result.bytes).toEqual(Buffer.from(body.bytes));
        const rejected = await get(server, { 'Accept-Encoding': 'gzip;q=1, identity;q=0' });
        expect(rejected.status).toBe(406);
        expect(rejected.bytes.length).toBe(0);
        expect(rejected.headers['content-length']).toBe('0');
        expect(rejected.headers['content-encoding']).toBeUndefined();
      });
      expect(encoder.calls).toBe(1);
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });
});
