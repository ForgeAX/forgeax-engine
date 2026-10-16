import { describe, expect, it } from 'vitest';
import { iesProfileLoader } from '../loaders/ies-profile.js';
import { createDefaultLoaderRegistry } from '../wire-default-loaders.js';

describe('IES cooked loader publication boundary', () => {
  it('is part of the default loader registry and preserves cooked bytes', () => {
    const bytes = new Uint8Array(256 * 128 * 2);
    bytes[1] = 0x3c;
    const registry = createDefaultLoaderRegistry();
    expect(registry.get('ies-profile')).toBe(iesProfileLoader);
    const loaded = iesProfileLoader.load({ kind: 'ies-profile', data: bytes }, [], {} as never);
    expect(loaded).toMatchObject({ kind: 'ies-profile', data: bytes });
  });

  it('normalizes serialized byte arrays into a typed cooked payload', () => {
    const bytes = new Array(256 * 128 * 2).fill(0);
    bytes[1] = 0x3c;
    const loaded = iesProfileLoader.load({ kind: 'ies-profile', data: bytes }, [], {} as never);
    expect(loaded?.data).toBeInstanceOf(Uint8Array);
    expect(loaded?.data).toEqual(Uint8Array.from(bytes));
  });

  it('does not parse source text and rejects malformed cooked payloads', () => {
    expect(
      iesProfileLoader.load(
        { kind: 'ies-profile', source: 'TILT=NONE', data: new Uint8Array(2) },
        [],
        {} as never,
      ),
    ).toBeUndefined();
    expect(
      iesProfileLoader.load(
        { kind: 'ies-profile', data: new Uint8Array(256 * 128 * 2).fill(0x7d) },
        [],
        {} as never,
      ),
    ).toBeUndefined();
  });
});
