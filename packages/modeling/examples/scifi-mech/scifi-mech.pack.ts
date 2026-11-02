import { assetsJobSources } from '@forgeax/engine-modeling';
import { AssetGuid, definePack, definePackageId, type PackCookSource } from '@forgeax/engine-pack/source';
import { Materials } from '@forgeax/engine-render';
import { type Asset, ok } from '@forgeax/engine-types';
import { EMISSIVE_SCALE, PBR } from './palette.ts';
import { C410_OUTPUTS, DEFAULT_QUALITY, jobOf, QUALITY_NAMES, type Quality, SHOW, textureKey } from './show-job.ts';

export const packageId = definePackageId('01900000-0000-7000-8000-0000000c0410');
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));

/**
 * Case C-410 as a page asset: `mesh/c410-low.<part>` (the UV'd form layer, one mesh per part,
 * one slot per texture set), `mesh/c410-high` (the detail source decimated to the preview
 * budget), `texture/c410-<set>-normal|albedo|orm|emissive` (the baked and composed maps),
 * `material/c410-baked-<set>` (maps on) and `material/c410-plain` (constant values, maps off).
 * `quality` ('page' default: 1024 atlases, 4 samples; 'full': 2048, 9 samples) changes sizes only. Every mesh and texture is a `modeling-mesh-job` cook source of a show job (show-job.ts):
 * register `createC410Cooker()` (or `createMeshJobCooker(C410_JOBS)`) in the build plugin.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  parameters: [{ name: 'quality', type: 'enum', default: DEFAULT_QUALITY, values: QUALITY_NAMES }],
  build: async ({ values }) => {
    const params = { quality: (values.quality ?? DEFAULT_QUALITY) as Quality };
    const out: Record<string, PackCookSource | Asset> = {};
    for (const name of [...SHOW.sets, 'high'] as const) {
      const sources = await assetsJobSources(jobOf(name), { key: `${SHOW.key}-${name}`, packageId, params, outputs: C410_OUTPUTS[name] });
      if (!sources.ok) return sources;
      Object.assign(out, sources.value);
    }
    for (const set of SHOW.sets) {
      out[`material/${SHOW.key}-baked-${set}`] = Materials.standard({
        baseColor: [1, 1, 1, 1],
        metallic: 1,
        roughness: 1,
        baseColorTexture: { texture: guid(textureKey(set, 'albedo')) },
        normalTexture: { texture: guid(textureKey(set, 'normal')) },
        metallicRoughnessTexture: { texture: guid(textureKey(set, 'orm')) },
        occlusionTexture: { texture: guid(textureKey(set, 'orm')) },
        emissive: [1, 1, 1],
        emissiveIntensity: EMISSIVE_SCALE,
        emissiveTexture: { texture: guid(textureKey(set, 'emissive')) },
      });
    }
    const armor = PBR.armor as NonNullable<(typeof PBR)['armor']>;
    out[`material/${SHOW.key}-plain`] = Materials.standard({ baseColor: [...armor.color, 1], metallic: armor.metallic, roughness: armor.roughness });
    return ok(out);
  },
});
