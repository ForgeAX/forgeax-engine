import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { videoContribution } from '@forgeax/engine-graphics-extras';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { expect, expectTypeOf, it } from 'vitest';

it('infers the Video payload from a source-loaded managed reference', async () => {
  const assets = new AssetRegistry();
  assets.installDecoder(videoContribution.kind, videoContribution.decoder);
  const guid = 'c0000000-0000-4000-a000-00000000a001';
  const packageUrl = 'https://video.invalid/clip.pack.json';
  const produced = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'clip.pack',
    sourceRevision: '1',
    packageUrl,
    pack: {
      assets: [
        {
          guid,
          kind: 'video',
          refs: [],
          artifacts: {},
          payload: { kind: 'video', url: 'https://video.invalid/clip.webm' },
        },
      ],
    },
  });
  assets.setCatalogSource(
    createCatalogSource({
      entries: [
        {
          guid,
          kind: 'video',
          sourcePath: 'clip.pack',
          packageUrl,
          publication: produced.publication,
        },
      ],
      fetch: async () => Response.json(produced.pack),
    }),
  );
  try {
    const handle = (await assets.load(guid, 'video')).unwrap();
    const video = assets.read(handle).unwrap();
    expectTypeOf(video.url).toEqualTypeOf<string>();
    expect(video.url).toBe('https://video.invalid/clip.webm');
    expect(video.kind).toBe('video');
  } finally {
    assets.dispose();
  }
});
