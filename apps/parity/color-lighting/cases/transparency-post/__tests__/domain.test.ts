import { describe, expect, it } from 'vitest';
import { validateColorDomainConnection } from '../../../../../../packages/render-graph/src/index';

describe('transparency post color domain boundary', () => {
  it('requires an explicit source domain for an LDR destination', () => {
    const result = validateColorDomainConnection(undefined, 'linear-ldr');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a missing domain failure');
    expect(result.error.code).toBe('missing-color-domain');
    expect(result.error.hint).toContain('domain');
  });

  it('accepts a linear HDR source into a linear HDR destination', () => {
    expect(validateColorDomainConnection('linear-hdr', 'linear-hdr')).toEqual({ ok: true });
  });
});
