import { createHash } from 'node:crypto';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { expect, it, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { captureAssetPublication } from '../capture-publication';
import { createCatalogSource } from '../catalog-source';
import { defined } from './assert-defined';

it('loads independent windows through the production source and captures the complete stored container', async () => {
  const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const stored = Uint8Array.of(99, 1, 2, 3, 4, 5, 88);
  const kind = defineAssetKind<Uint8Array>('chunk-binary');
  const ids = ['00000000-0000-7000-8000-000000000971', '00000000-0000-7000-8000-000000000972'];
  const packageUrl = 'https://source.invalid/map.pack.json';
  const produced = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'chunk.pack',
    sourceRevision: '1',
    packageUrl,
    pack: {
      assets: ids.map((guid, index) => ({
        guid,
        kind: kind.kind,
        payload: {},
        refs: [],
        artifacts: {
          body: {
            path: 'chunk.bin',
            contentEncoding: 'identity',
            mediaType: 'application/octet-stream',
            byteLength: index === 0 ? 3 : 2,
            integrity: {
              algorithm: 'sha256',
              digest: hash(stored.slice(index === 0 ? 1 : 4, index === 0 ? 4 : 6)),
            },
            byteRange: {
              offset: index === 0 ? 1 : 4,
              length: index === 0 ? 3 : 2,
              containerDigest: hash(stored),
            },
          },
        },
      })),
    },
  });
  const rows = ids.map((guid) => ({
    guid,
    kind: kind.kind,
    packageUrl,
    sourcePath: 'chunk.pack',
    publication: produced.publication,
  }));
  const fetcher = vi.fn(async (url: RequestInfo | URL) =>
    String(url) === packageUrl ? Response.json(produced.pack) : new Response(stored.slice()),
  );
  const source = createCatalogSource({ entries: rows, fetch: fetcher });
  const assets = new AssetRegistry({ catalog: source });
  assets.installDecoder(kind, {
    decode: ({ artifacts, envelope }) => artifacts.read(defined(envelope.artifacts.body)),
  });
  try {
    const handles = await Promise.all(
      ids.map(async (guid) => (await assets.load(guid, kind)).unwrap()),
    );
    expect(assets.read(defined(handles[0])).unwrap()).toEqual(Uint8Array.of(1, 2, 3));
    expect(assets.read(defined(handles[1])).unwrap()).toEqual(Uint8Array.of(4, 5));
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('chunk.bin'))).toHaveLength(1);
    assets.read(defined(handles[0])).unwrap()[0] = 77;
    const captured = (
      await captureAssetPublication(defined(rows[0]), rows, source, fetcher, { registry: assets })
    ).unwrap();
    expect(captured.blobs['chunk.bin']).toEqual(stored);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('chunk.bin'))).toHaveLength(2);
  } finally {
    assets.dispose();
  }
});
