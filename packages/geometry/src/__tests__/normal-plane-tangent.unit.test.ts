import { assert, expect, it } from 'vitest';
import { writeNormalPlaneTangent } from '../tangent';

it.each([
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [2, -3, 4],
])('writes a unit perpendicular frame for normal %j', (nx, ny, nz) => {
  const out = new Float32Array([9, 9, 9, -1, 7]);
  expect(writeNormalPlaneTangent(out, 0, nx, ny, nz)).toBe(true);
  const [tx, ty, tz] = out;
  assert(tx !== undefined && ty !== undefined && tz !== undefined);
  expect(Math.hypot(tx, ty, tz)).toBeCloseTo(1);
  expect(nx * tx + ny * ty + nz * tz).toBeCloseTo(0);
  expect(Array.from(out.subarray(3))).toEqual([-1, 7]);
});

it.each([
  [0, 0, 0],
  [Infinity, 1, 0],
  [NaN, NaN, NaN],
  [NaN, 1, 0],
  [1, NaN, 0],
  [0, 1, NaN],
])('refuses an undefined plane without writing', (nx, ny, nz) => {
  const out = new Float32Array([2, 3, 4, -1]);
  expect(writeNormalPlaneTangent(out, 0, nx, ny, nz)).toBe(false);
  expect(Array.from(out)).toEqual([2, 3, 4, -1]);
});

it.each([
  [0, 0],
  [1, 0],
  [4, 3],
  [4, -1],
  [4, 0.5],
  [4, NaN],
  [4, Infinity],
])('refuses an incomplete output range without writing (%i, %s)', (length, offset) => {
  const out = new Float32Array(length).fill(9);
  expect(writeNormalPlaneTangent(out, offset, 0, 0, 1)).toBe(false);
  expect(Array.from(out)).toEqual(new Array(length).fill(9));
});

it('writes at the final complete output range without touching its prefix', () => {
  const out = new Float32Array([9, 9, 9, 9]);
  expect(writeNormalPlaneTangent(out, 1, 0, 0, 1)).toBe(true);
  expect(Array.from(out)).toEqual([9, 0, -1, 0]);
});
