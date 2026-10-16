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
//     -> Result<writtenLightIndexCount, ClusterBinError>
//
//   deriveCullingRadius(range, intensity, threshold) — D-8 +Infinity fallback
//
// Constraints:
//   D-3: pure function + Result<number, ClusterBinError> + out param + no throw
//   D-8: spot uses sphere proxy (radius=range)
//   D-binner: CPU main thread, no GPU compute / worker
//   OOS-4: cone-AABB tight culling deferred
//   AGENTS.md conventions: structured errors, never throw for expected failures
//
// Capacity: max 65536 light index list entries (hard cap, AC-24).
// Grid: {x,y,z} each in [1, 64] integers (validated at install time).

import { type Mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import { err, ok, type Result } from '@forgeax/engine-rhi';

// ── types ──────────────────────────────────────────────────────────────────

export type ClusterBinErrorCode = 'index-overflow';

export interface ClusterBinError {
  readonly code: ClusterBinErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: IndexOverflowDetail;
}

export interface IndexOverflowDetail {
  readonly actual: number;
  readonly capacity: number;
}

/**
 * View-space NDC axis-aligned bounding box.
 * `min` and `max` are NDC coordinates clamped to [-1, 1] for XY;
 * Z may extend to projection-space depth values.
 */
export interface ClusterAabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Unsigned integer 3D cluster cell coordinate. */
export interface Uvec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Cluster cell range in the unsigned grid. */
export interface ClusterBounds {
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
}

/**
 * Selects the membership materialization owner after bounds and occupancy are
 * derived. The default keeps the existing CPU list writer; the WebGPU
 * producer uses the same CPU-owned scratch and leaves the ordered list to a
 * later compute pass.
 */
export interface ClusterBinOptions {
  readonly writeMembership?: boolean;
}

export type ClusterBinProfilePhase =
  | 'light-bounds-and-occupancy'
  | 'light-bounds-and-occupancy/light-aabb'
  | 'light-bounds-and-occupancy/cluster-occupancy'
  | 'cluster-reserve'
  | 'light-index-write'
  | 'light-index-write/bounds-read'
  | 'light-index-write/cluster-write';

export type ClusterBinProfileRunner = <T>(phase: ClusterBinProfilePhase, action: () => T) => T;

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
  };
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

// ── deriveCullingRadius ────────────────────────────────────────────────────

/**
 * Compute a culling radius for a punctual light.
 *
 * If `range` is finite, returns it verbatim (D-8 sphere proxy).
 * If `range === +Infinity`, derives a finite radius from the distance at which
 * the light's perceptible contribution drops below `threshold`.
 *
 * Formula: `sqrt(intensity / threshold)` gives the distance at which attenuation
 * = threshold (assuming E=1/r^2 falloff for point lights).
 * Cap to a conservative 1000 units to prevent overly large bounds.
 */
