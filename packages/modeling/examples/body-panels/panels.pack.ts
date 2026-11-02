import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { Materials } from '@forgeax/engine-render';
import { type Asset, ok, type TextureAsset } from '@forgeax/engine-types';
import { buildPanels, panelMaterials } from './panels.ts';

const packageId = definePackageId('01900000-0000-7000-8000-0000000c0106');
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));

/**
 * Case C-106 as an ordinary procedural asset: `mesh/body-panels` (hood and front fenders
 * from NURBS patches) plus one Standard material per slot and their generated textures;
 * no image files.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  build: () => {
    const finished = buildPanels().finish({ key: 'body-panels', normals: { mode: 'autoSmooth', angle: 40 } });
    if (!finished.ok) return finished;
    const outputs: Record<string, Asset> = { ...finished.value };
    const texture = (key: string, asset: TextureAsset) => {
      outputs[`texture/${key}`] = asset;
      return guid(`texture/${key}`);
    };
    for (const [slot, recipe] of Object.entries(panelMaterials())) {
      outputs[`material/${slot}`] = Materials.standard(recipe(texture));
    }
    return ok(outputs);
  },
});
