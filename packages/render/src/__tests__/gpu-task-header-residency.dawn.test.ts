import { frustum, mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { assemblePreparedPlan } from '../gpu-driven/production-raster-prepare';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';
import { nativeDeviceFixture } from './native-device-fixture';

it('consumes held resident headers through alternating active subsets for 60 native submissions', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const source = createFilterPlanFixture({ instances: 65 });
  const available = GpuScene.create(device, 8).unwrap();
  if (available.status !== 'available') throw Error('Missing native GPU Scene');
  const scene = available.scene;
  scene
    .sync({
      created: source.slots.length,
      updated: 0,
      removed: 0,
      recreated: 0,
      ignoredLateUpdates: 0,
      createdSlots: [...source.slots],
      updatedSlots: [],
      contentUpdatedSlots: [],
      instanceUpdatedSlots: [],
      removedSlots: [],
      recreatedSlots: [],
      previous: new Map(),
      resynced: 0,
    })
    .unwrap();
  const prepared = source.prepare();
  const owner = new FilteredPlanContributionOwner();
  const full = owner.update(prepared).resident.plan;
  const subsets = [0, 1].map((parity) => {
    const batches = [...prepared.source.batches].filter((_, index) => index % 2 === parity);
    return owner.update(
      assemblePreparedPlan(prepared.residentSource, prepared.residentRows, {
        ...prepared.source,
        batches,
        candidateCount: batches.reduce((sum, batch) => sum + batch.candidates.length, 0),
      }),
    ).active.plan;
  });
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const readback = device.createBuffer({ size: full.batches.length * 20, usage: 1 | 8 }).unwrap();
  if (source.source.sourceGroups === undefined) throw Error('Missing resident source roots');
  scene.inputs.adoptSources(source.source.sourceGroups);
  try {
    view.prepareResidentHeaders(full, scene).unwrap();
    const headers = scene.inputs.taskHeadersWritten;
    expect(headers).toBe(3);
    for (let frame = 0; frame < 60; frame++) {
      const plan = frame % 3 === 0 ? full : subsets[frame % 2];
      if (plan === undefined) throw Error('Missing active subset');
      const resources = scene.captureResources().unwrap();
      try {
        view.update(plan, scene, resources.inputReads(), planes).unwrap();
        const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
        view.addPasses(graph).unwrap();
        const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
        try {
          view._commitResourceReplacement();
          resources.seal().unwrap();
          const encoder = device.createCommandEncoder().unwrap();
          compiled.execute({ encoder }).unwrap();
          const indirect = view.indirectBuffer;
          if (indirect === undefined) throw Error('Missing native indirect buffer');
          let index = 0;
          for (const batch of plan.batches)
            encoder.copyBufferToBuffer(indirect, batch.indirectOffset, readback, index++ * 20, 20);
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          await device.queue.onSubmittedWorkDone();
          const mapped = (await readback.mapAsync(1)).unwrap();
          try {
            const words = new Uint32Array(mapped.getMappedRange().unwrap());
            let index = 0;
            for (const batch of plan.batches) {
              expect(words[index * 5], `frame ${frame} task ${index} indexCount`).toBe(
                batch.key.count,
              );
              expect(words[index * 5 + 1], `frame ${frame} task ${index} instanceCount`).toBe(65);
              index++;
            }
          } finally {
            mapped.unmap();
          }
        } finally {
          await compiled.retire();
        }
      } finally {
        resources.release();
      }
      view.prepareResidentHeaders(full, scene).unwrap();
      expect(scene.inputs.taskHeadersWritten).toBe(headers);
      expect(scene.inputs.taskHeadersReleased).toBe(0);
    }
    const validation = await native.popErrorScope();
    expect(validation, validation?.message).toBeNull();
    // This validates the native selector ABI, not mesh raster resources or Level Ready.
    view.dispose();
    expect(scene.inputs.taskHeadersReleased).toBe(headers);
  } finally {
    device.destroyBuffer(readback);
    view.dispose();
    scene.dispose();
    native.destroy();
  }
}, 30_000);

