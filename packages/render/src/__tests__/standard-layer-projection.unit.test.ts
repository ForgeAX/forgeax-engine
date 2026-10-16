import { describe, expect, it } from 'vitest';
import { Materials } from '../materials.js';

describe('Standard pass projection', () => {
  it('keeps default and custom base surfaces on the base pass family', () => {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1] });
    expect(material.passes?.map((pass) => pass.name)).toEqual([
      'forward',
      'deferred',
      'shadow-caster',
    ]);
  });

  it('uses the same physical forward-only projection for a zero-factor declaration', () => {
    const material = Materials.standard({
      staticSwitches: { clearcoat: true },
      baseColor: [1, 1, 1, 1],
      clearcoat: 0,
      clearcoatRoughness: 0,
    });
    expect(material.passes?.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
    expect(material.parameters?.some((parameter) => parameter.name === 'clearcoat')).toBe(true);
  });
});
