import { frustum, mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { materialBindingKey } from '../gpu-driven/material-bindings';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

it('reuses owned filtered topology and observes mutable raw inputs through full projection', async () => {
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
      createdSlots: f.slots,
      updatedSlots: [],
      contentUpdatedSlots: [],
      instanceUpdatedSlots: [],
      removedSlots: [],
      recreatedSlots: [],
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
    view.update(plan, availability.scene, planes).unwrap();
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
    const first = owner.update(prepared, 'same-current-programs', undefined, f.bindings);
    const baseline = upload(first.plan);
    expect(baseline.inspection.candidateUploadBytes).toBeGreaterThan(0);
    expect(baseline.inspection.batchUploadBytes).toBeGreaterThan(0);
    // An unchanged owned publication keeps its topology; frame constants still update.
    const second = owner.update(prepared, 'same-current-programs', undefined, f.bindings);
    expect(second).toBe(first);
    expect(second.plan).toBe(first.plan);
    expect(owner.lastWork.projectedBatches).toBe(0);
    const unchanged = upload(second.plan);
    expect(unchanged.inspection.candidateUploadBytes).toBe(0);
    expect(unchanged.inspection.batchUploadBytes).toBe(0);
    expect(unchanged.inspection.viewConstantsUploadBytes).toBeGreaterThan(0);

    const irrelevant = new Map([...f.bindings].reverse());
    irrelevant.set('99:9999:12345', 'unused-by-all-admitted-groups');
    expect(JSON.stringify([...irrelevant])).not.toBe(JSON.stringify([...f.bindings]));
    const reordered = owner.update(prepared, 'same-current-programs', undefined, irrelevant);
    expect(reordered).toBe(first);
    expect(owner.lastWork).toMatchObject({
      projectedBatches: 0,
      projectedCandidates: 0,
      copiedCandidates: 0,
    });
    const repeated = upload(reordered.plan);
    expect(repeated.inspection.candidateUploadBytes).toBe(0);
    expect(repeated.inspection.batchUploadBytes).toBe(0);
    expect(repeated.inspection.viewConstantsUploadBytes).toBeGreaterThan(0);

    // Exact retained topology already permits moving view constants without
    // repeating its topology writes. This is a source capability witness,
    // not an optimization or a promise that arbitrary old plans are valid.
    planes[3] = (planes[3] ?? 0) + 0.1;
    const constantsOnly = upload(reordered.plan);
    expect(constantsOnly.inspection.candidateUploadBytes).toBe(0);
    expect(constantsOnly.inspection.batchUploadBytes).toBe(0);
    expect(constantsOnly.inspection.viewConstantsUploadBytes).toBeGreaterThan(0);

    const slot = f.slots[0];
    if (slot === undefined) throw new Error('missing retained slot');
    irrelevant.set(materialBindingKey(slot.snapshot, 100), 'changed-consumed-class');
    const changed = owner.update(prepared, 'same-current-programs', undefined, irrelevant);
    expect(changed).not.toEqual(first);
    expect(owner.lastWork.projectedBatches).toBeGreaterThan(0);
    const changedUpload = upload(changed.plan);
    expect(changedUpload.inspection.candidateUploadBytes).toBeGreaterThan(0);
    expect(changedUpload.data.slice(0, 2)).not.toEqual(baseline.data.slice(0, 2));

    // Raw nested data has no immutable-source authority. Use the existing
    // undefined-scope full projection, and establish its baseline before any
    // mutation so allocation/layout differences cannot satisfy the falsifiers.
    const raw = owner.update(prepared, undefined, undefined, irrelevant);
    const rawUpload = upload(raw.plan);
    const rawCandidate = f.source.batches[0]?.candidates[0];
    if (rawCandidate === undefined) throw new Error('missing raw candidate');
    Object.assign(rawCandidate, { instanceOrdinal: 1 });
    const mutated = owner.update(prepared, undefined, undefined, irrelevant);
    expect(owner.lastWork.projectedBatches).toBe(prepared.batchRows.length);
    const mutatedUpload = upload(mutated.plan);
    expect(mutatedUpload.data.slice(0, 2)).not.toEqual(rawUpload.data.slice(0, 2));

    const sourceBatch = f.source.batches[0];
    if (sourceBatch?.lod === undefined) throw new Error('missing raw LOD source');
    Object.assign(sourceBatch.lod.coverages, { 1: 0.25 });
    const changedLod = owner.update(prepared, undefined, undefined, irrelevant);
    expect(owner.lastWork.projectedBatches).toBe(prepared.batchRows.length);
    const lodUpload = upload(changedLod.plan);
    expect(lodUpload.data.slice(0, 2)).not.toEqual(mutatedUpload.data.slice(0, 2));
    Object.assign(sourceBatch.key, { count: sourceBatch.key.count + 1 });
    const changedRange = owner.update(prepared, undefined, undefined, irrelevant);
    const rangeUpload = upload(changedRange.plan);
    expect(rangeUpload.data.slice(0, 2)).not.toEqual(lodUpload.data.slice(0, 2));
  } finally {
    writes.mockRestore();
    view.dispose();
    availability.scene.dispose();
  }
});
