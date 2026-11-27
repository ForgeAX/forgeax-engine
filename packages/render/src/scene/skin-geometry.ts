import { meshAttributeWindow, skinWeightDenominator } from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';

/** Admit the three typed influence windows without retaining mesh bytes. */
function skinGeometryWindows(mesh: MeshAsset) {
  const position = meshAttributeWindow(mesh, 'position');
  const index = meshAttributeWindow(mesh, 'skinIndex');
  const weight = meshAttributeWindow(mesh, 'skinWeight');
  if (
    !position ||
    !index ||
    !weight ||
    !(position.data instanceof Float32Array) ||
    !(index.data instanceof Uint16Array) ||
    !Number.isInteger(position.count) ||
    position.count <= 0 ||
    index.count !== position.count ||
    weight.count !== position.count
  )
    return undefined;
  return { position, index, weight };
}

/** vec4 header (minimum sum, maximum sum, required joints, envelope count),
 * then two vec4s per used joint: (minimum.xyz, joint index), (maximum.xyz, 0).
 * Derived once at an admitted Mesh edit; retains no vertex bytes or pose facts.
 */
export function skinGeometryEnvelopes(mesh: MeshAsset): Float32Array | undefined {
  // A base-position envelope cannot prove visibility after authored morphing.
  if (mesh.morphTargets !== undefined && mesh.morphTargets.length > 0) return undefined;
  const geometry = skinGeometryWindows(mesh);
  if (geometry === undefined) return undefined;
  const { position, index, weight } = geometry;
  const positions = position.data,
    indices = index.data,
    weights = weight.data;
  const weightUnit = skinWeightDenominator(weights);
  const bounds = new Map<number, number[]>();
  let minimumSum = Infinity,
    maximumSum = 0,
    requiredJoints = 0;
  for (let vertex = 0; vertex < position.count; vertex++) {
    const x = positions[position.offset + vertex * position.stride] as number;
    const y = positions[position.offset + vertex * position.stride + 1] as number;
    const z = positions[position.offset + vertex * position.stride + 2] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
    let sum = 0;
    for (let lane = 0; lane < 4; lane++) {
      const joint = indices[index.offset + vertex * index.stride + lane] as number;
      const rawWeight = weights[weight.offset + vertex * weight.stride + lane] as number;
      const influence = Math.fround(rawWeight / weightUnit);
      // Individual subnormal weights may all flush to zero even when their
      // positive sum is normal, so homogeneous w has no portable lower bound.
      if (!Number.isFinite(influence) || influence < 0 || (influence > 0 && influence < 2 ** -126))
        return undefined;
      requiredJoints = Math.max(requiredJoints, joint + 1);
      sum += influence;
      if (influence === 0) continue;
      const box = bounds.get(joint);
      if (box === undefined) bounds.set(joint, [x, y, z, x, y, z]);
      else {
        box[0] = Math.min(box[0] as number, x);
        box[1] = Math.min(box[1] as number, y);
        box[2] = Math.min(box[2] as number, z);
        box[3] = Math.max(box[3] as number, x);
        box[4] = Math.max(box[4] as number, y);
        box[5] = Math.max(box[5] as number, z);
      }
    }
    if (!(sum > 0) || !Number.isFinite(sum)) return undefined;
    minimumSum = Math.min(minimumSum, sum);
    maximumSum = Math.max(maximumSum, sum);
  }
  if (!Number.isFinite(Math.fround(maximumSum))) return undefined;
  const packed = new Float32Array(4 + bounds.size * 8);
  packed[0] = minimumSum;
  packed[1] = maximumSum;
  // Both sums are positive. Round the interval outwards, including subnormal sums.
  const words = new DataView(packed.buffer);
  if ((packed[0] as number) > minimumSum) words.setUint32(0, words.getUint32(0, true) - 1, true);
  if ((packed[1] as number) < maximumSum) words.setUint32(4, words.getUint32(4, true) + 1, true);
  if (!Number.isFinite(packed[1])) return undefined;
  packed[2] = requiredJoints;
  packed[3] = bounds.size;
  let at = 4;
  for (const [joint, box] of bounds) {
    packed[at] = box[0] as number;
    packed[at + 1] = box[1] as number;
    packed[at + 2] = box[2] as number;
    packed[at + 3] = joint;
    packed[at + 4] = box[3] as number;
    packed[at + 5] = box[4] as number;
    packed[at + 6] = box[5] as number;
    at += 8;
  }
  return packed;
}
