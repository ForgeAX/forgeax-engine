import { createHash } from 'node:crypto';
import { encodeAssetBundle } from '@forgeax/engine-pack/bundle';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { expect, it, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { captureAssetPublication } from '../capture-publication';
import { createCatalogSource } from '../catalog-source';
import { defined } from './assert-defined';

it('loads independent Bundle entries through the production source and captures the complete Bundle', async () => {
  const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const bodies = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)];
  const { bytes: stored, windows } = encodeAssetBundle(bodies);
  const kind = defineAssetKind<Uint8Array>('bundle-binary');
  const ids = ['00000000-0000-7000-8000-000000000971', '00000000-0000-7000-8000-000000000972'];
  const packageUrl = 'https://source.invalid/map.pack.json';
  const produced = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'bundle.pack',
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
            path: 'bundle.bin',
            contentEncoding: 'identity',
            mediaType: 'application/octet-stream',
            byteLength: defined(bodies[index]).byteLength,
            integrity: { algorithm: 'sha256', digest: hash(defined(bodies[index])) },
            byteRange: { ...defined(windows[index]), bundleDigest: hash(stored) },
          },
        },
      })),
    },
  });
  const rows = ids.map((guid) => ({
    guid,
    kind: kind.kind,
    packageUrl,
    sourcePath: 'bundle.pack',
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
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('bundle.bin'))).toHaveLength(
      1,
    );
    assets.read(defined(handles[0])).unwrap()[0] = 77;
    const captured = (
      await captureAssetPublication(defined(rows[0]), rows, source, fetcher, { registry: assets })
    ).unwrap();
    expect(captured.blobs['bundle.bin']).toEqual(stored);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('bundle.bin'))).toHaveLength(
      2,
    );
  } finally {
    assets.dispose();
  }
});
