// @forgeax/engine-runtime — CPU cluster-forward binner (M3 pure functions)
// feat-20260608-cluster-lighting.
//
// Transplants Bevy's clustered_forward CPU math skeleton (research Finding 1)
// from WGSL to pure TypeScript. Four internal pure functions ported from
// Bevy cluster.wgsl lines 75-200:
//   cluster_space_object_aabb — sphere -> view-space NDC AABB
//   ndc_position_to_cluster   — NDC coords -> cluster index (XY+Z)
//   calculate_sphere_cluster_bounds — AABB -> cluster-cell range
//   view_z_to_z_slice        — log-z inverse mapping (idTech6 formula)
//
// Public surface:
//   bin(lights, view, proj, grid, near, far, clusterGrid, lightIndexList, capacity)
//     -> Result<writtenLightIndexCount, never>
//
// Constraints:
//   D-3: pure function + Result + out param + no throw
//   D-8: spot uses sphere proxy (radius=range)
//   D-binner: CPU main thread, no GPU compute / worker
//   OOS-4: cone-AABB tight culling deferred
//
// Capacity: when the requested entries exceed `capacity`, every cluster keeps
// at most K entries, K the largest value whose sum of min(count, K) fits
// (water-filling), and the lowest light indices survive. The frame is never
// rejected; the scratch reports K and the dropped entries.
// Grid: {x,y,z} each in [1, 64] integers (validated at install time).

import { type Mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import { ok, type Result } from '@forgeax/engine-rhi';

// ── types ──────────────────────────────────────────────────────────────────

/**
 * View-space NDC axis-aligned bounding box.
 * XY is the intersection with the NDC screen interval; a reversed interval is empty.
 * Z holds the far and near edges in camera space.
 */
interface ClusterAabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Unsigned integer 3D cluster cell coordinate. */
interface Uvec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Cluster cell range in the unsigned grid. */
interface ClusterBounds {
  readonly min: Uvec3;
  readonly max: Uvec3;
}

type MutableClusterBounds = {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
};

/**
 * Reusable typed scratch for cluster-major output. The binner must emit one
 * contiguous light-index run per cluster, so counts and cursors replace the
 * per-frame `number[][]` staging lists without changing output order.
 */
export interface ClusterBinScratch {
  clusterCounts: Uint32Array;
  clusterCursors: Uint32Array;
  lightBounds: Int32Array;
  clusterDeltas: Int32Array;
  aabbOutput: ClusterAabb;
  boundsOutput: MutableClusterBounds;
  /** Per-cluster entry cap of the last `bin`, or `undefined` when every entry fit. */
  clusterEntryCapK: number | undefined;
  /** Entries the last `bin` dropped under `clusterEntryCapK`. */
  droppedClusterEntries: number;
  occupiedClusterCount: number;
}

/**
 * Selects the membership materialization owner after bounds and occupancy are
 * derived. The default keeps the existing CPU list writer; the WebGPU
 * producer uses the same CPU-owned scratch and leaves the ordered list to a
 * later compute pass.
 */
interface ClusterBinOptions {
  readonly writeMembership?: boolean;
}

type ClusterBinProfilePhase =
  | 'light-bounds-and-occupancy'
  | 'light-bounds-and-occupancy/light-aabb'
  | 'light-bounds-and-occupancy/cluster-occupancy'
  | 'cluster-reserve'
  | 'light-index-write'
  | 'light-index-write/bounds-read'
  | 'light-index-write/cluster-write';

type ClusterBinProfileRunner = <T>(phase: ClusterBinProfilePhase, action: () => T) => T;

function runClusterBinProfilePhase<T>(
  runner: ClusterBinProfileRunner | undefined,
  phase: ClusterBinProfilePhase,
  action: () => T,
): T {
  return runner === undefined ? action() : runner(phase, action);
}

export function createClusterBinScratch(): ClusterBinScratch {
  return {
    clusterCounts: new Uint32Array(0),
    clusterCursors: new Uint32Array(0),
    lightBounds: new Int32Array(0),
    clusterDeltas: new Int32Array(0),
    aabbOutput: {
      min: vec3.create(0, 0, 0),
      max: vec3.create(0, 0, 0),
    },
    boundsOutput: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0, y: 0, z: 0 },
    },
    clusterEntryCapK: undefined,
    droppedClusterEntries: 0,
    occupiedClusterCount: 0,
  };
}

/**
 * Water-filling cap: the largest K with sum(min(counts[i], K)) <= capacity.
 * Callers only ask when the uncapped sum exceeds `capacity`.
 */
export function clusterEntryCapK(
  counts: ArrayLike<number>,
  clusterCount: number,
  capacity: number,
): number {
  let high = 0;
  for (let index = 0; index < clusterCount; index++) high = Math.max(high, counts[index] ?? 0);
  let low = 0;
  while (low < high) {
    const k = low + Math.ceil((high - low) / 2);
    let total = 0;
    for (let index = 0; index < clusterCount && total <= capacity; index++)
      total += Math.min(counts[index] ?? 0, k);
    if (total <= capacity) low = k;
    else high = k - 1;
  }
  return low;
}

function ensureScratchCapacity(
  scratch: ClusterBinScratch,
  clusterCount: number,
  lightCount: number,
  gridX: number,
  gridY: number,
  gridZ: number,
): void {
  if (scratch.clusterCounts.length < clusterCount) {
    scratch.clusterCounts = new Uint32Array(clusterCount);
    scratch.clusterCursors = new Uint32Array(clusterCount);
  }
  if (scratch.lightBounds.length < lightCount * 6) {
    scratch.lightBounds = new Int32Array(lightCount * 6);
  }
  const differenceVolumeSize = (gridX + 1) * (gridY + 1) * (gridZ + 1);
  if (scratch.clusterDeltas.length < differenceVolumeSize) {
    scratch.clusterDeltas = new Int32Array(differenceVolumeSize);
  }
}

// ── spot binning sphere ────────────────────────────────────────────────────

/**
 * Smallest-radius bounding sphere of a spot light's lit volume, for binning.
 *
 * A spot contributes exactly zero outside its outer cone (evalSpotCone) and
 * outside its range sphere (the squared range window), so its lit volume is
 * the spherical sector with apex `position`, axis `direction`, half-angle
 * acos(cosOuter) and slant length `range`. The range sphere proxy (D-8)
 * bounds a 16 degree cone of range 70 with radius 70; this sector sphere has
 * radius 70 / (2 cos 16) ~= 36.4, an 8x smaller volume and correspondingly
 * fewer cluster cells, with the same shaded result in every cell.
 *
 * Construction (sector bounding sphere):
 *   half-angle <= 45 deg: the sphere through the apex whose chord along every
 *     cone edge has length `range`: radius = range / (2 cos), centre on the
 *     axis at that radius. Cap points (angle phi < theta, distance range)
 *     lie inside because the chord at phi is 2 R cos(phi) >= range.
 *   45 .. 90 deg: centre = apex + axis * range * cos, radius = range * sin
 *     (the rim circle's sphere; apex and cap both inside).
 *   wider than 90 deg, a degenerate axis or a non-finite range: the range
 *     sphere itself.
 *
 * `output` receives the centre; the returned value is the radius. A relative
 * 1e-5 pad keeps boundary fragments (where the factor is already zero)
 * conservatively inside after f32/f64 rounding.
 */
export function spotBinningSphere(
  position: Vec3,
  direction: Vec3,
  cosOuter: number,
  range: number,
  output: Vec3,
): number {
  const px = position[0] ?? 0;
  const py = position[1] ?? 0;
  const pz = position[2] ?? 0;
  output[0] = px;
  output[1] = py;
  output[2] = pz;
  const dx = direction[0] ?? 0;
  const dy = direction[1] ?? 0;
  const dz = direction[2] ?? 0;
  const length = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(range) || !(range > 0) || !(length > 1e-8) || !(cosOuter > 0)) {
    return range;
  }
  const cos = Math.min(cosOuter, 1);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  let offset: number;
  let radius: number;
  if (cos >= Math.SQRT1_2) {
    radius = range / (2 * cos);
    offset = radius;
  } else {
    radius = range * sin;
    offset = range * cos;
  }
  const scale = offset / length;
  output[0] = px + dx * scale;
  output[1] = py + dy * scale;
  output[2] = pz + dz * scale;
  return Math.min(range, radius * (1 + 1e-5));
}

