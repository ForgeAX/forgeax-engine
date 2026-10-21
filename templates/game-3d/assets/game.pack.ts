import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { mountPluginAsset, type Plugin } from '@forgeax/engine/plugin';

/** Native composition; Pack references determine the persistent definition closure. */
export const game: Plugin.Object<{ readonly children: readonly string[] }> = {
  name: 'game-3d',
  inject: ['assets', 'pluginPrograms'],
  async apply(ctx, config) {
    await ctx.effect(async function* () {
      for (const guid of config.children) {
        const result = await mountPluginAsset(ctx, guid);
        if (!result.ok) throw result.error;
        yield result.value.dispose;
      }
    });
  },
};

export default definePack({
  schemaVersion: '2.0.0', plugins: true,
  packageId: definePackageId('019fb7ce-3800-7000-8000-000000000000'),
  build: () => ok({
    'plugin/engine': {
      kind: 'plugin',
      module: { specifier: './game.pack.ts', export: 'game' },
      config: {
        children: [
          { $asset: '148f7370-c2bc-5c43-976f-b85f5d521057' },
          { $asset: 'ad08daa6-fd56-5e2e-8ada-26fc233183ec' },
        ],
      },
    },
  }),
});
