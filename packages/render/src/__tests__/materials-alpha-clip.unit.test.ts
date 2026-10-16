import { describe, expect, it } from 'vitest';
import { Materials } from '../materials';

const custom = {
  surfaceModule: 'test::cutout-surface',
  parameters: [],
  values: {},
} as const;

describe('Materials.standard custom Surface alpha-clip admission', () => {
  it.each([
    [undefined, 'disabled'],
    [false, 'disabled'],
    [true, 'enabled'],
  ] as const)('projects alphaClip=%s to every existing pass tag %s', (alphaClip, expected) => {
    const material = Materials.standard({
      ...custom,
      ...(alphaClip === undefined ? {} : { alphaClip }),
    });
    expect(material.passes?.map((pass) => pass.name)).toEqual([
      'forward',
      'deferred',
      'shadow-caster',
    ]);
    expect(
      material.passes?.map((pass) => {
        const tags = pass.renderState?.tags;
        return typeof tags === 'object' && tags !== null && 'AlphaClip' in tags
          ? tags.AlphaClip
          : undefined;
      }),
    ).toEqual([expected, expected, expected]);
    expect(material.passes?.map((pass) => pass.program?.moduleSlots?.surface)).toEqual([
      custom.surfaceModule,
      custom.surfaceModule,
      custom.surfaceModule,
    ]);
    expect(material.values).toBe(custom.values);
  });

  it('preserves the complete omitted-option material when explicitly disabled', () => {
    expect(Materials.standard({ ...custom, alphaClip: false })).toEqual(Materials.standard(custom));
  });
});
