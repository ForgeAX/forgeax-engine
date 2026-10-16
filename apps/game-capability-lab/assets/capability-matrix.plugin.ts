import type { EntityHandle } from '@forgeax/engine-ecs';
import { physicsPlugin } from '@forgeax/engine-physics';
import { joinPluginFiber, type Plugin } from '@forgeax/engine-plugin';
import { worldDespawnScene } from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { gameplay } from './plugins/game-plugin.ts';
export interface SceneBinding { readonly root: EntityHandle; readonly asset: SceneAsset }
declare module '@forgeax/engine-plugin' {
  interface EngineContextServices { capabilityScene: SceneBinding }
}
const sceneOwner = {
  name: 'capabilityScene-owner', inject: ['world', 'assets', 'physics'],
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
      ctx.provide('capabilityScene', { root, asset: loaded.value });
      yield joinPluginFiber(ctx.plugin(gameplay));
    });
  },
} satisfies Plugin.Object<{ readonly scene: string }>;

export default {
  name: "capability-lab",
  apply(ctx, config) {
    ctx.plugin(physicsPlugin("rapier-3d"));
    ctx.plugin(sceneOwner, config);
  },
} satisfies Plugin.Object<{ readonly scene: string }>;
