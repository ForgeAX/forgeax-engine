import { bakeMaps, thinHoleCheck } from '@forgeax/engine-modeling';
import { definePackageId, executePackBuild } from '@forgeax/engine-pack/source';
import { describe, expect, it } from 'vitest';
import { buildVent, VENT_DEFAULTS } from '../vent';
import pack from '../vent.pack';

describe('thin-vent example', () => {
  it('bakes holes by opacity whose coverage holds on every mip, with two valid flat quads', {
    timeout: 60000,
  }, () => {
    const { plan, backing } = buildVent({ ...VENT_DEFAULTS, resolution: 256 });
    expect(plan.detail.validate().pass).toBe(true);
    const baked = bakeMaps({ base: plan.base, detail: plan.detail, ...plan.settings });
    if (!baked.ok) throw baked.error;
    const report = thinHoleCheck(baked.value, plan);
    expect(report.pass).toBe(true);
    expect(backing.validate().faces).toBe(1);
    expect(plan.base.validate().faces).toBe(1);
  });

  it('is an ordinary Pack build with two meshes, four bake sources and two materials', async () => {
    const result = await executePackBuild(pack, {
      packageId: definePackageId('01900000-0000-7000-8000-0000000c0401'),
      readByGuid: async () => {
        throw new Error('the vent reads no other asset');
      },
      values: { diameter: VENT_DEFAULTS.diameter, resolution: 64 },
    });
    expect(result.ok && Object.keys(result.value).sort()).toEqual([
      'material/vent',
      'material/vent-backing',
      'mesh/vent',
      'mesh/vent-backing',
      'texture/vent-ao',
      'texture/vent-height',
      'texture/vent-normal',
      'texture/vent-opacity',
    ]);
  });
});
