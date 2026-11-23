import { copyMeshAttribute, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { box3, mat4, quat, vec3 } from '@forgeax/engine-math';
import type { MeshAsset, SkeletonAsset } from '@forgeax/engine-types';
import { Matrix3, Matrix4, SkinnedMesh, Vector3, Vector4 } from 'three/src/Three.Core.js';
import { invalidError } from './compatibility-error';
import { invalid } from './errors';
import { hasPositiveUniformSourceBasis } from './pose';
import type { SkinCursor } from './skeleton-changes';

export function skinValues(mesh: SkinnedMesh): unknown[] {
  return [
    mesh.skeleton.bones.length,
    ...mesh.skeleton.boneInverses.flatMap((matrix) => matrix.elements),
  ];
}

/** Native world-space palettes: P * jointWorld * (inverseBind * bindMatrix). */
export function projectSkeleton(mesh: SkinnedMesh): SkeletonAsset {
  const { skeleton } = mesh;
  if (
    skeleton.bones.length < 1 ||
    skeleton.bones.length > 256 ||
    skeleton.boneInverses.length !== skeleton.bones.length
  )
    return invalid('SkinnedMesh skeleton joint count/inverse binds', mesh.uuid).unwrap();
  const inverseBindMatrices = new Float32Array(skeleton.bones.length * 16);
  for (let index = 0; index < skeleton.bones.length; index++) {
    const matrix = skeleton.boneInverses[index]?.clone().multiply(mesh.bindMatrix);
    if (matrix === undefined || !matrix.elements.every(Number.isFinite))
      return invalid('SkinnedMesh inverse bind values', mesh.uuid).unwrap();
    inverseBindMatrices.set(matrix.elements, index * 16);
  }
  return { kind: 'skeleton', jointCount: skeleton.bones.length, inverseBindMatrices };
}

export function projectJoints(mesh: SkinnedMesh, cache?: JointSnapshots, cursor?: SkinCursor) {
  return (
    nativeJoints(mesh, cache, cursor) ??
    invalid('SkinnedMesh joint world transform', mesh.uuid).unwrap()
  );
}

type JointPose = { pos: Float32Array; quat: Float32Array; scale: Float32Array };
export type JointSnapshots = WeakMap<
  SkinnedMesh,
  {
    pre: Matrix4;
    worlds: Float64Array;
    joints: JointPose[];
    layout?: object | undefined;
    patch?: { version: number; indices: number[] } | undefined;
  }
>;

function nativeJoints(mesh: SkinnedMesh, cache?: JointSnapshots, cursor?: SkinCursor) {
  const pre = new Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
  const bones = mesh.skeleton.bones;
  const previous = cache?.get(mesh);
  const layout = cursor?.owner.poseLayout;
  const comparable =
    previous &&
    previous.joints.length === bones.length &&
    previous.pre.equals(pre) &&
    previous.layout === layout;
  const dirty = comparable && layout ? cursor?.dirty : undefined;
  if (cursor) cursor.work.jointReads += dirty ? dirty.size : bones.length;
  if (dirty?.size === 0 && previous) return previous.joints;
  const changes: { index: number; pose: JointPose; elements: number[] }[] = [];
  const matrix = new Matrix4();
  const read = (index: number): boolean => {
    const bone = bones[index];
    if (!bone) return false;
    const elements = bone.matrixWorld.elements;
    if (
      !layout &&
      comparable &&
      elements.every((value, i) => Object.is(value, previous.worlds[index * 16 + i]))
    )
      return true;
    matrix.multiplyMatrices(pre, bone.matrixWorld);
    const pos = vec3.create(),
      rotation = quat.create(),
      scale = vec3.create(),
      shear = vec3.create();
    if (!mat4.decomposeAffine(pos, rotation, scale, shear, matrix.elements)) return false;
    changes.push({ index, elements, pose: { pos, quat: rotation, scale } });
    return true;
  };
  // Validate the entire patch before changing any accepted pose.
  if (dirty) {
    for (const index of dirty)
      if (!read(index)) {
        cache?.delete(mesh);
        return undefined;
      }
  } else {
    for (let index = 0; index < bones.length; index++)
      if (!read(index)) {
        cache?.delete(mesh);
        return undefined;
      }
  }
  if (!changes.length && comparable) return previous.joints;
  const joints = comparable ? (layout ? previous.joints : previous.joints.slice()) : [];
  const worlds = layout
    ? emptyWorlds
    : comparable
      ? previous.worlds.slice()
      : new Float64Array(bones.length * 16);
  for (const { index, elements, pose } of changes) {
    joints[index] = pose;
    if (!layout) worlds.set(elements, index * 16);
  }
  const patch = layout
    ? {
        version: (previous?.patch?.version ?? 0) + 1,
        indices: changes.map((change) => change.index),
      }
    : undefined;
  cache?.set(mesh, { pre, worlds, joints, layout, patch });
  cursor?.dirty.clear();
  return joints;
}
const emptyWorlds = new Float64Array(0);

function isAffine(matrix: Matrix4): boolean {
  const e = matrix.elements;
  return e[3] === 0 && e[7] === 0 && e[11] === 0 && e[15] === 1;
}

/** Positive similarity preserves the Three normal direction in world space. */
export function projectLitJoints(
  mesh: SkinnedMesh,
  cache?: JointSnapshots,
  cursor?: SkinCursor,
): ReturnType<typeof nativeJoints> {
  if (!canProjectLitSkin(mesh, cursor)) return;
  return nativeJoints(mesh, cache, cursor);
}

export function canProjectLitSkin(mesh: SkinnedMesh, cursor?: SkinCursor): boolean {
  return (
    canProjectAffinePoint(mesh, cursor) &&
    hasPositiveUniformSourceBasis(mesh) &&
    mesh.matrixWorld.determinant() > 0 &&
    !Object.values(mesh.geometry.morphAttributes).some((attributes) => attributes?.length)
  );
}

export function canProjectAffinePoint(mesh: SkinnedMesh, cursor?: SkinCursor): boolean {
  return (
    mesh.applyBoneTransform === SkinnedMesh.prototype.applyBoneTransform &&
    isAffine(mesh.matrixWorld) &&
    isAffine(mesh.bindMatrix) &&
    isAffine(mesh.bindMatrixInverse) &&
    (cursor?.owner.binding?.affine ?? mesh.skeleton.boneInverses.every(isAffine))
  );
}

export function cpuSkinValues(mesh: SkinnedMesh, cursor?: SkinCursor): unknown[] {
  return [
    ...(cursor?.owner.binding ? [cursor.owner.binding] : skinValues(mesh)),
    ...mesh.bindMatrix.elements,
    ...mesh.bindMatrixInverse.elements,
    ...(cursor?.owner.poseLayout
      ? [cursor.owner.poseLayout, cursor.owner.revision]
      : mesh.skeleton.bones.flatMap((bone) => bone.matrixWorld.elements)),
    ...(mesh.morphTargetInfluences ?? []),
  ];
}

export interface CpuSkinGeometry {
  readonly base: MeshAsset;
  readonly weights: Float32Array | undefined;
  readonly singleJoint: Uint16Array | undefined;
  readonly maxJoint: number;
}

/** A rigidly weighted source can reuse one point and direction transform per joint. */
export function cpuSkinGeometry(base: MeshAsset): CpuSkinGeometry {
  const indices = base.attributes.skinIndex;
  const weights =
    base.attributeStorage === undefined && base.attributes.skinWeight instanceof Float32Array
      ? base.attributes.skinWeight
      : copyMeshAttribute(base, 'skinWeight');
  if (
    base.morphTargets !== undefined ||
    !(indices instanceof Uint16Array) ||
    !(weights instanceof Float32Array)
  )
    return { base, weights, singleJoint: undefined, maxJoint: 0 };

  const singleJoint = new Uint16Array(indices.length / 4);
  let maxJoint = 0;
  for (let vertex = 0; vertex < singleJoint.length; vertex++) {
    let joint: number | undefined;
    for (let lane = vertex * 4; lane < vertex * 4 + 4; lane++) {
      const index = indices[lane] ?? 0;
      const weight = weights[lane];
      maxJoint = Math.max(maxJoint, index);
      if (weight === 0) continue;
      if (weight !== 1 || joint !== undefined)
        return { base, weights, singleJoint: undefined, maxJoint: 0 };
      joint = index;
    }
    if (joint === undefined) return { base, weights, singleJoint: undefined, maxJoint: 0 };
    singleJoint[vertex] = joint;
  }
  return { base, weights, singleJoint, maxJoint };
}

function applySingleJointSkin(
  mesh: SkinnedMesh,
  palette: readonly (Matrix4 | undefined)[],
  joints: Uint16Array,
  position: Float32Array,
  normal: Float32Array,
  tangent: Float32Array,
): void {
  const transforms = palette.map((entry) => {
    if (entry === undefined) return invalid('SkinnedMesh joint index/weight', mesh.uuid).unwrap();
    const point = entry.clone().multiply(mesh.bindMatrix);
    const direction = new Matrix3().setFromMatrix4(mesh.bindMatrixInverse.clone().multiply(point));
    // Three uses the blended xyz as a point with w=1 in bind-inverse space.
    point.elements[3] = 0;
    point.elements[7] = 0;
    point.elements[11] = 0;
    point.elements[15] = 1;
    point.premultiply(mesh.bindMatrixInverse);
    return { point, direction };
  });
  const vector = new Vector3();
  for (let vertex = 0; vertex < joints.length; vertex++) {
    // The source's maximum index was checked against the current skeleton.
    const transform = transforms[joints[vertex] as number] as (typeof transforms)[number];
    vector
      .fromArray(position, vertex * 3)
      .applyMatrix4(transform.point)
      .toArray(position, vertex * 3);
    vector
      .fromArray(normal, vertex * 3)
      .applyMatrix3(transform.direction)
      .toArray(normal, vertex * 3);
    vector
      .fromArray(tangent, vertex * 4)
      .applyMatrix3(transform.direction)
      .toArray(tangent, vertex * 4);
  }
}

function applySkinMorph(
  mesh: SkinnedMesh,
  morphTargets: MeshAsset['morphTargets'],
  name: 'position' | 'normal',
  vertex: number,
  vector: Vector3,
  morphDelta: Vector3,
): void {
  for (let i = 0; i < (morphTargets?.length ?? 0); i++) {
    const delta = morphTargets?.[i]?.[name],
      weight = mesh.morphTargetInfluences?.[i] ?? 0;
    if (!Number.isFinite(weight)) throw invalidError('Mesh.morphTargetInfluences', mesh.uuid);
    if (delta !== undefined)
      vector.addScaledVector(morphDelta.fromArray(delta, vertex * 3), weight);
  }
}

function applyBlendedCpuSkin(
  mesh: SkinnedMesh,
  base: MeshAsset,
  palette: readonly (Matrix4 | undefined)[],
  joints: Uint16Array,
  weights: Float32Array,
  position: Float32Array,
  normal: Float32Array,
  tangent: Float32Array,
  customPositionSkin: boolean,
): void {
  const vector = new Vector3(),
    homogeneous = new Vector4(),
    morphDelta = new Vector3(),
    sum = new Matrix4(),
    linear = new Matrix3();
  const sourceVertexCount = mesh.geometry.getAttribute('position').count;
  const channels = [
    ['position', position],
    ['normal', normal],
  ] as const;
  for (let vertex = 0; vertex < position.length / 3; vertex++) {
    sum.elements.fill(0);
    for (let lane = 0; lane < 4; lane++) {
      const index = joints[vertex * 4 + lane] ?? 0,
        weight = weights[vertex * 4 + lane] ?? 0;
      const matrix = palette[index];
      if (matrix === undefined || !Number.isFinite(weight))
        throw invalidError('SkinnedMesh joint index/weight', mesh.uuid);
      if (weight === 0) continue;
      for (let i = 0; i < 16; i++)
        sum.elements[i] = (sum.elements[i] ?? 0) + (matrix.elements[i] ?? 0) * weight;
    }
    for (const [name, data] of channels) {
      vector.fromArray(data, vertex * 3);
      applySkinMorph(mesh, base.morphTargets, name, vertex, vector, morphDelta);
      if (name === 'position') {
        if (customPositionSkin) mesh.applyBoneTransform(vertex % sourceVertexCount, vector);
        else {
          // Match the Three vertex shader: keep the weighted w through the
          // inverse bind and discard it before the mesh's world transform.
          homogeneous
            .set(vector.x, vector.y, vector.z, 1)
            .applyMatrix4(mesh.bindMatrix)
            .applyMatrix4(sum)
            .applyMatrix4(mesh.bindMatrixInverse);
          vector.set(homogeneous.x, homogeneous.y, homogeneous.z);
        }
      } else {
        linear.setFromMatrix4(sum.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix));
        vector.applyMatrix3(linear);
      }
      vector.toArray(data, vertex * 3);
    }
    vector
      .fromArray(tangent, vertex * 4)
      .applyMatrix3(linear)
      .toArray(tangent, vertex * 4);
  }
}

