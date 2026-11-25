import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { DeviceScope } from '../../device/device-scope';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../../gpu-texture-usage';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../../render-pipeline';
import { addSsrHitColor } from '../../ssr/hit-color';
import { SSR_SCENE_COLOR_HISTORY_PROGRAM } from '../../ssr/scene-color-input';
import {
  abortStagedTemporalGpuState,
  commitStagedTemporalGpuState,
  getTemporalGpuState,
  hasPendingTemporalGpuSubmit,
  retireTemporalGpuState,
  stageTemporalGpuWrite,
  temporalWriteIndex,
} from '../../temporal/gpu';
import { addTypedFullscreenPass } from '../../typed-render-graph-primitives';
import type { RenderFrameState } from '../frame-snapshot';

describe('SSR scene-color producer admission', () => {
  it('produces a single half-resolution color level and one downsample', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const context = { graph };
    const size = { width: 17, height: 9 };
    const source = createRenderPipelineTarget(graph, 'scene', {
      format: 'rgba16float',
      size,
    }).unwrap();
    graph
      .addRasterPass('scene-opaque', {
        accesses: [{ resource: source.view, usage: 'color-attachment' }],
        colorAttachments: [{ view: source.view, loadOp: 'clear', storeOp: 'store' }],
        encode: () => {},
      })
      .unwrap();
    const color = addSsrHitColor(context, source, size, 'ssr-color').unwrap();
    graph
      .addComputePass('ssr-trace', {
        accesses: [{ resource: color.view, usage: 'sampled-read' }],
        encode: () => {},
      })
      .unwrap();
    const plan = graph.compile({ device, surfaceSize: size }).unwrap();
    try {
      expect(plan.inspect().passes.map(({ name }) => name)).toEqual([
        'scene-opaque',
        'ssr-color-downsample',
        'ssr-trace',
      ]);
      expect(
        plan.inspect().resources.filter((resource) => resource.kind === 'texture'),
      ).toHaveLength(2);
      expect(plan.inspect().resources.find(({ label }) => label === 'ssr-color')).toMatchObject({
        descriptor: { width: 8, height: 4, mipLevelCount: 1 },
      });
    } finally {
      (await plan.retire()).unwrap();
    }
  });

  it.each([
    true,
    false,
  ])('stages the typed scene-color writer only after an encoded draw (pipeline ready=%s)', async (ready) => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const scope = DeviceScope.create(10, 'ssr-color-snapshot');
    const frameState = {
      retiringTemporalGpuStates: new Set(),
      compiledFrameGraph: null,
    } as unknown as RenderFrameState;
    const hooks = {
      onReplaced: vi.fn(),
      onRetireFailure: (cause: unknown) => {
        throw cause;
      },
    };
    const taa = getTemporalGpuState(frameState, device, scope, 8, 8);
    stageTemporalGpuWrite(frameState, taa);
    commitStagedTemporalGpuState(frameState, device.queue, hooks);
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const source = createRenderPipelineTarget(graph, 'snapshot-current-scene', {
      format: 'rgba16float',
      size: { width: 8, height: 8 },
      domain: 'linear-hdr',
    }).unwrap();
    graph
      .addRasterPass('snapshot-scene-producer', {
        accesses: [{ resource: source.view, usage: 'color-attachment' }],
        colorAttachments: [{ view: source.view, loadOp: 'clear', storeOp: 'store' }],
        encode: () => {},
      })
      .unwrap();
    const candidate = () =>
      getTemporalGpuState(frameState, device, scope, 8, 8, false, undefined, 'scene-color');
    const output = graph
      .importTexture(
        'snapshot-scene-color-output',
        {
          format: 'rgba16float',
          size: { width: 4, height: 4 },
          mipLevelCount: 3,
          domain: 'linear-hdr',
          usage:
            GPU_TEXTURE_USAGE_COPY_SRC |
            GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
            GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        },
        () => {
          const state = candidate();
          return state.color[temporalWriteIndex(state)].texture;
        },
      )
      .unwrap();
    const outputView = graph
      .importView(output, { dimension: '2d', mipLevelCount: 1 }, () => {
        const state = candidate();
        return state.color[temporalWriteIndex(state)].view;
      })
      .unwrap();
    addTypedFullscreenPass(graph, {
      name: 'ssr-scene-color-history',
      shader: SSR_SCENE_COLOR_HISTORY_PROGRAM.name,
      input: source,
      outputs: [
        {
          texture: output,
          view: outputView,
          format: 'rgba16float',
          sampleCount: 1,
          domain: 'linear-hdr',
        },
      ],
    }).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 8, height: 8 } }).unwrap();
    const frame = () =>
      ({
        encoder: device.createCommandEncoder({ label: 'scene-color-snapshot-regression' }).unwrap(),
        runtime: {
          device,
          deviceScope: scope,
          errorRegistry: {
            fire: (cause: unknown) => {
              throw cause;
            },
          },
          lookupPostProcess: () => SSR_SCENE_COLOR_HISTORY_PROGRAM,
          getPostProcessPipeline: () => (ready ? {} : null),
        },
        pipelineState: { colorAttachmentFormat: 'rgba16float', format: 'rgba16float' },
        frameState,
        bindGroupCounts: {},
        geometryDepthKey: 'scene-depth',
        postProcessParams: new Map(),
        msaaActive: false,
        targetW: 8,
        targetH: 8,
        outputTarget: () => ({ texture: undefined, view: undefined }),
        clear: [0, 0, 0, 1],
      }) as unknown as RenderPipelineFrame;
    try {
      const rejected = candidate();
      expect(compiled.execute(frame()).ok).toBe(true);
      expect(hasPendingTemporalGpuSubmit(rejected)).toBe(ready);
      expect(frameState.activeTemporalGpuState).toBe(taa);
      abortStagedTemporalGpuState(frameState);
      expect(frameState.activeTemporalGpuState).toBe(taa);
      expect(taa.valid).toBe(true);
      if (!ready) return;
      const accepted = candidate(),
        nextFrame = frame();
      expect(compiled.execute(nextFrame).ok).toBe(true);
      expect(device.queue.submit([nextFrame.encoder.finish().unwrap()]).ok).toBe(true);
      commitStagedTemporalGpuState(frameState, device.queue, hooks);
      expect(frameState.activeTemporalGpuState).toBe(accepted);
      expect(accepted.valid).toBe(true);
      expect(accepted.mode).toBe('scene-color');
      expect(hasPendingTemporalGpuSubmit(accepted)).toBe(false);
      expect(hooks.onReplaced).toHaveBeenCalledOnce();
    } finally {
      abortStagedTemporalGpuState(frameState);
      if (frameState.activeTemporalGpuState !== undefined)
        retireTemporalGpuState(frameState.activeTemporalGpuState);
      await compiled.retire();
    }
  });
});
