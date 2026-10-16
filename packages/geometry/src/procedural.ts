// @forgeax/engine-geometry - reusable contour, sweep, and revolution meshes.
//
// These factories stay pure and use meshFromInterleaved as the one MeshAsset
// validation/tangent/AABB path. Invalid authored data fails before a browser or
// renderer is involved.

import type { AssetError, MeshAsset, Result } from '@forgeax/engine-types';
import { err } from '@forgeax/engine-types';
import { FACTORY_FLOATS_PER_VERTEX, meshFromInterleaved } from './box';
import { geometryError } from './contour';

export interface Vec2Point {
  readonly x: number;
  readonly y: number;
}

export type Vec3Point = readonly [number, number, number];

function invalid(field: string, detail: string): Result<MeshAsset, AssetError> {
  return err(geometryError(field, detail));
}

function finitePoint(point: Vec2Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function pushVertex(
  vertices: number[],
  position: readonly [number, number, number],
  normal: readonly [number, number, number],
  uv: readonly [number, number],
): number {
  const index = vertices.length / FACTORY_FLOATS_PER_VERTEX;
  vertices.push(
    position[0],
    position[1],
    position[2],
    normal[0],
    normal[1],
    normal[2],
    uv[0],
    uv[1],
  );
  return index;
}

/** Sweep a circular profile along a 3D path. */
export function createSweepGeometry(
  path: readonly Vec3Point[],
  radius: number,
  radialSegments = 12,
): Result<MeshAsset, AssetError> {
  if (!Number.isFinite(radius) || radius <= 0)
    return invalid('radius', 'must be positive and finite');
  const segments = radialSegments | 0;
  if (
    path.length < 2 ||
    path.some((point) => point.length !== 3 || point.some((value) => !Number.isFinite(value)))
  )
    return invalid('path', 'needs at least two finite 3D points');
  if (segments < 3) return invalid('radialSegments', 'must be at least 3');
  // A repeated path point makes the local tangent undefined. A repeated first
  // and last point is the explicit closed-path form used by authored railings;
  // retain that seam while rejecting every other repeat before mesh creation.
  const first = path[0] as Vec3Point;
  const last = path[path.length - 1] as Vec3Point;
  const closed =
    path.length > 3 &&
    Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]) <= 1e-8;
  for (let left = 0; left < path.length; left++) {
    const a = path[left] as Vec3Point;
    for (let right = left + 1; right < path.length; right++) {
      const b = path[right] as Vec3Point;
      if (closed && left === 0 && right === path.length - 1) continue;
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= 1e-8) {
        return invalid('path', 'must not contain repeated points');
      }
    }
  }
  const lengths = [0];
  for (let i = 1; i < path.length; i++) {
    const previous = path[i - 1] as Vec3Point;
    const current = path[i] as Vec3Point;
    lengths.push(
      (lengths[i - 1] as number) +
        Math.hypot(current[0] - previous[0], current[1] - previous[1], current[2] - previous[2]),
    );
  }
  const total = lengths[lengths.length - 1] as number;
  if (!(total > 0)) return invalid('path', 'must contain distinct points');
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row < path.length; row++) {
    const point = path[row] as Vec3Point;
    const previous = path[Math.max(0, row - 1)] as Vec3Point;
    const next = path[Math.min(path.length - 1, row + 1)] as Vec3Point;
    let tx = next[0] - previous[0];
    let ty = next[1] - previous[1];
    let tz = next[2] - previous[2];
    const tangentLength = Math.hypot(tx, ty, tz) || 1;
    tx /= tangentLength;
    ty /= tangentLength;
    tz /= tangentLength;
    const reference: Vec3Point = Math.abs(ty) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    let nx = ty * reference[2] - tz * reference[1];
    let ny = tz * reference[0] - tx * reference[2];
    let nz = tx * reference[1] - ty * reference[0];
    const nLength = Math.hypot(nx, ny, nz) || 1;
    nx /= nLength;
    ny /= nLength;
    nz /= nLength;
    const bx = ty * nz - tz * ny;
    const by = tz * nx - tx * nz;
    const bz = tx * ny - ty * nx;
    for (let column = 0; column <= segments; column++) {
      const angle = (column / segments) * Math.PI * 2;
      const radialX = Math.cos(angle) * nx + Math.sin(angle) * bx;
      const radialY = Math.cos(angle) * ny + Math.sin(angle) * by;
      const radialZ = Math.cos(angle) * nz + Math.sin(angle) * bz;
      pushVertex(
        vertices,
        [point[0] + radialX * radius, point[1] + radialY * radius, point[2] + radialZ * radius],
        [radialX, radialY, radialZ],
        [column / segments, (lengths[row] as number) / total],
      );
    }
  }
  const stride = segments + 1;
  const position = (index: number): Vec3Point => [
    vertices[index * 8] as number,
    vertices[index * 8 + 1] as number,
    vertices[index * 8 + 2] as number,
  ];
  for (let row = 0; row < path.length - 1; row++) {
    for (let column = 0; column < segments; column++) {
      const a = row * stride + column;
      const b = a + 1;
      const c = (row + 1) * stride + column + 1;
      const d = (row + 1) * stride + column;
      const p = position(a);
      const q = position(b);
      const r = position(c);
      const ab: Vec3Point = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const ac: Vec3Point = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      const normal: Vec3Point = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      const center = path[row] as Vec3Point;
      const outward: Vec3Point = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
      const dot = normal[0] * outward[0] + normal[1] * outward[1] + normal[2] * outward[2];
      if (dot > 0) indices.push(a, b, c, a, c, d);
      else indices.push(a, c, b, a, d, c);
    }
  }
  return meshFromInterleaved(new Float32Array(vertices), new Uint32Array(indices));
}

