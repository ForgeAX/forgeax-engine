import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../../render-pipeline';
import { addTypedScenePass } from '../../typed-render-graph-primitives';
import { addOrdinaryMaterialDepthSnapshot } from '../ordinary-material-depth';

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
