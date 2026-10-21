import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { uiAssetContribution } from '@forgeax/engine/ui';
import type { Plugin } from '@forgeax/engine/plugin';
import { ok } from '@forgeax/engine/types';

import type {} from '@forgeax/engine/app';
import { createGuideUi } from './guide-controller.ts';

export const ui: Plugin.Object<{ readonly guide: string }> = {
  name: 'game-3d/ui',
  inject: ['assets', 'gameHost'],
  async apply(ctx, config) {
    const assets = ctx.get('assets') as unknown as AssetRegistry;
    await ctx.effect(async function* () {
      const lease = assets.installDecoder(uiAssetContribution.kind, uiAssetContribution.decoder);
      yield () => lease.dispose();
      const loaded = await assets.load(config.guide, uiAssetContribution.kind);
      if (!loaded.ok) throw loaded.error;
      yield () => assets.release(loaded.value).unwrap();
      const ui = await createGuideUi(assets.read(loaded.value).unwrap(), ctx.gameHost!);
      yield () => ui.dispose();
    });
  },
};

export default definePack({
  schemaVersion: '2.0.0', plugins: true,
  packageId: definePackageId('019fb7ce-3d00-7000-8000-000000000000'),
  build: () => ok({
    'plugin/host': {
      kind: 'plugin',
      module: { specifier: './ui.pack.ts', export: 'ui' },
      config: { guide: { $asset: '019fb7ce-3600-7000-8000-000000000001' } },
    },
  }),
});
