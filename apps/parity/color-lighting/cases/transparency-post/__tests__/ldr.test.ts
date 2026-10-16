import { describe, expect, it } from 'vitest';
import { validateColorDomainConnection } from '../../../../../../packages/render-graph/src/pipeline/color-value-domain';

function blendLinear(source: readonly number[], destination: readonly number[], alpha: number) {
  return source.map((value, index) => {
    const background = destination[index] ?? 0;
    return value * alpha + background * (1 - alpha);
  });
}

describe('LDR transparent PBR analytic case', () => {
  it('blends a non-black destination in linear LDR', () => {
    expect(blendLinear([0.8, 0.4, 0.2], [0.2, 0.1, 0.05], 0.5)).toEqual([
      0.5, 0.25, 0.125,
    ]);
    expect(validateColorDomainConnection('linear-ldr', 'linear-ldr')).toEqual({ ok: true });
  });

  it('falsifies an encoded destination before output encoding', () => {
    const result = validateColorDomainConnection('linear-ldr', 'display-encoded');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected encoded destination rejection');
    expect(result.error.code).toBe('color-domain-mismatch');
  });
});
