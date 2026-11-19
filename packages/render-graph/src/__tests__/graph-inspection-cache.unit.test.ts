import type { Buffer, Texture } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { RenderGraphBuilder } from '../builder';
import { compiledRenderGraphGeneration } from '../compiled-graph';
import type { CompiledRenderGraph, CompiledRenderGraphInfo, RenderGraphFrame } from '../types';

it('reads compiled generations without inspection and falls back for external graphs', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const builder = new RenderGraphBuilder();
  const buffer = builder.createBuffer('generation-buffer', { size: 16 }).unwrap();
  builder
    .addCopyPass('write-generation-buffer', {
      accesses: [{ resource: buffer, usage: 'copy-dst' }],
      encode() {},
    })
    .unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const inspect = vi.spyOn(graph, 'inspect');

  const generation = compiledRenderGraphGeneration(graph);
  expect(generation).toBeGreaterThan(0);
  expect(inspect).not.toHaveBeenCalled();

  const info = graph.inspect();
  expect(info.generation).toBe(generation);
  expect(info.resources).toMatchObject([
    { label: 'generation-buffer', allocationState: 'live', byteSize: 16 },
  ]);
  expect(info.resourceAllocation?.liveBytes).toBe(16);
  expect(inspect).toHaveBeenCalledOnce();
  (await graph.retire()).unwrap();

  const externalInfo = { generation: 73 } as unknown as CompiledRenderGraphInfo;
  const externalInspect = vi.fn(() => externalInfo);
  const externalGraph = {
    inspect: externalInspect,
  } as Pick<CompiledRenderGraph<RenderGraphFrame>, 'inspect'>;
  expect(compiledRenderGraphGeneration(externalGraph)).toBe(73);
  expect(externalInspect).toHaveBeenCalledOnce();
});

it('projects resolved import allocations without owning them and invalidates only changed or failed inputs', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const texture = () =>
    device
      .createTexture({
        format: 'rgba16float',
        size: { width: 16, height: 16, depthOrArrayLayers: 1 },
        usage: 4,
      })
      .unwrap();
  const firstTexture = texture(),
    secondTexture = texture();
  const buffer = device.createBuffer({ size: 16, usage: 128 }).unwrap();
  interface Frame extends RenderGraphFrame {
    texture: Texture;
    buffer: Buffer;
    fail: boolean;
  }
  const builder = new RenderGraphBuilder<Frame>();
  const importedTexture = builder
    .importTexture(
      'imported-texture',
      { format: 'rgba16float', size: { width: 16, height: 16 }, usage: 4 },
      (frame) => frame.texture,
    )
    .unwrap();
  const importedBuffer = builder
    .importBuffer('imported-buffer', { size: 16, usage: 128 }, (frame) => {
      if (frame.fail) throw new Error('owned resolver failure');
      return frame.buffer;
    })
    .unwrap();
  builder
    .addComputePass('read-imports', {
      accesses: [
        { resource: builder.view(importedTexture).unwrap(), usage: 'sampled-read' },
        { resource: importedBuffer, usage: 'storage-read' },
      ],
      encode() {},
    })
    .unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
  const before = graph.inspect();
  expect(before.resources.every((resource) => resource.physicalAllocationKey === undefined)).toBe(
    true,
  );
  const execute = (source: Texture, fail = false) =>
    graph.execute({
      encoder: device.createCommandEncoder().unwrap(),
      texture: source,
      buffer,
      fail,
    });
  execute(firstTexture).unwrap();
  const first = graph.inspect();
  expect(first.resources.every((resource) => resource.physicalAllocationKey !== undefined)).toBe(
    true,
  );
  expect(first.resourceAllocation?.liveBytes).toBe(0);
  execute(firstTexture).unwrap();
  expect(graph.inspect()).toBe(first);
  execute(secondTexture).unwrap();
  const second = graph.inspect();
  expect(second.resources[0]?.physicalAllocationKey).not.toBe(
    first.resources[0]?.physicalAllocationKey,
  );
  expect(first.resources[0]?.physicalAllocationKey).toBeDefined();
  expect(before.resources[0]?.physicalAllocationKey).toBeUndefined();
  expect(execute(firstTexture, true).ok).toBe(false);
  expect(
    graph.inspect().resources.every((resource) => resource.physicalAllocationKey === undefined),
  ).toBe(true);
  execute(secondTexture).unwrap();
  expect(graph.inspect().resources[0]?.physicalAllocationKey).toBe(
    second.resources[0]?.physicalAllocationKey,
  );
  (await graph.retire()).unwrap();
  device.destroyTexture(firstTexture).unwrap();
  device.destroyTexture(secondTexture).unwrap();
  device.destroyBuffer(buffer).unwrap();
});

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const builder = new RenderGraphBuilder();
  for (const label of ['first', 'second']) {
    const resource = builder.createBuffer(label, { size: 16 }).unwrap();
    builder
      .addCopyPass(`write-${label}`, { accesses: [{ resource, usage: 'copy-dst' }], encode() {} })
      .unwrap();
  }
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  return { device, graph };
}

