import { describe, expect, it } from 'vitest';
import * as curve3 from '../curve3';
import type { Vec3Like } from '../types';
import * as vec3 from '../vec3';

const points: readonly Vec3Like[] = [
  [0, 0, 0],
  [0.05, 0.01, 0],
  [1, 2, 0],
  [5, 2, 1],
  [5.1, 2.1, 1],
];
const out = vec3.create();
describe('whole-path curves and explicit distance tables', () => {
  it('has exact endpoints and uniform segment parity', () => {
    expect(Array.from(curve3.catmullRom(out, points, 0))).toEqual(points[0]);
    expect(Array.from(curve3.catmullRom(out, points, 1))).toEqual(
      Array.from(new Float32Array(required(points.at(-1)))),
    );
    const expected = vec3.catmullRom(
      vec3.create(),
      required(points[0]),
      required(points[1]),
      required(points[2]),
      required(points[3]),
      0.37,
    );
    const actual = curve3.catmullRom(out, points, 1.37 / 4, { parameterization: 'uniform' });
    for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(required(expected[i]), 6);
    expect(Array.from(curve3.catmullRom(out, points, 1.37 / 4))).not.toEqual(Array.from(expected));
  });
  it.each([
    'uniform',
    'centripetal',
    'chordal',
  ] as const)('analytic tangents agree with finite differences (%s)', (parameterization) => {
    const a = vec3.create(),
      b = vec3.create();
    for (const t of [0, 0.12, 0.44, 0.76, 1]) {
      curve3.catmullRom(a, points, Math.max(0, t - 1e-4), { parameterization });
      curve3.catmullRom(b, points, Math.min(1, t + 1e-4), { parameterization });
      vec3.normalize(b, vec3.sub(b, b, a));
      curve3.catmullRomTangent(a, points, t, { parameterization });
      expect(vec3.dot(a, b)).toBeGreaterThan(0.9999);
    }
  });
  it('closes positions and directions without a duplicate endpoint', () => {
    const a = curve3.catmullRom(vec3.create(), points, 0, { closed: true });
    expect(Array.from(curve3.catmullRom(out, points, 1, { closed: true }))).toEqual(Array.from(a));
    curve3.catmullRomTangent(a, points, 0, { closed: true });
    expect(vec3.dot(a, curve3.catmullRomTangent(out, points, 1, { closed: true }))).toBeGreaterThan(
      0.99999,
    );
  });
  it('handles empty, constant, repeated and tiny controls finitely', () => {
    for (const pts of [
      [],
      [[1, 2, 3]],
      [
        [1, 2, 3],
        [1, 2, 3],
        [1, 2, 3],
      ],
      [
        [0, 0, 0],
        [1e-12, 0, 0],
        [1e-12, 0, 0],
        [2e-12, 1e-12, 0],
      ],
    ] as readonly (readonly Vec3Like[])[]) {
      for (let i = 0; i <= 100; i++)
        expect(Array.from(curve3.catmullRom(out, pts, i / 100)).every(Number.isFinite)).toBe(true);
      const sample = (v: vec3.Vec3, t: number) => curve3.catmullRom(v, pts, t);
      const table = curve3.arcLengths(new Float32Array(257), sample);
      expect(Number.isFinite(curve3.parameterAtDistance(table, 0))).toBe(true);
    }
  });
  it('supports aliasing with a control point', () => {
    const p = vec3.create(1, 2, 3),
      controls = [p, [3, 1, 2], [4, 5, 6]] as Vec3Like[];
    const expected = curve3.catmullRom(out, controls, 0.37);
    expect(Array.from(curve3.catmullRom(p, controls, 0.37))).toEqual(Array.from(expected));
  });
  it('distance sampling converges against a dense independent chord integral', () => {
    const sample = (v: vec3.Vec3, t: number) => curve3.catmullRom(v, points, t);
    const table = curve3.arcLengths(new Float32Array(4097), sample);
    const dense = curve3.arcLengths(new Float32Array(65537), sample);
    const total = required(table.at(-1));
    expect(Math.abs(total / required(dense.at(-1)) - 1)).toBeLessThan(1e-4);
    // Compare inverse parameters to the high-resolution integral; speed budget 0.2%.
    for (let i = 1; i < 100; i++) {
      const d = (total * i) / 100,
        t = curve3.parameterAtDistance(table, d);
      const index = t * (dense.length - 1),
        lo = Math.floor(index),
        u = index - lo;
      const actual = required(dense[lo]) * (1 - u) + required(dense[lo + 1]) * u;
      expect(Math.abs(actual - d) / total).toBeLessThan(2e-5);
    }
    const a = vec3.create(),
      b = vec3.create(),
      steps = [];
    sample(a, 0);
    for (let i = 1; i <= 1000; i++) {
      sample(b, curve3.parameterAtDistance(table, (total * i) / 1000));
      steps.push(vec3.distance(a, b));
      vec3.copy(a, b);
    }
    expect(Math.max(...steps) / Math.min(...steps) - 1).toBeLessThan(0.002);
    expect(curve3.parameterAtDistance(table, -1)).toBe(0);
    expect(curve3.parameterAtDistance(table, total + 1)).toBe(1);
    expect(curve3.parameterAtDistance(new Float32Array(4), 1)).toBe(0);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing fixture value');
  return value;
}

it('short tables and invalid distances use the degenerate math policy', () => {
  const sample = (v: vec3.Vec3, t: number) => curve3.catmullRom(v, points, t);
  expect(Array.from(curve3.arcLengths(new Float32Array(1), sample))).toEqual([0]);
  expect(curve3.parameterAtDistance(new Float32Array([0, 1, 1, 2]), 1)).toBeCloseTo(2 / 3, 6);
  expect(curve3.parameterAtDistance(new Float32Array([0, 1]), Infinity)).toBe(0);
  expect(Array.from(curve3.catmullRomTangent(vec3.create(), [[1, 2, 3]], 0.5))).toEqual([0, 0, 0]);
});