// ── exact froxel culling ───────────────────────────────────────────────────

/**
 * Perspective terms that map a view-space point to cluster NDC, read once per
 * frame: ndc.x = (p00 * x + p20 * z) / (p23 * z), ndc.y likewise with p11 / p21.
 * `undefined` for projections where clip.w is not a pure function of view z
 * (orthographic or skewed); callers then keep the conservative cell box.
 */
export interface FroxelProjection {
  readonly p00: number;
  readonly p11: number;
  readonly p20: number;
  readonly p21: number;
  readonly p23: number;
}

function entry(values: ArrayLike<number>, index: number): number {
  return values[index] ?? 0;
}

function allNearZero(values: ArrayLike<number>, indices: readonly number[]): boolean {
  return indices.every((index) => Math.abs(entry(values, index)) < 1e-8);
}

// clip.w must not depend on view x / y / w, and clip x / y must not mix
// view x / y / translation, for the froxel box to be a function of depth.
const FROXEL_ZERO_ENTRIES = [3, 7, 15, 4, 1, 12, 13] as const;

export function froxelProjection(proj: Mat4): FroxelProjection | undefined {
  const p00 = entry(proj, 0);
  const p11 = entry(proj, 5);
  const p23 = entry(proj, 11);
  if (!allNearZero(proj, FROXEL_ZERO_ENTRIES) || Math.abs(p23) < 1e-5) return undefined;
  if (Math.abs(p00) < 1e-8 || Math.abs(p11) < 1e-8) return undefined;
  return { p00, p11, p20: entry(proj, 8), p21: entry(proj, 9), p23 };
}

/** Projection terms stored in a producer payload header (`encodeProducerBounds`). */
function payloadProjection(words: Float32Array): FroxelProjection {
  return {
    p00: entry(words, 0),
    p11: entry(words, 1),
    p20: entry(words, 2),
    p21: entry(words, 3),
    p23: entry(words, 4),
  };
}

/**
 * View-space AABB of the fragments the shader assigns to cluster cell
 * (cx, cy, cz) (`ndc_position_to_cluster`): an NDC tile and a log-z depth
 * slice. Slice 0 starts at the eye (anything nearer than `near` clamps into
 * it). The last slice is unbounded (anything beyond `far` clamps into it);
 * for it only `out[5]` (= -d0, the near face) is meaningful and the function
 * returns false. View x / y are linear in depth along a fixed NDC ray, so the
 * box is exact at the slice depths. It is padded by a relative 1e-4 so f32
 * cell assignment at a boundary can never place a reached fragment in a cell
 * that rejected the light.
 *
 * `out` = [minX, minY, minZ, maxX, maxY, maxZ]. Mirrors `froxel_aabb` in
 * `STANDARD_CLUSTER_MEMBERSHIP_WGSL`.
 */
/** Fraction of a cluster tile added on each side of its NDC footprint. */
export const FROXEL_TILE_PAD = 1 / 32;

export function froxelViewAabb(
  cx: number,
  cy: number,
  cz: number,
  projection: FroxelProjection,
  gridX: number,
  gridY: number,
  gridZ: number,
  near: number,
  far: number,
  out: Float64Array,
): boolean {
  const logRatio = Math.log(far / near);
  const d0 = cz === 0 ? 0 : near * Math.exp((logRatio * cz) / gridZ);
  if (cz >= gridZ - 1) {
    out[5] = -d0 * (1 - 1e-4);
    return false;
  }
  const d1 = near * Math.exp((logRatio * (cz + 1)) / gridZ);
  const pad = d1 * 1e-4;
  const { p00, p11, p20, p21, p23 } = projection;
  // The tile grows by FROXEL_TILE_PAD of its width on each side so a raster
  // projection that differs from the binning one by a sub-pixel jitter (TAA)
  // still looks fragments up in a cell that kept every light reaching them.
  const padX = (2 / gridX) * FROXEL_TILE_PAD;
  const padY = (2 / gridY) * FROXEL_TILE_PAD;
  // view.x = depth * (p20 - p23 * ndc.x) / p00, linear in depth and ndc.x.
  const ax0 = (p20 - p23 * ((cx / gridX) * 2 - 1 - padX)) / p00;
  const ax1 = (p20 - p23 * (((cx + 1) / gridX) * 2 - 1 + padX)) / p00;
  const ay0 = (p21 - p23 * ((cy / gridY) * 2 - 1 - padY)) / p11;
  const ay1 = (p21 - p23 * (((cy + 1) / gridY) * 2 - 1 + padY)) / p11;
  out[0] = Math.min(ax0 * d0, ax0 * d1, ax1 * d0, ax1 * d1) - pad;
  out[3] = Math.max(ax0 * d0, ax0 * d1, ax1 * d0, ax1 * d1) + pad;
  out[1] = Math.min(ay0 * d0, ay0 * d1, ay1 * d0, ay1 * d1) - pad;
  out[4] = Math.max(ay0 * d0, ay0 * d1, ay1 * d0, ay1 * d1) + pad;
  out[2] = -d1 - pad;
  out[5] = -d0 + pad;
  return true;
}

