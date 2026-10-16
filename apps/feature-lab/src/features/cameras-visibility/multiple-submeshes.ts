import { createBoxGeometry, createMeshBuilder } from '@forgeax/engine/geometry';
import { MeshRenderer } from '@forgeax/engine/render';
import type { MeshAsset } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnMesh, spawnStage, standard } from '../../lab/stage';
import { serial } from './support/serial';

function twoSlotBox(): MeshAsset {
  const box = createBoxGeometry(1.6, 1.6, 1.6).unwrap();
  const indices = box.indices ?? new Uint16Array();
  const half = indices.length / 2;
  return createMeshBuilder({
    attributes: box.attributes,
    indices,
    submeshes: [
      { indexOffset: 0, indexCount: half, materialSlot: 0 },
      { indexOffset: half, indexCount: half, materialSlot: 1 },
    ],
    materialSlots: [{ slotName: 'X faces' }, { slotName: 'Y and Z faces' }],
  })
    .build()
    .unwrap();
}

export default defineFeature({
  title: 'Multiple submeshes/materials',
  catalog: 'Multiple submeshes/materials',
  kind: 'visual',
  summary:
    'One MeshAsset with two submeshes; MeshRenderer.materials[i] binds materialSlots[i], so each index range gets its own material.',
  expect:
    'ON: the box shows red side faces (slot 0) and blue top/front faces (slot 1). OFF: both slots use red, so the whole box is red.',
  setup({ app, world, frames }) {
    spawnStage(world, { eye: [3, 2.6, 4], target: [0, 1, 0] });
    const red = standard(world, { baseColor: [0.95, 0.1, 0.1, 1] });
    const blue = standard(world, { baseColor: [0.1, 0.3, 1, 1] });
    const mesh = world.allocSharedRef('MeshAsset', twoSlotBox());
    const entity = spawnMesh(world, mesh, red, { pos: [0, 1, 0] });
    world.set(entity, MeshRenderer, { materials: [red, blue] } as never);
    return {
      toggle(on) {
        world.set(entity, MeshRenderer, { materials: on ? [red, blue] : [red, red] } as never);
      },
      checks: serial(async () => {
        const checks = new CheckList();
        await frames(2);
        const binding = app.renderer
          .inspect()
          .meshMaterialBindings.find((entry) => entry.entityKey === Number(entity));
        checks.ok('renderer reports per-slot bindings', binding !== undefined);
        if (binding !== undefined) {
          checks.equal('two slot bindings', binding.bindings.length, 2);
          checks.equal('no binding diagnostics', binding.diagnostics, []);
        }
        return checks.items;
      }),
    };
  },
});
