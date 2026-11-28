import { assetsJobSources } from '@forgeax/engine-modeling';
import { AssetGuid, definePack, definePackageId, type PackCookSource } from '@forgeax/engine-pack/source';
import { Materials } from '@forgeax/engine-render';
import { type Asset, ok } from '@forgeax/engine-types';
import { DEFAULT_QUALITY, materialKey, QUALITY_NAMES, type Quality, textureKey, TURRET, TURRET_OUTPUTS, turretJobOf } from './turret-job.ts';

export const packageId = definePackageId('01900000-0000-7000-8000-0000000c0600');
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));

/**
 * Case C-600 heavy turret as a game asset Pack: `mesh/c600-turret.<part>` per rig part with LOD levels
 * `/lod1..3`, `texture/c600-turret-normal|albedo|orm` (baked from the high turret, packed mip chains),
 * `material/c600-turret-baked` (maps on) and `material/c600-turret-plain` (constant values). Every mesh
 * and texture is a `modeling-mesh-job` cook source of one job (turret-job.ts): register
 * `createTurretCooker()` in the build plugin. `quality` ('page' default: the 1024 UV atlas; 'full': the same layout baked at 2048) changes sizes only.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  parameters: [{ name: 'quality', type: 'enum', default: DEFAULT_QUALITY, values: QUALITY_NAMES }],
  build: async ({ values }) => {
    const params = { quality: (values.quality ?? DEFAULT_QUALITY) as Quality };
    const out: Record<string, PackCookSource | Asset> = {};
    const sources = await assetsJobSources(turretJobOf(), { key: TURRET.key, packageId, params, outputs: TURRET_OUTPUTS });
    if (!sources.ok) return sources;
    Object.assign(out, sources.value);
    out[materialKey('baked')] = Materials.standard({
      baseColor: [1, 1, 1, 1],
      metallic: 1,
      roughness: 1,
      baseColorTexture: { texture: guid(textureKey('albedo')) },
      normalTexture: { texture: guid(textureKey('normal')) },
      metallicRoughnessTexture: { texture: guid(textureKey('orm')) },
      occlusionTexture: { texture: guid(textureKey('orm')) },
    });
    out[materialKey('plain')] = Materials.standard({ baseColor: [0.2, 0.23, 0.26, 1], metallic: 0.05, roughness: 0.55 });
    return ok(out);
  },
});
