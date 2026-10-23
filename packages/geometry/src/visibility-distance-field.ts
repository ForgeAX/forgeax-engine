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

type FieldTriple = [number, number, number];
type FieldFailure = Result<never, DistanceFieldError>;

function visibilityInputFailure(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  spacing: number,
  sidedness: ArrayLike<number>,
): FieldFailure | undefined {
  if (!Number.isFinite(spacing) || spacing <= 0)
    return distanceFieldFailure('visibility voxel size must be positive finite f32');
  if (positions.length < 9 || positions.length % 3 || indices.length < 3 || indices.length % 3)
    return distanceFieldFailure('visibility fields require indexed xyz triangles');
  if (positions.length > 3_145_728 || indices.length > 3_145_728)
    return distanceFieldFailure(
      'visibility fields allow at most 1048576 vertices and triangles',
      'distance-field-limit',
    );
  if (sidedness.length !== indices.length / 3)
    return distanceFieldFailure('visibility sidedness must cover every triangle');
  return undefined;
}

interface CanonicalPoints {
  readonly points: FieldVec3[];
  readonly canonical: Float32Array;
}

function canonicalPoints(
  positions: ArrayLike<number>,
): Result<CanonicalPoints, DistanceFieldError> {
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
  return ok({ points, canonical });
}

interface VisibilityTriangles {
  readonly topology: Uint32Array;
  /** Sidedness of every source triangle, the identity the source digest hashes. */
  readonly flags: Uint8Array;
  /** Sidedness of the nondegenerate triangles the query traces, in query order. */
  readonly activeFlags: number[];
  readonly triangles: QueryTriangle[];
  readonly min: FieldTriple;
  readonly max: FieldTriple;
  readonly twoSidedCount: number;
}

function isDegenerate(a: FieldVec3, b: FieldVec3, c: FieldVec3): boolean {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
  return (
    Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) ===
    0
  );
}

function collectVisibilityTriangles(
  indices: ArrayLike<number>,
  points: readonly FieldVec3[],
  sidedness: ArrayLike<number>,
): Result<VisibilityTriangles, DistanceFieldError> {
  const topology = new Uint32Array(indices.length);
  const flags = new Uint8Array(indices.length / 3);
  const activeFlags: number[] = [];
  const triangles: QueryTriangle[] = [];
  const min: FieldTriple = [Infinity, Infinity, Infinity];
  const max: FieldTriple = [-Infinity, -Infinity, -Infinity];
  let twoSidedCount = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i] ?? -1, indices[i + 1] ?? -1, indices[i + 2] ?? -1];
    if (ids.some((v) => !Number.isInteger(v) || v < 0 || v >= points.length))
      return distanceFieldFailure('visibility index outside source vertices');
    const a = points[ids[0] ?? -1],
      b = points[ids[1] ?? -1],
      c = points[ids[2] ?? -1];
    if (!a || !b || !c) return distanceFieldFailure('missing visibility triangle');
    const flag = sidedness[i / 3];
    if (flag !== 0 && flag !== 1) return distanceFieldFailure('triangle sidedness must be 0 or 1');
    flags[i / 3] = flag;
    twoSidedCount += flag;
    topology.set(ids, i);
    if (isDegenerate(a, b, c)) continue;
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
  return ok({ topology, flags, activeFlags, triangles, min, max, twoSidedCount });
}

/** The adjacent f32 value one step farther from zero (the smallest subnormal below zero for 0). */
function f32Outward(value: number): number {
  if (value === 0) return -(2 ** -149);
  const scratch = new Float32Array([value]),
    bits = new Uint32Array(scratch.buffer);
  bits[0] = (bits[0] ?? 0) + (value > 0 ? -1 : 1);
  return scratch[0] ?? NaN;
}

interface TraceLattice {
  /** Trace bounds: the source volume plus optional two-sided pullback room. */
  readonly lo: FieldTriple;
  readonly hi: FieldTriple;
  /** First stored sample, one gradient-border cell outside `lo`. */
  readonly origin: FieldTriple;
}

