import { type AssetError, err, type MeshAsset, type Result } from '@forgeax/engine-types';
import { geometryError, type PolygonShape, preparePolygon } from './contour';
import { cross3, polygonMesh, unit3 } from './polygon-mesh';
import type { Vec3Point } from './procedural';

export interface ProfileSweepOptions {
  readonly capped?: boolean;
  /** Duplicate endpoint is required for a closed path; caps are then omitted. */
  readonly closed?: boolean;
  /** Initial cross-section X axis, projected perpendicular to the path tangent. */
  readonly up?: Vec3Point;
}
const dot = (a: Vec3Point, b: Vec3Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const difference = (a: Vec3Point, b: Vec3Point): Vec3Point => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
function rotate(p: Vec3Point, axis: Vec3Point, angle: number): Vec3Point {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    cross = cross3(axis, p),
    d = dot(axis, p) * (1 - c);
  return [
    p[0] * c + cross[0] * s + axis[0] * d,
    p[1] * c + cross[1] * s + axis[1] * d,
    p[2] * c + cross[2] * s + axis[2] * d,
  ];
}
/** Minimal-rotation transport, with distributed closure twist for a repeated endpoint. */
export function createProfileSweepGeometry(
  shape: PolygonShape,
  path: readonly Vec3Point[],
  options: ProfileSweepOptions = {},
): Result<MeshAsset, AssetError> {
  const prepared = preparePolygon(shape);
  if (!prepared.ok) return prepared;
  if (
    path.length < 2 ||
    path.length > 4096 ||
    path.some((p) => p.length !== 3 || p.some((v) => !Number.isFinite(v)))
  )
    return err(geometryError('path', 'needs 2..4096 finite 3D points'));
  if (prepared.value.flat().length * path.length > 262144)
    return err(geometryError('mesh', 'at most 262144 ring vertices'));
  const closed = options.closed ?? false;
  if (
    closed &&
    (path.length < 4 ||
      Math.hypot(...difference(path[0] as Vec3Point, path.at(-1) as Vec3Point)) !== 0)
  )
    return err(
      geometryError(
        'path',
        'closed paths require a repeated endpoint and at least three distinct points',
      ),
    );
  const directions: Vec3Point[] = [],
    lengths = [0];
  for (let i = 1; i < path.length; i++) {
    const delta = difference(path[i] as Vec3Point, path[i - 1] as Vec3Point),
      length = Math.hypot(...delta);
    if (!(length > 0)) return err(geometryError('path', 'consecutive points must be distinct'));
    directions.push(unit3(delta));
    lengths.push((lengths[i - 1] as number) + length);
  }
  const tangents: Vec3Point[] = [];
  for (let i = 0; i < path.length; i++) {
    const previous = i === 0 ? (closed ? directions.at(-1) : directions[0]) : directions[i - 1];
    const next =
      i === path.length - 1 ? (closed ? directions[0] : directions.at(-1)) : directions[i];
    const a = previous as Vec3Point,
      b = next as Vec3Point;
    if (dot(a, b) < -0.999999)
      return err(geometryError('path', 'a reversal has no unique sweep frame'));
    tangents.push(unit3([a[0] + b[0], a[1] + b[1], a[2] + b[2]]));
  }
  const tangent = tangents[0] as Vec3Point;
  const reference = options.up ?? (Math.abs(tangent[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
  if (reference.length !== 3 || reference.some((v) => !Number.isFinite(v)))
    return err(geometryError('up', 'must be finite'));
  const projection = dot(reference, tangent);
  const initial: Vec3Point = [
    reference[0] - projection * tangent[0],
    reference[1] - projection * tangent[1],
    reference[2] - projection * tangent[2],
  ];
  if (Math.hypot(...initial) < 1e-8)
    return err(geometryError('up', 'must not be parallel to initial tangent'));
  const axes: Vec3Point[] = [unit3(initial)];
  for (let i = 1; i < tangents.length; i++) {
    const a = tangents[i - 1] as Vec3Point,
      b = tangents[i] as Vec3Point,
      axis = cross3(a, b),
      s = Math.hypot(...axis),
      c = dot(a, b);
    if (c < -0.999999) return err(geometryError('path', 'adjacent frames must not reverse'));
    axes.push(
      s < 1e-10
        ? (axes[i - 1] as Vec3Point)
        : rotate(axes[i - 1] as Vec3Point, unit3(axis), Math.atan2(s, c)),
    );
  }
  if (closed) {
    const first = axes[0] as Vec3Point,
      last = axes.at(-1) as Vec3Point;
    const twist = Math.atan2(dot(tangent, cross3(last, first)), dot(last, first));
    for (let i = 1; i < axes.length; i++)
      axes[i] = rotate(
        axes[i] as Vec3Point,
        tangents[i] as Vec3Point,
        (twist * (lengths[i] as number)) / (lengths.at(-1) as number),
      );
    axes[axes.length - 1] = first;
  }
  const section = prepared.value;
  return polygonMesh(
    path.map((p, i) => {
      const x = axes[i] as Vec3Point,
        y = cross3(tangents[i] as Vec3Point, x);
      return {
        section,
        v: (lengths[i] as number) / (lengths.at(-1) as number),
        points: section
          .flat()
          .map(
            (q): Vec3Point => [
              p[0] + x[0] * q.x + y[0] * q.y,
              p[1] + x[1] * q.x + y[1] * q.y,
              p[2] + x[2] * q.x + y[2] * q.y,
            ],
          ),
      };
    }),
    !closed && (options.capped ?? true),
  );
}
