import { generatePackMeshLods } from '@forgeax/engine-import/mesh-lod-generator';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { Materials } from '@forgeax/engine-render';
import { type Asset, ok, type TextureAsset } from '@forgeax/engine-types';
import { S6_LODS, S6_NORMALS } from './s6-exterior.ts';
import { buildS6c, type S6cGroup, s6cMaterials } from './s6c-assembly.ts';

const PACKAGES: Record<S6cGroup, string> = {
  cockpit: '01900000-0000-7000-8000-0000000c1076',
  front: '01900000-0000-7000-8000-0000000c1071',
  side: '01900000-0000-7000-8000-0000000c1072',
  rear: '01900000-0000-7000-8000-0000000c1073',
  wheels: '01900000-0000-7000-8000-0000000c1074',
  underbody: '01900000-0000-7000-8000-0000000c1075',
};

/**
 * C-100 stage S6c: one detail group as a Pack, `mesh/s6c-<group>` with its LOD levels
 * (`/lod1`, `/lod2`), one Standard material per slot it uses and their generated textures;
 * no image files.
 */
export function s6cPack(group: S6cGroup) {
  const packageId = definePackageId(PACKAGES[group]);
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
  return definePack({
    schemaVersion: '2.0.0',
    packageId,
    build: async () => {
      const { model: m } = buildS6c(group);
      const slots = m.inspect().materials;
      const key = `s6c-${group}`;
      const finished = m.finish({ key, normals: S6_NORMALS });
      if (!finished.ok) return finished;
      const outputs: Record<string, Asset> = {};
      const texture = (name: string, asset: TextureAsset) => {
        outputs[`texture/${name}`] = asset;
        return guid(`texture/${name}`);
      };
      for (const [slot, recipe] of Object.entries(s6cMaterials())) {
        if (slots.includes(slot)) outputs[`material/${slot}`] = Materials.standard(recipe(texture));
      }
      const lods = await generatePackMeshLods(packageId, finished.value, { [`mesh/${key}`]: S6_LODS });
      if (!lods.ok) return lods;
      return ok({ ...lods.value.outputs, ...outputs });
    },
  });
}
