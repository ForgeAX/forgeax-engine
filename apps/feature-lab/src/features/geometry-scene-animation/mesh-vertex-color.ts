import { packInterleavedVertexAttributes } from '@forgeax/engine/geometry';
import { MeshFilter } from '@forgeax/engine/render';
import type { MeshAsset, VertexAttributeMap } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { spawnCamera, spawnMesh, unlit } from '../../lab/stage';

function quad(withColor: boolean): MeshAsset | undefined {
  const attributes: VertexAttributeMap = {
    position: new Float32Array([-1.2, -0.9, 0, 1.2, -0.9, 0, 1.2, 0.9, 0, -1.2, 0.9, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
  };
  if (withColor)
    attributes.color = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1]);
  const packed = packInterleavedVertexAttributes(attributes, 4);
  if (!packed.ok) return undefined;
  return {
    kind: 'mesh',
    vertices: packed.value.vertices,
    attributes,
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    aabb: new Float32Array([-1.2, -0.9, 0, 1.2, 0.9, 0]),
    submeshes: [
      { indexOffset: 0, indexCount: 6, vertexCount: 4, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'vertex-color' }],
  };
}

export default defineFeature({
  title: 'Mesh vertex color',
  catalog: 'Mesh vertex color',
  kind: 'visual',
  summary:
    'MeshAsset.attributes.color is linear RGBA multiplied into the material; a mesh without the stream renders as if white, with no material switch.',
  expect:
    'ON: a quad with red / green / blue / yellow corners blended across the surface. OFF: the same quad and material without the color stream - flat white.',
  setup({ world }) {
    spawnCamera(world, { eye: [0, 0, 3.6], target: [0, 0, 0] });
    const colored = quad(true);
    const plain = quad(false);
    if (colored === undefined || plain === undefined) return {};
    const withColor = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', colored);
    const without = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', plain);
    const entity = spawnMesh(world, withColor, unlit(world, [1, 1, 1, 1]));
    return {
      toggle(on) {
        world.set(entity, MeshFilter, { assetHandle: on ? withColor : without } as never);
      },
    };
  },
});
