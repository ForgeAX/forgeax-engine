import {
  ClippingContractError,
  normalizeClippingPlanes,
  withClipping,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { clippingPlanesData, extractClippingPlanes } from '../components/clipping-planes';
import { Materials } from '../materials';

describe('public world-space clipping', () => {
  it('normalizes normal and constant together and detaches authored arrays', () => {
    const plane: [number, number, number, number] = [2, 0, 0, -4];
    const result = normalizeClippingPlanes([plane]);
    plane[3] = 40;
    expect(result).toEqual([[1, 0, 0, -2]]);
  });
  it.each(
    [[[0, 0, 0, 1]], [[NaN, 0, 1, 0]], [[1, 0, 0, Infinity]], Array(7).fill([1, 0, 0, 0])].map(
      (planes) => ({ planes }),
    ),
  )('rejects invalid planes atomically', ({ planes }) => {
    expect(() => normalizeClippingPlanes(planes as never)).toThrow(ClippingContractError);
  });
  it('keeps local clipping in one material contract with explicit shadow and intersection policy', () => {
    const root = Materials.standard({ baseColor: [1, 1, 1, 1] });
    const result = withClipping(root, {
      planes: [[1, 0, 0, 0]],
      intersection: true,
      clipShadows: true,
    });
    expect(root.values?.clippingControl).toBeUndefined();
    expect(result.values?.clippingControl).toEqual([1, 1, 1, 0]);
    expect(
      withClipping(result, { planes: [] }).parameters?.filter((p) => p.name === 'clippingControl'),
    ).toHaveLength(1);
    expect(withClipping(result, { planes: [] }).values?.clippingControl).toEqual([0, 0, 0, 0]);
  });
  it('round-trips a detached camera/capture contract', () => {
    const data = clippingPlanesData({ planes: [[0, 2, 0, -2]], clipShadows: true });
    const snapshot = extractClippingPlanes(data);
    expect(snapshot).toEqual({ planes: [[0, 1, 0, -1]], intersection: false, clipShadows: true });
    data.planes[1] = 3;
    expect(snapshot?.planes[0]?.[1]).toBe(1);
    expect(() => extractClippingPlanes({ ...data, count: 7 })).toThrow(ClippingContractError);
  });
});