/** Three skins local normals before the mesh normal matrix. Baking a source pose
 * preserves that order for lit meshes until the native world palette carries it.
 * Animation time, bones and bind modes remain entirely upstream-owned. */
export function projectCpuSkin(mesh: SkinnedMesh, source: CpuSkinGeometry): MeshAsset {
  const { base, weights, singleJoint, maxJoint } = source;
  projectSkeleton(mesh); // Validate the same joint/index contract as the GPU path.
  const attributes = { ...base.attributes };
  const position = (base.attributes.position as Float32Array).slice();
  const normal = (base.attributes.normal as Float32Array).slice();
  const tangent = (base.attributes.tangent as Float32Array).slice();
  const joints = base.attributes.skinIndex;
  if (!(joints instanceof Uint16Array) || !(weights instanceof Float32Array))
    return invalid('SkinnedMesh skinIndex/skinWeight', mesh.uuid).unwrap();
  // Pose-local palette: these products are identical for every vertex/influence.
  const palette = mesh.skeleton.bones.map((bone, index) => {
    const inverse = mesh.skeleton.boneInverses[index];
    return inverse === undefined ? undefined : bone.matrixWorld.clone().multiply(inverse);
  });
  const customPositionSkin = mesh.applyBoneTransform !== SkinnedMesh.prototype.applyBoneTransform;
  if (singleJoint !== undefined && !customPositionSkin) {
    if (maxJoint >= palette.length)
      return invalid('SkinnedMesh joint index/weight', mesh.uuid).unwrap();
    applySingleJointSkin(mesh, palette, singleJoint, position, normal, tangent);
  } else {
    applyBlendedCpuSkin(
      mesh,
      base,
      palette,
      joints,
      weights,
      position,
      normal,
      tangent,
      customPositionSkin,
    );
  }
  attributes.position = position;
  attributes.normal = normal;
  attributes.tangent = tangent;
  delete attributes.skinIndex;
  delete attributes.skinWeight;
  const packed = packInterleavedVertexAttributes(attributes, position.length / 3).unwrap();
  const { morphTargets: _morph, ...rest } = base;
  return {
    ...rest,
    attributes,
    vertices: packed.vertices,
    aabb: box3.fromPositions(box3.create(), position),
  };
}
