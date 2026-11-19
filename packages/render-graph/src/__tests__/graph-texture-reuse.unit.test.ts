import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { RenderGraphBuilder } from '../builder';
import type { CompiledRenderGraph, GraphTextureViewDescriptor, RenderGraphFrame } from '../types';

function compile(
  device: RhiDevice,
  previous?: CompiledRenderGraph<RenderGraphFrame>,
  width = 8,
  extra = false,
  viewDescriptor: GraphTextureViewDescriptor = {},
) {
  const builder = new RenderGraphBuilder();
  const texture = builder
    .createTexture('scene-color', { size: 'surface', format: 'rgba8unorm' })
    .unwrap();
  const view = builder.view(texture, viewDescriptor).unwrap();
  builder
    .addRasterPass('scene', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      encode() {},
    })
    .unwrap();
  if (extra) builder.addCopyPass('vfx-topology-change', { accesses: [], encode() {} }).unwrap();
  return builder
    .compile({ device, surfaceSize: { width, height: 8 }, reuseResourcesFrom: previous })
    .unwrap();
}

function persistentGraph(
  device: RhiDevice,
  previous: CompiledRenderGraph<RenderGraphFrame> | undefined,
  mode: 'write' | 'read' | 'read-discard' | 'discard-read',
  layer: number,
  width = 8,
  storeOp: GPUStoreOp = 'store',
  mip = 0,
) {
  const builder = new RenderGraphBuilder<RenderGraphFrame>();
  const texture = builder
    .createTexture('persistent-content', {
      format: 'rgba8unorm',
      size: { width, height: 8, depthOrArrayLayers: 2 },
      mipLevelCount: 2,
      lifetime: 'persistent',
      usage: 0x14,
    })
    .unwrap();
  const view = builder
    .view(texture, {
      dimension: '2d',
      baseMipLevel: mip,
      mipLevelCount: 1,
      baseArrayLayer: layer,
      arrayLayerCount: 1,
    })
    .unwrap();
  if (mode === 'write') {
    builder
      .addRasterPass('write-content', {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp }],
        encode() {},
      })
      .unwrap();
  } else if (mode === 'discard-read') {
    builder
      .addRasterPass('discard-content', {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp }],
        encode() {},
      })
      .unwrap();
    builder
      .addComputePass('read-discarded-content', {
        accesses: [{ resource: view, usage: 'sampled-read' }],
        encode() {},
      })
      .unwrap();
  } else {
    builder
      .addComputePass('read-content', {
        accesses: [{ resource: view, usage: 'sampled-read' }],
        encode() {},
      })
      .unwrap();
    if (mode === 'read-discard') {
      builder
        .addRasterPass('discard-content', {
          accesses: [{ resource: view, usage: 'color-attachment' }],
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'discard' }],
          encode() {},
        })
        .unwrap();
    }
  }
  return builder.compile({
    device,
    surfaceSize: { width, height: 8 },
    reuseResourcesFrom: previous,
  });
}

async function executeAndCommit(graph: CompiledRenderGraph<RenderGraphFrame>, device: RhiDevice) {
  const encoder = device.createCommandEncoder().unwrap();
  expect(graph.execute({ encoder }).ok).toBe(true);
  expect(encoder.finish().ok).toBe(true);
  graph.commitExecution();
}

