import { bakeSources } from '@forgeax/engine-modeling';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { Materials } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { buildVent, VENT_DEFAULTS } from './vent.ts';

const packageId = definePackageId('01900000-0000-7000-8000-0000000c0401');
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));

/**
 * Thin-hole vent (C-401 rule): `mesh/vent` (one flat quad), `mesh/vent-backing` (the dark
 * quad behind it), `texture/vent-opacity|height|normal|ao` as `modeling-bake` cook sources
 * and `material/vent` (alpha-tested by the opacity map) plus `material/vent-backing`.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  parameters: [
    {
      name: 'diameter',
      type: 'f32',
      default: VENT_DEFAULTS.diameter,
      minimum: 0.002,
      maximum: 0.01,
    },
    {
      name: 'resolution',
      type: 'u32',
      default: VENT_DEFAULTS.resolution,
      minimum: 64,
      maximum: 2048,
    },
  ],
  build: ({ values }) => {
    const { plan, backing } = buildVent({
      ...VENT_DEFAULTS,
      diameter: values.diameter as number,
      resolution: values.resolution as number,
    });
    const quad = plan.base.finish({ key: 'vent' });
    if (!quad.ok) return quad;
    const behind = backing.finish({ key: 'vent-backing' });
    if (!behind.ok) return behind;
    const maps = bakeSources({
      base: plan.base,
      detail: plan.detail,
      ...plan.settings,
      mips: true,
      key: 'vent',
    });
    if (!maps.ok) return maps;
    return ok({
      ...quad.value,
      ...behind.value,
      ...maps.value,
      'material/vent': Materials.standard({
        baseColor: [0.2, 0.23, 0.18, 1],
        metallic: 0.2,
        roughness: 0.55,
        baseColorTexture: { texture: guid('texture/vent-opacity') },
        alphaCutoff: plan.cutoff,
        normalTexture: { texture: guid('texture/vent-normal') },
        occlusionTexture: { texture: guid('texture/vent-ao') },
      }),
      'material/vent-backing': Materials.standard({
        baseColor: [0.02, 0.02, 0.022, 1],
        metallic: 0,
        roughness: 0.9,
      }),
    });
  },
});