// Positive plane volume, optional two-sided pullback room, then a distinct
// stored gradient border. Brick storage retains this isotropic sample lattice.
function traceLatticeFor(
  min: FieldTriple,
  max: FieldTriple,
  spacing: number,
  mostlyTwoSided: boolean,
): Result<TraceLattice, DistanceFieldError> {
  const lo: FieldTriple = [0, 0, 0],
    hi: FieldTriple = [0, 0, 0];
  for (const a of [0, 1, 2] as const) {
    const center = (min[a] + max[a]) / 2;
    const extent = Math.max((max[a] - min[a]) / 2, spacing / 2) + (mostlyTwoSided ? spacing : 0);
    lo[a] = Math.fround(center - extent);
    hi[a] = Math.fround(center + extent);
  }
  const origin = lo.map((v) => Math.fround(v - spacing)) as FieldTriple;
  for (const a of [0, 1, 2] as const) {
    // Undoing the border subtraction can round inward. Move the stored
    // origin one f32 value outward before deriving the GPU trace boundary.
    if (Math.fround(origin[a] + spacing) > lo[a]) origin[a] = f32Outward(origin[a]);
    lo[a] = Math.fround(origin[a] + spacing);
    if (lo[a] > min[a])
      return distanceFieldFailure(
        'visibility trace bounds lost source coverage to coordinate precision',
      );
  }
  return ok({ lo, hi, origin });
}

function latticeDimensions(
  lattice: TraceLattice,
  spacing: number,
): Result<FieldTriple, DistanceFieldError> {
  const { lo, hi, origin } = lattice;
  const dimensions = hi.map((v, a) => Math.ceil((v - (lo[a] ?? 0)) / spacing) + 3) as FieldTriple;
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
  return ok(dimensions);
}

/** Banded unsigned distance with a 98-direction backface vote for the sign. */
class VisibilitySampler {
  negativeSamples = 0;
  private readonly query: ReturnType<typeof createTriangleQuery>;
  private readonly nearestBudget = { remaining: 134_217_728 };
  private readonly rayBudget = { remaining: 1_073_741_824 };
  private readonly hit = { primitive: -1, distance: 0, frontFace: false };
  private readonly allTwoSided: boolean;
  private readonly activeFlags: readonly number[];
  private readonly dimensions: FieldTriple;
  private readonly origin: FieldTriple;
  private readonly spacing: number;
  private readonly distanceBand: number;

  constructor(
    triangles: readonly QueryTriangle[],
    activeFlags: readonly number[],
    dimensions: FieldTriple,
    origin: FieldTriple,
    spacing: number,
    distanceBand: number,
  ) {
    this.query = createTriangleQuery(triangles);
    this.activeFlags = activeFlags;
    this.allTwoSided = activeFlags.every((v) => v === 1);
    this.dimensions = dimensions;
    this.origin = origin;
    this.spacing = spacing;
    this.distanceBand = distanceBand;
  }

