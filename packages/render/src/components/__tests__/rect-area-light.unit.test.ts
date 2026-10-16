import { describe, expect, it } from 'vitest';
import { buildRectAreaWorldFrame, rectAreaFacesPoint } from '../../render-system-extract';

describe('RectAreaLight world frame', () => {
  it('normalizes world axes while preserving authored half extents', () => {
    const frame = buildRectAreaWorldFrame({
      center: [1, 2, 3],
      axisX: [0, 2, 0],
      axisY: [-3, 0, 0],
      width: 4,
      height: 2,
    });

    expect(Array.from(frame.axisX)).toEqual([0, 1, 0]);
    expect(Array.from(frame.axisY)).toEqual([-1, 0, 0]);
    expect(Array.from(frame.normal)).toEqual([0, 0, 1]);
    expect(frame.halfWidth).toBe(2);
    expect(frame.halfHeight).toBe(1);
  });

  it('defines the front from the world-axis cross product', () => {
    const frame = buildRectAreaWorldFrame({
      center: [0, 0, 0],
      axisX: [1, 0, 0],
      axisY: [0, 1, 0],
      width: 2,
      height: 2,
    });

    expect(rectAreaFacesPoint(frame, [0, 0, 1])).toBe(true);
    expect(rectAreaFacesPoint(frame, [0, 0, -1])).toBe(false);
  });
});
