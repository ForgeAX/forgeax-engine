import { frustum, mat4 } from '@forgeax/engine-math';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import { GpuScene } from '../gpu-scene';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { ShadowCasterMembership } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';
import { mesh, standardPbrInputs, updateSnapshot } from './gpu-driven-production-fixture';

it('retains unchanged shadow windows when real split/rejoin plans have non-monotonic batch ids', async () => {
  const f = createFilterPlanFixture();
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const projection = new RenderScene();
  const delta = projection.apply(f.slots.map((slot) => updateSnapshot(slot.snapshot)));
  const available = GpuScene.create(device, 32).unwrap();
  if (available.status !== 'available') throw Error('expected GPU Scene');
  const scene = available.scene;
  scene.sync(delta).unwrap();
  const residentMesh = mesh(device, true, true);
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const originalMembership: readonly ShadowCasterMembership[] = f.slots.map((slot) => ({
    worldEntity: slot.snapshot.entityKey,
    renderableIndex: slot.slot,
    drawItemIndex: 0,
    materialHandle: slot.snapshot.material.materialHandle ?? -1,
    passIndex: 0,
    renderState: { cullMode: slot.slot === 1 ? 'front' : 'back' },
  }));
  const input = {
    ...standardPbrInputs(device, shader, viewLayout),
    scene: {
      scene,
      plan: f.source,
      slots: projection.slotsSnapshot(),
      slotAt: projection.slotAt,
    },
    camera: makeZeroCameraFallbackSnapshot(),
    meshBySlot: new Map(f.slots.map((slot) => [slot.slot, residentMesh])),
    viewBindGroupLayout: viewLayout,
    meshResidencyEpoch: 1,
  };
  const identity = { kind: 'directional' as const, index: 0, layer: 'static' as const };
  const matrix = mat4.identity(mat4.create());
  const requests = [
    { identity, matrix, planes: frustum.fromViewProjection(frustum.create(), matrix) },
  ];
  const lookup = vi.spyOn(
    MaterialAbiRasterAdapter.prototype,
    'shadowVisibleWindowBindGroupForBuffer',
  );
  const prepare = (shadowCasterMembership: readonly ShadowCasterMembership[]) => {
    const frame = defined(production.prepare({ ...input, shadowCasterMembership }).unwrap());
    lookup.mockClear();
    frame.updateShadowViews?.(requests).unwrap();
    const submission = defined(frame.shadowViewPool?.submission(identity));
    const projections = defined(frame.shadowBatchProjections?.get(shadowViewIdentityKey(identity)));
    frame._commitResourceReplacement();
    return {
      submission,
      projections,
      buffer: submission.view.visibleBuffer,
      calls: lookup.mock.calls.length,
    };
  };
  try {
    const initial = prepare(originalMembership);
    expect(initial.submission.plan.batches.map((batch) => batch.batchId)).toEqual([0, 1]);
    expect(initial.calls).toBe(4);
    const splitMembership = originalMembership.map((entry) =>
      entry.renderableIndex === 2
        ? { ...entry, renderState: { cullMode: 'none' as const } }
        : entry,
    );
    const split = prepare(splitMembership);
    // Source first-occurrence order is C, B, A; stable command addresses
    // retain B and A while allocating the new C range after them.
    expect(split.submission.plan.batches.map((batch) => batch.batchId)).toEqual([2, 1, 0]);
    // First split genuinely grows the per-view buffer; every batch must bind
    // that new physical allocation, including unchanged logical windows.
    expect(split.buffer).not.toBe(initial.buffer);
    const before = defined(initial.submission.plan.batches[1]);
    const after = defined(split.submission.plan.batches[1]);
    expect(after.candidates).toEqual(before.candidates);
    expect([after.visibleBase, after.visibleCapacity, after.indirectOffset]).toEqual([
      before.visibleBase,
      before.visibleCapacity,
      before.indirectOffset,
    ]);
    expect({
      key: after.key === before.key,
      generation: after.generation === before.generation,
      contentEpoch: after.contentEpoch === before.contentEpoch,
      prepared: after.prepared === before.prepared,
      lod: after.lod === before.lod,
    }).toEqual({ key: true, generation: true, contentEpoch: true, prepared: true, lod: true });
    expect(split.calls).toBe(6);
    expect(split.projections.get(1)).not.toBe(initial.projections.get(1));
    expect(split.projections.get(0)).not.toBe(initial.projections.get(0));
    const steady = prepare(splitMembership);
    expect(steady.calls).toBe(0);
    for (const [id, projection] of steady.projections)
      expect(projection).toBe(split.projections.get(id));

    const rejoined = prepare(originalMembership);
    expect(rejoined.submission.plan.batches.map((batch) => batch.batchId)).toEqual([0, 1]);
    expect(rejoined.buffer).toBe(split.buffer);
    expect.soft(rejoined.calls).toBe(2);
    expect.soft(rejoined.projections.get(1)).toBe(split.projections.get(1));
    expect(rejoined.projections.get(0)).not.toBe(split.projections.get(0));
    expect(prepare(originalMembership).calls).toBe(0);

    const splitAgain = prepare(splitMembership);
    expect(splitAgain.submission.plan.batches.map((batch) => batch.batchId)).toEqual([2, 1, 0]);
    expect(splitAgain.buffer).toBe(rejoined.buffer);
    expect(splitAgain.calls).toBe(4);
    expect(splitAgain.projections.get(1)).toBe(rejoined.projections.get(1));
    expect(prepare(splitMembership).calls).toBe(0);
  } finally {
    lookup.mockRestore();
    production.dispose();
    scene.dispose();
    residentMesh.vertexBuffer.destroy().unwrap();
    residentMesh.indexBuffer?.destroy().unwrap();
  }
});

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw Error('expected shadow projection fixture value');
  return value;
}
