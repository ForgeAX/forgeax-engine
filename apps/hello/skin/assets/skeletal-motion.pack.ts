import { AnimationPlayer, AnimationTargetId } from '@forgeax/engine/animation';
import type { SkeletalMotionDefinition } from '@forgeax/engine/animation/skeletal-motion';
import { deriveAnimationTargetId } from '@forgeax/engine/animation/target-id';
import { createBoxGeometry, packInterleavedVertexAttributes } from '@forgeax/engine/geometry';
import { definePack } from '@forgeax/engine/pack/source';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { ChildOf, Name, Transform } from '@forgeax/engine/scene';
import { Skin } from '@forgeax/engine/skinning';
import type {
  AnimationClip,
  MaterialAsset,
  MeshAsset,
  PluginConfigValue,
  SceneAsset,
} from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';

import { MOTION_PACKAGE_ID, motionGuid } from '../src/skeletal-motion-guids';

// Source facts: parent-first authored rig with a hair chain and a planar limb rig.
const bones = [
  { name: 'torso', parent: -1, pos: [0, 1.5, 0], offset: [0, 0.4, 0], size: [0.65, 0.8, 0.35] },
  { name: 'head', parent: 0, pos: [0, 0.95, 0], offset: [0, 0.2, 0], size: [0.4, 0.4, 0.4] },
  { name: 'arm', parent: 0, pos: [0.4, 0.7, 0], offset: [0.35, 0, 0], size: [0.7, 0.2, 0.2] },
  { name: 'forearm', parent: 2, pos: [0.7, 0, 0], offset: [0.3, 0, 0], size: [0.6, 0.16, 0.16] },
  {
    name: 'left-thigh',
    parent: 0,
    pos: [-0.2, 0, 0],
    offset: [0, -0.35, 0],
    size: [0.2, 0.7, 0.25],
  },
  { name: 'left-calf', parent: 4, pos: [0, -0.7, 0], offset: [0, -0.3, 0], size: [0.18, 0.6, 0.2] },
  {
    name: 'right-thigh',
    parent: 0,
    pos: [0.2, 0, 0],
    offset: [0, -0.35, 0],
    size: [0.2, 0.7, 0.25],
  },
  {
    name: 'right-calf',
    parent: 6,
    pos: [0, -0.7, 0],
    offset: [0, -0.3, 0],
    size: [0.18, 0.6, 0.2],
  },
  ...Array.from({ length: 6 }, (_, i) => ({
    name: `hair-${i}`,
    parent: i === 0 ? 1 : 7 + i,
    pos: i === 0 ? [0, 0.4, 0] : [0, 0, -0.25],
    offset: [0, 0, -0.12],
    size: [0.13, 0.09, 0.25],
  })),
];
const target = (i: number) => deriveAnimationTargetId(['skeletal-motion', bones[i]?.name ?? '']);
const positions = bones.map((bone, i) => {
  const result = [...bone.pos];
  let parent = bone.parent;
  while (parent >= 0) {
    for (let a = 0; a < 3; a++) result[a] = (result[a] ?? 0) + (bones[parent]?.pos[a] ?? 0);
    parent = bones[parent]?.parent ?? -1;
  }
  void i;
  return result;
});

export const motionDefinition: SkeletalMotionDefinition = {
  springs: [
    {
      targets: Array.from({ length: 6 }, (_, i) => target(i + 8)),
      stiffness: 45,
      damping: 7,
      gravity: [0, -9.81, 0],
      maxAngle: 1.8,
      radius: 0.04,
      iterations: 12,
      collisions: [{ target: target(1), center: [0, 0.2, 0], radius: 0.26 }],
    },
  ],
  physical: {
    bones: bones.slice(0, 8).map((bone, index) => ({
      target: target(index),
      offset: bone.offset as [number, number, number],
      rotation: [0, 0, 0, 1],
      mass: index === 0 ? 4 : 1,
      additionalSolverIterations: 16,
      shape: {
        kind: 'cuboid',
        halfExtents: bone.size.map((v) => v / 2) as [number, number, number],
      },
      collisionGroups: 0x00020001,
    })),
    joints: bones.slice(1, 8).map((bone, index) => ({
      bodyA: bone.parent,
      bodyB: index + 1,
      anchorA: bone.pos.map((v, axis) => v - (bones[bone.parent]?.offset[axis] ?? 0)) as [
        number,
        number,
        number,
      ],
      anchorB: bone.offset.map((v) => -v) as [number, number, number],
      axisA: [0, 0, 1],
      axisB: [0, 0, 1],
      limits: bone.name.includes('calf') || bone.name === 'forearm' ? [-1.8, 0.15] : [-1.2, 1.2],
    })),
  },
};

function skinnedMaterial(): MaterialAsset {
  const material = Materials.standard({
    baseColor: [0.08, 0.65, 0.8, 1],
    roughness: 0.55,
    metallic: 0.1,
  });
  if (!material.passes) throw new Error('standard root material required');
  const [first, ...rest] = material.passes;
  const skin = (pass: typeof first) =>
    pass.name === 'shadow-caster'
      ? pass
      : { ...pass, program: { ...pass.program, module: 'forgeax::pbr-skin' } };
  return { ...material, passes: [skin(first), ...rest.map(skin)] };
}

