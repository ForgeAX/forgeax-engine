import { describe, expect, it } from 'vitest';
import { validateColorDomainConnection } from '../../../render-graph/src/pipeline/color-value-domain';

describe('LDR transparent blend contract', () => {
  it('keeps source and destination in the linear LDR domain', () => {
    expect(validateColorDomainConnection('linear-ldr', 'linear-ldr')).toEqual({ ok: true });
  });

  it('rejects a linear source mixed into an encoded destination', () => {
    const result = validateColorDomainConnection('linear-ldr', 'display-encoded');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected encoded destination rejection');
    expect(result.error.code).toBe('color-domain-mismatch');
  });

  it('requires an explicit encoding conversion after the blend', () => {
    const result = validateColorDomainConnection('linear-ldr', 'display-encoded', {
      kind: 'encode-srgb',
    });
    expect(result).toEqual({ ok: true });
  });
});
