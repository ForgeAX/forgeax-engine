import { describe, expect, it } from 'vitest';
import {
  COLOR_VALUE_DOMAINS,
  isColorValueDomain,
  validateColorDomainConnection,
} from '../color-value-domain';

describe('ColorValueDomain', () => {
  it('keeps the closed domain union in pipeline order', () => {
    expect(COLOR_VALUE_DOMAINS).toEqual(['linear-hdr', 'linear-ldr', 'display-encoded']);
    for (const domain of COLOR_VALUE_DOMAINS) expect(isColorValueDomain(domain)).toBe(true);
  });

  it('requires an explicit source domain', () => {
    const result = validateColorDomainConnection(undefined, 'linear-hdr');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a missing color domain');
    expect(result.error.code).toBe('missing-color-domain');
    expect(result.error.detail).toEqual({ resourceKey: 'source' });
  });

  it('rejects an unknown domain', () => {
    const result = validateColorDomainConnection('gamma-magic', 'linear-hdr');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an invalid color domain');
    expect(result.error.code).toBe('invalid-color-domain');
    expect(result.error.expected).toContain('linear-hdr');
    expect(result.error.hint).toContain('domain');
  });
});