export function deriveCullingRadius(range: number, intensity: number, threshold = 0.001): number {
  if (Number.isFinite(range)) {
    return Math.max(0, range);
  }
  const derived = Math.sqrt(intensity / threshold);
  return Math.min(derived, 1000);
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
  if (viewZ >= -near) {
    return 0;
  }
  const logFarOverNear = Math.log(far / near);
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
 *   4. Clamp to [-1, 1] for XY ; Z is kept as projected depth.
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

  const viewScaleX = Math.hypot(v00, v01, v02);
  const viewScaleY = Math.hypot(v10, v11, v12);
  const viewScaleZ = Math.hypot(v20, v21, v22);

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
    Math.abs(proj[3] ?? 0) < 1e-8 &&
    Math.abs(proj[7] ?? 0) < 1e-8 &&
    Math.abs(proj[15] ?? 0) < 1e-8 &&
    Math.abs(p23) >= 1e-5;

  if (perspectiveWOnlyZ) {
    const xExtent = Math.abs(p00) * rx + Math.abs(p10) * ry;
    const yExtent = Math.abs(p01) * rx + Math.abs(p11) * ry;
    for (let face = 0; face < 2; face++) {
      const zTest = face === 0 ? minViewZ : maxViewZ;
      if (zTest > 0) continue;
      const invW = 1 / (p23 * zTest);
      const xCenter = p20 * zTest + p30;
      const yCenter = p21 * zTest + p31;
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
    const corners: Array<[number, number]> = [
      [vMinX, vMinY],
      [vMinX, vMaxY],
      [vMaxX, vMinY],
      [vMaxX, vMaxY],
    ];

    for (const zTest of [minViewZ, maxViewZ]) {
      if (zTest <= 0) {
        for (const corner of corners) {
          const sx = corner[0];
          const sy = corner[1];
          const ndc = projectToNdc(sx, sy, zTest, proj);
          ndcMinX = Math.min(ndcMinX, ndc[0]);
          ndcMaxX = Math.max(ndcMaxX, ndc[0]);
          ndcMinY = Math.min(ndcMinY, ndc[1]);
          ndcMaxY = Math.max(ndcMaxY, ndc[1]);
        }
      }
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

/**
 * Project a view-space point to NDC via the perspective projection matrix.
 * Returns [ndc_x, ndc_y, ndc_z].
 */
function projectToNdc(vx: number, vy: number, vz: number, proj: Mat4): [number, number, number] {
  const p00 = proj[0] ?? 0;
  const p10 = proj[4] ?? 0;
  const p20 = proj[8] ?? 0;
  const p30 = proj[12] ?? 0;
  const p01 = proj[1] ?? 0;
  const p11 = proj[5] ?? 0;
  const p21 = proj[9] ?? 0;
  const p31 = proj[13] ?? 0;
  const p02 = proj[2] ?? 0;
  const p12 = proj[6] ?? 0;
  const p22 = proj[10] ?? 0;
  const p32 = proj[14] ?? 0;
  const p03 = proj[3] ?? 0;
  const p13 = proj[7] ?? 0;
  const p23 = proj[11] ?? 0;
  const p33 = proj[15] ?? 0;

  const cx = p00 * vx + p10 * vy + p20 * vz + p30;
  const cy = p01 * vx + p11 * vy + p21 * vz + p31;
  const cz = p02 * vx + p12 * vy + p22 * vz + p32;
  const cw = p03 * vx + p13 * vy + p23 * vz + p33;

  if (Math.abs(cw) < 1e-10) {
    return [vx < 0 ? -1 : 1, vy < 0 ? -1 : 1, cz];
  }

  const invW = 1 / cw;
  return [cx * invW, cy * invW, cz * invW];
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
  const ndcX = ndc[0] ?? 0;
  const ndcY = ndc[1] ?? 0;

  let cx = Math.floor((ndcX * 0.5 + 0.5) * gridX);
  let cy = Math.floor((ndcY * 0.5 + 0.5) * gridY);

  if (cx < 0) cx = 0;
  if (cx >= gridX) cx = gridX - 1;
  if (cy < 0) cy = 0;
  if (cy >= gridY) cy = gridY - 1;

  const cz = viewZToZSlice(viewZ, gridZ, near, far);

  return { x: cx, y: cy, z: cz };
}

// ── calculate_sphere_cluster_bounds ─────────────────────────────────────────

/**
 * Convert an NDC AABB to a range of cluster cell indices.
 *
 * Computes cluster indices for AABB min and max, then clamps and
 * orders the result so `min <= max` in each axis.
 *
 * If the sphere is entirely behind the camera, returns min > max
 * in at least one axis (cull signal).
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
  const minZ = aabb.min[2] ?? 0;
  const maxZ = aabb.max[2] ?? 0;

  const idxMin = ndcPositionToCluster(aabb.min, minZ, gridX, gridY, gridZ, near, far);
  const idxMax = ndcPositionToCluster(aabb.max, maxZ, gridX, gridY, gridZ, near, far);

  result.min.x = Math.min(idxMin.x, idxMax.x);
  result.min.y = Math.min(idxMin.y, idxMax.y);
  result.min.z = Math.min(idxMin.z, idxMax.z);
  result.max.x = Math.max(idxMin.x, idxMax.x);
  result.max.y = Math.max(idxMin.y, idxMax.y);
  result.max.z = Math.max(idxMin.z, idxMax.z);
  return result;
}

// ── bin ─────────────────────────────────────────────────────────────────────

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
 * @param capacity — max entries in lightIndexList (hard cap, typically 65536).
 * @param scratch — optional per-render-system typed scratch reused across frames.
 *
 * @returns `ok(written light-index entry count)` on success; `err(ClusterBinError)` with code
 *   'index-overflow' on overflow. The count lets the upload owner avoid copying unused capacity.
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
): Result<number, ClusterBinError> {
  const gridX = grid.x;
  const gridY = grid.y;
  const gridZ = grid.z;
  const clusterCount = gridX * gridY * gridZ;
  const binScratch = scratch ?? createClusterBinScratch();

  ensureScratchCapacity(binScratch, clusterCount, lights.length, gridX, gridY, gridZ);
  const { clusterCounts, clusterCursors, lightBounds, clusterDeltas } = binScratch;

  clusterGrid.fill(0, 0, clusterCount * 2);
  clusterCounts.fill(0, 0, clusterCount);

  let attemptedTotal = 0;

  runClusterBinProfilePhase(profile, 'light-bounds-and-occupancy', () => {
    runClusterBinProfilePhase(profile, 'light-bounds-and-occupancy/light-aabb', () => {
      for (let lightIdx = 0; lightIdx < lights.length; lightIdx++) {
        const boundsOffset = lightIdx * 6;
        lightBounds[boundsOffset] = -1;
        const light = lights[lightIdx];
        if (!light) continue;
        const radius = deriveCullingRadius(light.range, 1);

        if (radius <= 0) {
          continue;
        }

        const aabb = clusterSpaceObjectAabb(
          light.position,
          radius,
          view,
          proj,
          binScratch.aabbOutput,
        );

        const bounds = calculateSphereClusterBounds(
          aabb,
          gridX,
          gridY,
          gridZ,
          near,
          far,
          binScratch.boundsOutput,
        );
        if (
          bounds.min.x > bounds.max.x ||
          bounds.min.y > bounds.max.y ||
          bounds.min.z > bounds.max.z
        ) {
          continue;
        }

        lightBounds[boundsOffset] = bounds.min.x;
        lightBounds[boundsOffset + 1] = bounds.min.y;
        lightBounds[boundsOffset + 2] = bounds.min.z;
        lightBounds[boundsOffset + 3] = bounds.max.x;
        lightBounds[boundsOffset + 4] = bounds.max.y;
        lightBounds[boundsOffset + 5] = bounds.max.z;
      }
    });

    runClusterBinProfilePhase(profile, 'light-bounds-and-occupancy/cluster-occupancy', () => {
      const diffX = gridX + 1;
      const diffY = gridY + 1;
      const diffRow = diffX * diffY;
      clusterDeltas.fill(0, 0, diffRow * (gridZ + 1));

      const addDifference = (x: number, y: number, z: number, delta: number): void => {
        const index = z * diffRow + y * diffX + x;
        clusterDeltas[index] = (clusterDeltas[index] ?? 0) + delta;
      };

      for (let lightIdx = 0; lightIdx < lights.length; lightIdx++) {
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
      for (let cz = 0; cz < gridZ; cz++) {
        for (let cy = 0; cy < gridY; cy++) {
          for (let cx = 0; cx < gridX; cx++) {
            const diffIdx = cz * diffRow + cy * diffX + cx;
            let count = clusterDeltas[diffIdx] ?? 0;
            if (cx > 0) count += clusterDeltas[diffIdx - 1] ?? 0;
            if (cy > 0) count += clusterDeltas[diffIdx - diffX] ?? 0;
            if (cz > 0) count += clusterDeltas[diffIdx - diffRow] ?? 0;
            if (cx > 0 && cy > 0) count -= clusterDeltas[diffIdx - diffX - 1] ?? 0;
            if (cx > 0 && cz > 0) count -= clusterDeltas[diffIdx - diffRow - 1] ?? 0;
            if (cy > 0 && cz > 0) count -= clusterDeltas[diffIdx - diffRow - diffX] ?? 0;
            if (cx > 0 && cy > 0 && cz > 0) {
              count += clusterDeltas[diffIdx - diffRow - diffX - 1] ?? 0;
            }
            clusterDeltas[diffIdx] = count;
            const clusterIdx = cz * gridY * gridX + cy * gridX + cx;
            clusterCounts[clusterIdx] = count;
            attemptedTotal += count;
          }
        }
      }
    });
  });

  if (attemptedTotal > capacity) {
    return err({
      code: 'index-overflow',
      expected: `writeCount <= ${capacity}`,
      hint: `light index list overflow: needed ${attemptedTotal} entries, capacity ${capacity}; reduce lights, shrink grid, or shrink ranges (overrun = ${attemptedTotal - capacity})`,
      detail: { actual: attemptedTotal, capacity },
    });
  }

  // Reserve one contiguous output run per cluster. The second light-major pass
  // below preserves each cluster's original light ordering without allocating
  // one JavaScript array per cluster.
  const writeCount = runClusterBinProfilePhase(profile, 'cluster-reserve', () => {
    let reserved = 0;
    for (let ci = 0; ci < clusterCount; ci++) {
      const base = ci * 2;
      clusterGrid[base] = reserved;
      clusterGrid[base + 1] = clusterCounts[ci] ?? 0;
      clusterCursors[ci] = reserved;
      reserved += clusterCounts[ci] ?? 0;
    }
    return reserved;
  });

  if (options.writeMembership !== false) {
    runClusterBinProfilePhase(profile, 'light-index-write', () => {
      for (let lightIdx = 0; lightIdx < lights.length; lightIdx++) {
        const boundsOffset = lightIdx * 6;
        let valid = false;
        let minX = 0;
        let minY = 0;
        let minZ = 0;
        let maxX = -1;
        let maxY = -1;
        let maxZ = -1;
        runClusterBinProfilePhase(profile, 'light-index-write/bounds-read', () => {
          if ((lightBounds[boundsOffset] ?? -1) < 0) return;
          valid = true;
          minX = lightBounds[boundsOffset] ?? 0;
          minY = lightBounds[boundsOffset + 1] ?? 0;
          minZ = lightBounds[boundsOffset + 2] ?? 0;
          maxX = lightBounds[boundsOffset + 3] ?? -1;
          maxY = lightBounds[boundsOffset + 4] ?? -1;
          maxZ = lightBounds[boundsOffset + 5] ?? -1;
        });
        if (!valid) continue;
        runClusterBinProfilePhase(profile, 'light-index-write/cluster-write', () => {
          for (let cz = minZ; cz <= maxZ; cz++) {
            for (let cy = minY; cy <= maxY; cy++) {
              for (let cx = minX; cx <= maxX; cx++) {
                const clusterIdx = cz * gridY * gridX + cy * gridX + cx;
                const cursor = clusterCursors[clusterIdx] ?? 0;
                lightIndexList[cursor] = lightIdx;
                clusterCursors[clusterIdx] = cursor + 1;
              }
            }
          }
        });
      }
    });
  }

  return ok(writeCount);
}
