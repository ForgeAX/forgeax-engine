import { World } from '@forgeax/engine-ecs';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { ChildOf, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MeshAsset } from '@forgeax/engine-types';

/** Two-joint ribbon, with an inverse bind offset and blended influence band. */
export function skinScene(segments = 16) {
  const world = new World();
  const position = new Float32Array((segments + 1) * 2 * 3);
  const tangent = new Float32Array((segments + 1) * 2 * 4);
  const normal = new Float32Array(position.length);
  const uv = new Float32Array((segments + 1) * 2 * 2);
  const skinIndex = new Uint16Array((segments + 1) * 2 * 4);
  const skinWeight = new Float32Array(skinIndex.length);
  const indices = new Uint32Array(segments * 6);
  for (let row = 0; row <= segments; row++) {
    const y = -1 + (row * 2) / segments;
    const weight = Math.min(1, Math.max(0, y + 0.5));
    for (let side = 0; side < 2; side++) {
      const vertex = row * 2 + side;
      position.set([side === 0 ? -0.4 : 0.4, y, 0], vertex * 3);
      normal.set([0, 0, 1], vertex * 3);
      tangent.set([1, 0, 0, 1], vertex * 4);
      uv.set([side, row / segments], vertex * 2);
      skinIndex.set([0, 1, 0, 0], vertex * 4);
      skinWeight.set([1 - weight, weight, 0, 0], vertex * 4);
    }
    if (row < segments)
      indices.set(
        [row * 2, row * 2 + 1, row * 2 + 2, row * 2 + 2, row * 2 + 1, row * 2 + 3],
        row * 6,
      );
  }
  const attributes = { position, normal, tangent, uv, skinIndex, skinWeight };
  const mesh: MeshAsset = {
    kind: 'mesh',
    attributes,
    indices,
    vertices: packInterleavedVertexAttributes(attributes, position.length / 3).unwrap().vertices,
    aabb: new Float32Array([-0.4, -1, 0, 0.4, 1, 0]),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: position.length / 3,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'surface' }],
  };
  const root = world.spawn({ component: Transform, data: {} }).unwrap();
  const upper = world
    .spawn(
      { component: Transform, data: { pos: [0, 0.5, 0] } },
      { component: ChildOf, data: { parent: root } },
    )
    .unwrap();
  const ibm = new Float32Array(32);
  ibm.set(mat4.identity(mat4.create()));
  ibm.set(mat4.identity(mat4.create()), 16);
  ibm[29] = -0.5;
  const skeleton = world.allocSharedRef('SkeletonAsset', {
    kind: 'skeleton',
    jointCount: 2,
    inverseBindMatrices: ibm,
    jointPaths: ['root', 'root/upper'],
    bounds: new Float32Array([-4, -4, -1, 4, 4, 1]),
  });
  const standard = Materials.standard({
    baseColor: [0, 0, 0, 1],
    specular: 0,
    emissive: [1, 0.15, 0.03],
    emissiveIntensity: 1,
    renderState: { cullMode: 'none' },
  });
  const material = {
    ...standard,
    passes: standard.passes?.map((pass) => ({
      ...pass,
      program: {
        ...pass.program,
        module:
          pass.program.module === 'forgeax_material::standard'
            ? 'forgeax::pbr-skin'
            : pass.program.module,
      },
    })),
  };
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [0.3, 0, 0], scale: [1.5, 0.8, 1] } },
      { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', mesh) } },
      {
        component: MeshRenderer,
        data: { materials: [world.allocSharedRef('MaterialAsset', material)] },
      },
      { component: Skin, data: { skeleton, joints: new Uint32Array([root, upper]) } },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -2,
          right: 2,
          bottom: -2,
          top: 2,
          near: 0.1,
          far: 20,
          aspect: 1,
          antialias: 0,
          tonemap: 1,
          bloom: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0, 0, -1], intensity: 1, castShadow: false },
    })
    .unwrap();
  const pose = (x: number, angle: number, scale = 1) => {
    world.set(root, Transform, { pos: [x, 0, 0], scale: [scale, 1, 1] }).unwrap();
    world
      .set(upper, Transform, { quat: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)] })
      .unwrap();
    propagateTransforms(world).unwrap();
  };
  pose(0, 0);
  return { world, mesh, entity, camera, root, upper, skeleton, pose };
}
