import { describe, expect, it } from 'vitest';
import { lowerSceneMaterialAddresses } from '../scene-material-address.js';

describe('GPU Scene material address lowering', () => {
  it('uses the producer stride for nested, masked and independent accesses', () => {
    expect(
      lowerSceneMaterialAddresses(
        'sceneMaterials[visibleItems[i].y].baseColor + sceneMaterials[index & ~BIT].roughness',
        80,
      ),
    ).toBe(
      'sceneMaterials[(visibleItems[i].y) / 5u].baseColor + sceneMaterials[(index & ~BIT) / 5u].roughness',
    );
    expect(lowerSceneMaterialAddresses('sceneMaterials[index].payload[2]', 32)).toBe(
      'sceneMaterials[(index) / 2u].payload[2]',
    );
  });
  it.each([0, 17, NaN, Infinity])('rejects an invalid stride %s', (stride) => {
    expect(() => lowerSceneMaterialAddresses('sceneMaterials[index]', stride)).toThrow(RangeError);
  });
});
