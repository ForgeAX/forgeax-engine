import { Context } from '@forgeax/engine-plugin';
import type { Loader } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { AssetRegistry } from '../asset-registry';
import { LoaderRegistry } from '../loader-registry';
import { assetLoaderPlugin, assetsPlugin, packLoaderPlugin } from '../plugin';

describe('asset capability plugins', () => {
  it('removes loader contributions with their Fibers', async () => {
    const loaders = new LoaderRegistry();
    const assets = { loaders } as AssetRegistry;
    const loader = {
      kind: 'test-dialogue',
      load: () => ({ lines: [] }),
    } satisfies Loader<unknown>;
    const packLoader = {
      kind: 'test-cutscene',
      load: () => ({ shots: [] }),
    };
    const context = new Context();
    await context.plugin(assetsPlugin(assets));
    const loaderFiber = await context.plugin(assetLoaderPlugin(loader));
    const packFiber = await context.plugin(packLoaderPlugin(packLoader));

    expect(loaders.get(loader.kind)).toBe(loader);
    expect(
      await loaders.loadPack(
        {
          guid: '00000000-0000-7000-8000-000000000001',
          kind: packLoader.kind,
          payload: {},
          refs: [],
          artifacts: {},
        },
        {} as never,
      ),
    ).toMatchObject({ ok: true });

    await packFiber.dispose();
    await loaderFiber.dispose();
    expect(loaders.get(loader.kind)).toBeUndefined();
    expect(
      await loaders.loadPack(
        {
          guid: '00000000-0000-7000-8000-000000000001',
          kind: packLoader.kind,
          payload: {},
          refs: [],
          artifacts: {},
        },
        {} as never,
      ),
    ).toMatchObject({ ok: false });
  });
});
