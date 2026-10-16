import { ok, type Result } from '@forgeax/engine-types';
import {
  type DistanceFieldError,
  distanceFieldFailure,
  distanceFieldMeshDigest,
  type FieldVec3,
  MAX_VISIBILITY_DISTANCE_FIELD_AXIS,
  type MeshDistanceField,
} from './distance-field';
import { FieldBrickBuilder, fieldBrickLane, fieldBrickStart } from './distance-field-bricks';
import { createTriangleQuery, type QueryTriangle } from './triangle-query';

/** Fixed stratification; independent deterministic RNG, not an Embree/UE byte reproduction. */
function signDirections(): FieldVec3[] {
  let seed = 0x6d2b79f5;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const directions: FieldVec3[] = [];
  for (const side of [1, -1])
    for (let x = 0; x < 7; x++)
      for (let y = 0; y < 7; y++) {
        const a = (2 * (x + random())) / 7 - 1;
        const b = (2 * (y + random())) / 7 - 1;
        const r = Math.abs(a) > Math.abs(b) ? a : b;
        const theta =
          Math.abs(a) > Math.abs(b)
            ? (Math.PI * b) / (4 * a)
            : Math.PI / 2 - (Math.PI * a) / (4 * b);
        const scale = r * Math.sqrt(2 - r * r);
        directions.push([scale * Math.cos(theta), scale * Math.sin(theta), side * (1 - r * r)]);
      }
  return directions;
}
const DIRECTIONS = signDirections();

/**
 * Build-time approximate scene visibility. No watertightness or signed-distance
 * guarantee; the explicit voxel size is in source mesh units. Sidedness is per
 * triangle, not per material identity, and does not supply alpha coverage.
 */
