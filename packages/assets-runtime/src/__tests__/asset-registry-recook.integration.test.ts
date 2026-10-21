import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { AssetError, err, ok } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';

it('reloads recooked sidecars explicitly, retaining runtime identity and unrelated gameplay edits', async () => {
  const guids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ] as const;
  const kind = defineAssetKind<{ value: number }>('fixture-volume');
  const versions = new Map<string, number>(guids.map((guid) => [guid, 1]));
  const reads: string[] = [];
  const publication = (guid: string) => {
    const value = versions.get(guid);
    assert(value !== undefined);
    const path = `${guid}-${value}.bin`;
    return createRuntimePackPublication({
      scopeId: 'asset-runtime',
      sourcePath: `${guid}.source`,
      sourceRevision: String(value),
      generation: value,
      packageUrl: `${origin}/${guid}-${value}.pack.json`,
      pack: {
        assets: [
          {
            guid,
            kind: kind.kind,
            payload: { value },
            refs: [],
            artifacts: {
              body: {
                path,
                mediaType: 'application/octet-stream',
                contentEncoding: 'identity',
                byteLength: 1,
                integrity: {
                  algorithm: 'sha256',
                  digest: `sha256:${createHash('sha256').update(Uint8Array.of(value)).digest('hex')}`,
                },
              },
            },
          },
        ],
      },
    });
  };
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    reads.push(url);
    if (url === '/catalog.json') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          guids.map((guid) => ({
            guid,
            kind: kind.kind,
            packageUrl: `${origin}/${guid}-${versions.get(guid)}.pack.json`,
            sourcePath: `${guid}.source`,
            publication: publication(guid).publication,
          })),
        ),
      );
      return;
    }
    const guid = guids.find((guid) => url.startsWith(`/${guid}-`));
    if (guid !== undefined && url.endsWith('.pack.json')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(publication(guid).pack));
    } else if (guid !== undefined && url.endsWith('.bin')) {
      response.setHeader('content-type', 'application/octet-stream');
      const value = versions.get(guid);
      assert(value !== undefined);
      response.end(Uint8Array.of(value));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing HTTP listener');
  const origin = `http://127.0.0.1:${address.port}`;
  const registry = new AssetRegistry();
  registry.setCatalogSource(createCatalogSource({ url: `${origin}/catalog.json` }));
  registry.installDecoder(kind, {
    async decode({ envelope, artifacts }) {
      const descriptor = envelope.artifacts.body;
      if (descriptor === undefined) throw new Error('missing fixture artifact');
      const bytes = await artifacts.read(descriptor);
      if (!bytes.ok) return bytes;
      if (bytes.value[0] !== envelope.payload.value) throw new Error('stale sidecar');
      return ok(envelope.payload);
    },
    prepare: (value) =>
      Number.isFinite(value.value)
        ? ok(value)
        : err(
            new AssetError({
              code: 'asset-invalid-value',
              expected: 'finite fixture value',
              hint: 'fix source value',
            }),
          ),
  });
  try {
    const a = (await registry.load(guids[0], kind)).unwrap();
    const b = (await registry.load(guids[1], kind)).unwrap();
    registry.update(b, { value: 9 }).unwrap();
    versions.set(guids[0], 2);
    (await registry.reconcileCatalog()).unwrap();
    expect(registry.read(a).unwrap().value).toBe(1);
    (await registry.reload(a, { conflict: 'reject' })).unwrap();
    expect(registry.read(a).unwrap().value).toBe(2);
    expect(registry.read(b).unwrap().value).toBe(9);
    expect(reads.filter((url) => url === `/${guids[1]}-1.bin`)).toHaveLength(1);
    for (const guid of guids) versions.set(guid, 3);
    (await registry.reconcileCatalog()).unwrap();
    expect((await registry.reload(b, { conflict: 'reject' })).ok).toBe(false);
    expect(registry.read(b).unwrap().value).toBe(9);
    (await registry.reload(a, { conflict: 'overwrite' })).unwrap();
    (await registry.reload(b, { conflict: 'overwrite' })).unwrap();
    expect(registry.read(a).unwrap().value).toBe(3);
    expect(registry.read(b).unwrap().value).toBe(3);
    expect((await registry.load(guids[0], kind)).unwrap()).toBe(a);
    expect((await registry.load(guids[1], kind)).unwrap()).toBe(b);
  } finally {
    registry.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
