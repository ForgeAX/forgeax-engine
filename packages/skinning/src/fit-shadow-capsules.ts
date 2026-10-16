import {
  MAX_SHADOW_CAPSULES_PER_SKELETON,
  type MeshAsset,
  SHADOW_CAPSULE_STRIDE,
  type ShadowCapsuleSet,
} from '@forgeax/engine-types';

/** Default cap for fitted capsules; the loader accepts up to the hard cap. */
const DEFAULT_MAX_CAPSULES = 32;
const MIN_POINTS_PER_CAPSULE = 8;
const MIN_RADIUS = 0.01;
const AXIS_LOW_QUANTILE = 0.05;
const AXIS_HIGH_QUANTILE = 0.95;
// Biased inward so the capsule stays inside the skin and the mesh can receive
// its own capsule shadow without a hard black interior.
const RADIUS_QUANTILE = 0.25;
const POWER_ITERATIONS = 32;

export interface FitShadowCapsulesOptions {
  /** Keep at most this many capsules, largest volume first. Default 32, max 64. */
  readonly maxCapsules?: number;
}

type IndexArray = Float32Array | Uint16Array | Uint8Array | Uint32Array;

function indexArray(value: unknown): IndexArray | undefined {
  return value instanceof Float32Array ||
    value instanceof Uint16Array ||
    value instanceof Uint8Array ||
    value instanceof Uint32Array
    ? value
    : undefined;
}

function quantile(sorted: Float64Array, q: number): number {
  return sorted[Math.floor(q * (sorted.length - 1))] as number;
}

/** Principal axis of a centred point cloud: power iteration seeded by the dominant covariance column. */
function principalAxis(
  points: readonly number[],
  cx: number,
  cy: number,
  cz: number,
): [number, number, number] {
  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (let index = 0; index < points.length; index += 3) {
    const x = (points[index] as number) - cx;
    const y = (points[index + 1] as number) - cy;
    const z = (points[index + 2] as number) - cz;
    xx += x * x;
    xy += x * y;
    xz += x * z;
    yy += y * y;
    yz += y * z;
    zz += z * z;
  }
  const columns: [number, number, number][] = [
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ];
  const norms = columns.map((column) => Math.hypot(column[0], column[1], column[2]));
  let axis = columns[norms.indexOf(Math.max(...norms))] as [number, number, number];
  for (let step = 0; step < POWER_ITERATIONS; step++) {
    const length = Math.hypot(...axis);
    if (length === 0) return [0, 1, 0];
    const [ax, ay, az] = [axis[0] / length, axis[1] / length, axis[2] / length];
    axis = [xx * ax + xy * ay + xz * az, xy * ax + yy * ay + yz * az, xz * ax + yz * ay + zz * az];
  }
  const length = Math.hypot(...axis);
  if (length === 0) return [0, 1, 0];
  const dominant = axis.reduce((best, value) => (Math.abs(value) > Math.abs(best) ? value : best));
  const sign = dominant < 0 ? -1 : 1;
  return [(sign * axis[0]) / length, (sign * axis[1]) / length, (sign * axis[2]) / length];
}

interface FittedCapsule {
  readonly joint: number;
  readonly shape: readonly number[];
  readonly volume: number;
}

function fitJoint(joint: number, points: readonly number[]): FittedCapsule | undefined {
  const count = points.length / 3;
  if (count < MIN_POINTS_PER_CAPSULE) return undefined;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let index = 0; index < points.length; index += 3) {
    cx += points[index] as number;
    cy += points[index + 1] as number;
    cz += points[index + 2] as number;
  }
  cx /= count;
  cy /= count;
  cz /= count;
  const [ax, ay, az] = principalAxis(points, cx, cy, cz);
  const along = new Float64Array(count);
  const across = new Float64Array(count);
  for (let point = 0; point < count; point++) {
    const x = (points[point * 3] as number) - cx;
    const y = (points[point * 3 + 1] as number) - cy;
    const z = (points[point * 3 + 2] as number) - cz;
    const t = x * ax + y * ay + z * az;
    along[point] = t;
    across[point] = Math.hypot(x - t * ax, y - t * ay, z - t * az);
  }
  along.sort();
  across.sort();
  const radius = quantile(across, RADIUS_QUANTILE);
  if (!(radius >= MIN_RADIUS)) return undefined;
  let start = quantile(along, AXIS_LOW_QUANTILE) + radius;
  let end = quantile(along, AXIS_HIGH_QUANTILE) - radius;
  if (start > end) {
    start = (start + end) / 2;
    end = start;
  }
  return {
    joint,
    shape: [
      cx + start * ax,
      cy + start * ay,
      cz + start * az,
      cx + end * ax,
      cy + end * ay,
      cz + end * az,
      radius,
    ],
    volume: Math.PI * radius * radius * (end - start + (4 / 3) * radius),
  };
}

/**
 * Fit directional shadow capsules to skinned meshes in bind space.
 *
 * Each vertex joins its highest-weight joint; each joint's point cloud yields
 * one capsule along its principal axis, sized inward so it stays inside the
 * surface. Joints with too few points or a sub-centimetre radius are skipped.
 * Pass every mesh bound to the skeleton so shared joints see all vertices.
 * Returns `undefined` when no mesh carries skin attributes or no joint
 * qualifies; the result is deterministic for identical input.
 */
export function fitShadowCapsules(
  meshes: readonly Pick<MeshAsset, 'attributes'>[],
  jointCount: number,
  options: FitShadowCapsulesOptions = {},
): ShadowCapsuleSet | undefined {
  const limit = Math.min(
    MAX_SHADOW_CAPSULES_PER_SKELETON,
    Math.max(0, Math.floor(options.maxCapsules ?? DEFAULT_MAX_CAPSULES)),
  );
  const perJoint: number[][] = Array.from({ length: jointCount }, () => []);
  for (const mesh of meshes) {
    const positions = mesh.attributes.position;
    const skinIndex = indexArray(mesh.attributes.skinIndex);
    const skinWeight = indexArray(mesh.attributes.skinWeight);
    if (!(positions instanceof Float32Array) || skinIndex === undefined || skinWeight === undefined)
      continue;
    const vertexCount = Math.min(positions.length / 3, skinIndex.length / 4, skinWeight.length / 4);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      let joint = -1;
      let weight = 0;
      for (let lane = 0; lane < 4; lane++) {
        const laneWeight = skinWeight[vertex * 4 + lane] as number;
        if (laneWeight > weight) {
          weight = laneWeight;
          joint = skinIndex[vertex * 4 + lane] as number;
        }
      }
      const bucket = perJoint[joint];
      if (bucket === undefined) continue;
      bucket.push(
        positions[vertex * 3] as number,
        positions[vertex * 3 + 1] as number,
        positions[vertex * 3 + 2] as number,
      );
    }
  }
  const fitted: FittedCapsule[] = [];
  for (let joint = 0; joint < jointCount; joint++) {
    const capsule = fitJoint(joint, perJoint[joint] as number[]);
    if (capsule !== undefined) fitted.push(capsule);
  }
  const kept = fitted
    .sort((a, b) => b.volume - a.volume || a.joint - b.joint)
    .slice(0, limit)
    .sort((a, b) => a.joint - b.joint);
  if (kept.length === 0) return undefined;
  const joints = new Uint16Array(kept.length);
  const shapes = new Float32Array(kept.length * SHADOW_CAPSULE_STRIDE);
  kept.forEach((capsule, index) => {
    joints[index] = capsule.joint;
    shapes.set(capsule.shape, index * SHADOW_CAPSULE_STRIDE);
  });
  return { joints, shapes };
}