function persistentDepthStencilGraph(
  device: RhiDevice,
  previous: CompiledRenderGraph<RenderGraphFrame> | undefined,
  mode:
    | 'write-both'
    | 'discard-depth'
    | 'discard-stencil'
    | 'mixed-discard-depth-all'
    | 'mixed-discard-stencil-all'
    | 'read-depth'
    | 'read-stencil'
    | 'read-all',
) {
  const builder = new RenderGraphBuilder<RenderGraphFrame>();
  const texture = builder
    .createTexture('persistent-depth-stencil', {
      format: 'depth24plus-stencil8',
      size: { width: 8, height: 8 },
      lifetime: 'persistent',
      usage: 0x14,
    })
    .unwrap();
  const aspect =
    mode === 'write-both' || mode === 'read-all' || mode.endsWith('-all')
      ? 'all'
      : mode.endsWith('depth')
        ? 'depth-only'
        : 'stencil-only';
  const view = builder.view(texture, { dimension: '2d', aspect }).unwrap();
  if (mode === 'write-both') {
    builder
      .addRasterPass('write-both-aspects', {
        accesses: [{ resource: view, usage: 'depth-stencil-write' }],
        colorAttachments: [],
        depthStencilAttachment: {
          view,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'store',
        },
        encode() {},
      })
      .unwrap();
  } else if (mode === 'discard-depth') {
    builder
      .addRasterPass('discard-depth-aspect', {
        accesses: [{ resource: view, usage: 'depth-stencil-write' }],
        colorAttachments: [],
        depthStencilAttachment: {
          view,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
        },
        encode() {},
      })
      .unwrap();
  } else if (mode === 'discard-stencil') {
    builder
      .addRasterPass('discard-stencil-aspect', {
        accesses: [{ resource: view, usage: 'depth-stencil-write' }],
        colorAttachments: [],
        depthStencilAttachment: {
          view,
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
        },
        encode() {},
      })
      .unwrap();
  } else if (mode === 'mixed-discard-depth-all') {
    builder
      .addRasterPass('discard-depth-keep-stencil', {
        accesses: [{ resource: view, usage: 'depth-stencil-write' }],
        colorAttachments: [],
        depthStencilAttachment: {
          view,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'store',
        },
        encode() {},
      })
      .unwrap();
  } else if (mode === 'mixed-discard-stencil-all') {
    builder
      .addRasterPass('keep-depth-discard-stencil', {
        accesses: [{ resource: view, usage: 'depth-stencil-write' }],
        colorAttachments: [],
        depthStencilAttachment: {
          view,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
        },
        encode() {},
      })
      .unwrap();
  } else {
    builder
      .addComputePass('read-aspect', {
        accesses: [{ resource: view, usage: 'sampled-read' }],
        encode() {},
      })
      .unwrap();
  }
  return builder.compile({
    device,
    surfaceSize: { width: 8, height: 8 },
    reuseResourcesFrom: previous,
  });
}

function persistentDepthStencilMixedStoreThenRead(
  device: RhiDevice,
  previous: CompiledRenderGraph<RenderGraphFrame>,
  depthStoreOp: GPUStoreOp,
  stencilStoreOp: GPUStoreOp,
  readAspect: 'depth-only' | 'stencil-only',
) {
  const builder = new RenderGraphBuilder<RenderGraphFrame>();
  const texture = builder
    .createTexture('persistent-depth-stencil', {
      format: 'depth24plus-stencil8',
      size: { width: 8, height: 8 },
      lifetime: 'persistent',
      usage: 0x14,
    })
    .unwrap();
  const allView = builder.view(texture, { dimension: '2d', aspect: 'all' }).unwrap();
  const readView = builder.view(texture, { dimension: '2d', aspect: readAspect }).unwrap();
  builder
    .addRasterPass('mixed-depth-stencil-store', {
      accesses: [{ resource: allView, usage: 'depth-stencil-write' }],
      colorAttachments: [],
      depthStencilAttachment: {
        view: allView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp,
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp,
      },
      encode() {},
    })
    .unwrap();
  builder
    .addComputePass('read-one-aspect', {
      accesses: [{ resource: readView, usage: 'sampled-read' }],
      encode() {},
    })
    .unwrap();
  return builder.compile({
    device,
    surfaceSize: { width: 8, height: 8 },
    reuseResourcesFrom: previous,
  });
}

function persistentDepthStencilMixedLoadThenClear(
  device: RhiDevice,
  previous: CompiledRenderGraph<RenderGraphFrame>,
  loadAspect: 'depth-only' | 'stencil-only',
) {
  const builder = new RenderGraphBuilder<RenderGraphFrame>();
  const texture = builder
    .createTexture('persistent-depth-stencil', {
      format: 'depth24plus-stencil8',
      size: { width: 8, height: 8 },
      lifetime: 'persistent',
      usage: 0x14,
    })
    .unwrap();
  const view = builder.view(texture, { dimension: '2d', aspect: 'all' }).unwrap();
  builder
    .addRasterPass('mixed-depth-stencil-load', {
      accesses: [{ resource: view, usage: 'depth-stencil-write' }],
      colorAttachments: [],
      depthStencilAttachment: {
        view,
        depthClearValue: 1,
        depthLoadOp: loadAspect === 'depth-only' ? 'load' : 'clear',
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp: loadAspect === 'stencil-only' ? 'load' : 'clear',
        stencilStoreOp: 'store',
      },
      encode() {},
    })
    .unwrap();
  return builder.compile({
    device,
    surfaceSize: { width: 8, height: 8 },
    reuseResourcesFrom: previous,
  });
}