function sphereReachesFroxel(
  box: Float64Array,
  bounded: boolean,
  sx: number,
  sy: number,
  sz: number,
  radius: number,
): boolean {
  if (!bounded) return sz - radius <= (box[5] ?? 0);
  const dx = Math.max((box[0] ?? 0) - sx, 0, sx - (box[3] ?? 0));
  const dy = Math.max((box[1] ?? 0) - sy, 0, sy - (box[4] ?? 0));
  const dz = Math.max((box[2] ?? 0) - sz, 0, sz - (box[5] ?? 0));
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

/**
 * Use the tangent plane facing the cell center (UE LightGridInjection).
 * A rejected box is wholly outside the emitting cone or hemisphere.
 */
function emissionReachesFroxel(
  box: Float64Array,
  words: Float32Array,
  at: number,
  rect: boolean,
): boolean {
  const x = (box[0] as number) + (box[3] as number);
  const y = (box[1] as number) + (box[4] as number);
  const z = (box[2] as number) + (box[5] as number);
  const vx = x * 0.5 - (words[at + 12] as number);
  const vy = y * 0.5 - (words[at + 13] as number);
  const vz = z * 0.5 - (words[at + 14] as number);
  const ax = words[at + 16] as number;
  const ay = words[at + 17] as number;
  const az = words[at + 18] as number;
  let nx = -ax;
  let ny = -ay;
  let nz = -az;
  if (!rect) {
    const along = vx * ax + vy * ay + vz * az;
    const rx = vx - along * ax;
    const ry = vy - along * ay;
    const rz = vz - along * az;
    const length = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const cos = words[at + 19] as number;
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    if (length > 1e-6) {
      const scale = cos / length;
      nx = rx * scale - ax * sin;
      ny = ry * scale - ay * sin;
      nz = rz * scale - az * sin;
    }
  }
  const extent =
    Math.abs(nx) * ((box[3] as number) - (box[0] as number)) * 0.5 +
    Math.abs(ny) * ((box[4] as number) - (box[1] as number)) * 0.5 +
    Math.abs(nz) * ((box[5] as number) - (box[2] as number)) * 0.5;
  return vx * nx + vy * ny + vz * nz <= extent;
}

/**
 * Whether a view-space sphere can touch cluster cell (cx, cy, cz); see
 * `froxelViewAabb` for the cell. Mirrors the GPU membership producer.
 */
export function froxelSphereOverlaps(
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  radius: number,
  projection: FroxelProjection,
  gridX: number,
  gridY: number,
  gridZ: number,
  near: number,
  far: number,
): boolean {
  if (!Number.isFinite(radius)) return true;
  const box = new Float64Array(6);
  const bounded = froxelViewAabb(cx, cy, cz, projection, gridX, gridY, gridZ, near, far, box);
  return sphereReachesFroxel(box, bounded, sx, sy, sz, radius);
}

// ── GPU membership producer payload ─────────────────────────────────────────

/**
 * Producer payload (`light_bounds` binding) layout, in 32-bit words:
 *   header (8): f32 p00, p11, p20, p21, p23; u32 exact (1 = froxel tests on); u32 reserved index count; 0
 *   per light (20), at header + index * 20:
 *     i32 min x/y/z, max x/y/z cell box (min x < 0 = culled);
 *     u32 flags (bit 0: unbounded sphere, bit 1: cone valid); 0;
 *     f32 view sphere centre xyz, radius;
 *     f32 view cone apex xyz, slant range;
 *     f32 view cone axis xyz, cos(half-angle).
 */
export const PRODUCER_BOUNDS_HEADER_WORDS = 8;
/** Filled from the reserved CPU runs after encoding the individual lights. */
export const PRODUCER_RESERVATION_END_WORD = 6;
export const PRODUCER_BOUNDS_STRIDE_WORDS = 20;
const PRODUCER_FLAG_UNBOUNDED = 1;
const PRODUCER_FLAG_CONE = 2;
const PRODUCER_FLAG_RECT = 4;

export function producerBoundsInt32Length(lightSlots: number): number {
  return PRODUCER_BOUNDS_HEADER_WORDS + lightSlots * PRODUCER_BOUNDS_STRIDE_WORDS;
}

/** Optional spot cone carried next to a light's binning sphere (world space). */
export interface BinningCone {
  readonly apex: Vec3;
  readonly direction: Vec3;
  readonly cosOuter: number;
  readonly range: number;
}

/**
 * Encode the cell boxes from `bin` (stride 6 in `lightBounds`) plus each
 * light's view-space sphere / cone into the producer payload.
 */
export function encodeProducerBounds(
  lights: ReadonlyArray<{
    readonly position: Vec3;
    readonly range: number;
    readonly cone?: BinningCone | undefined;
    readonly rectNormal?: Vec3 | undefined;
  }>,
  lightBounds: Int32Array,
  view: Mat4,
  proj: Mat4,
  output: Int32Array,
  lightCount = lights.length,
  words = new Float32Array(output.buffer, output.byteOffset, output.length),
  centre = vec3.create(0, 0, 0),
): void {
  output.fill(0, 0, producerBoundsInt32Length(lightCount));
  const projection = froxelProjection(proj);
  const scale = viewAxisScale(view);
  const exact = projection !== undefined && scale > 0 && viewPreservesAngles(view, scale);
  if (exact) {
    words[0] = projection.p00;
    words[1] = projection.p11;
    words[2] = projection.p20;
    words[3] = projection.p21;
    words[4] = projection.p23;
    output[5] = 1;
  }
  if (lightCount === 0) return;
  for (let index = 0; index < lightCount; index++) {
    const light = lights[index];
    const at = PRODUCER_BOUNDS_HEADER_WORDS + index * PRODUCER_BOUNDS_STRIDE_WORDS;
    const cellAt = index * 6;
    if (light === undefined || (lightBounds[cellAt] ?? -1) < 0) {
      output[at] = -1;
      continue;
    }
    for (let k = 0; k < 6; k++) output[at + k] = lightBounds[cellAt + k] ?? 0;
    // A scaled or sheared view changes cone angles and turns spheres into ellipsoids.
    // A non-perspective producer also consumes just the conservative cell box.
    if (!exact) {
      output[at + 6] = PRODUCER_FLAG_UNBOUNDED;
      continue;
    }
    const sphereFlags = encodeLightSphere(
      light.position,
      light.range,
      view,
      centre,
      words,
      at,
      scale,
    );
    const coneFlags =
      light.cone === undefined ? 0 : encodeLightCone(light.cone, view, centre, words, at, scale);
    const rectFlags =
      light.rectNormal !== undefined && encodeEmissionAxis(light.rectNormal, view, words, at)
        ? PRODUCER_FLAG_RECT
        : 0;
    if (rectFlags !== 0) words.set(centre, at + 12);
    output[at + 6] = sphereFlags | coneFlags | rectFlags;
  }
}

/** Write one light's view-space binning sphere at `at + 8`; returns its flags. */
function encodeLightSphere(
  position: Vec3,
  range: number,
  view: Mat4,
  centre: Vec3,
  words: Float32Array,
  at: number,
  scale: number,
): number {
  const radius = viewSpaceBinningSphere(position, range, view, centre, scale);
  if (!Number.isFinite(radius)) return PRODUCER_FLAG_UNBOUNDED;
  words[at + 8] = entry(centre, 0);
  words[at + 9] = entry(centre, 1);
  words[at + 10] = entry(centre, 2);
  words[at + 11] = radius;
  return 0;
}

/** Write one spot light's view-space cone at `at + 12`; returns its flags. */
function encodeLightCone(
  cone: BinningCone,
  view: Mat4,
  centre: Vec3,
  words: Float32Array,
  at: number,
  scale: number,
): number {
  if (cone.cosOuter <= 0 || !Number.isFinite(cone.range)) return 0;
  const apexRange = viewSpaceBinningSphere(cone.apex, cone.range, view, centre, scale);
  if (!encodeEmissionAxis(cone.direction, view, words, at)) return 0;
  words.set(centre, at + 12);
  // The bounding sector is the broad phase. The apex sphere clips the actual range.
  words[at + 15] = apexRange * (1 + 1e-4);
  // Widen the half-angle slightly (cos down) for the same reason.
  words[at + 19] = Math.max(0, Math.min(1, cone.cosOuter) - 1e-4);
  return PRODUCER_FLAG_CONE;
}

function encodeEmissionAxis(axis: Vec3, view: Mat4, words: Float32Array, at: number): boolean {
  const dx = entry(axis, 0);
  const dy = entry(axis, 1);
  const dz = entry(axis, 2);
  const ax = rotatedLane(view, dx, dy, dz, 0);
  const ay = rotatedLane(view, dx, dy, dz, 1);
  const az = rotatedLane(view, dx, dy, dz, 2);
  const length = Math.hypot(ax, ay, az);
  if (!(length > 1e-8)) return false;
  words[at + 16] = ax / length;
  words[at + 17] = ay / length;
  words[at + 18] = az / length;
  return true;
}

/** One lane of the view rotation, retaining double precision through normalization. */
function rotatedLane(view: Mat4, x: number, y: number, z: number, lane: number): number {
  return entry(view, lane) * x + entry(view, 4 + lane) * y + entry(view, 8 + lane) * z;
}

/** Largest axis scale of the view matrix's upper 3x3. */
function viewAxisScale(view: Mat4): number {
  return Math.max(cameraAxisLength(view, 0), cameraAxisLength(view, 1), cameraAxisLength(view, 2));
}

// A rigid or uniformly scaled view preserves the shape used by the exact GPU test.
function viewPreservesAngles(view: Mat4, scale: number): boolean {
  const xx = entry(view, 0),
    xy = entry(view, 4),
    xz = entry(view, 8);
  const yx = entry(view, 1),
    yy = entry(view, 5),
    yz = entry(view, 9);
  const zx = entry(view, 2),
    zy = entry(view, 6),
    zz = entry(view, 10);
  const squared = scale * scale,
    tolerance = squared * 1e-6;
  return (
    Math.abs(xx * yx + xy * yy + xz * yz) <= tolerance &&
    Math.abs(xx * zx + xy * zy + xz * zz) <= tolerance &&
    Math.abs(yx * zx + yy * zy + yz * zz) <= tolerance &&
    Math.abs(xx * xx + xy * xy + xz * xz - squared) <= tolerance &&
    Math.abs(yx * yx + yy * yy + yz * yz - squared) <= tolerance &&
    Math.abs(zx * zx + zy * zy + zz * zz - squared) <= tolerance
  );
}

/**
 * Whether the producer keeps light `index` in cell (cx, cy, cz), given the
 * cell box already contains it. CPU mirror of the WGSL froxel tests.
 */
function producerKeeps(
  payload: Int32Array,
  words: Float32Array,
  index: number,
  box: Float64Array,
  bounded: boolean,
): boolean {
  const at = PRODUCER_BOUNDS_HEADER_WORDS + index * PRODUCER_BOUNDS_STRIDE_WORDS;
  const flags = payload[at + 6] ?? 0;
  if ((flags & PRODUCER_FLAG_UNBOUNDED) !== 0) return true;
  if (
    !sphereReachesFroxel(
      box,
      bounded,
      words[at + 8] ?? 0,
      words[at + 9] ?? 0,
      words[at + 10] ?? 0,
      words[at + 11] ?? 0,
    )
  )
    return false;
  if (!bounded || (flags & (PRODUCER_FLAG_CONE | PRODUCER_FLAG_RECT)) === 0) return true;
  const rect = (flags & PRODUCER_FLAG_RECT) !== 0;
  return (
    (rect ||
      sphereReachesFroxel(
        box,
        true,
        words[at + 12] as number,
        words[at + 13] as number,
        words[at + 14] as number,
        words[at + 15] as number,
      )) &&
    emissionReachesFroxel(box, words, at, rect)
  );
}

/**
 * View-space binning sphere of one light (rigid or uniformly scaled view):
 * `output` receives the centre, the returned value is the radius.
 */
export function viewSpaceBinningSphere(
  position: Vec3,
  range: number,
  view: Mat4,
  output: Vec3,
  scale = viewAxisScale(view),
): number {
  const x = entry(position, 0),
    y = entry(position, 1),
    z = entry(position, 2);
  output[0] = rotatedLane(view, x, y, z, 0) + entry(view, 12);
  output[1] = rotatedLane(view, x, y, z, 1) + entry(view, 13);
  output[2] = rotatedLane(view, x, y, z, 2) + entry(view, 14);
  return range * scale;
}

/** Lights-per-cell distribution of one membership derivation. */
export interface ClusterOccupancyStats {
  /** Sum of per-cell list lengths. */
  readonly entries: number;
  /** Cells with at least one light. */
  readonly occupied: number;
  /** entries / occupied (0 when nothing is occupied). */
  readonly meanPerOccupied: number;
  readonly max: number;
  /** Cell counts per list length bucket: 0, 1-4, 5-8, 9-16, 17-32, 33-64, 65+. */
  readonly histogram: readonly number[];
}

/** Diagnostic comparison of the conservative cell box and the exact froxel test. */
export interface ClusterOccupancyReport {
  readonly box: ClusterOccupancyStats;
  readonly exact: ClusterOccupancyStats | undefined;
}

const OCCUPANCY_BUCKETS = [0, 4, 8, 16, 32, 64] as const;

function occupancyStats(counts: Uint32Array): ClusterOccupancyStats {
  const histogram = new Array<number>(OCCUPANCY_BUCKETS.length + 1).fill(0);
  let entries = 0;
  let occupied = 0;
  let max = 0;
  for (const count of counts) {
    entries += count;
    if (count > 0) occupied++;
    if (count > max) max = count;
    let bucket = OCCUPANCY_BUCKETS.findIndex((limit) => count <= limit);
    if (bucket < 0) bucket = OCCUPANCY_BUCKETS.length;
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }
  return {
    entries,
    occupied,
    meanPerOccupied: occupied === 0 ? 0 : entries / occupied,
    max,
    histogram,
  };
}

/**
 * CPU mirror of the GPU membership producer for one light and one cell:
 * whether light `index` of an encoded producer payload survives the exact
 * froxel test in cell (cx, cy, cz). Cell-box membership is assumed.
 */
export function producerKeepsLight(
  payload: Int32Array,
  index: number,
  cx: number,
  cy: number,
  cz: number,
  grid: { readonly x: number; readonly y: number; readonly z: number },
  near: number,
  far: number,
): boolean {
  if (payload[5] !== 1) return true;
  const words = new Float32Array(payload.buffer, payload.byteOffset, payload.length);
  const projection = payloadProjection(words);
  const froxel = new Float64Array(6);
  const bounded = froxelViewAabb(cx, cy, cz, projection, grid.x, grid.y, grid.z, near, far, froxel);
  return producerKeeps(payload, words, index, froxel, bounded);
}

/** Visit every cell of the inclusive cell box stored at `payload[at..at+6)`. */
function forEachBoxCell(
  payload: Int32Array,
  at: number,
  visit: (cx: number, cy: number, cz: number) => void,
): void {
  const [x0, y0, z0, x1, y1, z1] = [0, 1, 2, 3, 4, 5].map((k) => payload[at + k] ?? -1);
  for (let cz = z0 ?? 0; cz <= (z1 ?? -1); cz++) {
    for (let cy = y0 ?? 0; cy <= (y1 ?? -1); cy++) {
      for (let cx = x0 ?? 0; cx <= (x1 ?? -1); cx++) visit(cx, cy, cz);
    }
  }
}

export interface TextureClusterMembershipScratch {
  runs?: Uint32Array;
  slots?: Uint32Array;
  box?: Float64Array;
}

/** Build compact CPU texture runs with the same cell tests and ordering as the GPU. */
export function refineTextureClusterMembership(
  payload: Int32Array,
  lightCount: number,
  grid: ClusterGridSize,
  reservation: Uint32Array,
  capacity: number,
  near: number,
  far: number,
  uncapped: Uint32Array | undefined,
  scratch: TextureClusterMembershipScratch = {},
): { readonly grid: Uint32Array; readonly indices: Uint32Array } {
  const words = new Float32Array(payload.buffer, payload.byteOffset, payload.length);
  const projection = payloadProjection(words);
  if (scratch.runs?.length !== reservation.length)
    scratch.runs = new Uint32Array(reservation.length);
  if (scratch.slots === undefined || scratch.slots.length < capacity)
    scratch.slots = new Uint32Array(capacity);
  scratch.box ??= new Float64Array(6);
  const { runs, slots, box } = scratch;
  let end = 0;
  for (let z = 0; z < grid.z; z++) {
    for (let y = 0; y < grid.y; y++) {
      for (let x = 0; x < grid.x; x++) {
        const offset = ((z * grid.y + y) * grid.x + x) * 2;
        const limit = reservation[offset + 1] as number;
        runs[offset] = end;
        runs[offset + 1] = 0;
        if (limit === 0) continue;
        const bounded = froxelViewAabb(x, y, z, projection, grid.x, grid.y, grid.z, near, far, box);
        const count =
          uncapped === undefined
            ? writeRefinedCell(payload, words, lightCount, box, bounded, x, y, z, slots, end, limit)
            : filterReservedCell(
                payload,
                words,
                uncapped,
                reservation[offset] as number,
                limit,
                box,
                bounded,
                slots,
                end,
              );
        runs[offset + 1] = count;
        end += count;
      }
    }
  }
  return { grid: runs, indices: slots.subarray(0, end) };
}

function filterReservedCell(
  payload: Int32Array,
  words: Float32Array,
  candidates: Uint32Array,
  offset: number,
  count: number,
  box: Float64Array,
  bounded: boolean,
  slots: Uint32Array,
  start: number,
): number {
  let end = start;
  for (let i = 0; i < count; i++) {
    const light = candidates[offset + i] as number;
    if (producerKeeps(payload, words, light, box, bounded)) slots[end++] = light;
  }
  return end - start;
}

// A capped reservation stores only a prefix of the broad candidates. Visit the
// whole list so a rejected candidate does not consume the slot of a later light.
function writeRefinedCell(
  payload: Int32Array,
  words: Float32Array,
  lightCount: number,
  box: Float64Array,
  bounded: boolean,
  x: number,
  y: number,
  z: number,
  slots: Uint32Array,
  start: number,
  limit: number,
): number {
  let count = 0;
  for (let light = 0; light < lightCount && count < limit; light++) {
    const at = PRODUCER_BOUNDS_HEADER_WORDS + light * PRODUCER_BOUNDS_STRIDE_WORDS;
    const left = payload[at] as number;
    if (
      left >= 0 &&
      left <= x &&
      x <= (payload[at + 3] as number) &&
      (payload[at + 1] as number) <= y &&
      y <= (payload[at + 4] as number) &&
      (payload[at + 2] as number) <= z &&
      z <= (payload[at + 5] as number) &&
      producerKeeps(payload, words, light, box, bounded)
    ) {
      slots[start + count] = light;
      count++;
    }
  }
  return count;
}

/**
 * Measure lights per cluster cell for the cell boxes and for the cells the
 * GPU producer keeps after its froxel tests, from one producer payload
 * (`encodeProducerBounds`). On-demand inspection tooling; not on the
 * per-frame path.
 */
export function measureClusterOccupancy(
  lightCount: number,
  payload: Int32Array,
  grid: { readonly x: number; readonly y: number; readonly z: number },
  near: number,
  far: number,
): ClusterOccupancyReport {
  const cellCount = grid.x * grid.y * grid.z;
  const box = new Uint32Array(cellCount);
  const kept = new Uint32Array(cellCount);
  const words = new Float32Array(payload.buffer, payload.byteOffset, payload.length);
  const exact = payload[5] === 1;
  const projection = payloadProjection(words);
  const froxel = new Float64Array(6);
  for (let index = 0; index < lightCount; index++) {
    const at = PRODUCER_BOUNDS_HEADER_WORDS + index * PRODUCER_BOUNDS_STRIDE_WORDS;
    if ((payload[at] ?? -1) < 0) continue;
    forEachBoxCell(payload, at, (cx, cy, cz) => {
      const cell = (cz * grid.y + cy) * grid.x + cx;
      box[cell] = (box[cell] ?? 0) + 1;
      if (!exact) return;
      const bounded = froxelViewAabb(
        cx,
        cy,
        cz,
        projection,
        grid.x,
        grid.y,
        grid.z,
        near,
        far,
        froxel,
      );
      if (producerKeeps(payload, words, index, froxel, bounded)) kept[cell] = (kept[cell] ?? 0) + 1;
    });
  }
  return {
    box: occupancyStats(box),
    exact: exact ? occupancyStats(kept) : undefined,
  };
}

// ── view_z_to_z_slice ──────────────────────────────────────────────────────

/**
 * Map view-space z (negative, camera-forward) to a cluster Z slice index.
 *
 * Implements the idTech6 inverse log-z formula (research §2):
 *   slice = floor(log(-view_z / near) / log(far / near) * gridZ)
 *
 * Clamped to [0, gridZ - 1].
 */
export function viewZToZSlice(viewZ: number, gridZ: number, near: number, far: number): number {
  return clusterDepthSlice(viewZ, gridZ, near, Math.log(far / near));
}

function clusterDepthSlice(
  viewZ: number,
  gridZ: number,
  near: number,
  logFarOverNear: number,
): number {
  if (viewZ >= -near) return 0;
  const slice = Math.floor((Math.log(-viewZ / near) / logFarOverNear) * gridZ);
  if (slice < 0) return 0;
  if (slice >= gridZ) return gridZ - 1;
  return slice;
}

// ── cluster_space_object_aabb ───────────────────────────────────────────────

/**
 * Compute view-space NDC AABB for a sphere (light culling proxy).
 *
 * Ported from Bevy `cluster_space_object_aabb` (cluster.wgsl lines 75-140).
 *
 * Steps:
 *   1. Transform sphere center to view space via view matrix.
 *   2. Expand by radius to get view-AABB corners.
 *   3. Project 4 key corners to NDC.
 *   4. Intersect XY with the screen interval and keep view-space depth.
 */
export function clusterSpaceObjectAabb(
  center: Vec3,
  radius: number,
  view: Mat4,
  proj: Mat4,
  output?: ClusterAabb,
): ClusterAabb {
  const result =
    output ??
    ({
      min: vec3.create(0, 0, 0),
      max: vec3.create(0, 0, 0),
    } satisfies ClusterAabb);
  return projectSphereAabb(
    center,
    radius,
    view,
    proj,
    result,
    cameraAxisLength(view, 0),
    cameraAxisLength(view, 1),
    cameraAxisLength(view, 2),
  );
}

// The support radius along one view coordinate is the norm of its matrix row.
function cameraAxisLength(view: Mat4, row: number): number {
  return Math.hypot(entry(view, row), entry(view, row + 4), entry(view, row + 8));
}

function projectSphereAabb(
  center: Vec3,
  radius: number,
  view: Mat4,
  proj: Mat4,
  result: ClusterAabb,
  viewScaleX: number,
  viewScaleY: number,
  viewScaleZ: number,
): ClusterAabb {
  const cx = center[0] ?? 0;
  const cy = center[1] ?? 0;
  const cz = center[2] ?? 0;

  const v00 = view[0] ?? 0;
  const v01 = view[1] ?? 0;
  const v02 = view[2] ?? 0;
  const v10 = view[4] ?? 0;
  const v11 = view[5] ?? 0;
  const v12 = view[6] ?? 0;
  const v20 = view[8] ?? 0;
  const v21 = view[9] ?? 0;
  const v22 = view[10] ?? 0;
  const v30 = view[12] ?? 0;
  const v31 = view[13] ?? 0;
  const v32 = view[14] ?? 0;

  const vx = v00 * cx + v10 * cy + v20 * cz + v30;
  const vy = v01 * cx + v11 * cy + v21 * cz + v31;
  const vz = v02 * cx + v12 * cy + v22 * cz + v32;

  const rx = radius * viewScaleX;
  const ry = radius * viewScaleY;
  const rz = radius * viewScaleZ;

  const vMinX = vx - rx;
  const vMaxX = vx + rx;
  const vMinY = vy - ry;
  const vMaxY = vy + ry;
  // View-space camera looks down -Z, so view_z < 0 in front of camera. The
  // sphere's view-space z-extent is [vMinZ, vMaxZ] with vMinZ <= vMaxZ in raw
  // sign-order; vMinZ is the FARTHEST (most negative) edge, vMaxZ is the
  // NEAREST edge (could be positive if the sphere crosses the near plane).
  //
  // M4.5-followup: previously we did `minViewZ = max(vMinZ, -1e-5)` which
  // collapses the FAR edge of every visible light to view_z ~= 0, which the
  // log-z slice mapping then bins as slice 0. Result: every light only ever
  // wrote into slice 0/0/0 .. {gx-1}/{gy-1}/0 -- floor pixels at view_z=-3..-9
  // (slice 13..17) found 0 lights and rendered black. The clamp must guard
  // the NEAR edge (vMaxZ) instead so projectToNdc never receives a positive
  // or zero view_z, while letting the far edge flow through to its real
  // log-z slice.
  const vMinZ = vz - rz;
  const vMaxZ = vz + rz;

  const minViewZ = vMinZ;
  const maxViewZ = Math.min(vMaxZ, -1e-5);

  // If even the near edge of the sphere is behind the camera, the light
  // contributes nothing. Caller (calculateSphereClusterBounds) returns
  // min > max which the bin loop treats as cull.
  if (minViewZ > maxViewZ) {
    result.min[0] = 1;
    result.min[1] = 1;
    result.min[2] = -1e-5;
    result.max[0] = -1;
    result.max[1] = -1;
    result.max[2] = -1e-5;
    return result;
  }

  let ndcMinX = Infinity;
  let ndcMaxX = -Infinity;
  let ndcMinY = Infinity;
  let ndcMaxY = -Infinity;

  const p00 = proj[0] ?? 0;
  const p10 = proj[4] ?? 0;
  const p20 = proj[8] ?? 0;
  const p30 = proj[12] ?? 0;
  const p01 = proj[1] ?? 0;
  const p11 = proj[5] ?? 0;
  const p21 = proj[9] ?? 0;
  const p31 = proj[13] ?? 0;
  const p23 = proj[11] ?? 0;

  // In the engine's perspective matrices clip.w depends only on view-space z.
  // The XY extrema of each z face are therefore the interval of one linear
  // form, avoiding eight corner projections and their temporary tuples.
  const perspectiveWOnlyZ =
    (proj[3] ?? 0) === 0 && (proj[7] ?? 0) === 0 && (proj[15] ?? 0) === 0 && Math.abs(p23) >= 1e-5;

  if (perspectiveWOnlyZ) {
    const xExtent = Math.abs(p00) * rx + Math.abs(p10) * ry;
    const yExtent = Math.abs(p01) * rx + Math.abs(p11) * ry;
    const xCenterXY = p00 * vx + p10 * vy;
    const yCenterXY = p01 * vx + p11 * vy;
    for (let face = 0; face < 2; face++) {
      const zTest = face === 0 ? minViewZ : maxViewZ;
      if (zTest > 0) continue;
      const invW = 1 / (p23 * zTest);
      const xCenter = xCenterXY + p20 * zTest + p30;
      const yCenter = yCenterXY + p21 * zTest + p31;
      const x0 = (xCenter - xExtent) * invW;
      const x1 = (xCenter + xExtent) * invW;
      const y0 = (yCenter - yExtent) * invW;
      const y1 = (yCenter + yExtent) * invW;
      ndcMinX = Math.min(ndcMinX, x0, x1);
      ndcMaxX = Math.max(ndcMaxX, x0, x1);
      ndcMinY = Math.min(ndcMinY, y0, y1);
      ndcMaxY = Math.max(ndcMaxY, y0, y1);
    }
  } else {
    let minW = Infinity,
      maxW = -Infinity;
    const p03 = proj[3] ?? 0,
      p13 = proj[7] ?? 0,
      p33 = proj[15] ?? 0;
    for (let face = 0; face < 2; face++) {
      const z = face === 0 ? minViewZ : maxViewZ;
      if (z > 0) continue;
      for (let corner = 0; corner < 4; corner++) {
        const x = corner < 2 ? vMinX : vMaxX;
        const y = (corner & 1) === 0 ? vMinY : vMaxY;
        const cw = p03 * x + p13 * y + p23 * z + p33;
        minW = Math.min(minW, cw);
        maxW = Math.max(maxW, cw);
        const singular = Math.abs(cw) < 1e-10;
        const invW = 1 / cw;
        const nx = singular ? (x < 0 ? -1 : 1) : (p00 * x + p10 * y + p20 * z + p30) * invW;
        const ny = singular ? (y < 0 ? -1 : 1) : (p01 * x + p11 * y + p21 * z + p31) * invW;
        ndcMinX = Math.min(ndcMinX, nx);
        ndcMaxX = Math.max(ndcMaxX, nx);
        ndcMinY = Math.min(ndcMinY, ny);
        ndcMaxY = Math.max(ndcMaxY, ny);
      }
    }
    // A custom projective matrix can put a pole inside the sphere's view-space box.
    // Its corner samples cannot bound the interior across that pole.
    if (minW <= 1e-10 && maxW >= -1e-10) {
      ndcMinX = ndcMinY = -1;
      ndcMaxX = ndcMaxY = 1;
    }
  }

  ndcMinX = Math.max(ndcMinX, -1);
  ndcMinY = Math.max(ndcMinY, -1);
  ndcMaxX = Math.min(ndcMaxX, 1);
  ndcMaxY = Math.min(ndcMaxY, 1);

  // M4.5-followup: aabb.min/max[2] now carries VIEW-SPACE z (negative), not
  // projected-NDC z. calculateSphereClusterBounds + ndcPositionToCluster +
  // viewZToZSlice all want view_z to do the log-z slice mapping; passing the
  // projected NDC z (>= 0) collapsed every light to slice 0 so cube/floor
  // fragments outside that slice received zero light.
  result.min[0] = ndcMinX;
  result.min[1] = ndcMinY;
  result.min[2] = minViewZ;
  result.max[0] = ndcMaxX;
  result.max[1] = ndcMaxY;
  result.max[2] = maxViewZ;
  return result;
}

// ── ndc_position_to_cluster ─────────────────────────────────────────────────

/**
 * Map an NDC point to its cluster cell index (XY + Z).
 *
 * XY: floor((ndc.xy * 0.5 + 0.5) * gridXy) clamped to [0, gridXy - 1].
 * Z: delegated to view_z_to_z_slice with the given view-space z.
 */
export function ndcPositionToCluster(
  ndc: Vec3,
  viewZ: number,
  gridX: number,
  gridY: number,
  gridZ: number,
  near: number,
  far: number,
): Uvec3 {
  return {
    x: clusterAxisCell(ndc[0] ?? 0, gridX),
    y: clusterAxisCell(ndc[1] ?? 0, gridY),
    z: viewZToZSlice(viewZ, gridZ, near, far),
  };
}

function clusterAxisCell(ndc: number, count: number): number {
  return Math.min(Math.max(0, Math.floor((ndc * 0.5 + 0.5) * count)), count - 1);
}

// ── calculate_sphere_cluster_bounds ─────────────────────────────────────────

/**
 * Convert an NDC AABB to a range of cluster cell indices.
 *
 * Intersect with the visible screen and depth interval before quantization.
 * A disjoint box returns an empty range (min > max).
 */
export function calculateSphereClusterBounds(
  aabb: ClusterAabb,
  gridX: number,
  gridY: number,
  gridZ: number,
  near: number,
  far: number,
  output?: MutableClusterBounds,
): ClusterBounds {
  const result =
    output ??
    ({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0, y: 0, z: 0 },
    } satisfies MutableClusterBounds);
  return writeSphereCells(aabb, gridX, gridY, gridZ, near, far, Math.log(far / near), result);
}

