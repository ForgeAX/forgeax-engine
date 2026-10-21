import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import type { RenderPipelineFrame } from '../render-pipeline';
import { createRenderPipelineTarget } from '../render-pipeline';

const { encodeMainPass, buildPerFrameBindGroups } = vi.hoisted(() => ({
  encodeMainPass: vi.fn(),
  buildPerFrameBindGroups: vi.fn(),
}));

vi.mock('../record/main-pass', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../record/main-pass')>()),
  encodeMainPass,
}));
vi.mock('../record/frame-lighting', () => ({ buildPerFrameBindGroups }));

function frameFor(
  device: import('@forgeax/engine-rhi').RhiDevice,
  materialSlots: readonly object[],
): RenderPipelineFrame {
  return {
    encoder: device.createCommandEncoder({ label: 'temporal-supplement-test' }).unwrap(),
    runtime: { device, errorRegistry: { fire: vi.fn() } },
    frameState: {},
    pipelineState: { colorAttachmentFormat: 'rgba8unorm' },
    validated: [],
    validatedOrdered: [],
    materialSlots,
    materialSlotCount: materialSlots.length,
    bindGroupCounts: {},
  } as unknown as RenderPipelineFrame;
}

describe('loaded temporal supplement eligibility', () => {
  it.each([
    [false, 'forward-only-opaque', 0],
    [true, 'forward-only-opaque', 1],
    [false, 'opaque', 1],
  ] as const)('GPU work %s, surfaces %s records %i supplements', async (gpuWork, surfaces, count) => {
    const { addStandardSceneDataPass } = await import('../temporal/standard-scene-data');
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const color = createRenderPipelineTarget(graph, 'temporal', {
      format: 'rgba16float',
      size: { width: 1, height: 1 },
    }).unwrap();
    const depth = createRenderPipelineTarget(graph, 'depth', {
      format: 'depth32float',
      size: { width: 1, height: 1 },
    }).unwrap();
    graph
      .addRasterPass('initialize', {
        accesses: [
          { resource: color.view, usage: 'color-attachment' },
          { resource: depth.view, usage: 'depth-stencil-write' },
        ],
        colorAttachments: [
          {
            view: color.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
        depthStencilAttachment: {
          view: depth.view,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
        encode: () => undefined,
      })
      .unwrap();
    const hasWork = vi.fn(() => gpuWork);
    addStandardSceneDataPass(
      graph,
      color,
      depth,
      { accesses: [], hasWork, encode: () => undefined },
      surfaces,
    ).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const frame = frameFor(device, []);
    Object.assign(frame, { dispatch: [] });
    const begin = vi.spyOn(frame.encoder, 'beginRenderPass');
    buildPerFrameBindGroups.mockReturnValue({
      viewBindGroup: null,
      meshBindGroup: null,
      hdrpClusterBindGroup: null,
      hdrpClusterMembershipBindGroup: null,
    });
    encodeMainPass.mockReset();
    compiled.execute(frame).unwrap();
    frame.encoder.finish().unwrap();
    expect(
      begin.mock.calls.filter(([descriptor]) => descriptor.label === 'standard-scene-data'),
    ).toHaveLength(count);
    if (surfaces === 'forward-only-opaque')
      expect(hasWork).toHaveBeenCalledWith(surfaces, 'fs_temporal');
    await compiled.retire();
  });
});
