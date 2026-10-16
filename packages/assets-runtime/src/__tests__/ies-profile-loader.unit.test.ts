import { describe, expect, it } from 'vitest';
import { iesProfileLoader } from '../loaders/ies-profile';

describe('IES profile loader consumer', () => {
  it('loads only the exact cooked payload and preserves bytes', () => {
    const bytes = new Uint8Array(256 * 128 * 2);
    bytes[0] = 0x00;
    bytes[1] = 0x3c;
    const value = iesProfileLoader.load({ kind: 'ies-profile', data: bytes }, [], {} as never);

    expect(value).toMatchObject({ kind: 'ies-profile' });
    if (value !== undefined && !('ok' in value)) expect(value.data).toBe(bytes);
  });

  it('returns no runtime asset for malformed payloads', () => {
    expect(
      iesProfileLoader.load({ kind: 'ies-profile', data: new Uint8Array(2) }, [], {} as never),
    ).toBeUndefined();
  });
});
