import { describe, expect, it } from 'vitest';
import { MaterialAuthoringContractError, Materials } from '../materials';

const custom = {
  surfaceModule: 'test::cutout-surface',
  parameters: [],
  values: {},
} as const;

describe('Materials.standard custom Surface alpha-clip admission', () => {
  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ] as const)('publishes alphaClip=%s in the canonical static contract', (alphaClip, expected) => {
    const material = Materials.standard({
      ...custom,
      ...(alphaClip === undefined ? {} : { alphaClip }),
    });
    expect(material.passes?.map((pass) => pass.name)).toEqual([
      'forward',
      'deferred',
      'shadow-caster',
    ]);
    expect(material.staticSwitches).toEqual({ alphaClipping: expected, alphaHash: false });
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

  it('preserves independent explicit hash and threshold selections', () => {
    const material = Materials.standard({
      ...custom,
      staticSwitches: { alphaHash: true, alphaClipping: true },
    });
    expect(material.staticSwitches).toEqual({ alphaClipping: true, alphaHash: true });
  });

  it('rejects conflicting coverage declarations before publication', () => {
    expect(() =>
      Materials.standard({
        ...custom,
        alphaClip: false,
        staticSwitches: { alphaClipping: true },
      }),
    ).toThrow(MaterialAuthoringContractError);
  });
});