it('retains same-descriptor targets across topology replacements until every graph fence retires', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const creates = vi.spyOn(device, 'createTexture');
  const views = vi.spyOn(device, 'createTextureView');
  const destroys = vi.spyOn(device, 'destroyTexture');
  const first = compile(device);
  const second = compile(device, first, 8, true);
  expect(creates).toHaveBeenCalledTimes(1);
  expect(views).toHaveBeenCalledTimes(1);
  expect(second.inspect().resources[0]?.physicalAllocationKey).toBe(
    first.inspect().resources[0]?.physicalAllocationKey,
  );
  await first.retire();
  expect(destroys).not.toHaveBeenCalled();
  const third = compile(device, second);
  expect(creates).toHaveBeenCalledTimes(1);
  expect(views).toHaveBeenCalledTimes(1);
  await second.retire();
  expect(destroys).not.toHaveBeenCalled();
  await third.retire();
  expect(destroys).toHaveBeenCalledTimes(1);
});

it('allocates a distinct resized target and retains the old graph for rollback', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const creates = vi.spyOn(device, 'createTexture');
  const first = compile(device);
  const resized = compile(device, first, 16);
  expect(creates).toHaveBeenCalledTimes(2);
  await resized.retire();
  const fallback = compile(device, first);
  expect(creates).toHaveBeenCalledTimes(2);
  await fallback.retire();
  await first.retire();
});

it('releases a failed candidate lease without destroying the usable previous graph', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const first = compile(device);
  const destroys = vi.spyOn(device, 'destroyTexture');
  const views = vi
    .spyOn(device, 'createTextureView')
    .mockReturnValueOnce({ ok: false, error: { code: 'webgpu-runtime-error' } } as never);
  expect(() => compile(device, first, 8, false, { baseMipLevel: 0 })).toThrow();
  expect(destroys).not.toHaveBeenCalled();
  views.mockRestore();
  const creates = vi.spyOn(device, 'createTexture');
  const retry = compile(device, first);
  expect(creates).not.toHaveBeenCalled();
  await retry.retire();
  expect(destroys).not.toHaveBeenCalled();
  await first.retire();
  expect(destroys).toHaveBeenCalledTimes(1);
});

it('waits for both generation fences even when they complete out of order', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const fences: Array<() => void> = [];
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(
    () => new Promise<undefined>((resolve) => fences.push(() => resolve(undefined))),
  );
  const destroys = vi.spyOn(device, 'destroyTexture');
  const first = compile(device);
  const second = compile(device, first);
  const oldRetirement = first.retire();
  const newRetirement = second.retire();
  expect(fences).toHaveLength(2);
  fences[1]?.();
  expect((await newRetirement).ok).toBe(true);
  expect(destroys).not.toHaveBeenCalled();
  expect(first.inspect().resources[0]?.allocationState).toBe('pending-retirement');
  fences[0]?.();
  expect((await oldRetirement).ok).toBe(true);
  expect(destroys).toHaveBeenCalledTimes(1);
  expect(first.inspect().resources[0]?.allocationState).toBe('released');
});

it('never borrows from a retired graph or a different device', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const otherDevice = (await adapter.requestDevice()).unwrap();
  const creates = vi.spyOn(device, 'createTexture');
  const otherCreates = vi.spyOn(otherDevice, 'createTexture');
  const first = compile(device);
  const other = compile(otherDevice, first);
  expect(otherCreates).toHaveBeenCalledTimes(1);
  await first.retire();
  const replacement = compile(device, first);
  expect(creates).toHaveBeenCalledTimes(2);
  await replacement.retire();
  await other.retire();
});