/** Intersect the continuous box before clamping its endpoints into cell addresses. */
function writeSphereCells(
  aabb: ClusterAabb,
  gridX: number,
  gridY: number,
  gridZ: number,
  near: number,
  far: number,
  logFarOverNear: number,
  result: MutableClusterBounds,
): ClusterBounds {
  const x0 = aabb.min[0] ?? 0,
    x1 = aabb.max[0] ?? 0;
  const y0 = aabb.min[1] ?? 0,
    y1 = aabb.max[1] ?? 0;
  const farZ = aabb.min[2] ?? 0,
    nearZ = aabb.max[2] ?? 0;
  if (
    x0 > x1 ||
    y0 > y1 ||
    x0 > 1 ||
    x1 < -1 ||
    y0 > 1 ||
    y1 < -1 ||
    farZ > nearZ ||
    farZ > -near ||
    nearZ < -far
  ) {
    result.min.x = result.min.y = result.min.z = 1;
    result.max.x = result.max.y = result.max.z = 0;
    return result;
  }
  result.min.x = clusterAxisCell(x0, gridX);
  result.max.x = clusterAxisCell(x1, gridX);
  result.min.y = clusterAxisCell(y0, gridY);
  result.max.y = clusterAxisCell(y1, gridY);
  result.min.z = clusterDepthSlice(nearZ, gridZ, near, logFarOverNear);
  result.max.z = clusterDepthSlice(farZ, gridZ, near, logFarOverNear);
  return result;
}