function skinMesh(): MeshAsset {
  const position: number[] = [],
    normal: number[] = [],
    uv: number[] = [],
    tangent: number[] = [],
    skinIndex: number[] = [],
    skinWeight: number[] = [],
    indices: number[] = [];
  for (const [joint, bone] of bones.entries()) {
    const mesh = createBoxGeometry(
      bone.size[0] ?? 1,
      bone.size[1] ?? 1,
      bone.size[2] ?? 1,
    ).unwrap();
    const attrs = mesh.attributes;
    const first = position.length / 3;
    const pos = attrs.position as Float32Array;
    for (let v = 0; v < pos.length / 3; v++) {
      for (let a = 0; a < 3; a++)
        position.push((pos[v * 3 + a] ?? 0) + (positions[joint]?.[a] ?? 0) + (bone.offset[a] ?? 0));
      normal.push(...Array.from((attrs.normal as Float32Array).slice(v * 3, v * 3 + 3)));
      uv.push(...Array.from((attrs.uv as Float32Array).slice(v * 2, v * 2 + 2)));
      tangent.push(...Array.from((attrs.tangent as Float32Array).slice(v * 4, v * 4 + 4)));
      skinIndex.push(joint, 0, 0, 0);
      skinWeight.push(1, 0, 0, 0);
    }
    for (const value of mesh.indices ?? []) indices.push(first + value);
  }
  const attributes = {
    position: new Float32Array(position),
    normal: new Float32Array(normal),
    uv: new Float32Array(uv),
    tangent: new Float32Array(tangent),
    skinIndex: new Uint16Array(skinIndex),
    skinWeight: new Float32Array(skinWeight),
  };
  const packed = packInterleavedVertexAttributes(attributes, position.length / 3).unwrap();
  return {
    kind: 'mesh',
    vertices: packed.vertices,
    indices: new Uint16Array(indices),
    attributes,
    aabb: new Float32Array([-5, -5, -5, 5, 5, 5]),
    materialSlots: [{ slotName: 'Body' }],
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: position.length / 3,
        materialSlot: 0,
        topology: 'triangle-list',
      },
    ],
  };
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: MOTION_PACKAGE_ID,
  name: 'Managed skeletal motion',
  sceneComponents: [
    Transform,
    ChildOf,
    Name,
    Skin,
    AnimationPlayer,
    AnimationTargetId,
    MeshFilter,
    MeshRenderer,
  ],
  build() {
    const inverseBindMatrices = new Float32Array(bones.length * 16);
    for (let i = 0; i < bones.length; i++) {
      for (const a of [0, 5, 10, 15]) inverseBindMatrices[i * 16 + a] = 1;
      for (let a = 0; a < 3; a++) inverseBindMatrices[i * 16 + 12 + a] = -(positions[i]?.[a] ?? 0);
    }
    const scene: SceneAsset = {
      kind: 'scene',
      skinGuids: [motionGuid('skin')],
      entities: {
        actor: { components: { Name: { value: 'Actor' }, Transform: {}, AnimationPlayer: {} } },
        ...Object.fromEntries(
          bones.map((bone, index) => [
            bone.name,
            {
              components: {
                Name: { value: bone.name },
                Transform: { pos: bone.pos },
                ChildOf: { parent: bone.parent < 0 ? 'actor' : bones[bone.parent]?.name },
                AnimationTargetId: { value: target(index) },
              },
            },
          ]),
        ),
        mesh: {
          components: {
            Name: { value: 'Skinned body and hair' },
            Transform: {},
            MeshFilter: { assetHandle: motionGuid('mesh') },
            MeshRenderer: { materials: [motionGuid('material')] },
            Skin: { skeleton: motionGuid('skeleton') },
            ChildOf: { parent: 'actor' },
          },
        },
      },
    };
    const clip: AnimationClip = {
      kind: 'animation-clip',
      duration: 2,
      channels: [
        {
          targetId: target(0),
          property: 'translation',
          sampler: {
            interpolation: 'LINEAR',
            input: new Float32Array([0, 0.5, 1, 1.5, 2]),
            output: new Float32Array([0, 1.5, 0, 0.7, 1.5, 0, 0, 1.5, 0, -0.7, 1.5, 0, 0, 1.5, 0]),
          },
        },
      ],
    };
    return ok({
      mesh: skinMesh(),
      skeleton: {
        kind: 'skeleton',
        jointCount: bones.length,
        inverseBindMatrices,
        bounds: new Float32Array([-5, -5, -5, 5, 5, 5]),
      },
      skin: {
        kind: 'skin',
        skeletonGuid: motionGuid('skeleton'),
        jointPaths: bones.map((bone) => {
          const path = [bone.name];
          let parent = bone.parent;
          while (parent >= 0) {
            path.unshift(bones[parent]?.name ?? '');
            parent = bones[parent]?.parent ?? -1;
          }
          return ['Actor', ...path].join('/');
        }),
      },
      material: skinnedMaterial(),
      clip,
      scene,
      motion: {
        kind: 'plugin',
        module: { specifier: '../src/skeletal-motion-program.ts', export: 'default' },
        config: motionDefinition as unknown as PluginConfigValue,
      },
    });
  },
});
