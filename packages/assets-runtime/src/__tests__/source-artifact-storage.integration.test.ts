import { createHash } from 'node:crypto';
import { compressZstd } from '@forgeax/engine-codec/encode';
import { expect, it, onTestFinished, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { captureAssetPublication } from '../capture-publication';
import { createCatalogSource } from '../catalog-source';
import { defined } from './assert-defined';
import { catalogPack } from './fixtures/catalog-pack';

function artifactReader(
  entries: Parameters<typeof createCatalogSource>[0]['entries'],
  fetch: typeof globalThis.fetch,
  kind: ReturnType<typeof defineAssetKind<Uint8Array>>,
) {
  const source = createCatalogSource({ entries, fetch });
  const assets = new AssetRegistry({ catalog: source });
  assets.installDecoder(kind, {
    decode: ({ artifacts, envelope }) => artifacts.read(defined(envelope.artifacts.body)),
  });
  onTestFinished(() => assets.dispose());
  return { assets, source };
}

it('coalesces in-flight reads across source packages while isolating decoded caller data', async () => {
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
    const produced = catalogPack(
      [{ guid, kind: kind.kind, payload: {}, refs: [], artifacts: { body: descriptor } }],
      { sourcePath: String(i), packageUrl },
    );
    return {
      ...produced,
      row: defined(produced.rows[0]),
    };
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const publication = publications.find((value) => value.row.packageUrl === String(input));
    return publication ? Response.json(publication.pack) : new Response(raw.slice());
  });
  const { assets, source } = artifactReader(
    publications.map(({ row }) => row),
    fetcher,
    kind,
  );
  const values = await Promise.all(publications.map((value) => assets.load(value.row.guid, kind)));
  for (const value of values) value.unwrap();
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('shared.bin'))).toHaveLength(1);
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
  // Two package documents and one shared body for the loads; the capture reads its package and body again.
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it.each([
  'identity',
  'zstd',
] as const)('loads %s and captures original stored bytes with one more body read', async (encoding) => {
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
  const { pack, rows } = catalogPack(
    [{ guid, kind: kind.kind, refs: [], artifacts: { body }, payload: {} }],
    { sourcePath: 'main.pack', packageUrl },
  );
  const row = defined(rows[0]);
  const fetcher = vi.fn(async (url: RequestInfo | URL) =>
    String(url) === packageUrl ? new Response(JSON.stringify(pack)) : new Response(stored.slice()),
  );
  const { assets, source } = artifactReader([row], fetcher, kind);
  const handle = (await assets.load(guid, kind)).unwrap();
  expect(assets.read(handle).unwrap()).toEqual(raw);
  const count = fetcher.mock.calls.length;
  const fixed = (
    await captureAssetPublication(row, [row], source, fetcher, { registry: assets })
  ).unwrap();
  expect(fixed.blobs['body.bin']).toEqual(stored);
  // Nothing completed is retained: the capture re-reads the package document and the body.
  expect(fetcher).toHaveBeenCalledTimes(count + 2);
});
