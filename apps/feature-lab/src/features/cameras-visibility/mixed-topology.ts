import { createMeshBuilder } from '@forgeax/engine/geometry';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import type { MeshAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { spawnMesh, spawnStage, unlit } from '../../lab/stage';

const repeat = (count: number, value: number[]) =>
  Float32Array.from({ length: count * value.length }, (_, i) => value[i % value.length] ?? 0);

function mesh(withLines: boolean): MeshAsset {
  const position: number[] = [-0.8, -0.8, 0, 0.8, -0.8, 0, 0.8, 0.8, 0, -0.8, 0.8, 0];
  const indices: number[] = [0, 1, 2, 0, 2, 3];
  const submeshes: {
    indexOffset: number;
    indexCount: number;
    topology: 'triangle-list' | 'line-list';
    materialSlot: number;
  }[] = [{ indexOffset: 0, indexCount: 6, topology: 'triangle-list', materialSlot: 0 }];
  if (withLines) {
    const start = indices.length;
    for (let r = 0.9; r < 1.6; r += 0.05) {
      const base = position.length / 3;
      position.push(-r, -r, 0.02, r, -r, 0.02, r, r, 0.02, -r, r, 0.02);
      indices.push(base, base + 1, base + 1, base + 2, base + 2, base + 3, base + 3, base);
    }
    submeshes.push({
      indexOffset: start,
      indexCount: indices.length - start,
      topology: 'line-list',
      materialSlot: 1,
    });
  }
  const count = position.length / 3;
  return createMeshBuilder({
    attributes: {
      position: new Float32Array(position),
      normal: repeat(count, [0, 0, 1]),
      uv: repeat(count, [0, 0]),
      tangent: repeat(count, [1, 0, 0, 1]),
    },
    indices,
    submeshes,
    materialSlots: withLines
      ? [{ slotName: 'Fill' }, { slotName: 'Lines' }]
      : [{ slotName: 'Fill' }],
  })
    .build()
    .unwrap();
}

export default defineFeature({
  title: 'Mixed primitive topology',
  catalog: 'Mixed primitive topology',
  kind: 'visual',
  summary:
    'One MeshAsset carries a triangle-list fill submesh and a line-list submesh; each gets its own pipeline, no separate line system.',
  expect:
    'ON: an orange filled square framed by fourteen cyan line squares from the same mesh. OFF: the mesh has only the triangle submesh, so the cyan lines disappear.',
  setup({ world }) {
    spawnStage(world, { eye: [0, 1.2, 4], target: [0, 1.2, 0] });
    const both = world.allocSharedRef('MeshAsset', mesh(true));
    const fillOnly = world.allocSharedRef('MeshAsset', mesh(false));
    const fill = unlit(world, [1, 0.5, 0.1, 1]);
    const lines = unlit(world, [0.1, 1, 1, 1]);
    const entity = spawnMesh(world, both, fill, { pos: [0, 1.2, 0] });
    world.set(entity, MeshRenderer, { materials: [fill, lines] } as never);
    return {
      toggle(on) {
        world.set(entity, MeshFilter, { assetHandle: on ? both : fillOnly } as never);
        world.set(entity, MeshRenderer, { materials: on ? [fill, lines] : [fill] } as never);
      },
    };
  },
});
