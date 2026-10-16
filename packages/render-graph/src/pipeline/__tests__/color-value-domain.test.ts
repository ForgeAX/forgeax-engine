import { describe, expect, it } from 'vitest';
import {
  COLOR_VALUE_DOMAINS,
  type ColorResourceDescriptor,
  type ColorValueDomain,
  deserializeColorValueDomain,
  serializeColorResourceDescriptor,
  serializeColorValueDomain,
} from '../color-value-domain';

describe('ColorValueDomain', () => {
  it('keeps the closed domain union in pipeline order', () => {
    expect(COLOR_VALUE_DOMAINS).toEqual(['linear-hdr', 'linear-ldr', 'display-encoded']);
  });

  it.each([
    'linear-hdr',
    'linear-ldr',
    'display-encoded',
  ] as const)('round-trips the %s domain through serialization', (domain: ColorValueDomain) => {
    expect(deserializeColorValueDomain(serializeColorValueDomain(domain))).toEqual({
      ok: true,
      value: domain,
    });
  });

  it('serializes a resource descriptor without using the attachment format as authority', () => {
    const descriptor: ColorResourceDescriptor = {
      domain: 'linear-hdr',
      format: 'rgba8unorm',
    };
    expect(JSON.parse(serializeColorResourceDescriptor(descriptor))).toEqual(descriptor);
  });

  it('keeps display-encoded as an explicit domain for float storage', () => {
    const descriptor: ColorResourceDescriptor = {
      domain: 'display-encoded',
      format: 'rgba16float',
    };
    expect(JSON.parse(serializeColorResourceDescriptor(descriptor))).toEqual(descriptor);
  });

  it.each([undefined, 'gamma-magic'])('rejects a missing or unknown domain: %s', (value) => {
    const result = deserializeColorValueDomain(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an invalid color domain');
    expect(result.error.code).toBe('invalid-color-domain');
    expect(result.error.expected).toContain('linear-hdr');
    expect(result.error.hint).toContain('domain');
  });
});
