import type { EntityHandle } from '@forgeax/engine-ecs';
import physics3d from '@forgeax/engine-physics-rapier3d';
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
    const loaded = await assets.load(assets.parseGuid(config.scene), 'scene');
    if (!loaded.ok) throw loaded.error;
    await ctx.effect(async function* () {
      const handle = loaded.value;
      yield () => { assets.release(handle).unwrap(); };
      const root = assets.instantiate(handle, ctx.world).unwrap();
      yield () => worldDespawnScene(ctx.world, root).unwrap();
      ctx.provide('capabilityScene', { root, asset: assets.read(handle).unwrap() });
      yield joinPluginFiber(ctx.plugin(gameplay));
    });
  },
} satisfies Plugin.Object<{ readonly scene: string }>;

export default {
  name: "capability-lab",
  apply(ctx, config) {
    ctx.plugin(physics3d);
    ctx.plugin(sceneOwner, config);
  },
} satisfies Plugin.Object<{ readonly scene: string }>;
