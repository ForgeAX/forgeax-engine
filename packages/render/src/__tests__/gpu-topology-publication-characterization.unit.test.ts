import { frustum, mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';
import { updateGpuView } from './helpers/gpu-input-read-domain';

it('reuses accepted topology and uploads replaced immutable source membership', async () => {
  const f = createFilterPlanFixture();
  const prepared = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const availability = GpuScene.create(device, 8).unwrap();
  if (availability.status !== 'available') throw new Error('GPU Scene unavailable');
  availability.scene
    .sync({
      created: f.slots.length,
      updated: 0,
      removed: 0,
      recreated: 0,
      ignoredLateUpdates: 0,
      createdSlots: [...f.slots],
      updatedSlots: [],
      contentUpdatedSlots: [],
      instanceUpdatedSlots: [],
      removedSlots: [],
      recreatedSlots: [],
      previous: new Map(),
      resynced: 0,
    })
    .unwrap();
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const upload = (plan: Parameters<typeof view.update>[0]) => {
    writes.mockClear();
    updateGpuView(view, plan, availability.scene, planes).unwrap();
    return {
      inspection: view.inspect(),
      data: writes.mock.calls.map((call) => {
        const data = call[2];
        return ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
          : new Uint8Array(data).slice();
      }),
    };
  };
  try {
    const first = owner.update(prepared, f.bindings);
    const baseline = upload(first.plan);
    expect(baseline.inspection.sharedInputUploadBytes).toBeGreaterThan(0);
    expect(baseline.inspection.batchUploadBytes).toBeGreaterThan(0);
    // An unchanged owned publication keeps its topology; frame constants still update.
    const second = owner.update(prepared, f.bindings);
    expect(second).toBe(first);
    expect(second.plan).toBe(first.plan);
    expect(owner.lastWork.projectedBatches).toBe(0);
    const unchanged = upload(second.plan);
    expect(unchanged.inspection.sharedInputUploadBytes).toBe(0);
    expect(unchanged.inspection.batchUploadBytes).toBe(0);
    expect(unchanged.inspection.viewConstantsUploadBytes).toBeGreaterThan(0);

    planes[3] = (planes[3] ?? 0) + 0.1;
    const moved = upload(second.plan);
    expect(moved.inspection.sharedInputUploadBytes).toBe(0);
    expect(moved.inspection.batchUploadBytes).toBe(0);
    expect(moved.inspection.viewConstantsUploadBytes).toBeGreaterThan(0);

    const changedBindings = new Map(f.bindings).set('0:1', 'different-object-resources');
    const changed = owner.update(prepared, changedBindings);
    expect(changed).not.toBe(first);
    expect(owner.lastWork.projectedCandidates).toBe(6);
    upload(changed.plan);

    const source = prepared.source.batches.at(0);
    if (source === undefined) throw new Error('missing source');
    const changedSource = {
      ...source,
      candidates: [...source.candidates].reverse(),
      contentEpoch: source.contentEpoch + 1,
    };
    const next = f.prepare({
      ...prepared.source,
      revision: prepared.source.revision + 1,
      batches: [changedSource, ...prepared.source.batches.slice(1)],
    });
    const replaced = owner.update(next, changedBindings);
    const replacedUpload = upload(replaced.plan);
    expect(replacedUpload.inspection.sharedInputUploadBytes).toBeGreaterThan(0);
    expect(replacedUpload.data.slice(0, 2)).not.toEqual(baseline.data.slice(0, 2));
    expect(first.plan.batches.at(0)?.candidates).toBe(source.candidates);
  } finally {
    writes.mockRestore();
    view.dispose();
    availability.scene.dispose();
  }
});
