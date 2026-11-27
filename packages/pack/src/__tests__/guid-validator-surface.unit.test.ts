import { isValidAssetGuidString } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetGuid } from '../guid';

describe('asset GUID spelling and byte identity', () => {
  it.each([
    ['019e3969-1d48-7c3b-ac24-6d68f457065f', true],
    ['019E3969-1D48-7C3B-AC24-6D68F457065F', true],
    ['00000000-0000-0000-0000-000000000000', true],
    ['ffffffff-ffff-ffff-ffff-ffffffffffff', true],
    ['not-a-guid', false],
    ['', false],
    ['zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', false],
    ['019e39691d487c3bac246d68f457065f', false],
    ['019e3969-1d48-7c3b-ac24-6d68f457065g', false],
    [' 019e3969-1d48-7c3b-ac24-6d68f457065f', false],
  ] as const)('agrees between pure admission and byte parsing for %s', (value, accepted) => {
    expect(isValidAssetGuidString(value)).toBe(accepted);
    const parsed = AssetGuid.parse(value);
    expect(parsed.ok).toBe(accepted);
    if (parsed.ok) {
      expect(parsed.value).toBeInstanceOf(Uint8Array);
      expect(parsed.value).toHaveLength(16);
      expect(AssetGuid.format(parsed.value)).toBe(value.toLowerCase());
      const second = AssetGuid.parse(value);
      if (!second.ok) throw second.error;
      expect(AssetGuid.equals(second.value, parsed.value)).toBe(true);
    } else {
      expect(parsed.error).toMatchObject({
        code: 'pack-guid-malformed',
        detail: { raw: value, reason: expect.any(String) },
      });
    }
  });

  it('generates distinct UUIDv7 values with the RFC variant', () => {
    const a = AssetGuid.random();
    const b = AssetGuid.random();
    expect(a).toHaveLength(16);
    expect((a[6] ?? 0) >> 4).toBe(7);
    expect((a[8] ?? 0) >> 6).toBe(2);
    expect(AssetGuid.equals(a, b)).toBe(false);
  });

  it.each([
    undefined,
    null,
    12,
    {},
    ['019e3969-1d48-7c3b-ac24-6d68f457065f'],
  ])('rejects non-string input without coercion: %j', (value) =>
    expect(isValidAssetGuidString(value)).toBe(false));
});
