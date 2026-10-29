import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { createMainPassMaterialSelectionOwner } from '../record/main-pass';
import { type ScenePassRequest, scenePassRequests } from '../record/scene-pass-work';
import type { RenderPipelineFrame } from '../render-pipeline';
import { createRenderPipelineTarget } from '../render-pipeline';
import { FORWARD_PASS_SELECTOR } from '../systems/pass-selector';

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
    false,
    true,
  ])('passes the borrowed frame and exact Scene Pass request to predicate %s, then detaches execution', async (execute) => {
    const { addTypedScenePass } = await import('../typed-render-graph-primitives');
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const color = createRenderPipelineTarget(graph, 'predicate-color', {
      format: 'rgba16float',
      size: { width: 1, height: 1 },
    }).unwrap();
    const depth = createRenderPipelineTarget(graph, 'predicate-depth', {
      format: 'depth32float',
      size: { width: 1, height: 1 },
    }).unwrap();
    const frame = frameFor(device, []);
    const predicate = vi.fn((_frame: RenderPipelineFrame, _request?: ScenePassRequest) => execute);
    addTypedScenePass(graph, {
      name: 'predicate-scene',
      color,
      depth,
      selector: FORWARD_PASS_SELECTOR,
      executeIf: predicate,
    }).unwrap();
    const rows = { validatedOrdered: [], dispatch: [], materialSlots: [], materialSlotIndices: [] };
    const selection = {};
    Object.assign(frame, {
      gpuDrivenSelection: selection,
      scenePassWork: new Map([
        [
          scenePassRequests(graph)[0],
          {
            ...rows,
            foldDispatchPlan: null,
            mainPassMaterialSelection: createMainPassMaterialSelectionOwner(rows),
          },
        ],
      ]),
    });
    buildPerFrameBindGroups.mockReturnValue({
      viewBindGroup: null,
      meshBindGroup: null,
      hdrpClusterBindGroup: null,
      hdrpClusterMembershipBindGroup: null,
    });
    encodeMainPass.mockReset();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    try {
      compiled.execute(frame).unwrap();
      expect(predicate).toHaveBeenCalledTimes(1);
      expect(predicate.mock.calls[0]?.[0]).toBe(frame);
      expect(predicate.mock.calls[0]?.[1]).toBe(scenePassRequests(graph)[0]);
      expect(encodeMainPass).toHaveBeenCalledTimes(execute ? 1 : 0);
      if (execute) {
        const recorded = encodeMainPass.mock.calls[0]?.[0];
        expect(recorded).not.toBe(frame);
        expect(recorded.gpuDrivenSelection).toBeUndefined();
        expect(Reflect.get(frame, 'gpuDrivenSelection')).toBe(selection);
      }
    } finally {
      frame.encoder.finish().unwrap();
      await compiled.retire();
    }
  });

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
    const selection = new GpuDrawSelection([]);
    Object.assign(frame, { dispatch: [], gpuDrivenSelection: selection });
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
    if (count > 0) {
      const recorded = encodeMainPass.mock.calls[0]?.[0];
      expect(recorded).not.toBe(frame);
      expect(recorded.gpuDrivenSelection).toBe(selection);
      expect(Reflect.get(frame, 'gpuDrivenSelection')).toBe(selection);
    }
    await compiled.retire();
  });
});