// ── bin ─────────────────────────────────────────────────────────────────────

// Consecutive light indices with the same current box can be written contiguously
// into each destination run. This grouping is computed from this view's projection.
function endOfLightBoxRun(bounds: Int32Array, first: number, count: number): number {
  const start = first * 6;
  let next = first + 1;
  while (next < count) {
    const at = next * 6;
    if (
      bounds[at] !== bounds[start] ||
      bounds[at + 1] !== bounds[start + 1] ||
      bounds[at + 2] !== bounds[start + 2] ||
      bounds[at + 3] !== bounds[start + 3] ||
      bounds[at + 4] !== bounds[start + 4] ||
      bounds[at + 5] !== bounds[start + 5]
    )
      break;
    next++;
  }
  return next;
}

function writeClusterBoxRun(
  first: number,
  end: number,
  bounds: Int32Array,
  gridX: number,
  gridY: number,
  cursors: Uint32Array,
  indices: Uint32Array,
): void {
  const at = first * 6;
  const x0 = bounds[at] ?? -1,
    y0 = bounds[at + 1] ?? 0,
    z0 = bounds[at + 2] ?? 0;
  const x1 = bounds[at + 3] ?? -1,
    y1 = bounds[at + 4] ?? -1,
    z1 = bounds[at + 5] ?? -1;
  for (let z = z0; z <= z1; z++) {
    let row = (z * gridY + y0) * gridX;
    for (let y = y0; y <= y1; y++, row += gridX) {
      for (let cell = row + x0; cell <= row + x1; cell++) {
        let cursor = cursors[cell] ?? 0;
        for (let light = first; light < end; light++) indices[cursor++] = light;
        cursors[cell] = cursor;
      }
    }
  }
}