it('inherits only submitted writes covering the exact persistent texture range', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const otherDevice = (await adapter.requestDevice()).unwrap();
  const first = persistentGraph(device, undefined, 'write', 0).unwrap();
  const firstEncoder = device.createCommandEncoder().unwrap();
  expect(first.execute({ encoder: firstEncoder }).ok).toBe(true);
  expect(firstEncoder.finish().ok).toBe(true);
  first.discardExecution();
  const uncommitted = persistentGraph(device, first, 'read', 0);
  expect(uncommitted.ok).toBe(false);
  if (!uncommitted.ok) expect(uncommitted.error.code).toBe('uninitialized-read');

  await executeAndCommit(first, device);
  const retained = persistentGraph(device, first, 'read', 0);
  expect(retained.ok).toBe(true);
  if (retained.ok) {
    await executeAndCommit(retained.value, device);
    const relayed = persistentGraph(device, retained.value, 'read', 0);
    expect(relayed.ok).toBe(true);
    if (relayed.ok) await relayed.value.retire();
    await retained.value.retire();
  }

  const uncoveredLayer = persistentGraph(device, first, 'read', 1);
  expect(uncoveredLayer.ok).toBe(false);
  if (!uncoveredLayer.ok) expect(uncoveredLayer.error.code).toBe('uninitialized-read');

  const uncoveredMip = persistentGraph(device, first, 'read', 0, 8, 'store', 1);
  expect(uncoveredMip.ok).toBe(false);
  if (!uncoveredMip.ok) expect(uncoveredMip.error.code).toBe('uninitialized-read');

  const changedExtent = persistentGraph(device, first, 'read', 0, 16);
  expect(changedExtent.ok).toBe(false);
  if (!changedExtent.ok) expect(changedExtent.error.code).toBe('uninitialized-read');

  const changedDevice = persistentGraph(otherDevice, first, 'read', 0);
  expect(changedDevice.ok).toBe(false);
  if (!changedDevice.ok) expect(changedDevice.error.code).toBe('uninitialized-read');

  await first.retire();
});

it('does not publish ranges whose raster attachment discards its store', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const discarded = persistentGraph(device, undefined, 'write', 0, 8, 'discard').unwrap();
  await executeAndCommit(discarded, device);
  const successor = persistentGraph(device, discarded, 'read', 0);
  expect(successor.ok).toBe(false);
  if (!successor.ok) expect(successor.error.code).toBe('uninitialized-read');
  await discarded.retire();
});

it('does not publish a pass write when the execution observer skips encoding it', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const skipped = persistentGraph(device, undefined, 'write', 0).unwrap();
  expect(
    skipped.execute({ encoder: device.createCommandEncoder().unwrap() }, () => undefined).ok,
  ).toBe(true);
  skipped.commitExecution();
  const read = persistentGraph(device, skipped, 'read', 0);
  expect(read.ok).toBe(false);
  if (!read.ok) expect(read.error.code).toBe('uninitialized-read');
  await skipped.retire();
});

it('invalidates previously committed content when a submitted write discards the same range', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const written = persistentGraph(device, undefined, 'write', 0).unwrap();
  await executeAndCommit(written, device);
  const discarded = persistentGraph(device, written, 'read-discard', 0).unwrap();
  await executeAndCommit(discarded, device);
  const read = persistentGraph(device, discarded, 'read', 0);
  expect(read.ok).toBe(false);
  if (!read.ok) expect(read.error.code).toBe('uninitialized-read');
  await discarded.retire();
  await written.retire();
});

it('revalidates borrowed persistent content when another graph discards it after compilation', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const written = persistentGraph(device, undefined, 'write', 0).unwrap();
  await executeAndCommit(written, device);
  const delayed = persistentGraph(device, written, 'read', 0).unwrap();
  const discard = persistentGraph(device, written, 'read-discard', 0).unwrap();
  await executeAndCommit(discard, device);

  const execution = delayed.execute({ encoder: device.createCommandEncoder().unwrap() });
  expect(execution.ok).toBe(false);
  if (!execution.ok) expect(execution.error.code).toBe('uninitialized-read');
  await delayed.retire();
  await discard.retire();
  await written.retire();
});