it('reuses live inspection without recreating resource rows and refreshes after each release', async () => {
  const { device, graph } = await fixture();
  let complete: (() => void) | undefined;
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(
    () =>
      new Promise<undefined>((resolve) => {
        complete = () => resolve(undefined);
      }),
  );
  const live = graph.inspect();
  expect(Object.isFrozen(live)).toBe(true);
  expect(Object.isFrozen(live.resourceAllocation)).toBe(true);
  for (let frame = 0; frame < 600; frame += 1) expect(graph.inspect()).toBe(live);
  const retiring = graph.retire();
  const pending = graph.inspect();
  expect(pending).not.toBe(live);
  expect(graph.inspect()).toBe(pending);
  expect(live.resourceAllocation?.liveBytes).toBe(32);
  expect(pending.resourceAllocation?.pendingRetirementBytes).toBe(32);
  const destroy = device.destroyBuffer.bind(device);
  let visits = 0;
  vi.spyOn(device, 'destroyBuffer').mockImplementation((buffer) => {
    if (visits++ === 1) {
      const partial = graph.inspect();
      expect(partial).not.toBe(pending);
      expect(partial.resourceAllocation).toMatchObject({
        pendingRetirementBytes: 16,
        retiredBytes: 16,
      });
      expect(partial.resources.map((row) => row.allocationState)).toEqual([
        'released',
        'pending-retirement',
      ]);
      expect(graph.inspect()).toBe(partial);
    }
    return destroy(buffer);
  });
  complete?.();
  expect((await retiring).ok).toBe(true);
  const released = graph.inspect();
  expect(released.resourceAllocation).toMatchObject({
    pendingRetirementBytes: 0,
    retiredBytes: 32,
  });
  expect(released.resources.map((row) => row.allocationState)).toEqual(['released', 'released']);
  expect(graph.inspect()).toBe(released);
  expect(pending.resourceAllocation?.pendingRetirementBytes).toBe(32);
  expect(released.passes).toBe(live.passes);
});

it.each([
  'refuse',
  'throw',
] as const)('keeps a failed %s token pending while refreshing released tokens', async (mode) => {
  const { device, graph } = await fixture();
  const live = graph.inspect();
  const destroy = device.destroyBuffer.bind(device);
  let visits = 0;
  vi.spyOn(device, 'destroyBuffer').mockImplementation((buffer) => {
    if (visits++ === 0) {
      if (mode === 'throw') throw new Error('owned test refusal');
      return { ok: false, error: { code: 'webgpu-runtime-error' } } as never;
    }
    return destroy(buffer);
  });
  expect((await graph.retire()).ok).toBe(false);
  const failed = graph.inspect();
  expect(failed).not.toBe(live);
  expect(failed.resourceAllocation).toMatchObject({
    liveBytes: 0,
    pendingRetirementBytes: 16,
    retiredBytes: 16,
  });
  expect(failed.resources.map((row) => row.allocationState)).toEqual([
    'pending-retirement',
    'released',
  ]);
  expect(graph.inspect()).toBe(failed);
});

it('keeps a rejected fence pending and never replaces its snapshot with released evidence', async () => {
  const { device, graph } = await fixture();
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockRejectedValue(new Error('owned fence refusal'));
  const live = graph.inspect();
  const retirement = graph.retire();
  const pending = graph.inspect();
  expect((await retirement).ok).toBe(false);
  expect(pending).not.toBe(live);
  expect(graph.inspect()).toBe(pending);
  expect(pending.resourceAllocation).toMatchObject({ pendingRetirementBytes: 32, retiredBytes: 0 });
});
