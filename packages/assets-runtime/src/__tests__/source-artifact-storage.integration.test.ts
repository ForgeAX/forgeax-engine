import { createHash } from 'node:crypto';
import { compressZstd } from '@forgeax/engine-codec/encode';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { expect, it, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { captureAssetPublication } from '../capture-publication';
import { createCatalogSource } from '../catalog-source';
import { defined } from './assert-defined';

it('shares verified stored bytes across source packages while isolating decoded caller data', async () => {
  const raw = Uint8Array.of(1, 2, 3);
  const kind = defineAssetKind<Uint8Array>('test-binary');
  const descriptor = {
    path: 'shared.bin',
    contentEncoding: 'identity' as const,
    mediaType: 'application/octet-stream',
    byteLength: raw.length,
    integrity: {
      algorithm: 'sha256' as const,
      digest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    },
  };
  const publications = [1, 2].map((i) => {
    const guid = `00000000-0000-7000-8000-00000000091${i}`;
    const packageUrl = `https://source.invalid/${i}.pack.json`;
    const produced = createRuntimePackPublication({
      scopeId: 'asset-runtime',
      sourcePath: String(i),
      sourceRevision: '1',
      packageUrl,
      pack: {
        assets: [{ guid, kind: kind.kind, payload: {}, refs: [], artifacts: { body: descriptor } }],
      },
    });
    return {
      ...produced,
      row: {
        guid,
        kind: kind.kind,
        packageUrl,
        sourcePath: String(i),
        publication: produced.publication,
      },
    };
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const publication = publications.find((value) => value.row.packageUrl === String(input));
    return publication ? Response.json(publication.pack) : new Response(raw.slice());
  });
  const source = createCatalogSource({
    entries: publications.map((value) => value.row),
    fetch: fetcher,
  });
  const assets = new AssetRegistry({ catalog: source });
  assets.installDecoder(kind, {
    decode: ({ artifacts, envelope }) => artifacts.read(defined(envelope.artifacts.body)),
  });
  try {
    const values = await Promise.all(
      publications.map((value) => assets.load(value.row.guid, kind)),
    );
    for (const value of values) value.unwrap();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('shared.bin'))).toHaveLength(
      1,
    );
    assets.read(defined(values[0]).unwrap()).unwrap()[0] = 9;
    expect(assets.read(defined(values[1]).unwrap()).unwrap()).toEqual(raw);
    const fixed = (
      await captureAssetPublication(
        defined(publications[0]).row,
        publications.map((value) => value.row),
        source,
        fetcher,
        { registry: assets },
      )
    ).unwrap();
    expect(fixed.blobs['shared.bin']).toEqual(raw);
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    assets.dispose();
  }
});

it.each([
  'identity',
  'zstd',
] as const)('loads %s and captures original stored bytes without repeated I/O', async (encoding) => {
  const guid = '00000000-0000-7000-8000-000000000918';
  const packageUrl = 'https://source.invalid/main.pack.json';
  const raw = new Uint8Array([2, 4, 6, 8]);
  const compressed = await compressZstd(raw);
  if (!compressed.ok) throw compressed.error;
  const stored = encoding === 'zstd' ? compressed.value : raw;
  const body = {
    path: 'body.bin',
    contentEncoding: encoding,
    mediaType: 'application/octet-stream',
    byteLength: raw.length,
    integrity: {
      algorithm: 'sha256' as const,
      digest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    },
  };
  const kind = defineAssetKind<Uint8Array>('test-binary');
  const { pack, publication } = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'main.pack',
    sourceRevision: '1',
    packageUrl,
    pack: { assets: [{ guid, kind: kind.kind, refs: [], artifacts: { body }, payload: {} }] },
  });
  const row = { guid, kind: kind.kind, packageUrl, sourcePath: 'main.pack', publication };
  const fetcher = vi.fn(async (url: RequestInfo | URL) =>
    String(url) === packageUrl ? new Response(JSON.stringify(pack)) : new Response(stored.slice()),
  );
  const source = createCatalogSource({ entries: [row], fetch: fetcher });
  const assets = new AssetRegistry({ catalog: source });
  assets.installDecoder(kind, {
    decode: ({ artifacts, envelope }) => artifacts.read(defined(envelope.artifacts.body)),
  });
  try {
    const handle = (await assets.load(guid, kind)).unwrap();
    expect(assets.read(handle).unwrap()).toEqual(raw);
    const count = fetcher.mock.calls.length;
    const fixed = (
      await captureAssetPublication(row, [row], source, fetcher, { registry: assets })
    ).unwrap();
    expect(fixed.blobs['body.bin']).toEqual(stored);
    expect(fetcher).toHaveBeenCalledTimes(count);
  } finally {
    assets.dispose();
  }
});