it('rejects a same-graph read after a discard even when the reused allocation had old content', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const written = persistentGraph(device, undefined, 'write', 0).unwrap();
  await executeAndCommit(written, device);
  const candidate = persistentGraph(device, written, 'discard-read', 0, 8, 'discard');
  expect(candidate.ok).toBe(false);
  if (!candidate.ok) expect(candidate.error.code).toBe('uninitialized-read');
  await written.retire();
});

it.each([
  { discarded: 'discard-depth', retained: 'read-stencil', invalid: 'read-depth' },
  { discarded: 'discard-stencil', retained: 'read-depth', invalid: 'read-stencil' },
  { discarded: 'mixed-discard-depth-all', retained: 'read-stencil', invalid: 'read-depth' },
  { discarded: 'mixed-discard-stencil-all', retained: 'read-depth', invalid: 'read-stencil' },
] as const)('preserves only the stored depth-stencil aspect after $discarded', async ({
  discarded,
  retained,
  invalid,
}) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const first = persistentDepthStencilGraph(device, undefined, 'write-both').unwrap();
  await executeAndCommit(first, device);
  const second = persistentDepthStencilGraph(device, first, discarded).unwrap();
  await executeAndCommit(second, device);
  const retainedAspect = persistentDepthStencilGraph(device, second, retained);
  expect(retainedAspect.ok).toBe(true);
  if (retainedAspect.ok) await retainedAspect.value.retire();
  const discardedAspect = persistentDepthStencilGraph(device, second, invalid);
  expect(discardedAspect.ok).toBe(false);
  if (!discardedAspect.ok) expect(discardedAspect.error.code).toBe('uninitialized-read');
  const allAspects = persistentDepthStencilGraph(device, second, 'read-all');
  expect(allAspects.ok).toBe(false);
  if (!allAspects.ok) expect(allAspects.error.code).toBe('uninitialized-read');
  await second.retire();
  await first.retire();
});

it('checks only the loaded aspect for same-graph all-view depth-stencil attachments', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const both = persistentDepthStencilGraph(device, undefined, 'write-both').unwrap();
  await executeAndCommit(both, device);
  const depthOnly = persistentDepthStencilGraph(device, both, 'discard-stencil').unwrap();
  await executeAndCommit(depthOnly, device);
  const depthLoadStencilClear = persistentDepthStencilMixedLoadThenClear(
    device,
    depthOnly,
    'depth-only',
  );
  expect(depthLoadStencilClear.ok).toBe(true);
  if (depthLoadStencilClear.ok) await depthLoadStencilClear.value.retire();

  await executeAndCommit(both, device);
  const stencilOnly = persistentDepthStencilGraph(device, both, 'discard-depth').unwrap();
  await executeAndCommit(stencilOnly, device);
  const depthClearStencilLoad = persistentDepthStencilMixedLoadThenClear(
    device,
    stencilOnly,
    'stencil-only',
  );
  expect(depthClearStencilLoad.ok).toBe(true);
  if (depthClearStencilLoad.ok) await depthClearStencilLoad.value.retire();

  await stencilOnly.retire();
  await depthOnly.retire();
  await both.retire();
});

it.each([
  { depthStore: 'discard', stencilStore: 'store', retained: 'stencil-only', invalid: 'depth-only' },
  { depthStore: 'store', stencilStore: 'discard', retained: 'depth-only', invalid: 'stencil-only' },
] as const)('checks same-graph first reads against mixed all-view store ops', async ({
  depthStore,
  stencilStore,
  retained,
  invalid,
}) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const first = persistentDepthStencilGraph(device, undefined, 'write-both').unwrap();
  await executeAndCommit(first, device);
  const readable = persistentDepthStencilMixedStoreThenRead(
    device,
    first,
    depthStore,
    stencilStore,
    retained,
  );
  expect(readable.ok).toBe(true);
  if (readable.ok) await readable.value.retire();
  const unreadable = persistentDepthStencilMixedStoreThenRead(
    device,
    first,
    depthStore,
    stencilStore,
    invalid,
  );
  expect(unreadable.ok).toBe(false);
  if (!unreadable.ok) expect(unreadable.error.code).toBe('uninitialized-read');
  await first.retire();
});
