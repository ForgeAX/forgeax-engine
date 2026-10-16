import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { defineAssetKind, type RuntimeAssetRegistry } from '@forgeax/engine/assets-runtime';
import { createUiLoader, type UiAsset } from '@forgeax/engine/ui';
import type { Plugin } from '@forgeax/engine/plugin';
import { ok } from '@forgeax/engine/types';

import type {} from '@forgeax/engine/app';
import { createGuideUi } from './guide-controller.ts';

const uiKind = defineAssetKind<UiAsset, 'ui'>('ui');
export const ui: Plugin.Object<{ readonly guide: string }> = {
  name: 'game-3d/ui',
  inject: ['assets', 'gameHost'],
  async apply(ctx, config) {
    const assets = ctx.get('assets') as unknown as RuntimeAssetRegistry;
    await ctx.effect(async function* () {
      const loader = createUiLoader();
      const lease = assets.installDecoder(uiKind, loader);
      yield () => lease.dispose();
      const loaded = await assets.load(config.guide, uiKind);
      if (!loaded.ok) throw loaded.error;
      const ui = await createGuideUi(loaded.value, ctx.gameHost!);
      yield () => ui.dispose();
    });
  },
};

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('019fb7ce-3d00-7000-8000-000000000000'),
  build: () => ok({
    'plugin/host': {
      kind: 'plugin',
      module: { specifier: './ui.pack.ts', export: 'ui' },
      config: { guide: { $asset: '019fb7ce-3600-7000-8000-000000000001' } },
    },
  }),
});
