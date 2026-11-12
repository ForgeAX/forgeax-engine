import { MATERIAL_STATIC_SWITCH_NAMES } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { standardStaticSwitchDefines } from '../lower-standard-contract.js';

const standard = [{ name: 'forward', program: { module: 'forgeax_material::standard' } }];
const custom = [{ name: 'forward', program: { module: 'game::custom' } }];

describe('Standard environment BRDF static switch', () => {
  it('is a declared static switch', () => {
    expect(MATERIAL_STATIC_SWITCH_NAMES).toContain('environmentBrdfApprox');
  });

  it('keeps the preintegrated LUT unless the fit is explicitly requested', () => {
    expect(standardStaticSwitchDefines(undefined, standard)).toEqual({});
    expect(standardStaticSwitchDefines({}, standard)).toEqual({});
    expect(standardStaticSwitchDefines({ environmentBrdfApprox: false }, standard)).toEqual({});
  });

  it('selects the analytic fit for Standard roots only', () => {
    expect(standardStaticSwitchDefines({ environmentBrdfApprox: true }, standard)).toEqual({
      ENV_BRDF_FIT: true,
    });
    expect(standardStaticSwitchDefines({ environmentBrdfApprox: true }, custom)).toEqual({});
  });
});
