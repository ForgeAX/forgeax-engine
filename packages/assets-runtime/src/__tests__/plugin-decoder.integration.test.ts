import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { Context } from '@forgeax/engine-plugin';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';
import { assetDecoderPlugin, assetsPlugin } from '../plugin';

it('Cordis Fibers lease the real decoder and keep accepted content alive after retirement', async () => {
  const kind = defineAssetKind<{ kind: 'test-dialogue'; lines: string[] }>('test-dialogue');
  const guids = ['00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002'];
  const packageUrl = 'https://decoder.invalid/pack.json';
  const published = createRuntimePackPublication({
    scopeId: 'decoder',
    packageUrl,
    sourcePath: 'dialogue',
    sourceRevision: '1',
    pack: {
      assets: guids.map((guid) => ({
        guid,
        kind: kind.kind,
        refs: [],
        artifacts: {},
        payload: { kind: kind.kind, lines: ['hello'] },
      })),
    },
  });
  const assets = new AssetRegistry({ scopeId: 'decoder' });
  assets.setCatalogSource(
    createCatalogSource({
      entries: guids.map((guid) => ({
        guid,
        kind: kind.kind,
        packageUrl,
        sourcePath: 'dialogue',
        publication: published.publication,
      })),
      fetch: async () => new Response(JSON.stringify(published.pack)),
    }),
  );
  const context = new Context();
  const service = await context.plugin(assetsPlugin(assets));
  const contribution = {
    kind,
    consumer: 'Dialogue',
    decoder: { decode: async () => ok({ kind: 'test-dialogue' as const, lines: ['hello'] }) },
  };
  const fiber = await context.plugin(assetDecoderPlugin(contribution));
  try {
    const handle = (await assets.load(guids[0] as string, kind)).unwrap();
    await fiber.dispose();
    expect(assets.read(handle).unwrap().lines).toEqual(['hello']);
    expect(await assets.load(guids[1] as string, kind)).toMatchObject({
      ok: false,
      error: { code: 'asset-decoder-missing' },
    });
  } finally {
    await fiber.dispose();
    await service.dispose();
    assets.dispose();
  }
});
