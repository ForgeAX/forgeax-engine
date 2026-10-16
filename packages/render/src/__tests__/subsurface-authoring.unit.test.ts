import { describe, expect, it } from 'vitest';
import { freezeRenderProfile, validateRenderProfile } from '../assembly/renderer-facade';
import { MaterialAuthoringContractError, Materials } from '../materials';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';

describe('ordinary Standard subsurface authoring', () => {
  it('keeps ordinary Standard materials inactive by default', () => {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1] });
    expect(material.values?.subsurfaceRadius).toEqual([0, 0, 0]);
    expect(material.values?.subsurfaceWeight).toBe(0);
  });
  it.each([
    { subsurfaceRadius: [-1, 1, 1] as const },
    { subsurfaceRadius: [13, 1, 1] as const },
    { subsurfaceRadius: [NaN, 1, 1] as const },
    { subsurfaceWeight: -1 },
    { subsurfaceWeight: 2 },
    { subsurfaceWeight: NaN },
  ])('rejects invalid public values before publication: %j', (options) => {
    let failure: unknown;
    try {
      Materials.standard({ baseColor: [1, 1, 1, 1], ...options });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MaterialAuthoringContractError);
    expect(failure).toMatchObject({
      code: 'material-authoring-contract-invalid',
      detail: {
        parameter: 'subsurfaceRadius' in options ? 'subsurfaceRadius' : 'subsurfaceWeight',
      },
    });
  });
  it('publishes the profile through ordinary values and parameter schema', () => {
    const material = Materials.standard({
      baseColor: [1, 0.6, 0.4, 1],
      subsurfaceRadius: [9, 6, 3],
      subsurfaceWeight: 0.5,
    });
    expect(material.values?.subsurfaceRadius).toEqual([9, 6, 3]);
    expect(material.values?.subsurfaceWeight).toBe(0.5);
    expect(material.parameters?.find((p) => p.name === 'subsurfaceRadius')?.type).toBe('vec3');
  });
});

it('admits and preserves the public subsurface quality selector', () => {
  for (const subsurfaceQuality of ['low', 'high'] as const) {
    const profile = {
      ...DEFAULT_STANDARD_PROFILE,
      renderPath: 'deferred' as const,
      subsurfaceQuality,
    };
    expect(validateRenderProfile(profile)).toBeUndefined();
    expect(freezeRenderProfile(profile).subsurfaceQuality).toBe(subsurfaceQuality);
  }
});
