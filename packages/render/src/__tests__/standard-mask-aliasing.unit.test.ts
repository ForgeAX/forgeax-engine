import {
  STANDARD_OBJECT_SPACE_NORMAL_BIT,
  STANDARD_TRIPLANAR_PROJECTION_BIT,
} from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { materialStandardTextureMask } from '../render-system-extract';

const shaderId = 'forgeax::default-standard-pbr';
const hasBit = (mask: number, bit: number) => Math.floor(mask / bit) % 2 === 1;

function mask(values: Record<string, number>): number {
  const result = materialStandardTextureMask(undefined, shaderId, values, {
    textureHandles: new Map(Object.entries(values).filter(([name]) => name.endsWith('Texture'))),
    samplerHandles: new Map(),
    textureCoordinates: new Map(),
  });
  if (result === undefined) throw new Error('missing Standard texture mask');
  return result;
}

describe('Standard pipeline override aliasing', () => {
  const alphaReusesMetallic = {
    baseColorTexture: 1,
    metallicTexture: 2,
    roughnessTexture: 3,
    alphaTexture: 2,
  };

  it('alpha reuse of a late source sets no projection bit', () => {
    const reuse = mask(alphaReusesMetallic);
    expect(hasBit(reuse, STANDARD_TRIPLANAR_PROJECTION_BIT)).toBe(false);
    expect(hasBit(reuse, STANDARD_OBJECT_SPACE_NORMAL_BIT)).toBe(false);
  });

  it('alpha reuse and projection selectors give distinct pipeline masks', () => {
    const reuse = mask(alphaReusesMetallic);
    const distinct = { ...alphaReusesMetallic, alphaTexture: 4 };
    const triplanar = mask({ ...distinct, triplanarSpace: 1 });
    const objectNormal = mask({ ...distinct, normalMapSpace: 1 });
    expect(new Set([reuse, triplanar, objectNormal, mask(distinct)]).size).toBe(4);
    expect(hasBit(triplanar, STANDARD_TRIPLANAR_PROJECTION_BIT)).toBe(true);
    expect(hasBit(objectNormal, STANDARD_OBJECT_SPACE_NORMAL_BIT)).toBe(true);
    expect(hasBit(triplanar, STANDARD_OBJECT_SPACE_NORMAL_BIT)).toBe(false);
  });
});