it('selects background Filtered headers through one cached graph for 60 native submissions', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const source = createFilterPlanFixture({ instances: 65 });
  const available = GpuScene.create(device, 8).unwrap();
  if (available.status !== 'available') throw Error('Missing native GPU Scene');
  const scene = available.scene;
  scene
    .sync({
      created: source.slots.length,
      updated: 0,
      removed: 0,
      recreated: 0,
      ignoredLateUpdates: 0,
      createdSlots: [...source.slots],
      updatedSlots: [],
      contentUpdatedSlots: [],
      instanceUpdatedSlots: [],
      removedSlots: [],
      recreatedSlots: [],
      previous: new Map(),
      resynced: 0,
    })
    .unwrap();
  const prepared = source.prepare();
  const rows = prepared.residentRows.slice(1);
  const owner = new FilteredPlanContributionOwner();
  const context = { scene, device };
  owner.update(
    assemblePreparedPlan(prepared.source, [], {
      ...prepared.source,
      batches: [],
      candidateCount: 0,
    }),
    undefined,
    undefined,
    context,
  );
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const readback = device.createBuffer({ size: 40, usage: 1 | 8 }).unwrap();
  let graph: ReturnType<RenderGraphBuilder<{ encoder: RhiCommandEncoder }>['compile']> | undefined;
  if (source.source.sourceGroups === undefined) throw Error('Missing source roots');
  scene.inputs.adoptSources(source.source.sourceGroups);
  try {
    writes.mockClear();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (row === undefined) throw Error('Missing actual inactive row');
      owner
        .prepareContribution({
          plan: prepared.source,
          index: index + 1,
          row,
          taskContext: context,
          isCurrent: () => true,
        })
        .unwrap();
    }
    expect(writes).not.toHaveBeenCalled();
    const written = scene.inputs.taskHeadersWritten;
    expect(written).toBe(2);
    let completed = 0;
    for (let frame = 0; frame < 60; frame++) {
      const selected = frame % 3 === 0 ? rows : rows.filter((_, index) => index === frame % 2);
      const batches = selected.map((row) => row.origin);
      const filtered = owner.update(
        assemblePreparedPlan(prepared.source, rows, {
          ...prepared.source,
          batches,
          candidateCount: batches.reduce((sum, batch) => sum + batch.candidates.length, 0),
        }),
        undefined,
        undefined,
        context,
      );
      const plan = filtered.active.plan;
      const resources = scene.captureResources().unwrap();
      try {
        view.update(plan, scene, resources.inputReads(), planes).unwrap();
        if (graph === undefined) {
          const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
          view.addPasses(builder).unwrap();
          graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } });
        }
        resources.seal().unwrap();
        const encoder = device.createCommandEncoder().unwrap();
        graph.unwrap().execute({ encoder }).unwrap();
        const indirect = view.indirectBuffer;
        if (indirect === undefined) throw Error('Missing actual indirect buffer');
        let index = 0;
        for (const batch of plan.batches)
          encoder.copyBufferToBuffer(indirect, batch.indirectOffset, readback, index++ * 20, 20);
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        view._commitResourceReplacement();
        await device.queue.onSubmittedWorkDone();
        const mapped = (await readback.mapAsync(1)).unwrap();
        try {
          const words = new Uint32Array(mapped.getMappedRange().unwrap());
          let index = 0;
          for (const batch of plan.batches) {
            expect(words[index * 5], `frame ${frame} indexCount`).toBe(batch.key.count);
            expect(words[index * 5 + 1], `frame ${frame} instances`).toBe(65);
            index++;
          }
        } finally {
          mapped.unmap();
        }
        expect(scene.inputs.taskHeadersWritten).toBe(written);
        expect(scene.inputs.taskHeadersReleased).toBe(0);
        completed++;
      } finally {
        resources.release();
      }
    }
    expect(completed).toBe(60);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    writes.mockRestore();
    if (graph?.ok) await graph.value.retire();
    view.dispose();
    owner.clear();
    device.destroyBuffer(readback);
    scene.dispose();
    native.destroy();
  }
}, 30_000);
