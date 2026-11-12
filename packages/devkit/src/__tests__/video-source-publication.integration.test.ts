// An imported `.mp4` must reach a material as a playable URL: the container is
// published as one streamed Pack artifact, the decoder resolves its URL, and
// the loader never downloads the video body (the Host <video> element does,
// with Range requests). A Three port's billboards failed before because no
// importer admitted the container at all.
import { createServer } from 'node:http';
import {
  AssetRegistry,
  createCatalogSource,
  defineAssetKind,
} from '@forgeax/engine-assets-runtime';
import { videoContribution } from '@forgeax/engine-graphics-extras';
import { videoImporter } from '@forgeax/engine-graphics-extras/video-importer';
import {
  createRuntimePackPublication,
  finalizePackageTransportSource,
} from '@forgeax/engine-pack/build';
import type { ImportResult, VideoAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { DEFAULT_IMPORTERS } from '../importers.js';

it('publishes an imported mp4 as a streamed artifact and loads it as the VideoAsset URL', async () => {
  expect(DEFAULT_IMPORTERS).toContain(videoImporter);
  const guid = '019f5d11-0e1f-7c21-a4d2-7e4f6e8f2101';
  const container = Uint8Array.from({ length: 64 }, (_, index) => index);
  const imported: ImportResult = await videoImporter.import({
    source: 'billboards/ad-01.mp4',
    subAssets: [{ guid, sourceIndex: 0, kind: 'video' }],
    importSettings: {},
    readSource: async () => ({ ok: true, value: container }),
    readSibling: async () => ({ ok: true, value: new Uint8Array() }),
    decodeImage: async () => {
      throw new Error('video import never decodes');
    },
  });
  if (!imported.ok) throw imported.error;
  const emitted = new Map<string, Uint8Array>();
  const built = await finalizePackageTransportSource(
    {
      assets: imported.value.assets.map((asset) => ({
        ...asset,
        payload: { ...asset.payload },
        refs: asset.refs.map((ref) => ref.guid),
      })),
    },
    {
      base: '/',
      packagePath: 'video.pack.json',
      artifactPath: (assetGuid, key) => `media/${assetGuid}/${key}.bin`,
      sink: (path, bytes) => {
        emitted.set(path, bytes);
      },
    },
  );
  const descriptor = built.pack.assets[0]?.artifacts.source;
  expect(descriptor).toMatchObject({
    delivery: 'stream',
    mediaType: 'video/mp4',
    byteLength: container.byteLength,
    integrity: { algorithm: 'sha256' },
  });
  expect(built.pack.assets[0]?.payload).toEqual({ kind: 'video', mediaType: 'video/mp4' });
  expect(emitted.get(`media/${guid}/source.bin`)).toEqual(container);
  const { pack, publication } = createRuntimePackPublication({
    pack: built.pack,
    scopeId: 'video-source',
    generation: 1,
    sourcePath: 'billboards/ad-01.mp4',
    sourceRevision: 'one',
    packageUrl: '/video.pack.json',
  });
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push(path);
    response.setHeader('Content-Type', 'application/json');
    if (path === '/catalog.json')
      response.end(
        JSON.stringify([
          {
            guid,
            kind: 'video',
            packageUrl: '/video.pack.json',
            sourcePath: 'billboards/ad-01.mp4',
            publication,
          },
        ]),
      );
    else if (path === '/video.pack.json') response.end(JSON.stringify(pack));
    else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing HTTP address');
    const origin = `http://127.0.0.1:${address.port}`;
    const registry = new AssetRegistry({
      scopeId: 'video-source',
      catalog: createCatalogSource({ url: `${origin}/catalog.json` }),
    });
    const videoKind = defineAssetKind<VideoAsset, 'video'>('video');
    registry.installDecoder(videoKind, videoContribution.decoder);
    const handle = (await registry.load(guid, videoKind)).unwrap();
    expect(registry.read(handle).unwrap()).toEqual({
      kind: 'video',
      url: `${origin}/media/${guid}/source.bin`,
    });
    expect(requests).toEqual(['/catalog.json', '/video.pack.json']);
    registry.release(handle).unwrap();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
