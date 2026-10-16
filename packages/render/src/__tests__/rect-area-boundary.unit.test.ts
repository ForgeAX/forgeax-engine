import { describe, expect, it } from 'vitest';
import { buildRectAreaWorldFrame, closestPointOnRectArea } from '../render-system-extract';

const frame = buildRectAreaWorldFrame({
  center: [0, 0, 0],
  axisX: [1, 0, 0],
  axisY: [0, 1, 0],
  width: 4,
  height: 2,
});

describe('RectAreaLight range and cluster boundaries', () => {
  it('clamps the nearest point to authored half extents', () => {
    expect(Array.from(closestPointOnRectArea(frame, [3, 2, 4]))).toEqual([2, 1, 0]);
    expect(Array.from(closestPointOnRectArea(frame, [1, 0.5, 4]))).toEqual([1, 0.5, 0]);
  });
});
