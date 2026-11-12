import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { Materials } from '@forgeax/engine-render';
import { type Asset, ok, type TextureAsset } from '@forgeax/engine-types';
import { gtPaintScheme } from './s6b-paint.ts';
import { buildS6bMech, s6bDecalMaterials } from './s6b-robot.ts';

/**
 * C-100 stage S6b: the robot form alone, standing on the shut skeleton in the mech frame
 * (detail views): `mesh/s6b-robot` with one Standard material per slot it uses (the shared
 * mech-gt paint scheme) and their generated textures. The transforming assembly is `s7.pack.ts`.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c10b0'),
  build: ({ packageId }) => {
    const m = buildS6bMech(undefined, 'standing');
    const finished = m.finish({ key: 's6b-robot', normals: { mode: 'autoSmooth', angle: 40 } });
    if (!finished.ok) return finished;
    const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const outputs: Record<string, Asset> = {};
    const texture = (key: string, asset: TextureAsset) => {
      outputs[`texture/${key}`] = asset;
      return guid(`texture/${key}`);
    };
    const slots = m.inspect().materials;
    for (const [slot, recipe] of Object.entries(gtPaintScheme())) if (slots.includes(slot)) outputs[`material/${slot}`] = Materials.standard(recipe(texture));
    // The pauldron numbers live on the fenders (car form only); their sheets ship here for the assembly's consumers.
    for (const [slot, recipe] of Object.entries(s6bDecalMaterials())) outputs[`material/${slot}`] = Materials.standard(recipe(texture));
    return ok({ ...finished.value, ...outputs });
  },
});
