import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  STANDARD_OBJECT_SPACE_NORMAL_BIT,
  STANDARD_TRIPLANAR_PROJECTION_BIT,
  standardProjectionMask,
  standardTextureMask,
} from '@forgeax/engine-shader';
import type { MaterialAsset, MaterialValue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { MaterialAuthoringContractError, Materials } from '../materials';

const texture = { texture: 'tex-guid', sampler: 'smp-guid' } as unknown as MaterialValue;

function authoringError(run: () => unknown): MaterialAuthoringContractError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MaterialAuthoringContractError);
    return error as MaterialAuthoringContractError;
  }
  throw new Error('expected a MaterialAuthoringContractError');
}

function materialValue(material: MaterialAsset): (name: string) => unknown {
  return (name) => material.values?.[name];
}

describe('Materials.standard triplanar projection', () => {
  it('projects world and object space onto the declared scalar contract', () => {
    const world = Materials.standard({
      baseColor: [1, 1, 1, 1],
      baseColorTexture: texture,
      normalTexture: texture,
      triplanar: { space: 'world', scale: 0.5, sharpness: 4 },
    });
    expect(world.values).toMatchObject({
      triplanarSpace: 1,
      triplanarScale: 0.5,
      triplanarSharpness: 4,
    });
    expect(
      Materials.standard({ baseColor: [1, 1, 1, 1], triplanar: { space: 'object' } }).values,
    ).toMatchObject({ triplanarSpace: 2, triplanarScale: 1, triplanarSharpness: 1 });
    const names = new Set(world.parameters?.map((parameter) => parameter.name));
    for (const name of ['triplanarSpace', 'triplanarScale', 'triplanarSharpness']) {
      expect(names.has(name)).toBe(true);
    }
  });

  it('keeps UV mapping as the default with no projection values', () => {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1], baseColorTexture: texture });
    expect(material.values).not.toHaveProperty('triplanarSpace');
    expect(material.values).not.toHaveProperty('normalMapSpace');
    expect(standardProjectionMask(materialValue(material))).toBe(0);
  });

  it.each([
    [{ space: 'screen' }, 'range'],
    [{ space: 'world', scale: 0 }, 'range'],
    [{ space: 'world', scale: -1 }, 'range'],
    [{ space: 'world', sharpness: 0.5 }, 'range'],
    [{ space: 'world', scale: Number.NaN }, 'non-finite'],
    [{ space: 'object', sharpness: Number.POSITIVE_INFINITY }, 'non-finite'],
  ] as const)('rejects triplanar=%o with reason %s', (triplanar, reason) => {
    const error = authoringError(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        triplanar: triplanar as never,
      }),
    );
    expect(error).toMatchObject({
      code: 'material-authoring-contract-invalid',
      hint: expect.stringContaining('sharpness >= 1'),
      detail: { parameter: 'triplanar', reason, actual: triplanar },
    });
  });

  it.each([
    ['bumpTexture', { bumpTexture: texture }],
    ['displacementTexture', { displacementTexture: texture }],
    ['clearcoatNormalTexture', { clearcoatNormalTexture: texture }],
    ['transmissionTexture', { transmissionTexture: texture }],
    ['alphaCutoff', { alphaCutoff: 0.5 }],
    ['alphaHash', { alphaHash: true }],
    ['normalMapSpace', { normalMapSpace: 'object' }],
  ] as const)('rejects triplanar combined with %s', (actual, extra) => {
    const error = authoringError(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        normalTexture: texture,
        triplanar: { space: 'world' },
        ...extra,
      }),
    );
    expect(error.detail).toMatchObject({ parameter: 'triplanar', reason: 'conflict', actual });
    expect(error.hint).toContain('depth, shadow and temporal coverage sample by UV');
  });

  it('sets only the triplanar pipeline bit and leaves texture presence bits intact', () => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      baseColorTexture: texture,
      triplanar: { space: 'world' },
    });
    const projection = standardProjectionMask(materialValue(material));
    expect(projection).toBe(STANDARD_TRIPLANAR_PROJECTION_BIT);
    expect(projection & standardTextureMask(DEFAULT_STANDARD_PBR_PARAM_SCHEMA)).toBe(0);
  });
});

