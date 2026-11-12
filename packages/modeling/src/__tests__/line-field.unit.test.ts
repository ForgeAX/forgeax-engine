import { describe, expect, it } from 'vitest';
import { type Flow, flowAt, lineAngle, lineField, tangent } from '../compute/line-field';
import type { Tuple3 } from '../geom';

/** A cylinder of radius r about +y: `rings` x `segments` vertices, quads split into triangles. */
function cylinder(r = 0.5, height = 1, rings = 9, segments = 32) {
  const positions: number[] = [];
  const triangles: number[] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = (2 * Math.PI * j) / segments;
      positions.push(r * Math.cos(a), (height * i) / (rings - 1), r * Math.sin(a));
    }
  }
  const id = (i: number, j: number) => i * segments + (j % segments);
  for (let i = 0; i + 1 < rings; i++) {
    for (let j = 0; j < segments; j++) {
      triangles.push(
        id(i, j),
        id(i + 1, j),
        id(i, j + 1),
        id(i, j + 1),
        id(i + 1, j),
        id(i + 1, j + 1),
      );
    }
  }
  return { positions, triangles, vertices: rings * segments, segments };
}

const at = (f: Float64Array, v: number): Tuple3 => [
  f[v * 3] as number,
  f[v * 3 + 1] as number,
  f[v * 3 + 2] as number,
];
const point = (p: readonly number[], v: number): Tuple3 => [
  p[v * 3] as number,
  p[v * 3 + 1] as number,
  p[v * 3 + 2] as number,
];

describe('line field', () => {
  const around: Flow = { around: { axis: [0, 1, 0], center: [0, 0, 0] } };

  it('evaluates the four flows in the tangent plane', () => {
    const n: Tuple3 = [1, 0, 0];
    expect(flowAt({ along: [1, 1, 0] }, [0.5, 0, 0], n)).toEqual([0, 1, 0]);
    expect(lineAngle(flowAt(around, [0.5, 0, 0], n) as Tuple3, [0, 0, 1])).toBeLessThan(1e-9);
    expect(
      lineAngle(flowAt({ from: [0, -1, 0] }, [0.5, 0, 0], n) as Tuple3, [0, 1, 0]),
    ).toBeLessThan(45.1);
    const curve = flowAt(
      {
        curve: [
          [0.5, 0, -1],
          [0.5, 0, 1],
        ],
      },
      [0.5, 0, 0.2],
      n,
    ) as Tuple3;
    expect(lineAngle(curve, [0, 0, 1])).toBeLessThan(1e-9);
    // Along the normal there is no tangent direction.
    expect(flowAt({ along: [1, 0, 0] }, [0.5, 0, 0], n)).toBeUndefined();
  });

  it('follows an around flow on a cylinder and fills undata-ed regions smoothly', () => {
    const c = cylinder();
    const full = lineField({
      positions: c.positions,
      triangles: c.triangles,
      data: (_t, centroid, normal) => flowAt(around, centroid, normal),
    });
    for (let v = 0; v < c.vertices; v++) {
      const p = point(c.positions, v);
      expect(lineAngle(at(full.field, v), [-p[2], 0, p[0]])).toBeLessThan(2);
    }
    // Data on the lower half only: the smoothing carries the circles up.
    const half = lineField({
      positions: c.positions,
      triangles: c.triangles,
      data: (_t, centroid, normal) =>
        centroid[1] < 0.5 ? flowAt(around, centroid, normal) : undefined,
    });
    for (let v = 0; v < c.vertices; v++) {
      const p = point(c.positions, v);
      expect(lineAngle(at(half.field, v), [-p[2], 0, p[0]])).toBeLessThan(2);
    }
    expect(half.roughness).toBeLessThan(2);
  });

  it('holds the field along a constraint edge, or across it when the data crosses it', () => {
    const c = cylinder();
    // A vertical seam (j = 0) as a constraint.
    const seam: [number, number][] = [];
    for (let i = 0; i + 1 < 9; i++) seam.push([i * c.segments, (i + 1) * c.segments]);
    const tilted: Flow = { along: [0.3, 1, 0.3] };
    // Data near the seam's direction: the seam vertices run exactly along it.
    const along = lineField({
      positions: c.positions,
      triangles: c.triangles,
      data: (_t, centroid, normal) => flowAt(tilted, centroid, normal),
      constraints: seam,
    });
    expect(along.constrained).toBe(9);
    for (let i = 0; i < 9; i++)
      expect(lineAngle(at(along.field, i * c.segments), [0, 1, 0])).toBeLessThan(1e-6);
    // Data crossing the seam (circles): its vertices run exactly across it, not along it.
    const across = lineField({
      positions: c.positions,
      triangles: c.triangles,
      data: (_t, centroid, normal) => flowAt(around, centroid, normal),
      constraints: seam,
    });
    for (let i = 0; i < 9; i++) {
      const v = i * c.segments;
      // Exactly perpendicular to the seam in the vertex's own tangent plane (its normal tilts
      // on the open rims): the field is orthogonal to the seam direction there.
      const f = at(across.field, v);
      const n = at(across.normals, v);
      const seamTangent = tangent([0, 1, 0], n) as Tuple3;
      expect(
        Math.abs(f[0] * seamTangent[0] + f[1] * seamTangent[1] + f[2] * seamTangent[2]),
      ).toBeLessThan(1e-9);
    }
  });

  it('lets a flow cross a boundary rim instead of turning it along (the dome-rim case)', () => {
    // The bottom ring is a preserved boundary; the flow (meridians on a dome, here the
    // cylinder axis) crosses it. The approved first rule forced the rim field along the ring
    // and the smoothing dragged that inward.
    const c = cylinder();
    const rim: [number, number][] = [];
    for (let j = 0; j < c.segments; j++) rim.push([j, (j + 1) % c.segments]);
    const f = lineField({
      positions: c.positions,
      triangles: c.triangles,
      data: (_t, centroid, normal) => flowAt({ along: [0, 1, 0] }, centroid, normal),
      constraints: rim,
    });
    expect(f.constrained).toBe(c.segments);
    let worst = 0;
    for (let v = 0; v < 2 * c.segments; v++)
      worst = Math.max(worst, lineAngle(at(f.field, v), [0, 1, 0]));
    expect(worst).toBeLessThan(10);
  });

  it('runs along the axis of a cylinder for principal curvature', () => {
    const c = cylinder();
    const f = lineField({ positions: c.positions, triangles: c.triangles, principal: true });
    let worst = 0;
    for (let i = 1; i < 8; i++) {
      for (let j = 0; j < c.segments; j++)
        worst = Math.max(worst, lineAngle(at(f.field, i * c.segments + j), [0, 1, 0]));
    }
    expect(worst).toBeLessThan(5);
  });
});
