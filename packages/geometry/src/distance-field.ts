import { err, ok, type Result } from '@forgeax/engine-types';
import { brickDistanceFieldValues, distanceFieldTexel } from './distance-field-bricks';
import { createTriangleQuery } from './triangle-query';

export type {
  DistanceFieldPolicy,
  FieldBounds,
  FieldVec3,
  MeshDistanceField,
} from '@forgeax/engine-types';

import type { DistanceFieldPolicy, FieldVec3, MeshDistanceField } from '@forgeax/engine-types';
export const MAX_VISIBILITY_DISTANCE_FIELD_AXIS = 514;
/** Advance when the builder policy changes, independently of artifact encoding. */
export const MESH_DISTANCE_FIELD_GENERATION_VERSION = 5;
export type GeometricDistanceField = MeshDistanceField & {
  readonly policy: Extract<DistanceFieldPolicy, { readonly errorBound: number }>;
};
export interface DistanceFieldError {
  readonly code: 'distance-field-invalid' | 'distance-field-unsupported' | 'distance-field-limit';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly reason: string };
}
export function distanceFieldFailure(
  reason: string,
  code: DistanceFieldError['code'] = 'distance-field-invalid',
): Result<never, DistanceFieldError> {
  return err({
    code,
    expected:
      'bounded resolved geometry with an explicit distance-bound or sampled-visibility policy',
    hint:
      code === 'distance-field-limit'
        ? 'Inspect the declared bounds; reduce resolution or geometry workload on preparation-budget exhaustion, then rebuild.'
        : 'Inspect topology and voxel coverage; repair the mesh or increase resolution before rebuilding.',
    detail: { reason },
  });
}
const sub = (a: FieldVec3, b: FieldVec3): FieldVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: FieldVec3, b: FieldVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: FieldVec3, b: FieldVec3): FieldVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: FieldVec3) => Math.hypot(...a);
/** Canonical derived-data identity; source validation belongs to buildMeshDistanceField. */
export async function distanceFieldMeshDigest(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): Promise<string> {
  const bytes = new Uint8Array(8 + (positions.length + indices.length) * 4),
    v = new DataView(bytes.buffer);
  v.setUint32(0, positions.length, true);
  v.setUint32(4, indices.length, true);
  for (let i = 0; i < positions.length; i++) v.setFloat32(8 + i * 4, positions[i] ?? NaN, true);
  for (let i = 0; i < indices.length; i++)
    v.setUint32(8 + (positions.length + i) * 4, indices[i] ?? 0xffffffff, true);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Explicit preparation work. Never invoked by Renderer or on an ordinary frame path. */
export async function buildMeshDistanceField(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  options: { readonly resolution?: number; readonly twoSided?: boolean } = {},
): Promise<Result<GeometricDistanceField, DistanceFieldError>> {
  const { resolution = 24, twoSided = false } = options;
  if (typeof twoSided !== 'boolean') return distanceFieldFailure('twoSided must be boolean');
  if (!Number.isInteger(resolution) || resolution < 8 || resolution > 64)
    return distanceFieldFailure('resolution must be an integer in 8..64', 'distance-field-limit');
  if (
    positions.length < (twoSided ? 9 : 12) ||
    positions.length % 3 !== 0 ||
    indices.length < (twoSided ? 3 : 12) ||
    indices.length % 3 !== 0
  )
    return distanceFieldFailure(
      'expected indexed xyz triangles, enclosing a volume for signed fields',
    );
  if (positions.length > 3_145_728 || indices.length > (twoSided ? 196608 : 3072))
    return distanceFieldFailure(
      'at most 1048576 source vertices; 1024 signed or 65536 two-sided triangles',
      'distance-field-limit',
    );
  const points: FieldVec3[] = [],
    welded: number[] = [],
    weld = new Map<string, number>();
  for (let i = 0; i < positions.length; i += 3) {
    const p: FieldVec3 = [
      Math.fround(positions[i] ?? NaN),
      Math.fround(positions[i + 1] ?? NaN),
      Math.fround(positions[i + 2] ?? NaN),
    ];
    if (!p.every(Number.isFinite)) return distanceFieldFailure('positions must be finite f32');
    const key = p.join(',');
    let id = weld.get(key);
    if (id === undefined) {
      id = weld.size;
      weld.set(key, id);
    }
    points.push(p);
    welded.push(id);
  }
  const triangles: [FieldVec3, FieldVec3, FieldVec3][] = [],
    edges = new Map<string, { count: number; balance: number }>();
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i] ?? -1, indices[i + 1] ?? -1, indices[i + 2] ?? -1];
    if (ids.some((v) => !Number.isInteger(v) || v < 0 || v >= points.length))
      return distanceFieldFailure('index outside source vertices');
    const a = item(points, item(ids, 0)),
      b = item(points, item(ids, 1)),
      c = item(points, item(ids, 2));
    if (length(cross(sub(b, a), sub(c, a))) === 0)
      return distanceFieldFailure('degenerate triangle');
    triangles.push([a, b, c]);
    for (let e = 0; !twoSided && e < 3; e++) {
      const x = item(welded, item(ids, e)),
        y = item(welded, item(ids, (e + 1) % 3)),
        key = `${Math.min(x, y)}:${Math.max(x, y)}`;
      const edge = edges.get(key) ?? { count: 0, balance: 0 };
      edge.count++;
      edge.balance += x < y ? 1 : -1;
      edges.set(key, edge);
    }
  }
  if (!twoSided && [...edges.values()].some((e) => e.count !== 2 || e.balance !== 0))
    return distanceFieldFailure(
      'open, non-manifold or inconsistently wound edges',
      'distance-field-unsupported',
    );
  const anchor = triangles[0]?.[0] ?? [0, 0, 0];
  const volume6 = triangles.reduce(
    (sum, [a, b, c]) => sum + dot(sub(a, anchor), cross(sub(b, anchor), sub(c, anchor))),
    0,
  );
  if (!twoSided && volume6 <= 0)
    return distanceFieldFailure(
      'closed mesh must be outward wound with positive volume',
      'distance-field-unsupported',
    );
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const [a, b, c] of triangles)
    for (const p of [a, b, c])
      for (const axis of [0, 1, 2] as const) {
        min[axis] = Math.min(min[axis], p[axis]);
        max[axis] = Math.max(max[axis], p[axis]);
      }
  const spacing = Math.fround(Math.max(...max.map((v, i) => v - item(min, i))) / resolution);
  if (!Number.isFinite(spacing) || spacing <= 0)
    return distanceFieldFailure('invalid field extent');
  const origin = min.map((v) => Math.fround(v - spacing)) as [number, number, number];
  const dimensions = max.map((v, i) => Math.ceil((v - item(min, i)) / spacing) + 3) as [
    number,
    number,
    number,
  ];
  const count = dimensions[0] * dimensions[1] * dimensions[2];
  if (!twoSided && count * triangles.length > 32_000_000)
    return distanceFieldFailure(
      'voxel/triangle preparation budget exceeded',
      'distance-field-limit',
    );
  const query = createTriangleQuery(triangles);
  // A bounded allowance per sample caps all closest-point primitive evaluations at 32M.
  const queryBudget = Math.floor(32_000_000 / count);
  const values = new Float32Array(count);
  let interiorSamples = 0,
    rounding = 0;
  const surfaceEpsilon = Math.max(
    spacing * 1e-7,
    Math.max(...min.map(Math.abs), ...max.map(Math.abs)) * 1e-7,
  );
  for (let z = 0; z < dimensions[2]; z++)
    for (let y = 0; y < dimensions[1]; y++)
      for (let x = 0; x < dimensions[0]; x++) {
        const p: FieldVec3 = [
          origin[0] + x * spacing,
          origin[1] + y * spacing,
          origin[2] + z * spacing,
        ];
        const distanceSquared = query.nearestSquared(p, Infinity, { remaining: queryBudget });
        if (distanceSquared === null)
          return distanceFieldFailure(
            'closest-point preparation budget exhausted',
            'distance-field-limit',
          );
        const nearest = Math.sqrt(distanceSquared);
        let angle = 0;
        if (!twoSided)
          for (const [a, b, c] of triangles) {
            const u = sub(a, p),
              v = sub(b, p),
              w = sub(c, p),
              lu = length(u),
              lv = length(v),
              lw = length(w);
            angle +=
              2 *
              Math.atan2(
                dot(u, cross(v, w)),
                lu * lv * lw + dot(u, v) * lw + dot(v, w) * lu + dot(w, u) * lv,
              );
          }
        const winding = Math.abs(angle) / (4 * Math.PI);
        if (nearest > surfaceEpsilon && (winding > 1.01 || (winding > 0.01 && winding < 0.99)))
          return distanceFieldFailure(
            'ambiguous sampled winding; intersecting or nested shells are not qualified',
            'distance-field-unsupported',
          );
        const signed = nearest <= surfaceEpsilon ? 0 : nearest * (winding > 0.5 ? -1 : 1),
          sample = Math.fround(signed);
        values[(z * dimensions[1] + y) * dimensions[0] + x] = sample;
        rounding = Math.max(rounding, Math.abs(signed - sample));
        if (sample < 0) interiorSamples++;
      }
  if (!twoSided && interiorSamples === 0)
    return distanceFieldFailure(
      'thin solid has no interior voxel support',
      'distance-field-unsupported',
    );
  // Bounded surface coverage diagnostic. It is not a proof about every sub-voxel feature.
  if (!twoSided)
    for (const [a, b, c] of triangles) {
      const center: FieldVec3 = [
        (a[0] + b[0] + c[0]) / 3,
        (a[1] + b[1] + c[1]) / 3,
        (a[2] + b[2] + c[2]) / 3,
      ];
      const cell = center.map((v, i) => Math.floor((v - item(origin, i)) / spacing));
      let supported = false;
      for (let dz = -2; dz <= 2; dz++)
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const x = item(cell, 0) + dx,
              y = item(cell, 1) + dy,
              z = item(cell, 2) + dz;
            if (
              x >= 0 &&
              y >= 0 &&
              z >= 0 &&
              x < dimensions[0] &&
              y < dimensions[1] &&
              z < dimensions[2] &&
              item(values, (z * dimensions[1] + y) * dimensions[0] + x) < 0
            )
              supported = true;
          }
      if (!supported)
        return distanceFieldFailure(
          'triangle centroid has no nearby interior voxel support',
          'distance-field-unsupported',
        );
    }
  const errorBound = Math.fround(
    (Math.sqrt(3) * spacing) / 2 + rounding + surfaceEpsilon * 4 + spacing * 1e-5,
  );
  const storage = brickDistanceFieldValues(dimensions, values);
  if (!storage)
    return distanceFieldFailure('distance-field storage exceeds 32 MiB', 'distance-field-limit');
  return ok({
    meshDigest: await distanceFieldMeshDigest(positions, indices),
    policy: { kind: twoSided ? 'two-sided' : 'signed-solid', errorBound },
    dimensions,
    origin,
    spacing,
    ...storage,
    bounds: { min, max },
    quality: { negativeSamples: interiorSamples, testedTriangles: triangles.length },
  });
}

/** Trilinear local-space distance under the published sign policy; null means outside the volume. */
export function sampleMeshDistanceField(field: MeshDistanceField, p: FieldVec3): number | null {
  const q = p.map((v, i) => (v - item(field.origin, i)) / field.spacing);
  if (q.some((v, i) => !Number.isFinite(v) || v < 0 || v > item(field.dimensions, i) - 1))
    return null;
  const cell = q.map((v, i) => Math.min(Math.floor(v), item(field.dimensions, i) - 2));
  let result = 0;
  for (let z = 0; z < 2; z++)
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        const w =
          (x ? item(q, 0) - item(cell, 0) : 1 - (item(q, 0) - item(cell, 0))) *
          (y ? item(q, 1) - item(cell, 1) : 1 - (item(q, 1) - item(cell, 1))) *
          (z ? item(q, 2) - item(cell, 2) : 1 - (item(q, 2) - item(cell, 2)));
        result +=
          distanceFieldTexel(field, item(cell, 0) + x, item(cell, 1) + y, item(cell, 2) + z) * w;
      }
  return result;
}

function item<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined)
    throw new RangeError(`distance field index ${index} outside validated span`);
  return value;
}
