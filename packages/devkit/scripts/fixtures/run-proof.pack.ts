import { createBoxGeometry } from '@forgeax/engine/geometry';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine/render';
import type {} from '@forgeax/engine/assets-runtime';
import type { Plugin } from '@forgeax/engine/plugin';
import type { SceneAsset } from '@forgeax/engine/types';
import { Name, Transform, worldDespawnScene } from '@forgeax/engine/scene';
import { ok } from '@forgeax/engine/types';

const packageId = definePackageId('019fb7ce-3900-7000-8000-000000000000');
const guid = (key: string) => AssetGuid.derive(packageId, key);
export const sceneOwner: Plugin.Object<{ readonly scene: string }> = {
  name: 'independent-run-scene',
  inject: ['world', 'assets'],
  async apply(ctx, config) {
    const assets = ctx.assets;
    if (!assets) throw new Error('Independent run scene requires assets');
    const scene = await assets.loadByGuid<SceneAsset>(assets.parseGuid(config.scene));
    if (!scene.ok) throw scene.error;
    ctx.effect(function* () {
      const handle = ctx.world.allocSharedRef('SceneAsset', scene.value);
      yield () => { ctx.world.sharedRefs.release(handle).unwrap(); };
      const root = assets.instantiate<SceneAsset>(handle, ctx.world).unwrap();
      yield () => worldDespawnScene(ctx.world, root).unwrap();
    });
  },
};
export default definePack({
  schemaVersion: '2.0.0', packageId, name: 'Workspace lifecycle proof',
  sceneComponents: [Camera, MeshFilter, MeshRenderer, Name, Transform],
  build: () => {
    const box = createBoxGeometry(2, 2, 2);
    if (!box.ok) return box;
    return ok({
      'plugin/scene': { kind: 'plugin', module: { specifier: './proof.pack.ts', export: 'sceneOwner' }, config: { scene: { $asset: AssetGuid.format(guid('scene/proof')) } } },
      'plugin/ui': { kind: 'plugin', module: { specifier: './ui.ts' } },
      'material/box': Materials.unlit([0.9, 0.25, 0.08, 1]),
      'mesh/box': { ...box.value, materialSlots: [{ slotName: 'surface', sourceKey: 'proof:box', defaultMaterial: guid('material/box') }] },
      'scene/proof': { kind: 'scene', entities: {
        box: { components: { Name: { value: 'Lifecycle proof cube' }, Transform: { pos: [0, 0, 0] }, MeshFilter: { assetHandle: AssetGuid.format(guid('mesh/box')) }, MeshRenderer: { materials: [] } } },
        camera: { components: { Name: { value: 'Proof camera' }, Transform: { pos: [0, 0, 6] }, Camera: { ...perspective({ fov: Math.PI / 4, aspect: 4 / 3, near: 0.1, far: 100 }), clearColor: [0.03, 0.06, 0.12, 1] } } },
      } },
    });
  },
});
