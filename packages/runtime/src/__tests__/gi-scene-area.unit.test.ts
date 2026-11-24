import { expect, it } from 'vitest';
import {
  type AreaBox,
  boxFormFactor,
  type Point3,
  polygonFormFactor,
  quadratureBox,
  quadraturePolygon,
  segmentIntersectsBox,
} from './gi-scene-area.fixture';
import { aperturePolygon, CONCAVE_BARS } from './gi-scene-concave.fixture';
import { sceneValue } from './gi-scene-value.fixture';

const box: AreaBox = { min: [-2.625, -1, -0.45], max: [-2.375, 1, 1.05], radiance: [4, 0.4, 0.1] };
it('cross-checks full and horizon-clipped finite-source integrals against independent quadrature', () => {
  const normals: Point3[] = [
    [0, 0, 1],
    [0.8, 0, 0.6],
    [-0.8, 0, 0.6],
    [0, 0.8, 0.6],
    [1, 0, 0],
  ];
  for (const point of [
    [0, 0, -2.875],
    [1, 0.6, -3.2],
    [-0.9, -0.2, -2.5],
  ] as const)
    for (const normal of normals) {
      const exact = boxFormFactor(point, normal, box);
      const coarse = quadratureBox(point, normal, box, 32),
        fine = quadratureBox(point, normal, box, 64);
      expect(Math.abs(exact - fine)).toBeLessThan(2e-5);
      expect(Math.abs(coarse - fine)).toBeLessThan(6e-5);
      expect(exact).toBeGreaterThanOrEqual(0);
      expect(exact).toBeLessThanOrEqual(1);
    }
});

it('cross-checks the aperture polygon against independent exact box segments and smooth area quadrature', () => {
  for (const x of [-0.6, 0, 0.6])
    for (const y of [-0.6, 0, 0.6]) {
      const receiver: Point3 = [x, y, -2.875],
        polygon = aperturePolygon(receiver);
      const exact = polygonFormFactor(receiver, [0, 0, 1], polygon);
      expect(
        Math.abs(quadraturePolygon(receiver, [0, 0, 1], polygon, 64) - exact) / exact,
      ).toBeLessThan(0.0001);
      for (let u = 0; u < 33; u++)
        for (let v = 0; v < 33; v++) {
          const point: Point3 = [-2 + ((u + 0.5) * 4) / 33, -2 + ((v + 0.5) * 4) / 33, 0.65];
          const clear = !CONCAVE_BARS.some((bar) =>
            segmentIntersectsBox(
              receiver,
              [point[0] - x, point[1] - y, point[2] - receiver[2]],
              bar,
            ),
          );
          const inside =
            point[0] > sceneValue(polygon[0])[0] &&
            point[0] < sceneValue(polygon[2])[0] &&
            point[1] > sceneValue(polygon[0])[1] &&
            point[1] < sceneValue(polygon[2])[1];
          expect(inside).toBe(clear);
        }
    }
});
