import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { assetGuid, guidText, PACKAGE_IDS } from '../shared/asset-refs.ts';
import { joinPluginFiber, mountPluginAsset, type Plugin } from '@forgeax/engine/plugin';
import { worldDespawnScene } from '@forgeax/engine/scene';
import type {} from '../shared/scene-refs.ts';
import { VASE_PLUGIN } from '../runtime-vase/vase-program.ts';
export const scene: Plugin.Object<{ readonly scene: string; readonly children: readonly string[] }> =
  {
    name: 'game-3d/scene',
    inject: ['world', 'assets', 'physics', 'pluginPrograms'],
    async apply(ctx, config) {
      const assets = ctx.assets;
      if (!assets) throw new Error('scene owner requires assets');
      const loaded = await assets.load(assets.parseGuid(config.scene), 'scene');
      if (!loaded.ok) throw loaded.error;
      // Register each inverse immediately; generator disposal joins children before scene data.
      await ctx.effect(async function* () {
        const handle = loaded.value;
        yield () => {
          assets.release(handle).unwrap();
        };
        const root = assets.instantiate(handle, ctx.world).unwrap();
        yield () => worldDespawnScene(ctx.world, root).unwrap();
        yield ctx.provide('gameScene', { root });
        for (const guid of config.children) {
          const child = await mountPluginAsset(ctx, guid);
          if (!child.ok) throw child.error;
          yield joinPluginFiber(child.value);
        }
      });
    },
  };

export default definePack({
  schemaVersion: '2.0.0', plugins: true,
  packageId: definePackageId('019fb7ce-3a00-7000-8000-000000000000'),
  build: () => ok({
    'plugin/scene': {
      kind: 'plugin',
      module: { specifier: './world.pack.ts', export: 'scene' },
      config: {
        scene: { $asset: guidText(assetGuid(PACKAGE_IDS.scene, 'scene/showcase')) },
        children: [
          { $asset: guidText(assetGuid(VASE_PLUGIN, 'plugin/vase')) },
          { $asset: 'c034cc6c-b31f-5b16-89d6-4db4d05939d8' },
          { $asset: '2056f194-6791-5504-8ae1-d67c2bdfa28a' },
        ],
      },
    },
  }),
});
