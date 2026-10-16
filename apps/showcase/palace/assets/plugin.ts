import type { EntityHandle } from '@forgeax/engine/ecs';
import { joinPluginFiber, type Plugin } from '@forgeax/engine/plugin';
import { worldDespawnScene } from '@forgeax/engine/scene';
import type { SceneAsset } from '@forgeax/engine/types';
import navigation from './navigation.ts';
export interface SceneBinding { readonly root: EntityHandle; readonly asset: SceneAsset }
declare module '@forgeax/engine/plugin' {
  interface EngineContextServices { palaceScene: SceneBinding }
}
export default {
  name: 'palaceScene-owner', inject: ['world', 'assets'],
  async apply(ctx, config) {
    if (!ctx.assets) throw new Error('scene owner requires assets');
    const assets = ctx.assets;
    const loaded = await assets.loadByGuid<SceneAsset>(assets.parseGuid(config.scene));
    if (!loaded.ok) throw loaded.error;
    await ctx.effect(async function* () {
      const handle = ctx.world.allocSharedRef('SceneAsset', loaded.value);
      yield () => { ctx.world.sharedRefs.release(handle).unwrap(); };
      const root = assets.instantiate<SceneAsset>(handle, ctx.world).unwrap();
      yield () => worldDespawnScene(ctx.world, root).unwrap();
      ctx.provide('palaceScene', { root, asset: loaded.value });
      yield joinPluginFiber(ctx.plugin(navigation));
    });
  },
} satisfies Plugin.Object<{ readonly scene: string }>;