/** Revolve a (radius, height) profile around the Y axis. */
export function createRevolutionGeometry(
  profile: readonly Vec2Point[],
  radialSegments = 24,
): Result<MeshAsset, AssetError> {
  const segments = radialSegments | 0;
  if (profile.length < 2 || profile.some((point) => !finitePoint(point) || point.x < 0))
    return invalid('profile', 'needs at least two finite points with non-negative radius');
  if (segments < 3) return invalid('radialSegments', 'must be at least 3');
  const first = profile[0];
  if (first === undefined || !profile.some((point) => point.y !== first.y))
    return invalid('profile', 'must span a non-zero height');
  // A repeated profile point creates a zero-area ring strip.  Letting that
  // reach MeshAsset validation produces a seemingly valid mesh with collapsed
  // triangles, so reject the authored degeneracy at the geometry boundary.
  for (let left = 0; left < profile.length; left++) {
    const a = profile[left] as Vec2Point;
    for (let right = left + 1; right < profile.length; right++) {
      const b = profile[right] as Vec2Point;
      if (Math.hypot(a.x - b.x, a.y - b.y) <= 1e-8) {
        return invalid('profile', 'must not contain repeated points');
      }
    }
  }
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row < profile.length; row++) {
    const point = profile[row] as Vec2Point;
    const previous = profile[Math.max(0, row - 1)] as Vec2Point;
    const next = profile[Math.min(profile.length - 1, row + 1)] as Vec2Point;
    const dr = next.x - previous.x;
    const dy = next.y - previous.y;
    const normalLength = Math.hypot(dy, dr) || 1;
    for (let column = 0; column <= segments; column++) {
      const u = column / segments;
      const angle = u * Math.PI * 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      pushVertex(
        vertices,
        [point.x * c, point.y, point.x * s],
        [(c * dy) / normalLength, -dr / normalLength, (s * dy) / normalLength],
        [u, row / (profile.length - 1)],
      );
    }
  }
  const stride = segments + 1;
  for (let row = 0; row < profile.length - 1; row++) {
    for (let column = 0; column < segments; column++) {
      const a = row * stride + column;
      const b = a + 1;
      const c = (row + 1) * stride + column + 1;
      const d = (row + 1) * stride + column;
      indices.push(a, d, b, b, d, c);
    }
  }
  return meshFromInterleaved(new Float32Array(vertices), new Uint32Array(indices));
}