/** Find the first cell at or after index with room in its reserved run. */
function nextOpenCluster(next: Int32Array, index: number): number {
  let parent = next[index] ?? index;
  while (parent !== index) {
    const sibling = next[parent] ?? parent;
    next[index] = sibling;
    index = parent;
    parent = sibling;
  }
  return index;
}

/** Write exactly the reserved first-K indices. Completed cells link to their successor,
 * so overlapping light boxes never walk the already-filled part of a row. */
function writeCappedClusterMembership(
  lightCount: number,
  bounds: Int32Array,
  gridX: number,
  gridY: number,
  gridZ: number,
  grid: Uint32Array,
  cursors: Uint32Array,
  indices: Uint32Array,
  next: Int32Array,
): void {
  const cells = gridX * gridY * gridZ;
  let remaining = (grid[2 * cells - 2] ?? 0) + (grid[2 * cells - 1] ?? 0);
  if (remaining === 0) return;
  next[cells] = cells;
  for (let cell = cells - 1; cell >= 0; cell--)
    next[cell] = (grid[cell * 2 + 1] ?? 0) === 0 ? (next[cell + 1] ?? cells) : cell;
  let end = 0;
  for (let light = 0; light < lightCount && remaining > 0; light = end) {
    end = endOfLightBoxRun(bounds, light, lightCount);
    const at = light * 6;
    const x0 = bounds[at] ?? -1;
    if (x0 < 0) continue;
    const y0 = bounds[at + 1] ?? 0,
      z0 = bounds[at + 2] ?? 0;
    const x1 = bounds[at + 3] ?? -1,
      y1 = bounds[at + 4] ?? -1,
      z1 = bounds[at + 5] ?? -1;
    for (let z = z0; z <= z1; z++) {
      let row = (z * gridY + y0) * gridX;
      for (let y = y0; y <= y1; y++, row += gridX) {
        const last = row + x1;
        let cell = nextOpenCluster(next, row + x0);
        while (cell <= last) {
          let cursor = cursors[cell] ?? 0;
          const cellEnd = (grid[cell * 2] ?? 0) + (grid[cell * 2 + 1] ?? 0);
          const length = Math.min(cellEnd - cursor, end - light);
          const limit = light + length;
          for (let index = light; index < limit; index++) indices[cursor++] = index;
          cursors[cell] = cursor;
          const successor = nextOpenCluster(next, cell + 1);
          if (cursor === cellEnd) next[cell] = successor;
          remaining -= length;
          cell = successor;
        }
      }
    }
  }
}