export async function buildVisibilityDistanceField(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  options: { readonly voxelSize: number; readonly triangleSidedness: ArrayLike<number> },
): Promise<Result<MeshDistanceField, DistanceFieldError>> {
  const spacing = Math.fround(options.voxelSize);
  if (!Number.isFinite(spacing) || spacing <= 0)
    return distanceFieldFailure('visibility voxel size must be positive finite f32');
  if (positions.length < 9 || positions.length % 3 || indices.length < 3 || indices.length % 3)
    return distanceFieldFailure('visibility fields require indexed xyz triangles');
  if (positions.length > 3_145_728 || indices.length > 3_145_728)
    return distanceFieldFailure(
      'visibility fields allow at most 1048576 vertices and triangles',
      'distance-field-limit',
    );
  if (options.triangleSidedness.length !== indices.length / 3)
    return distanceFieldFailure('visibility sidedness must cover every triangle');
  const points: FieldVec3[] = [];
  const canonical = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const p: FieldVec3 = [
      Math.fround(positions[i] ?? NaN),
      Math.fround(positions[i + 1] ?? NaN),
      Math.fround(positions[i + 2] ?? NaN),
    ];
    if (!p.every(Number.isFinite))
      return distanceFieldFailure('visibility positions must be finite f32');
    canonical.set(p, i);
    points.push(p);
  }
  const topology = new Uint32Array(indices.length);
  const flags = new Uint8Array(indices.length / 3);
  const activeFlags: number[] = [];
  const triangles: QueryTriangle[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let twoSided = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i] ?? -1, indices[i + 1] ?? -1, indices[i + 2] ?? -1];
    if (ids.some((v) => !Number.isInteger(v) || v < 0 || v >= points.length))
      return distanceFieldFailure('visibility index outside source vertices');
    const a = points[ids[0] ?? -1],
      b = points[ids[1] ?? -1],
      c = points[ids[2] ?? -1];
    if (!a || !b || !c) return distanceFieldFailure('missing visibility triangle');
    const flag = options.triangleSidedness[i / 3];
    if (flag !== 0 && flag !== 1) return distanceFieldFailure('triangle sidedness must be 0 or 1');
    flags[i / 3] = flag;
    twoSided += flag;
    topology.set(ids, i);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
    if (
      Math.hypot(
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      ) === 0
    )
      continue;
    activeFlags.push(flag);
    triangles.push([a, b, c]);
    for (const p of [a, b, c])
      for (const axis of [0, 1, 2] as const) {
        min[axis] = Math.min(min[axis], p[axis]);
        max[axis] = Math.max(max[axis], p[axis]);
      }
  }
  if (!triangles.length)
    return distanceFieldFailure('visibility geometry has no nondegenerate triangles');
  const mostlyTwoSided = twoSided * 4 >= flags.length;
  const allTwoSided = activeFlags.every((v) => v === 1);
  // Positive plane volume, optional two-sided pullback room, then a distinct
  // stored gradient border. Brick storage retains this isotropic sample lattice.
  const lo: [number, number, number] = [0, 0, 0],
    hi: [number, number, number] = [0, 0, 0];
  for (const a of [0, 1, 2] as const) {
    const center = (min[a] + max[a]) / 2;
    const extent = Math.max((max[a] - min[a]) / 2, spacing / 2) + (mostlyTwoSided ? spacing : 0);
    lo[a] = Math.fround(center - extent);
    hi[a] = Math.fround(center + extent);
  }
  const origin = lo.map((v) => Math.fround(v - spacing)) as [number, number, number];
  for (const a of [0, 1, 2] as const) {
    // Undoing the border subtraction can round inward. Move the stored
    // origin one f32 value outward before deriving the GPU trace boundary.
    if (Math.fround(origin[a] + spacing) > lo[a]) {
      if (origin[a] === 0) origin[a] = -(2 ** -149);
      else {
        const value = new Float32Array([origin[a]]),
          bits = new Uint32Array(value.buffer);
        bits[0] = (bits[0] ?? 0) + (origin[a] > 0 ? -1 : 1);
        origin[a] = value[0] ?? NaN;
      }
    }
    lo[a] = Math.fround(origin[a] + spacing);
    if (lo[a] > min[a])
      return distanceFieldFailure(
        'visibility trace bounds lost source coverage to coordinate precision',
      );
  }
  const dimensions = hi.map((v, a) => Math.ceil((v - (lo[a] ?? 0)) / spacing) + 3) as [
    number,
    number,
    number,
  ];
  if (
    dimensions.some((n) => !Number.isInteger(n) || n < 3 || n > MAX_VISIBILITY_DISTANCE_FIELD_AXIS)
  )
    return distanceFieldFailure(
      `visibility field exceeds ${MAX_VISIBILITY_DISTANCE_FIELD_AXIS} samples per axis; choose voxel size or repair representation granularity`,
      'distance-field-limit',
    );
  for (const axis of [0, 1, 2] as const) {
    let previous = -Infinity;
    for (let i = 0; i < dimensions[axis]; i++) {
      const p = Math.fround(origin[axis] + Math.fround(i * spacing));
      if (!Number.isFinite(p) || p <= previous)
        return distanceFieldFailure('visibility samples must have distinct finite f32 centers');
      previous = p;
    }
    if (lo[axis] - origin[axis] < spacing * 0.99 || previous - hi[axis] < spacing * 0.99)
      return distanceFieldFailure('visibility gradient border was lost to coordinate precision');
  }
  const distanceBand = Math.fround(4 * Math.sqrt(3) * spacing);
  if (!Number.isFinite(distanceBand))
    return distanceFieldFailure('visibility distance band overflow');
  const query = createTriangleQuery(triangles);
  const nearestBudget = { remaining: 134_217_728 };
  const rayBudget = { remaining: 1_073_741_824 };
  const storage = new FieldBrickBuilder(dimensions),
    brick = new Float32Array(64);
  const hit = { primitive: -1, distance: 0, frontFace: false };
  let negativeSamples = 0;
  for (let index = 0; index < storage.bricks.length; index++) {
    const start = fieldBrickStart(dimensions, index);
    const lower = start.map((v, a) => Math.fround((origin[a] ?? 0) + Math.fround(v * spacing)));
    const upper = start.map((v, a) =>
      Math.fround(
        (origin[a] ?? 0) + Math.fround(Math.min(v + 3, (dimensions[a] ?? 0) - 1) * spacing),
      ),
    );
    const center = lower.map((v, a) => (v + (upper[a] ?? 0)) / 2) as [number, number, number];
    const radius = Math.hypot(...upper.map((v, a) => (v - (lower[a] ?? 0)) / 2));
    // The unsigned distance is 1-Lipschitz. An outward guard covers coordinate
    // and nearest-query rounding; no sample within the band is discarded.
    const guard =
      distanceBand + radius + Math.max(spacing * 1e-5, ...center.map((v) => Math.abs(v) * 1e-7));
    const nearest = query.nearestSquared(center, guard, nearestBudget);
    if (nearest === null)
      return distanceFieldFailure(
        'visibility brick closest-point budget exhausted',
        'distance-field-limit',
      );
    if (nearest >= guard * guard) brick.fill(distanceBand);
    else
      for (let k = 0; k < 4; k++)
        for (let j = 0; j < 4; j++)
          for (let i = 0; i < 4; i++) {
            const lane = (k * 4 + j) * 4 + i;
            if (fieldBrickLane(dimensions, start, i, j, k) !== lane) continue;
            const x = start[0] + i,
              y = start[1] + j,
              z = start[2] + k;
            const p: FieldVec3 = [
              Math.fround(origin[0] + Math.fround(x * spacing)),
              Math.fround(origin[1] + Math.fround(y * spacing)),
              Math.fround(origin[2] + Math.fround(z * spacing)),
            ];
            const nearest = query.nearestSquared(p, distanceBand, nearestBudget);
            if (nearest === null)
              return distanceFieldFailure(
                'visibility closest-point budget exhausted',
                'distance-field-limit',
              );
            const distance = Math.sqrt(nearest);
            let back = 0;
            let remaining = DIRECTIONS.length;
            // A capped nearest result contains no geometry reachable by a sign ray:
            // its pulled-back start puts the far endpoint strictly inside the band.
            if (!allTwoSided && nearest < distanceBand * distanceBand)
              for (const d of DIRECTIONS) {
                const start: FieldVec3 = [
                  p[0] - 1e-4 * distanceBand * d[0],
                  p[1] - 1e-4 * distanceBand * d[1],
                  p[2] - 1e-4 * distanceBand * d[2],
                ];
                const found = query.trace(hit, start, d, 0, distanceBand, rayBudget);
                if (found === null)
                  return distanceFieldFailure(
                    'visibility sign-ray budget exhausted',
                    'distance-field-limit',
                  );
                if (found && !hit.frontFace && activeFlags[hit.primitive] === 0) back++;
                remaining--;
                // Remaining votes cannot undo a negative decision, or supply enough
                // backfaces for one. Preserve the complete 98-direction predicate.
                if (back > DIRECTIONS.length * 0.25 || back + remaining <= DIRECTIONS.length * 0.25)
                  break;
              }
            const value = Math.fround(
              Math.min(distance, distanceBand) * (back > DIRECTIONS.length * 0.25 ? -1 : 1),
            );
            brick[lane] = value;
            if (value < 0) negativeSamples++;
          }
    if (!storage.store(index, brick))
      return distanceFieldFailure(
        'visibility field storage exceeds 32 MiB',
        'distance-field-limit',
      );
  }
  const meshDigest = await distanceFieldMeshDigest(canonical, topology);
  const sourceDigest = await visibilityDistanceFieldSourceDigest(meshDigest, flags);
  return ok({
    meshDigest,
    bounds: { min, max },
    dimensions,
    origin,
    spacing,
    ...storage.finish(),
    policy: {
      kind: 'sampled-visibility',
      sourceDigest,
      mostlyTwoSided,
      traceBounds: { min: lo, max: hi },
      distanceBand,
    },
    quality: { negativeSamples, testedTriangles: triangles.length },
  });
}

/** Same canonical geometry and sidedness identity at cook and asset admission. */
export async function visibilityDistanceFieldSourceDigest(
  meshDigest: string,
  flags: Uint8Array,
): Promise<string> {
  const sourceBytes = new Uint8Array(64 + flags.length);
  sourceBytes.set(new TextEncoder().encode(meshDigest));
  sourceBytes.set(flags, 64);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', sourceBytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
