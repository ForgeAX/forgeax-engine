import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { MorphWeights, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MeshAsset } from '@forgeax/engine-types';
import { skinScene } from './skin-scene.fixture';

/** Same real mesh, with authored deltas and explicit live weights as the renderer consumes. */
export function morphScene(skinned = false, indexed = true) {
  const scene = skinScene(1);
  const { world, entity } = scene;
  if (!skinned) {
    world.removeComponent(entity, Skin).unwrap();
    world
      .set(entity, MeshRenderer, {
        materials: [
          world.allocSharedRef(
            'MaterialAsset',
            Materials.standard({
              baseColor: [0, 0, 0, 1],
              specular: 0,
              emissive: [1, 0.15, 0.03],
              emissiveIntensity: 1,
              renderState: { cullMode: 'none' },
            }),
          ),
        ],
      })
      .unwrap();
  }
  world.set(entity, Transform, { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] }).unwrap();
  const source = scene.mesh.attributes;
  const order = indexed ? [0, 1, 2, 3] : [0, 1, 2, 2, 1, 3];
  const position = new Float32Array(
    order.flatMap((i) => Array.from((source.position as Float32Array).subarray(i * 3, i * 3 + 3))),
  );
  const attributes = {
    position,
    normal: new Float32Array(order.flatMap(() => [0, 0, 1])),
    tangent: new Float32Array(order.flatMap(() => [1, 0, 0, 1])),
    uv: new Float32Array(order.flatMap(() => [0, 0])),
    ...(skinned
      ? {
          skinIndex: new Uint16Array(
            order.flatMap((i) =>
              Array.from((source.skinIndex as Uint16Array).subarray(i * 4, i * 4 + 4)),
            ),
          ),
          skinWeight: new Float32Array(
            order.flatMap((i) =>
              Array.from((source.skinWeight as Float32Array).subarray(i * 4, i * 4 + 4)),
            ),
          ),
        }
      : {}),
  };
  const delta = new Float32Array(position.length);
  for (let i = 0; i < delta.length; i += 3) delta[i] = 3;
  const mesh: MeshAsset = {
    kind: 'mesh',
    aabb: new Float32Array([-0.4, -1, 0, 0.4, 1, 0]),
    materialSlots: scene.mesh.materialSlots,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, order.length).unwrap().vertices,
    ...(indexed ? { indices: new Uint32Array([0, 1, 2, 2, 1, 3]) } : {}),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indexed ? 6 : 0,
        vertexCount: order.length,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    morphTargets: [{ position: delta }],
    morphWeights: new Float32Array([1]),
  };
  world.set(entity, MeshFilter, { assetHandle: world.allocSharedRef('MeshAsset', mesh) }).unwrap();
  world
    .addComponent(entity, { component: MorphWeights, data: { weights: new Float32Array([1]) } })
    .unwrap();
  propagateTransforms(world).unwrap();
  return { ...scene, mesh };
}
