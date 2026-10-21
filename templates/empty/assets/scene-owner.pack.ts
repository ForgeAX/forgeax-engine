import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
// Include the asset service vocabulary without adding a runtime import.
import type {} from '@forgeax/engine/assets-runtime';
import type { Plugin } from '@forgeax/engine/plugin';
import { worldDespawnScene } from '@forgeax/engine/scene';

export const sceneOwner: Plugin.Object<{ readonly scene: string }> = {
  name: 'empty/scene',
  inject: ['assets', 'world'],
  async apply(ctx, config) {
    if (!ctx.assets) throw new Error('scene requires the asset service');
    const loaded = await ctx.assets.load(ctx.assets.parseGuid(config.scene), 'scene');
    if (!loaded.ok) throw loaded.error;
    ctx.effect(function* () {
      const handle = loaded.value;
      yield () => {
        ctx.assets!.release(handle).unwrap();
      };
      const root = ctx.assets!.instantiate(handle, ctx.world).unwrap();
      yield () => worldDespawnScene(ctx.world, root).unwrap();
    });
  },
};

export default definePack({
  schemaVersion: '2.0.0', plugins: true,
  packageId: definePackageId('019fb7ce-1100-7000-8000-000000000000'),
  build: () => ok({
    'plugin/scene': {
      kind: 'plugin',
      module: { specifier: './scene-owner.pack.ts', export: 'sceneOwner' },
      config: { scene: { $asset: '019fb7ce-1000-7000-8000-000000000001' } },
    },
  }),
});
