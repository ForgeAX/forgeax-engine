import {
  STANDARD_DIRECT_DFG_LUT_BINDING,
  STANDARD_PHYSICAL_BINDING_START,
} from '@forgeax/engine-shader';
import {
  derive,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  lowerStandardContract,
  lowerStandardPhysicalBindings,
} from '../lower-standard-contract.js';

const passes = [{ name: 'forward', program: { module: 'forgeax_material::standard' } }];

describe('Standard direct DFG contract lowering', () => {
  it('derives capability from the declaration, independently of runtime selection', () => {
    const baseline = standardSurfaceParameters([]);
    const fit = lowerStandardContract(baseline, passes).unwrap();
    expect(fit.defines).not.toHaveProperty('DIRECT_DFG_LUT_AVAILABLE');
    for (const defaultValue of [0, 1, 2]) {
      const lut = lowerStandardContract(
        [...baseline, { name: 'directMultiscatteringLut', type: 'u32', default: defaultValue }],
        passes,
      ).unwrap();
      expect(lut.defines.DIRECT_DFG_LUT_AVAILABLE).toBe(true);
      expect(lut.paramSchema.at(-1)).toEqual({
        name: 'directMultiscatteringLut',
        type: 'u32',
        default: defaultValue,
      });
      expect(lut.layoutIdentity).not.toBe(fit.layoutIdentity);
      expect(derive(lut.paramSchema).resourceBindings).toEqual(
        derive(fit.paramSchema).resourceBindings,
      );
    }
  });

  it('rejects a wrong Standard field type before shader composition', () => {
    const result = lowerStandardContract(
      [{ name: 'directMultiscatteringLut', type: 'f32' }],
      passes,
      'wrong-type',
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'material-parameter-type-unsupported',
        detail: { material: 'wrong-type', parameter: 'directMultiscatteringLut', type: 'f32' },
        hint: expect.stringContaining('u32'),
      },
    });
  });

  it('does not assign Standard semantics to the same name on another root', () => {
    const lowered = lowerStandardContract(
      [{ name: 'directMultiscatteringLut', type: 'f32' }],
      [{ name: 'forward', program: { module: 'game::custom' } }],
    ).unwrap();
    expect(lowered.defines).not.toHaveProperty('DIRECT_DFG_LUT_AVAILABLE');
  });

  it('places the engine texture after the entire reserved physical region', () => {
    const parameters = standardSurfaceParameters([
      { name: 'directMultiscatteringLut', type: 'u32', default: 1 },
      { name: 'baseColorTexture', type: 'texture' },
      { name: 'clearcoatTexture', type: 'texture' },
      { name: 'diffuseTransmissionColorTexture', type: 'texture' },
    ]);
    const schema = lowerStandardContract(parameters, passes).unwrap().paramSchema;
    const source = `@group(1) @binding(0) var directDfgLut: texture_2d<f32>;
@group(1) @binding(99) var irradianceSampler: sampler;
@group(1) @binding(99) var clearcoatTexture: texture_2d<f32>;
@group(1) @binding(99) var diffuseTransmissionColorTexture: texture_2d<f32>;`;
    const lowered = lowerStandardPhysicalBindings(source, schema);
    expect(STANDARD_DIRECT_DFG_LUT_BINDING).toBe(
      STANDARD_PHYSICAL_BINDING_START + STANDARD_PHYSICAL_TEXTURE_FIELDS.length * 2,
    );
    expect(lowered).toContain(`@binding(${STANDARD_DIRECT_DFG_LUT_BINDING}) var directDfgLut`);
    expect(lowered).toContain('@binding(4) var irradianceSampler');
    expect(lowered).toContain('@binding(49) var clearcoatTexture');
    expect(lowered).toContain(
      `@binding(${STANDARD_DIRECT_DFG_LUT_BINDING - 1}) var diffuseTransmissionColorTexture`,
    );
  });
});
