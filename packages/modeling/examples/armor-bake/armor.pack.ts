import { bakeSources } from '@forgeax/engine-modeling';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { Materials } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { ARMOR_DEFAULTS, armorBake, BASE_NORMALS, buildArmorParts } from './armor.ts';

const packageId = definePackageId('01900000-0000-7000-8000-0000000c0110');
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));

/**
 * Case C-110 as an ordinary procedural asset: `mesh/armor` (the auto-UVed low-poly
 * shoulder plate), `mesh/armor-detail` (the high-poly source), the baked
 * `texture/armor-normal`, `texture/armor-ao` and `texture/armor-materialId` as
 * `modeling-bake` cook sources (baked by the NativeCooker outside the build timeout;
 * register `createBakeCooker()` in the build plugin) and `material/armor-baked`.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  parameters: [
    { name: 'curl', type: 'f32', default: 50, minimum: 0, maximum: 110 },
    { name: 'resolution', type: 'u32', default: 512, minimum: 64, maximum: 2048 },
  ],
  build: ({ values }) => {
    const p = { ...ARMOR_DEFAULTS, curl: values.curl as number, resolution: values.resolution as number };
    const { base, detail } = buildArmorParts(p);
    const low = base.finish({ key: 'armor', normals: BASE_NORMALS });
    if (!low.ok) return low;
    const high = detail.finish({ key: 'armor-detail', normals: BASE_NORMALS });
    if (!high.ok) return high;
    const maps = bakeSources({ base, detail, ...armorBake(p), mips: true, key: 'armor' });
    if (!maps.ok) return maps;
    return ok({
      ...low.value,
      ...high.value,
      ...maps.value,
      'material/armor-baked': Materials.standard({
        baseColor: [0.62, 0.14, 0.1, 1],
        metallic: 0.25,
        roughness: 0.45,
        normalTexture: { texture: guid('texture/armor-normal') },
        occlusionTexture: { texture: guid('texture/armor-ao') },
      }),
    });
  },
});
