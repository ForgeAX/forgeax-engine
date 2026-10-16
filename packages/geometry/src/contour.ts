import { ASSET_ERROR_HINTS, AssetError, err, ok, type Result } from '@forgeax/engine-types';
import earcut from 'earcut';
import type { Vec2Point } from './procedural';

export interface PolygonShape {
  readonly contour: readonly Vec2Point[];
  readonly holes?: readonly (readonly Vec2Point[])[];
}

export function geometryError(field: string, reason: string): AssetError {
  return new AssetError({
    code: 'asset-parse-failed',
    expected: `valid procedural ${field}`,
    hint: ASSET_ERROR_HINTS['asset-parse-failed'],
    detail: { field, value: reason, reason },
  });
}
export function area(points: readonly Vec2Point[]): number {
  return (
    points.reduce((sum, a, i) => {
      const b = points[(i + 1) % points.length] as Vec2Point;
      return sum + a.x * b.y - b.x * a.y;
    }, 0) / 2
  );
}
const cross = (a: Vec2Point, b: Vec2Point, c: Vec2Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function on(a: Vec2Point, b: Vec2Point, p: Vec2Point): boolean {
  return (
    cross(a, b, p) === 0 &&
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y)
  );
}
function intersects(a: Vec2Point, b: Vec2Point, c: Vec2Point, d: Vec2Point): boolean {
  if (
    Math.max(a.x, b.x) < Math.min(c.x, d.x) ||
    Math.max(c.x, d.x) < Math.min(a.x, b.x) ||
    Math.max(a.y, b.y) < Math.min(c.y, d.y) ||
    Math.max(c.y, d.y) < Math.min(a.y, b.y)
  )
    return false;
  return (
    on(a, b, c) ||
    on(a, b, d) ||
    on(c, d, a) ||
    on(c, d, b) ||
    (cross(a, b, c) > 0 !== cross(a, b, d) > 0 && cross(c, d, a) > 0 !== cross(c, d, b) > 0)
  );
}
export function contains(loop: readonly Vec2Point[], p: Vec2Point): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i] as Vec2Point,
      b = loop[j] as Vec2Point;
    if (on(a, b, p)) return false;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}
