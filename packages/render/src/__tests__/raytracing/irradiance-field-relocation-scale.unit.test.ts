import { describe, expect, it } from 'vitest';
import {
  authoredBox,
  dot,
  geometryRays,
  insideBox,
  nearestTriangle,
  normal,
  type Point,
  placementFailures,
  relocationPlan,
  relocationProbe,
  relocationScales,
} from './irradiance-field-relocation-scale.fixture';

describe('independent authored closed geometry reference', () => {
  it('admits all scaled public plans with exactly64 probes and finite distances', () => {
    for (const scale of relocationScales) {
      const p = relocationPlan(scale);
      expect(p.probeCount).toBe(64);
      expect(p.dimensions).toEqual([4, 4, 4]);
      expect(p.spacing).toBe(4 * scale);
      expect(p.origin).toEqual([scale, scale, scale]);
    }
  });
  it('uses all12 triangles, outward mirrored normals and analytic halfspaces', () => {
    for (const mirror of [false, true]) {
      const triangles = authoredBox(mirror);
      expect(triangles).toHaveLength(12);
      for (const t of triangles) {
        const c: Point = [
          (t.a[0] + t.b[0] + t.c[0]) / 3,
          (t.a[1] + t.b[1] + t.c[1]) / 3,
          (t.a[2] + t.b[2] + t.c[2]) / 3,
        ];
        expect(dot(normal(t), c)).toBeGreaterThan(0);
      }
      for (const [direction, expected] of [
        [[1, 0, 0], 0.8],
        [[-1, 0, 0], 0.8],
        [[0, 1, 0], 4],
        [[0, 0, -1], 3],
      ] as const) {
        const hit = nearestTriangle(triangles, [0, 0, 0], direction);
        expect(hit?.distance).toBeCloseTo(expected, 10);
        expect(hit && dot(direction, hit.normal)).toBeGreaterThan(0);
      }
      expect(nearestTriangle(triangles, [2, 0, 0], [1, 0, 0])).toBeUndefined();
      expect(nearestTriangle(triangles, [2, 0, 0], [-1, 0, 0])?.distance).toBeCloseTo(1.2, 10);
    }
    expect(insideBox([0, 0, 0])).toBe(true);
    expect(insideBox([1, 0, 0])).toBe(false);
  });
  it('rejects wrong-normal activation and a stale placed origin without using the producer as oracle', () => {
    const directions = new Float32Array(256 * 4);
    for (let r = 0; r < 256; r++) directions.set([1, 0, 0, 1], r * 4);
    expect(geometryRays(directions, [0, 0, 0], 1).backs).toBe(256);
    expect(geometryRays(directions, [0, 0, 0], 1, false, true).backs).toBe(0);
    const meta = new Uint32Array(64 * 4);
    meta[relocationProbe * 4] = 1;
    meta[relocationProbe * 4 + 1] = 1;
    expect(placementFailures([5, 5, 5], meta, 1, [5, 5, 5]).failures).toContain(
      'active probe remains inside authored solid',
    );
    expect(placementFailures([6.8, 5, 5], meta, 1, [5, 5, 5]).failures).toEqual([]);
    const scale = 65536;
    expect(
      placementFailures([5 * scale + 1.8, 5 * scale, 5 * scale], meta, scale, [
        5 * scale,
        5 * scale,
        5 * scale,
      ]).failures,
    ).toContain('active probe remains inside authored solid');
  });
});
