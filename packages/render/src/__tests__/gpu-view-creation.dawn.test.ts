import { type CompiledRenderGraph, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type Buffer, err, ok, type RhiCommandEncoder, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { assert, expect, it, vi } from 'vitest';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { encodedViewTopology } from '../gpu-driven/view-topology';
import type { GpuSceneResourceFrame } from '../gpu-scene';
import { nativeDeviceFixture } from './native-device-fixture';
import { shadowSourceFixture } from './shadow-source-content.fixture';

it('completion-qualifies the actual native View recipe without allocating execution buffers', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  let view: GpuDrivenView | undefined;
  const sync = vi.spyOn(device, 'createComputePipeline');
  const buffers = vi.spyOn(device, 'createBuffer');
  try {
    assert(device.createComputePipelineAsync);
    const completed = vi.spyOn(device, 'createComputePipelineAsync');
    try {
      const module = (
        await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })
      ).unwrap();
      const work = GpuDrivenView.prepareCreation(
        { device, shaderModuleFactory: { createShaderModule: () => ok(module) } },
        () => true,
      );
      for (let count = 0; count < 100; count++) {
        const next = work.next();
        if (next.done) {
          view = next.value.unwrap();
          break;
        }
        if (next.value instanceof Promise) await next.value;
      }
      assert(view);
      expect(completed).toHaveBeenCalledTimes(8);
      expect(sync).not.toHaveBeenCalled();
      expect(buffers).not.toHaveBeenCalled();
      expect(view.visibleBuffer).toBeUndefined();
      expect(await native.popErrorScope()).toBeNull();
    } finally {
      completed.mockRestore();
    }
  } finally {
    sync.mockRestore();
    buffers.mockRestore();
    view?.dispose();
    if (view !== undefined) (await view.settleRetirement()).unwrap();
    native.destroy();
  }
}, 30000);

it('prepares real static target storage incrementally and consumes the same native buffers in first compute', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const failures: unknown[] = [];
  const attempt = async (run: () => unknown | Promise<unknown>) => {
    try {
      await run();
    } catch (cause) {
      failures.push(cause);
    }
  };
  let view: GpuDrivenView | undefined;
  let source: ReturnType<typeof shadowSourceFixture> | undefined;
  let resources: GpuSceneResourceFrame | undefined;
  let graph: CompiledRenderGraph<{ encoder: RhiCommandEncoder }> | undefined;
  let readback: Buffer | undefined;
  let construction: ReturnType<typeof GpuDrivenView.prepareCreation> | undefined;
  let storage: ReturnType<GpuDrivenView['prepareInitialStorage']> | undefined;
  const creates = vi.spyOn(device, 'createBuffer');
  try {
    const module = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
    const factory = { createShaderModule: () => ok(module) };
    construction = GpuDrivenView.prepareCreation(
      { device, shaderModuleFactory: factory },
      () => true,
    );
    for (let count = 0; count < 100; count++) {
      const next = construction.next();
      if (next.done) {
        view = next.value.unwrap();
        break;
      }
      if (next.value instanceof Promise) await next.value;
    }
    assert(view);
    source = shadowSourceFixture(device, factory);
    const input = source.input();
    if (input.sourcePlan.sourceGroups !== undefined)
      source.scene.inputs.adoptSources(input.sourcePlan.sourceGroups);
    storage = view.prepareInitialStorage(input.sourcePlan, source.scene, () => true, {
      surfaceRows: false,
      lateMirror: true,
    });
    let finished = false;
    creates.mockClear();
    for (let count = 0; count < 100; count++) {
      const before = creates.mock.calls.length;
      const next = storage.next();
      expect(creates.mock.calls.length - before).toBeLessThanOrEqual(1);
      if (next.done) {
        next.value.unwrap();
        finished = true;
        break;
      }
      expect(view.visibleBuffer).toBeUndefined();
    }
    expect(finished).toBe(true);
    const preparedBuffers = creates.mock.results.flatMap((result) =>
      result.type === 'return' && result.value.ok ? [result.value.value] : [],
    );
    expect(preparedBuffers).toHaveLength(6);
    resources = source.scene.captureResources().unwrap();
    const reads = resources.inputReads();
    // Other C1 stages stay explicit: this storage proof does not claim topology/Inputs were prepared above.
    encodedViewTopology(input.sourcePlan, source.scene, reads);
    reads.buffer().unwrap();
    creates.mockClear();
    view.update(input.sourcePlan, source.scene, reads, input.planes).unwrap();
    resources.seal().unwrap();
    expect(creates).not.toHaveBeenCalled();
    const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    view.addPasses(builder).unwrap();
    graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const extent = Math.max(
      ...Array.from(input.sourcePlan.batches, (batch) => batch.indirectOffset + 20),
    );
    readback = device.createBuffer({ size: extent, usage: 1 | 8 }).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    graph.execute({ encoder }).unwrap();
    const indirect = view.indirectBuffer;
    assert(indirect);
    expect(preparedBuffers).toContain(indirect);
    encoder.copyBufferToBuffer(indirect, 0, readback, 0, extent);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapping = (await readback.mapAsync(1)).unwrap();
    try {
      const bytes = new DataView(mapping.getMappedRange().unwrap());
      const count = Array.from(input.sourcePlan.batches).reduce(
        (sum, batch) => sum + bytes.getUint32(batch.indirectOffset + 4, true),
        0,
      );
      expect(count).toBe(input.sourcePlan.candidateCount);
      expect(count).toBeGreaterThan(0);
    } finally {
      mapping.unmap();
    }
    expect(await native.popErrorScope()).toBeNull();
  } catch (cause) {
    failures.push(cause);
  } finally {
    creates.mockRestore();
    await attempt(() =>
      storage?.return(
        err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'closed native storage witness',
            hint: 'retire every private receipt',
          }),
        ),
      ),
    );
    await attempt(() =>
      construction?.return(
        err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'closed native construction witness',
            hint: 'discard pending construction',
          }),
        ),
      ),
    );
    const closingGraph = graph;
    if (closingGraph !== undefined)
      await attempt(async () => (await closingGraph.retire()).unwrap());
    await attempt(() => device.queue.onSubmittedWorkDone());
    await attempt(() => resources?.release());
    await attempt(() => view?.dispose());
    const closingView = view;
    if (closingView !== undefined)
      await attempt(async () => (await closingView.settleRetirement()).unwrap());
    await attempt(() => source?.dispose());
    const closingReadback = readback;
    if (closingReadback !== undefined)
      await attempt(() => device.destroyBuffer(closingReadback).unwrap());
    await attempt(() => native.destroy());
  }
  if (failures.length > 0) throw new AggregateError(failures, 'native initial View storage failed');
}, 30000);
