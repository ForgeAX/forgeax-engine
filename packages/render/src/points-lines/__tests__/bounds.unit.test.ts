import { describe, expect, it } from 'vitest';
import { expandPointsLinesBounds } from '../bounds';

describe('Points/Lines conservative transformed culling bounds', () => {
  it('retains a physical-pixel raster margin around transformed edge geometry', () => {
    const expanded = expandPointsLinesBounds(new Float32Array([10, 20, -1, 30, 40, 1]), {
      kind: 'points',
      size: 16,
      sizeUnits: 'pixels',
      shape: 'circle',
    });
    expect([...expanded]).toEqual([2, 12, -9, 38, 48, 9]);
  });

  it('uses line width as the conservative envelope for off-edge segments', () => {
    const expanded = expandPointsLinesBounds([-1, -1, 0, 1, 1, 0], {
      kind: 'lines',
      width: 4,
    });
    expect([...expanded]).toEqual([-9, -9, -8, 9, 9, 8]);
  });

  it('returns immutable Float32Array bounds without a copy when no style expands them', () => {
    const bounds = new Float32Array([-1, -1, -1, 1, 1, 1]);
    expect(expandPointsLinesBounds(bounds, undefined)).toBe(bounds);
    expect([...expandPointsLinesBounds([0, 0, 0, 1, 1, 1], undefined)]).toEqual([0, 0, 0, 1, 1, 1]);
  });
});
