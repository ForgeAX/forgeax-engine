import { MATERIAL_STATIC_SWITCH_NAMES } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { engineShaderDefines } from '../../engine-program.js';
import { standardStaticSwitchDefines } from '../lower-standard-contract.js';

const standard = [{ name: 'forward', program: { module: 'forgeax_material::standard' } }];
const custom = [{ name: 'forward', program: { module: 'game::custom' } }];

describe('Standard environment BRDF static switch', () => {
  it('is a declared static switch', () => {
    expect(MATERIAL_STATIC_SWITCH_NAMES).toContain('environmentBrdfApprox');
  });

  it('keeps the shared fit for built-ins, including generated Standard and VFX programs', () => {
    for (const id of [
      'forgeax::default-standard-pbr',
      'forgeax::pbr-skin',
      'forgeax::engine-standard-deferred-lighting',
      'forgeax::vfx-render.particles.mesh',
    ]) {
      expect(engineShaderDefines(id)).not.toHaveProperty('ENV_BRDF_LUT');
    }
    expect(standardStaticSwitchDefines(undefined, standard)).toEqual({});
    expect(standardStaticSwitchDefines({}, standard)).toEqual({});
    expect(standardStaticSwitchDefines({ environmentBrdfApprox: true }, standard)).toEqual({});
  });

  it('selects the preintegrated LUT only for an explicit Standard request', () => {
    expect(standardStaticSwitchDefines({ environmentBrdfApprox: false }, standard)).toEqual({
      ENV_BRDF_LUT: true,
    });
    expect(standardStaticSwitchDefines({ environmentBrdfApprox: false }, custom)).toEqual({});
  });
});