  fillBrick(index: number, brick: Float32Array): FieldFailure | undefined {
    const dimensions = this.dimensions,
      origin = this.origin,
      spacing = this.spacing,
      distanceBand = this.distanceBand;
    const start = fieldBrickStart(dimensions, index);
    const lower = start.map((v, a) => Math.fround((origin[a] ?? 0) + Math.fround(v * spacing)));
    const upper = start.map((v, a) =>
      Math.fround(
        (origin[a] ?? 0) + Math.fround(Math.min(v + 3, (dimensions[a] ?? 0) - 1) * spacing),
      ),
    );
    const center = lower.map((v, a) => (v + (upper[a] ?? 0)) / 2) as FieldTriple;
    const radius = Math.hypot(...upper.map((v, a) => (v - (lower[a] ?? 0)) / 2));
    // The unsigned distance is 1-Lipschitz. An outward guard covers coordinate
    // and nearest-query rounding; no sample within the band is discarded.
    const guard =
      distanceBand + radius + Math.max(spacing * 1e-5, ...center.map((v) => Math.abs(v) * 1e-7));
    const nearest = this.query.nearestSquared(center, guard, this.nearestBudget);
    if (nearest === null)
      return distanceFieldFailure(
        'visibility brick closest-point budget exhausted',
        'distance-field-limit',
      );
    if (nearest >= guard * guard) {
      brick.fill(distanceBand);
      return undefined;
    }
    for (let k = 0; k < 4; k++)
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const lane = (k * 4 + j) * 4 + i;
          if (fieldBrickLane(dimensions, start, i, j, k) !== lane) continue;
          const value = this.sample(start[0] + i, start[1] + j, start[2] + k);
          if (typeof value !== 'number') return value;
          brick[lane] = value;
          if (value < 0) this.negativeSamples++;
        }
    return undefined;
  }

  private sample(x: number, y: number, z: number): number | FieldFailure {
    const origin = this.origin,
      spacing = this.spacing,
      distanceBand = this.distanceBand;
    const p: FieldVec3 = [
      Math.fround(origin[0] + Math.fround(x * spacing)),
      Math.fround(origin[1] + Math.fround(y * spacing)),
      Math.fround(origin[2] + Math.fround(z * spacing)),
    ];
    const nearest = this.query.nearestSquared(p, distanceBand, this.nearestBudget);
    if (nearest === null)
      return distanceFieldFailure(
        'visibility closest-point budget exhausted',
        'distance-field-limit',
      );
    const distance = Math.sqrt(nearest);
    // A capped nearest result contains no geometry reachable by a sign ray:
    // its pulled-back start puts the far endpoint strictly inside the band.
    const back =
      !this.allTwoSided && nearest < distanceBand * distanceBand ? this.backfaceVotes(p) : 0;
    if (typeof back !== 'number') return back;
    return Math.fround(
      Math.min(distance, distanceBand) * (back > DIRECTIONS.length * 0.25 ? -1 : 1),
    );
  }

  private backfaceVotes(p: FieldVec3): number | FieldFailure {
    const distanceBand = this.distanceBand,
      hit = this.hit;
    let back = 0;
    let remaining = DIRECTIONS.length;
    for (const d of DIRECTIONS) {
      const start: FieldVec3 = [
        p[0] - 1e-4 * distanceBand * d[0],
        p[1] - 1e-4 * distanceBand * d[1],
        p[2] - 1e-4 * distanceBand * d[2],
      ];
      const found = this.query.trace(hit, start, d, 0, distanceBand, this.rayBudget);
      if (found === null)
        return distanceFieldFailure('visibility sign-ray budget exhausted', 'distance-field-limit');
      if (found && !hit.frontFace && this.activeFlags[hit.primitive] === 0) back++;
      remaining--;
      // Remaining votes cannot undo a negative decision, or supply enough
      // backfaces for one. Preserve the complete 98-direction predicate.
      if (back > DIRECTIONS.length * 0.25 || back + remaining <= DIRECTIONS.length * 0.25) break;
    }
    return back;
  }
}

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
  const inputFailure = visibilityInputFailure(
    positions,
    indices,
    spacing,
    options.triangleSidedness,
  );
  if (inputFailure !== undefined) return inputFailure;
  const pointsResult = canonicalPoints(positions);
  if (!pointsResult.ok) return pointsResult;
  const { points, canonical } = pointsResult.value;
  const source = collectVisibilityTriangles(indices, points, options.triangleSidedness);
  if (!source.ok) return source;
  const { topology, flags, activeFlags, triangles, min, max } = source.value;
  const mostlyTwoSided = source.value.twoSidedCount * 4 >= flags.length;
  const lattice = traceLatticeFor(min, max, spacing, mostlyTwoSided);
  if (!lattice.ok) return lattice;
  const { lo, hi, origin } = lattice.value;
  const dimensionsResult = latticeDimensions(lattice.value, spacing);
  if (!dimensionsResult.ok) return dimensionsResult;
  const dimensions = dimensionsResult.value;
  const distanceBand = Math.fround(4 * Math.sqrt(3) * spacing);
  if (!Number.isFinite(distanceBand))
    return distanceFieldFailure('visibility distance band overflow');
  const sampler = new VisibilitySampler(
    triangles,
    activeFlags,
    dimensions,
    origin,
    spacing,
    distanceBand,
  );
  const storage = new FieldBrickBuilder(dimensions),
    brick = new Float32Array(64);
  for (let index = 0; index < storage.bricks.length; index++) {
    const brickFailure = sampler.fillBrick(index, brick);
    if (brickFailure !== undefined) return brickFailure;
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
    quality: { negativeSamples: sampler.negativeSamples, testedTriangles: triangles.length },
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
