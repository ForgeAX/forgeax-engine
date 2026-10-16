import { describe, expect, it } from 'vitest';
import { validateColorDomainConnection } from '../../../../../../packages/render-graph/src/pipeline/color-value-domain';

describe('HDR transparent PBR analytic case', () => {
  it('blends a non-black destination in linear HDR', () => {
    const source = [2, 1, 0.5];
    const destination = [0.5, 0.25, 0.125];
    const alpha = 0.25;
    const result = source.map((value, index) => {
      const background = destination[index] ?? 0;
      return value * alpha + background * (1 - alpha);
    });
    expect(result).toEqual([0.875, 0.4375, 0.21875]);
    expect(validateColorDomainConnection('linear-hdr', 'linear-hdr')).toEqual({ ok: true });
  });

  it('keeps encoding after the paired HDR blend', () => {
    const result = validateColorDomainConnection('linear-hdr', 'display-encoded', {
      kind: 'tone-map',
    });
    expect(result).toEqual({ ok: true });
  });
});
