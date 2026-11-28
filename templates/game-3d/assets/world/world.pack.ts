import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { assetGuid, guidText, PACKAGE_IDS } from '../shared/asset-refs.ts';
import { physicsComponentsPlugin } from '@forgeax/engine/physics';
import { joinPluginFiber, mountPluginAsset, type Plugin } from '@forgeax/engine/plugin';
import { worldDespawnScene } from '@forgeax/engine/scene';
import type {} from '../shared/scene-refs.ts';
export const scene: Plugin.Object<{ readonly scene: string; readonly children: readonly string[] }> =
  {
    name: 'game-3d/scene',
    inject: ['world', 'assets', 'pluginPrograms'],
    async apply(ctx, config) {
      const assets = ctx.assets;
      if (!assets) throw new Error('scene owner requires assets');
      // Asset admission needs the schemas before the simulation backend is ready.
      await ctx.plugin(physicsComponentsPlugin());
      const loading = new AbortController();
      ctx.effect(() => () => loading.abort(), 'game-3d/scene-load');
      // Overlap definition I/O with scene loading. Mount still checks the current
      // publication and installs children in the authored dependency order.
      const children = config.children.map(async (guid) => {
        await assets.readPluginDefinition(guid).catch(() => undefined);
        return guid;
      });
      const loaded = await assets.load(assets.parseGuid(config.scene), 'scene', {
        usage: 'render',
        signal: loading.signal,
      });
      if (loading.signal.aborted) {
        if (loaded.ok) assets.release(loaded.value).unwrap();
        return;
      }
      if (!loaded.ok) throw loaded.error;
      // Instantiate only once the simulation service is available.
      await ctx.effect(async function* () {
        const handle = loaded.value;
        yield () => {
          assets.release(handle).unwrap();
        };
        yield joinPluginFiber(ctx.inject(['physics'], async (instance) => {
          // Dispose children before removing the scene they read.
          await instance.effect(async function* () {
            const root = assets.instantiate(handle, instance.world).unwrap();
            yield () => worldDespawnScene(instance.world, root).unwrap();
            yield instance.provide('gameScene', { root });
            for (const definition of children) {
              const child = await mountPluginAsset(instance, await definition);
              if (!child.ok) throw child.error;
              yield joinPluginFiber(child.value);
            }
          });
        }));
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
          // Feature plugins by GUID: delete a feature folder and remove its line here.
          { $asset: 'c034cc6c-b31f-5b16-89d6-4db4d05939d8' }, // player/player.pack.ts plugin/player
          { $asset: '2056f194-6791-5504-8ae1-d67c2bdfa28a' }, // camera/camera.pack.ts plugin/camera
        ],
      },
    },
  }),
});
