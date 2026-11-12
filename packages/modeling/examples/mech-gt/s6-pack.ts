import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { Materials } from '@forgeax/engine-render';
import { type Asset, ok, type TextureAsset } from '@forgeax/engine-types';
import { generatePackMeshLods } from '@forgeax/engine-import/mesh-lod-generator';
import { assetsJobSources } from '@forgeax/engine-modeling';
import { S6_LODS, S6_NORMALS, type S6Group } from './s6-exterior.ts';
import { s6JobOf, S6_OUTPUTS } from './s6-job.ts';
import { buildS6Mechanics, type S6Mechanics, s6MechanicsMaterials } from './s6-mechanics.ts';

const PACKAGES: Record<S6Group | S6Mechanics, string> = {
  internals: '01900000-0000-7000-8000-0000000c1065',
  core: '01900000-0000-7000-8000-0000000c1066',
  front: '01900000-0000-7000-8000-0000000c1060',
  nose: '01900000-0000-7000-8000-0000000c1064',
  cabin: '01900000-0000-7000-8000-0000000c1061',
  rear: '01900000-0000-7000-8000-0000000c1062',
  wheels: '01900000-0000-7000-8000-0000000c1063',
};

/**
 * C-100 stage S6: one part group as a Pack, `mesh/s6-<group>` with its LOD levels
 * (`mesh/s6-<group>/lod1`, `/lod2`), one Standard material per slot it uses, their
 * generated textures and the baked normal/AO maps; no image files. Every output is a
 * `modeling-mesh-job` cook source of the group's job (s6-job.ts): register
 * `createMeshJobCooker([...S6_JOBS])` in the project's build plugin.
 */
export function s6Pack(group: S6Group) {
  const packageId = definePackageId(PACKAGES[group]);
  return definePack({
    schemaVersion: '2.0.0',
    packageId,
    build: () => assetsJobSources(s6JobOf(group), { key: `s6-${group}`, packageId, params: {}, outputs: S6_OUTPUTS[group] }),
  });
}

/** C-100 stage S6 mechanics as a Pack: `mesh/s6-<group>` with its LOD levels and one Standard material per slot. */
export function s6MechanicsPack(group: S6Mechanics) {
  const packageId = definePackageId(PACKAGES[group]);
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
  return definePack({
    schemaVersion: '2.0.0',
    packageId,
    build: async () => {
      const m = buildS6Mechanics(group);
      const slots = m.inspect().materials;
      const key = `s6-${group}`;
      const finished = m.finish({ key, normals: S6_NORMALS });
      if (!finished.ok) return finished;
      const outputs: Record<string, Asset> = {};
      const texture = (key: string, asset: TextureAsset) => {
        outputs[`texture/${key}`] = asset;
        return guid(`texture/${key}`);
      };
      for (const [slot, recipe] of Object.entries(s6MechanicsMaterials())) {
        if (slots.includes(slot)) outputs[`material/${slot}`] = Materials.standard(recipe(texture));
      }
      const lods = await generatePackMeshLods(packageId, finished.value, { [`mesh/${key}`]: S6_LODS });
      if (!lods.ok) return lods;
      return ok({ ...lods.value.outputs, ...outputs });
    },
  });
}
