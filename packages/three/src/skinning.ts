import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { box3, mat4, quat, vec3 } from '@forgeax/engine-math';
import type { MeshAsset, SkeletonAsset } from '@forgeax/engine-types';
import { Matrix3, Matrix4, type SkinnedMesh, Vector3 } from 'three/src/Three.Core.js';
import { invalid } from './errors';

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

export function projectJoints(mesh: SkinnedMesh) {
  const pre = mesh.matrixWorld.clone().multiply(mesh.bindMatrixInverse);
  return mesh.skeleton.bones.map((bone) => {
    const matrix = pre.clone().multiply(bone.matrixWorld);
    const pos = vec3.create(),
      rotation = quat.create(),
      scale = vec3.create(),
      shear = vec3.create();
    if (!mat4.decomposeAffine(pos, rotation, scale, shear, matrix.elements))
      return invalid('SkinnedMesh joint world transform', mesh.uuid).unwrap();
    return { pos, quat: rotation, scale, shear };
  });
}

export function cpuSkinValues(mesh: SkinnedMesh): unknown[] {
  return [
    ...skinValues(mesh),
    ...mesh.bindMatrix.elements,
    ...mesh.bindMatrixInverse.elements,
    ...mesh.skeleton.bones.flatMap((bone) => bone.matrixWorld.elements),
    ...(mesh.morphTargetInfluences ?? []),
  ];
}

/** Three skins local normals before the mesh normal matrix. Baking a source pose
 * preserves that order for lit meshes until the native world palette carries it.
 * Animation time, bones and bind modes remain entirely upstream-owned. */
export function projectCpuSkin(mesh: SkinnedMesh, base: MeshAsset): MeshAsset {
  projectSkeleton(mesh); // Validate the same joint/index contract as the GPU path.
  const attributes = { ...base.attributes };
  const position = (base.attributes.position as Float32Array).slice();
  const normal = (base.attributes.normal as Float32Array).slice();
  const tangent = (base.attributes.tangent as Float32Array).slice();
  const joints = base.attributes.skinIndex,
    weights = base.attributes.skinWeight;
  if (!(joints instanceof Uint16Array) || !(weights instanceof Float32Array))
    return invalid('SkinnedMesh skinIndex/skinWeight', mesh.uuid).unwrap();
  const vector = new Vector3(),
    sum = new Matrix4(),
    linear = new Matrix3();
  for (let vertex = 0; vertex < position.length / 3; vertex++) {
    sum.elements.fill(0);
    for (let lane = 0; lane < 4; lane++) {
      const index = joints[vertex * 4 + lane] ?? 0,
        weight = weights[vertex * 4 + lane] ?? 0;
      const bone = mesh.skeleton.bones[index],
        inverse = mesh.skeleton.boneInverses[index];
      if (bone === undefined || inverse === undefined || !Number.isFinite(weight))
        return invalid('SkinnedMesh joint index/weight', mesh.uuid).unwrap();
      const matrix = bone.matrixWorld.clone().multiply(inverse);
      for (let i = 0; i < 16; i++)
        sum.elements[i] = (sum.elements[i] ?? 0) + (matrix.elements[i] ?? 0) * weight;
    }
    sum.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
    linear.setFromMatrix4(sum);
    for (const [name, data] of [
      ['position', position],
      ['normal', normal],
    ] as const) {
      vector.fromArray(data, vertex * 3);
      for (let i = 0; i < (base.morphTargets?.length ?? 0); i++) {
        const delta = base.morphTargets?.[i]?.[name],
          weight = mesh.morphTargetInfluences?.[i] ?? 0;
        if (!Number.isFinite(weight))
          return invalid('Mesh.morphTargetInfluences', mesh.uuid).unwrap();
        if (delta !== undefined)
          vector.addScaledVector(new Vector3().fromArray(delta, vertex * 3), weight);
      }
      if (name === 'position')
        mesh.applyBoneTransform(vertex % mesh.geometry.getAttribute('position').count, vector);
      else vector.applyMatrix3(linear);
      vector.toArray(data, vertex * 3);
    }
    vector
      .fromArray(tangent, vertex * 4)
      .applyMatrix3(linear)
      .toArray(tangent, vertex * 4);
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
