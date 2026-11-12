import { describe, expect, it } from 'vitest';
import { materialAlphaMask } from '../material-alpha-mask';

describe('materialAlphaMask', () => {
  it('admits only materials whose values can cut out', () => {
    expect(materialAlphaMask(undefined)).toBe(false);
    expect(materialAlphaMask({})).toBe(false);
    expect(materialAlphaMask({ alphaCutoff: 0, alphaHash: 0 })).toBe(false);
    expect(materialAlphaMask({ alphaCutoff: 0.5 })).toBe(true);
    expect(materialAlphaMask({ alphaHash: 1 })).toBe(true);
    expect(materialAlphaMask({ alphaHash: 0.25 })).toBe(false);
  });
});
