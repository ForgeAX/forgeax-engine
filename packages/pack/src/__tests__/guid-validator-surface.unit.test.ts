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
    ['019e39691d487c3bac246d68f457065f', false],
    ['019e3969-1d48-7c3b-ac24-6d68f457065g', false],
    [' 019e3969-1d48-7c3b-ac24-6d68f457065f', false],
  ] as const)('agrees between pure admission and byte parsing for %s', (value, accepted) => {
    expect(isValidAssetGuidString(value)).toBe(accepted);
    const parsed = AssetGuid.parse(value);
    expect(parsed.ok).toBe(accepted);
    if (parsed.ok) expect(AssetGuid.format(parsed.value)).toBe(value.toLowerCase());
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