/** No profiling callbacks or per-light lexical environments in ordinary preparation. */
function writeClusterMembership(
  lightCount: number,
  lightBounds: Int32Array,
  gridX: number,
  gridY: number,
  clusterCursors: Uint32Array,
  lightIndexList: Uint32Array,
): void {
  let end = 0;
  for (let light = 0; light < lightCount; light = end) {
    end = endOfLightBoxRun(lightBounds, light, lightCount);
    if ((lightBounds[light * 6] ?? -1) >= 0)
      writeClusterBoxRun(light, end, lightBounds, gridX, gridY, clusterCursors, lightIndexList);
  }
}

/**
 * Write the cluster-major light index list that `bin(..., { writeMembership:
 * false })` reserved: `clusterGrid` holds each cluster's [offset, count] run
 * and `lightBounds` the per-light cluster boxes from the same call. The result
 * equals the list `bin` writes with membership enabled; `capped` (the call set
 * `clusterEntryCapK`) keeps each cluster's first entries within its run. Cursor
 * scratch belongs to the calling view; detached callers use temporary cursors.
 */
export function writeClusterMembershipFromGrid(
  lightCount: number,
  lightBounds: Int32Array,
  grid: { readonly x: number; readonly y: number; readonly z: number },
  clusterGrid: Uint32Array,
  lightIndexList: Uint32Array,
  capped = false,
  scratch?: ClusterBinScratch,
): void {
  const clusterCount = grid.x * grid.y * grid.z;
  let cursors = scratch?.clusterCursors;
  if (cursors === undefined || cursors.length < clusterCount) {
    cursors = new Uint32Array(clusterCount);
    if (scratch !== undefined) scratch.clusterCursors = cursors;
  }
  for (let ci = 0; ci < clusterCount; ci++) cursors[ci] = clusterGrid[ci * 2] ?? 0;
  if (!capped) {
    writeClusterMembership(lightCount, lightBounds, grid.x, grid.y, cursors, lightIndexList);
    return;
  }
  let next = scratch?.clusterDeltas;
  if (next === undefined || next.length <= clusterCount) {
    next = new Int32Array(clusterCount + 1);
    if (scratch !== undefined) scratch.clusterDeltas = next;
  }
  writeCappedClusterMembership(
    lightCount,
    lightBounds,
    grid.x,
    grid.y,
    grid.z,
    clusterGrid,
    cursors,
    lightIndexList,
    next,
  );
}

type ClusterLights = ReadonlyArray<{ readonly position: Vec3; readonly range: number }>;
type ClusterGridSize = { readonly x: number; readonly y: number; readonly z: number };

/** Project the current ordered light prefix. Each light writes exactly six grid coordinates. */
export function projectClusterLightBounds(
  lights: ClusterLights,
  lightCount: number,
  view: Mat4,
  proj: Mat4,
  grid: ClusterGridSize,
  near: number,
  far: number,
  scratch: ClusterBinScratch,
): void {
  if (lightCount === 0) return;
  if (scratch.lightBounds.length < lightCount * 6)
    scratch.lightBounds = new Int32Array(lightCount * 6);
  const lightBounds = scratch.lightBounds;
  const { x: gridX, y: gridY, z: gridZ } = grid;
  const scaleX = cameraAxisLength(view, 0),
    scaleY = cameraAxisLength(view, 1),
    scaleZ = cameraAxisLength(view, 2);
  const logFarOverNear = Math.log(far / near);
  // Unused coordinates of a rejected light cannot retain an earlier box.
  lightBounds.fill(0, 0, lightCount * 6);
  for (let lightIdx = 0; lightIdx < lightCount; lightIdx++) {
    const boundsOffset = lightIdx * 6;
    lightBounds[boundsOffset] = -1;
    const light = lights[lightIdx];
    if (!light) continue;
    // A no-cutoff source illuminates every visible cluster, including
    // when the light itself is outside the camera frustum.
    if (light.range === Number.POSITIVE_INFINITY) {
      lightBounds[boundsOffset] = 0;
      lightBounds[boundsOffset + 1] = 0;
      lightBounds[boundsOffset + 2] = 0;
      lightBounds[boundsOffset + 3] = gridX - 1;
      lightBounds[boundsOffset + 4] = gridY - 1;
      lightBounds[boundsOffset + 5] = gridZ - 1;
      continue;
    }
    const radius = light.range;

    if (radius <= 0) {
      continue;
    }

    const aabb = projectSphereAabb(
      light.position,
      radius,
      view,
      proj,
      scratch.aabbOutput,
      scaleX,
      scaleY,
      scaleZ,
    );

    const bounds = writeSphereCells(
      aabb,
      gridX,
      gridY,
      gridZ,
      near,
      far,
      logFarOverNear,
      scratch.boundsOutput,
    );
    if (bounds.min.x > bounds.max.x || bounds.min.y > bounds.max.y || bounds.min.z > bounds.max.z) {
      continue;
    }

    lightBounds[boundsOffset] = bounds.min.x;
    lightBounds[boundsOffset + 1] = bounds.min.y;
    lightBounds[boundsOffset + 2] = bounds.min.z;
    lightBounds[boundsOffset + 3] = bounds.max.x;
    lightBounds[boundsOffset + 4] = bounds.max.y;
    lightBounds[boundsOffset + 5] = bounds.max.z;
  }
}

