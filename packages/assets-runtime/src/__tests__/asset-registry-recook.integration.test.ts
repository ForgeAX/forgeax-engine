import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';

it('reloads sidecars after targeted and realm invalidation without changing another loaded asset', async () => {
  const guids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ] as const;
  let value = 1;
  const reads: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    reads.push(url);
    if (url === '/catalog.json') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          guids.map((guid) => ({ guid, kind: 'fixture-volume', packageUrl: `/${guid}.pack.json` })),
        ),
      );
    } else if (url.endsWith('.pack.json')) {
      const guid = url.slice(1, -10);
      const bytes = Uint8Array.of(value);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid,
              kind: 'fixture-volume',
              payload: { kind: 'fixture-volume', value },
              refs: [],
              artifacts: {
                body: {
                  path: `${guid}.bin`,
                  mediaType: 'application/octet-stream',
                  contentEncoding: 'identity',
                  byteLength: 1,
                  integrity: {
                    algorithm: 'sha256',
                    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                  },
                },
              },
            },
          ],
        }),
      );
    } else if (url.endsWith('.bin')) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(Uint8Array.of(value));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing HTTP listener');
  const registry = new AssetRegistry({} as ConstructorParameters<typeof AssetRegistry>[0]);
  registry.configurePackIndex(`http://127.0.0.1:${address.port}/catalog.json`);
  const release = registry.loaders.registerPackLoader({
    kind: 'fixture-volume',
    load(input) {
      if (input.artifacts.body?.bytes[0] !== input.payload.value) throw new Error('stale sidecar');
      return input.payload;
    },
  });
  const load = (guid: string) =>
    registry.loadByGuid<{ kind: 'fixture-volume'; value: number }>(registry.parseGuid(guid));
  try {
    const a = guids[0];
    const b = guids[1];
    expect((await load(a)).unwrap().value).toBe(1);
    expect((await load(b)).unwrap().value).toBe(1);
    value = 2;
    registry.invalidate(a);
    expect((await load(a)).unwrap().value).toBe(2);
    expect((await load(b)).unwrap().value).toBe(1);
    expect(reads.filter((url) => url === `/${b}.bin`)).toHaveLength(1);
    value = 3;
    registry.invalidateAll();
    expect((await load(a)).unwrap().value).toBe(3);
    expect((await load(b)).unwrap().value).toBe(3);
  } finally {
    release();
    registry.invalidateAll();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
