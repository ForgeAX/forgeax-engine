import { describe, expect, it } from 'vitest';
import { frustum, mat4, ray } from '../index';

describe('Reverse-Z camera consumers', () => {
  for (const far of [100, 1e8, Infinity]) {
    it(`clips the near plane and preserves distant geometry (far=${far})`, () => {
      const projection = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 2, 1, 0.1, far);
      const planes = frustum.fromViewProjection(frustum.create(), projection);
      expect(frustum.intersectsSphere(planes, [0, 0, -0.05], 0.001)).toBe(false);
      expect(frustum.intersectsSphere(planes, [0, 0, -1], 0.001)).toBe(true);
      if (Number.isFinite(far)) {
        expect(frustum.intersectsSphere(planes, [0, 0, -far * 1.1], 0.001)).toBe(false);
      } else {
        expect(frustum.intersectsSphere(planes, [0, 0, -1e9], 1)).toBe(true);
      }
    });
  }
  it('distinguishes distant surfaces after float32 storage', () => {
    const project = (matrix: ArrayLike<number>, distance: number) =>
      Math.fround((-(matrix[10] ?? 0) * distance + (matrix[14] ?? 0)) / distance);
    const forward = mat4.perspective(mat4.create(), 1, 1, 0.1, 1e8);
    const reverse = mat4.perspectiveReverseZ(mat4.create(), 1, 1, 0.1, 1e8);
    expect(project(forward, 100000)).toBe(project(forward, 100001));
    expect(project(reverse, 100000)).toBeGreaterThan(project(reverse, 100001));
  });
  for (const kind of ['perspective', 'orthographic'] as const) {
    it(`casts a forward ray from the near plane for ${kind}`, () => {
      const projection =
        kind === 'perspective'
          ? mat4.perspectiveReverseZ(mat4.create(), 1, 1, 0.1, Infinity)
          : mat4.orthographicReverseZ(mat4.create(), -1, 1, 1, -1, 0.1, 100);
      const result = ray.screenToRay(
        ray.create(),
        50,
        50,
        100,
        100,
        mat4.identity(mat4.create()),
        projection,
        kind,
      );
      expect(result[2]).toBeCloseTo(-0.1, 5);
      expect(result[5]).toBeCloseTo(-1, 5);
    });
  }
});