/** Copy and orient material on the left: outer CCW, holes CW. No input mutation. */
export function preparePolygon(shape: PolygonShape): Result<Vec2Point[][], AssetError> {
  const input = [shape.contour, ...(shape.holes ?? [])];
  if (input.reduce((n, loop) => n + loop.length, 0) > 4096)
    return err(geometryError('contour', 'at most 4096 total contour points'));
  const loops: Vec2Point[][] = [];
  for (const [index, source] of input.entries()) {
    const loop = source.map((p) => ({ x: p.x, y: p.y }));
    if (loop.length > 1 && loop[0]?.x === loop.at(-1)?.x && loop[0]?.y === loop.at(-1)?.y)
      loop.pop();
    if (loop.length < 3 || loop.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
      return err(geometryError('contour', 'needs at least three finite points'));
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as Vec2Point,
        b = loop[(i + 1) % loop.length] as Vec2Point;
      if (a.x === b.x && a.y === b.y)
        return err(geometryError('contour', 'repeated adjacent point'));
    }
    // Earcut drops collinear boundary vertices. Remove them once here so caps
    // and walls retain the same boundary topology; reject backtracking edges.
    for (let i = 0; i < loop.length; i++) {
      const a = loop[(i + loop.length - 1) % loop.length] as Vec2Point;
      const b = loop[i] as Vec2Point,
        c = loop[(i + 1) % loop.length] as Vec2Point;
      if (cross(a, b, c) !== 0) continue;
      if ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) <= 0)
        return err(geometryError('contour', 'boundary edges must not backtrack'));
      if (loop.length > 3) {
        loop.splice(i, 1);
        i = -1;
      }
    }
    if (area(loop) === 0) return err(geometryError('contour', 'area must be non-zero'));
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as Vec2Point,
        b = loop[(i + 1) % loop.length] as Vec2Point;
      for (let j = i + 1; j < loop.length; j++) {
        if (j === i + 1 || (j + 1) % loop.length === i) continue;
        if (intersects(a, b, loop[j] as Vec2Point, loop[(j + 1) % loop.length] as Vec2Point))
          return err(geometryError('contour', 'must not self-intersect'));
      }
    }
    if (area(loop) > 0 !== (index === 0)) loop.reverse();
    loops.push(loop);
  }
  for (let i = 1; i < loops.length; i++) {
    const hole = loops[i] as Vec2Point[];
    if (!contains(loops[0] as Vec2Point[], hole[0] as Vec2Point))
      return err(geometryError('holes', 'holes must lie strictly inside contour'));
    for (let j = 0; j < i; j++) {
      const other = loops[j] as Vec2Point[];
      if (j > 0 && (contains(other, hole[0] as Vec2Point) || contains(hole, other[0] as Vec2Point)))
        return err(geometryError('holes', 'nested holes are not a material domain'));
      for (let a = 0; a < hole.length; a++)
        for (let b = 0; b < other.length; b++)
          if (
            intersects(
              hole[a] as Vec2Point,
              hole[(a + 1) % hole.length] as Vec2Point,
              other[b] as Vec2Point,
              other[(b + 1) % other.length] as Vec2Point,
            )
          )
            return err(geometryError('holes', 'boundaries must not touch or intersect'));
    }
  }
  return ok(loops);
}
export function triangulatePolygon(
  loops: readonly (readonly Vec2Point[])[],
): Result<number[], AssetError> {
  const flat: number[] = [],
    holes: number[] = [];
  for (const [index, loop] of loops.entries()) {
    if (index > 0) holes.push(flat.length / 2);
    for (const p of loop) flat.push(p.x, p.y);
  }
  const triangles = earcut(flat, holes, 2);
  const expected = loops.reduce((sum, loop) => sum + area(loop), 0);
  let actual = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = (triangles[i] as number) * 2,
      b = (triangles[i + 1] as number) * 2,
      c = (triangles[i + 2] as number) * 2;
    actual +=
      (((flat[b] as number) - (flat[a] as number)) *
        ((flat[c + 1] as number) - (flat[a + 1] as number))) /
        2 -
      (((flat[b + 1] as number) - (flat[a + 1] as number)) *
        ((flat[c] as number) - (flat[a] as number))) /
        2;
  }
  if (!(expected > 0) || !Number.isFinite(actual) || Math.abs(actual - expected) > expected * 1e-8)
    return err(geometryError('contour', 'triangulation must cover the complete material domain'));
  return ok(triangles);
}

/** Inset offset-line intersections. Refuse topology changes rather than clipping silently. */
export function insetPolygon(
  loops: Vec2Point[][],
  distance: number,
): Result<Vec2Point[][], AssetError> {
  const offset = loops.map((loop) =>
    loop.map((p, i) => {
      const a = loop[(i + loop.length - 1) % loop.length] as Vec2Point;
      const b = loop[(i + 1) % loop.length] as Vec2Point;
      const la = Math.hypot(p.x - a.x, p.y - a.y),
        lb = Math.hypot(b.x - p.x, b.y - p.y);
      const nx = -(p.y - a.y) / la,
        ny = (p.x - a.x) / la;
      const mx = -(b.y - p.y) / lb,
        my = (b.x - p.x) / lb;
      const denominator = 1 + nx * mx + ny * my;
      return {
        x: p.x + (distance * (nx + mx)) / denominator,
        y: p.y + (distance * (ny + my)) / denominator,
      };
    }),
  );
  for (let l = 0; l < loops.length; l++) {
    const old = loops[l] as Vec2Point[],
      next = offset[l] as Vec2Point[];
    for (let i = 0; i < old.length; i++) {
      const a = old[i] as Vec2Point,
        b = old[(i + 1) % old.length] as Vec2Point;
      const c = next[i] as Vec2Point,
        d = next[(i + 1) % old.length] as Vec2Point;
      if ((b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y) <= 0)
        return err(geometryError('bevel', 'offset collapses a contour edge'));
    }
  }
  const prepared = preparePolygon({ contour: offset[0] as Vec2Point[], holes: offset.slice(1) });
  if (!prepared.ok) return prepared;
  if (prepared.value.some((loop, i) => loop.length !== loops[i]?.length))
    return err(geometryError('bevel', 'offset changes contour topology'));
  return prepared;
}
