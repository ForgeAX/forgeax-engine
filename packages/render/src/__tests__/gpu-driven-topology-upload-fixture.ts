import { frustum, mat4 } from '@forgeax/engine-math';
import { ok, type RhiDevice, type ShaderModule } from '@forgeax/engine-rhi';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

export function uploadFixture(device: RhiDevice, shader: ShaderModule) {
  const source = createFilterPlanFixture();
  const availability = GpuScene.create(device, 8).unwrap();
  if (availability.status !== 'available') throw Error('GPU Scene unavailable');
  availability.scene
    .sync({
      created: source.slots.length,
      updated: 0,
      removed: 0,
      recreated: 0,
      ignoredLateUpdates: 0,
      createdSlots: source.slots,
      updatedSlots: [],
      contentUpdatedSlots: [],
      instanceUpdatedSlots: [],
      removedSlots: [],
      recreatedSlots: [],
      resynced: 0,
    })
    .unwrap();
  const owner = new FilteredPlanContributionOwner();
  const original = owner.update(
    source.prepare(),
    'same-artifacts',
    undefined,
    source.bindings,
  ).plan;
  const changed = {
    ...original,
    revision: original.revision + 1,
    batches: original.batches.map((batch, index) =>
      index !== 0
        ? batch
        : {
            ...batch,
            key: { ...batch.key, count: batch.key.count + 1 },
            candidates: batch.candidates.map((candidate, ordinal) =>
              ordinal !== 0
                ? candidate
                : {
                    ...candidate,
                    instanceOrdinal: candidate.instanceOrdinal === 0 ? 1 : 0,
                  },
            ),
          },
    ),
  };
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  return {
    view,
    original,
    changed,
    update: (plan = original) => view.update(plan, availability.scene, planes),
    close() {
      view.dispose();
      availability.scene.dispose();
    },
  };
}