/** Occupied cells and ordered runs depend only on the projected integer boxes. */
export function reserveProjectedClusterGrid(
  lightCount: number,
  grid: ClusterGridSize,
  clusterGrid: Uint32Array,
  capacity: number,
  scratch: ClusterBinScratch,
): number {
  return binProjected(lightCount, grid, clusterGrid, undefined, capacity, scratch);
}

/**
 * Main entry point: assign punctual lights to cluster cells.
 *
 * Light-major loop: for each light, compute its sphere-AABB and iterate the
 * intersecting cluster cells, appending the light index to the light_index_list
 * and updating cluster_grid offsets.
 *
 * @param lights — array of { position: Vec3, range: number }
 * @param view — view matrix (column-major 16 floats)
 * @param proj — projection matrix (column-major 16 floats)
 * @param grid — cluster grid dimensions { x, y, z }
 * @param near — near plane distance
 * @param far — far plane distance
 * @param clusterGrid — caller-owned Uint32Array, length = grid.x * grid.y * grid.z * 2.
 *   Format: [offset, count] pairs. offset = start index in lightIndexList; count = number of lights.
 * @param lightIndexList — caller-owned Uint32Array for light index storage.
 * @param capacity — max entries in lightIndexList; over it each cluster keeps its first K.
 * @param scratch — optional per-render-system typed scratch reused across frames.
 *
 * @returns `ok(written light-index entry count)`, never above `capacity`. The count lets the
 *   upload owner avoid copying unused capacity.
 */

export function bin(
  lights: ReadonlyArray<{ readonly position: Vec3; readonly range: number }>,
  view: Mat4,
  proj: Mat4,
  grid: { readonly x: number; readonly y: number; readonly z: number },
  near: number,
  far: number,
  clusterGrid: Uint32Array,
  lightIndexList: Uint32Array,
  capacity: number,
  scratch?: ClusterBinScratch,
  profile?: ClusterBinProfileRunner,
  options: ClusterBinOptions = {},
): Result<number, never> {
  const binScratch = scratch ?? createClusterBinScratch();
  return ok(
    binProjected(
      lights.length,
      grid,
      clusterGrid,
      options.writeMembership === false ? undefined : lightIndexList,
      capacity,
      binScratch,
      profile,
      () =>
        projectClusterLightBounds(lights, lights.length, view, proj, grid, near, far, binScratch),
    ),
  );
}

function binProjected(
  lightCount: number,
  grid: ClusterGridSize,
  clusterGrid: Uint32Array,
  lightIndexList: Uint32Array | undefined,
  capacity: number,
  binScratch: ClusterBinScratch,
  profile?: ClusterBinProfileRunner,
  project?: () => void,
): number {
  const gridX = grid.x;
  const gridY = grid.y;
  const gridZ = grid.z;
  const clusterCount = gridX * gridY * gridZ;

  ensureScratchCapacity(binScratch, clusterCount, lightCount, gridX, gridY, gridZ);
  const { clusterCounts, clusterCursors, lightBounds, clusterDeltas } = binScratch;

  let attemptedTotal = 0;

  runClusterBinProfilePhase(profile, 'light-bounds-and-occupancy', () => {
    if (project !== undefined)
      runClusterBinProfilePhase(profile, 'light-bounds-and-occupancy/light-aabb', project);

    runClusterBinProfilePhase(profile, 'light-bounds-and-occupancy/cluster-occupancy', () => {
      const diffX = gridX + 1;
      const diffY = gridY + 1;
      const diffRow = diffX * diffY;
      clusterDeltas.fill(0, 0, diffRow * (gridZ + 1));

      const addDifference = (x: number, y: number, z: number, delta: number): void => {
        const index = z * diffRow + y * diffX + x;
        clusterDeltas[index] = (clusterDeltas[index] ?? 0) + delta;
      };

      for (let lightIdx = 0; lightIdx < lightCount; lightIdx++) {
        const boundsOffset = lightIdx * 6;
        if ((lightBounds[boundsOffset] ?? -1) < 0) continue;
        const minX = lightBounds[boundsOffset] ?? 0;
        const minY = lightBounds[boundsOffset + 1] ?? 0;
        const minZ = lightBounds[boundsOffset + 2] ?? 0;
        const maxX = lightBounds[boundsOffset + 3] ?? -1;
        const maxY = lightBounds[boundsOffset + 4] ?? -1;
        const maxZ = lightBounds[boundsOffset + 5] ?? -1;
        const endX = maxX + 1;
        const endY = maxY + 1;
        const endZ = maxZ + 1;
        addDifference(minX, minY, minZ, 1);
        addDifference(endX, minY, minZ, -1);
        addDifference(minX, endY, minZ, -1);
        addDifference(minX, minY, endZ, -1);
        addDifference(endX, endY, minZ, 1);
        addDifference(endX, minY, endZ, 1);
        addDifference(minX, endY, endZ, 1);
        addDifference(endX, endY, endZ, -1);
      }
      // Sum raw X differences along this row. The previous Y and Z faces
      // already contain their full prefix; subtract their intersection once.
      let cell = 0;
      for (let z = 0; z < gridZ; z++) {
        for (let y = 0; y < gridY; y++) {
          let index = z * diffRow + y * diffX;
          let rowSum = 0;
          for (let x = 0; x < gridX; x++, index++, cell++) {
            rowSum += clusterDeltas[index] ?? 0;
            let count = rowSum;
            if (y > 0) count += clusterDeltas[index - diffX] ?? 0;
            if (z > 0) count += clusterDeltas[index - diffRow] ?? 0;
            if (y > 0 && z > 0) count -= clusterDeltas[index - diffRow - diffX] ?? 0;
            clusterDeltas[index] = count;
            clusterCounts[cell] = count;
            attemptedTotal += count;
          }
        }
      }
    });
  });

  // Over capacity every cluster keeps its first K entries (lowest light
  // indices); within capacity K is unbounded and the output is unchanged.
  const capK =
    attemptedTotal > capacity ? clusterEntryCapK(clusterCounts, clusterCount, capacity) : undefined;

  // Reserve one contiguous output run per cluster. The second light-major pass
  // below preserves each cluster's original light ordering without allocating
  // one JavaScript array per cluster.
  const writeCount = runClusterBinProfilePhase(profile, 'cluster-reserve', () => {
    let reserved = 0;
    let occupied = 0;
    for (let ci = 0; ci < clusterCount; ci++) {
      const base = ci * 2;
      const count =
        capK === undefined ? (clusterCounts[ci] ?? 0) : Math.min(clusterCounts[ci] ?? 0, capK);
      clusterGrid[base] = reserved;
      clusterGrid[base + 1] = count;
      clusterCursors[ci] = reserved;
      reserved += count;
      if (count > 0) occupied++;
    }
    binScratch.occupiedClusterCount = occupied;
    return reserved;
  });
  binScratch.clusterEntryCapK = capK;
  binScratch.droppedClusterEntries = attemptedTotal - writeCount;

  if (capK !== undefined && lightIndexList !== undefined) {
    runClusterBinProfilePhase(profile, 'light-index-write', () =>
      writeCappedClusterMembership(
        lightCount,
        lightBounds,
        gridX,
        gridY,
        gridZ,
        clusterGrid,
        clusterCursors,
        lightIndexList,
        clusterDeltas,
      ),
    );
    return writeCount;
  }

  if (lightIndexList !== undefined && profile === undefined) {
    writeClusterMembership(lightCount, lightBounds, gridX, gridY, clusterCursors, lightIndexList);
  } else if (lightIndexList !== undefined) {
    runClusterBinProfilePhase(profile, 'light-index-write', () => {
      let end = 0;
      for (let light = 0; light < lightCount; light = end) {
        end = runClusterBinProfilePhase(profile, 'light-index-write/bounds-read', () =>
          endOfLightBoxRun(lightBounds, light, lightCount),
        );
        if ((lightBounds[light * 6] ?? -1) >= 0)
          runClusterBinProfilePhase(profile, 'light-index-write/cluster-write', () =>
            writeClusterBoxRun(
              light,
              end,
              lightBounds,
              gridX,
              gridY,
              clusterCursors,
              lightIndexList,
            ),
          );
      }
    });
  }

  return writeCount;
}
