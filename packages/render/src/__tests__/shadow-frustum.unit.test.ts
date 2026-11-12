import { frustum, mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { shadowPlanes } from '../shadow-frustum';

it('admits upstream directional blockers while preserving side and far planes', () => {
  const matrix = mat4.identity(mat4.create());
  const clipped = shadowPlanes(matrix);
  const pancaked = shadowPlanes(matrix, true);
  const inside = (planes: frustum.Frustum, min: number[], max: number[]) =>
    frustum.intersectsBox(planes, [...min, ...max]);
  expect(inside(clipped, [-0.1, -0.1, 2], [0.1, 0.1, 3])).toBe(false);
  expect(inside(pancaked, [-0.1, -0.1, 2], [0.1, 0.1, 3])).toBe(true);
  expect(inside(pancaked, [-0.1, -0.1, -3], [0.1, 0.1, -2])).toBe(false);
  for (const axis of [0, 1])
    for (const sign of [-1, 1]) {
      const min = [-0.1, -0.1, 2],
        max = [0.1, 0.1, 3];
      min[axis] = sign > 0 ? 2 : -3;
      max[axis] = sign > 0 ? 3 : -2;
      expect(inside(pancaked, min, max)).toBe(false);
    }
  expect(Array.from(clipped.subarray(0, 20))).toEqual(Array.from(pancaked.subarray(0, 20)));
});
