import { STANDARD_TRIPLANAR_PROJECTION_BIT, standardTextureMask } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { materialLeanInputs } from '../material-lean-inputs';

const mask = (...names: string[]) =>
  standardTextureMask(names.map((name) => ({ name, type: 'texture2d' }) as never));

describe('materialLeanInputs', () => {
  it('admits a UV0 base-colour cutout like grass', () => {
    expect(materialLeanInputs({ alphaCutoff: 0.4 }, mask('baseColorTexture'), undefined)).toBe(
      true,
    );
    expect(materialLeanInputs({}, 0, new Map([['baseColorTexture', { set: 0 }]]))).toBe(true);
  });

  it('admits normal-mapped and anisotropic UV0 materials: the lean row keeps the tangent', () => {
    expect(materialLeanInputs({}, mask('baseColorTexture', 'normalTexture'), undefined)).toBe(true);
    expect(materialLeanInputs({ anisotropyStrength: 0.3 }, 0, undefined)).toBe(true);
  });

  it('keeps general inputs for projections, hashing, transmission or another UV set', () => {
    expect(materialLeanInputs({}, undefined, undefined)).toBe(false);
    expect(materialLeanInputs({}, STANDARD_TRIPLANAR_PROJECTION_BIT, undefined)).toBe(false);
    expect(materialLeanInputs({ alphaHash: 1 }, 0, undefined)).toBe(false);
    expect(materialLeanInputs({ transmission: 0.5 }, 0, undefined)).toBe(false);
    expect(
      materialLeanInputs({}, mask('baseColorTexture'), new Map([['baseColorTexture', { set: 1 }]])),
    ).toBe(false);
  });
});
