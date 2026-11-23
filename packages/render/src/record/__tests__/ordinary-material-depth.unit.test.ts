import { RenderGraphBuilder, renderGraphCompileCount } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GpuResourceAllocationLedger } from '../../gpu-driven/resource-allocation';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../../render-pipeline';
import { addTypedScenePass } from '../../typed-render-graph-primitives';
import { addCurrentMaterialDepth, CurrentMaterialDepth } from '../current-material-depth';
import { addOrdinaryMaterialDepthSnapshot } from '../ordinary-material-depth';
import { ViewTargetTextures } from '../view-target-textures';

it.each([
  undefined,
  false,
  true,
])('only requires sampled MSAA depth when the view declares material demand (%s)', async (demand) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const depth = createRenderPipelineTarget(graph, 'scene-depth', {
    format: 'depth32float',
    size: { width: 7, height: 3 },
    sampleCount: 4,
  }).unwrap();
  const color = createRenderPipelineTarget(graph, 'scene-color', {
    format: 'rgba8unorm',
    size: { width: 7, height: 3 },
    sampleCount: 4,
  }).unwrap();
  graph
    .addRasterPass('initial-depth', {
      accesses: [{ resource: depth.view, usage: 'depth-stencil-write' }],
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.view,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
      encodeDirect() {},
    })
    .unwrap();
  addTypedScenePass(graph, {
    name: 'consumer',
    color,
    depth,
    depthLoadOp: 'load',
    colorLoadOp: 'clear',
    materialSceneDepth: demand,
  }).unwrap();
  const create = vi.spyOn(device, 'createTexture');
  const compiled = graph.compile({ device, surfaceSize: { width: 7, height: 3 } }).unwrap();
  try {
    const descriptor = create.mock.calls
      .map(([value]) => value)
      .find((value) => value.label === 'scene-depth');
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) throw new Error('Missing scene depth allocation');
    expect((descriptor.usage & 0x04) !== 0).toBe(demand === true);
    expect(
      compiled.inspect().passes.some((pass) => pass.name === 'consumer.material-depth-resolve'),
    ).toBe(demand === true);
  } finally {
    await compiled.retire();
  }
});

it.each([
  1, 4,
] as const)('declares disjoint before-pass storage with exact extent for %i samples', async (sampleCount) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const depth = createRenderPipelineTarget(graph, 'depth', {
    format: sampleCount === 4 ? 'depth32float-stencil8' : 'depth32float',
    size: { width: 7, height: 3 },
    sampleCount,
  }).unwrap();
  graph
    .addRasterPass('depth-producer', {
      accesses: [{ resource: depth.view, usage: 'depth-stencil-write' }],
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.view,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
      encodeDirect() {},
    })
    .unwrap();
  const sampled = addOrdinaryMaterialDepthSnapshot(graph, depth, 'consumer', () => true).unwrap();
  expect(sampled).not.toBe(depth.view);
  graph
    .addComputePass('actual-consumer', {
      accesses: [{ resource: sampled, usage: 'sampled-read' }],
      encode() {},
    })
    .unwrap();
  const create = vi.spyOn(device, 'createTexture');
  const compiled = graph.compile({ device, surfaceSize: { width: 50, height: 40 } }).unwrap();
  try {
    expect(create.mock.calls.map(([descriptor]) => descriptor)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sampleCount: 1,
          size: { width: 7, height: 3, depthOrArrayLayers: 1 },
        }),
      ]),
    );
    const passes = compiled.inspect().passes.map((pass) => pass.name);
    expect(passes).toEqual([
      'depth-producer',
      sampleCount === 4 ? 'consumer.material-depth-resolve' : 'consumer.material-depth-copy',
      'actual-consumer',
    ]);
  } finally {
    await compiled.retire();
  }
});

it('shares physical depth between ordered consumers and retires it on the last use across 60 changing frames', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const extent = { width: 7, height: 3 };
  const depth = createRenderPipelineTarget(graph, 'scene-depth', {
    format: 'depth32float',
    size: extent,
  }).unwrap();
  const retired = vi.fn((release: () => void) => release());
  const ledger = new GpuResourceAllocationLedger();
  const owner = new CurrentMaterialDepth(new ViewTargetTextures(device, ledger, retired));
  const beforeClear = {};
  const beforeCopy = {};
  let reads = false;
  let executions = 0;
  let earlier: ReturnType<typeof owner.sampled>;
  const inspect = (token: object) => {
    const current = owner.sampled(token);
    if (!reads) {
      expect(current).toBeUndefined();
      return;
    }
    expect(current).toBeDefined();
    if (token === beforeClear) earlier = current;
    else {
      expect(current).toBe(earlier);
      expect(owner.sampled(beforeClear)).toBeUndefined();
    }
    executions++;
  };
  addCurrentMaterialDepth(graph, depth, extent, beforeClear, 'first', true, () => reads).unwrap();
  graph
    .addRasterPass('first', {
      accesses: [{ resource: depth.view, usage: 'depth-stencil-write' }],
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.view,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0.5,
      },
      encodeDirect() {
        inspect(beforeClear);
      },
    })
    .unwrap();
  addCurrentMaterialDepth(graph, depth, extent, beforeCopy, 'second', false, () => reads).unwrap();
  graph
    .addCopyPass('second', {
      accesses: [],
      encodeDirect() {
        inspect(beforeCopy);
      },
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: extent }).unwrap();
  const compilations = renderGraphCompileCount();
  const create = vi.spyOn(device, 'createTexture');
  try {
    for (let tick = 0; tick < 60; tick++) {
      reads = tick % 3 !== 2;
      owner.begin();
      const encoder = device.createCommandEncoder().unwrap();
      const frame = {
        encoder,
        currentMaterialDepthDemand: reads,
        frameState: { ordinaryMaterialDepth: owner },
      } as unknown as RenderPipelineFrame;
      compiled.execute(frame).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      compiled.commitExecution();
      owner.finish();
    }
    expect(executions).toBe(80);
    expect(
      create.mock.calls.filter(([descriptor]) => descriptor.label === 'ordinary-material-depth'),
    ).toHaveLength(20);
    expect(retired).toHaveBeenCalledTimes(20);
    expect(ledger.inspect()).toMatchObject({
      liveBytes: 0,
      pendingRetirementBytes: 0,
      retiredBytes: 7 * 3 * 4 * 20,
    });
    expect(renderGraphCompileCount()).toBe(compilations);
  } finally {
    create.mockRestore();
    owner.release();
    await compiled.retire();
  }
});