describe('Materials.standard object-space normal maps', () => {
  it('selects the object-space decode through one pipeline bit', () => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      normalTexture: texture,
      normalMapSpace: 'object',
    });
    expect(material.values).toMatchObject({ normalMapSpace: 1 });
    expect(standardProjectionMask(materialValue(material))).toBe(STANDARD_OBJECT_SPACE_NORMAL_BIT);
    expect(
      Materials.standard({ baseColor: [1, 1, 1, 1], normalMapSpace: 'tangent' }).values,
    ).not.toHaveProperty('normalMapSpace');
  });

  it('rejects an unknown space and a competing height map', () => {
    expect(
      authoringError(() =>
        Materials.standard({ baseColor: [1, 1, 1, 1], normalMapSpace: 'view' as never }),
      ).detail,
    ).toMatchObject({ parameter: 'normalMapSpace', reason: 'range', actual: 'view' });
    const conflict = authoringError(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        normalTexture: texture,
        bumpTexture: texture,
        normalMapSpace: 'object',
      }),
    );
    expect(conflict.detail).toMatchObject({
      parameter: 'normalMapSpace',
      reason: 'conflict',
      actual: 'bumpTexture',
    });
    expect(conflict.hint).toContain('replaces the height-derived normal');
  });
});

describe('non-PBR material family', () => {
  it('builds Lambert as the diffuse-only Standard path', () => {
    const material = Materials.lambert({ baseColor: [0.8, 0.2, 0.1, 1] });
    const standard = Materials.standard({ baseColor: [1, 1, 1, 1] });
    if (material.passes === undefined || standard.passes === undefined) {
      throw new Error('expected declared Lambert and Standard passes');
    }
    expect(material.values).toMatchObject({ metallic: 0, roughness: 1, specular: 0 });
    expect(material.passes.map((pass) => pass.name)).toEqual(
      standard.passes.map((pass) => pass.name),
    );
  });

  it('inherits Standard projection options for Lambert', () => {
    expect(
      Materials.lambert({
        baseColor: [1, 1, 1, 1],
        baseColorTexture: texture,
        triplanar: { space: 'object', scale: 2 },
      }).values,
    ).toMatchObject({ triplanarSpace: 2, triplanarScale: 2 });
  });

  it('selects unlit shading modes through the one declared scalar', () => {
    const unlit = Materials.unlit([1, 0, 0, 1]);
    const normal = Materials.normal({ opacity: 0.5 });
    const matcap = Materials.matcap(texture, { color: [0.5, 0.5, 0.5, 1] });
    expect(unlit.values).not.toHaveProperty('shading');
    expect(normal.values).toMatchObject({ shading: 1, baseColor: [1, 1, 1, 0.5] });
    expect(matcap.values).toMatchObject({
      shading: 2,
      baseColor: [0.5, 0.5, 0.5, 1],
      baseColorTexture: texture,
    });
    for (const material of [unlit, normal, matcap]) {
      if (material.passes === undefined || unlit.passes === undefined) {
        throw new Error('expected declared unlit family passes');
      }
      expect(material.passes.map((pass) => pass.program.module)).toEqual(
        unlit.passes.map((pass) => pass.program.module),
      );
      expect(material.parameters).toEqual(unlit.parameters);
    }
  });

  it('keeps the unlit alpha contract for the derived modes', () => {
    expect(() => Materials.matcap(texture, { alphaCutoff: 2 })).toThrow(
      'Materials.matcap: alphaCutoff must be in [0, 1], got 2',
    );
    expect(() => Materials.normal({ alphaCutoff: -1 })).toThrow('Materials.normal');
  });
});
