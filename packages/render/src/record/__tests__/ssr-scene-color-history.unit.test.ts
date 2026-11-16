import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { WaterSsrTemporalValue } from '../../components/screen-space-reflection';
import { DeviceScope } from '../../device/device-scope';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../../gpu-texture-usage';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../../render-pipeline';
import type { SsrSpatialAdmission } from '../../ssr/admission';
import { createSsrHistoryOwner } from '../../ssr/history';
import { SSR_SCENE_COLOR_HISTORY_PROGRAM } from '../../ssr/scene-color-input';
import { TemporalViewHistory } from '../../temporal/frame';
import {
  abortStagedTemporalGpuState,
  commitStagedTemporalGpuState,
  commitTemporalGpuSubmit,
  getTemporalGpuState,
  hasPendingTemporalGpuSubmit,
  retireTemporalGpuState,
  stageTemporalGpuSubmit,
  stageTemporalGpuWrite,
  temporalWriteIndex,
} from '../../temporal/gpu';
import { createTemporalView } from '../../temporal/view';
import { addTypedFullscreenPass } from '../../typed-render-graph-primitives';
import type { RenderFrameState } from '../frame-snapshot';
import type { RenderSystemInternals } from '../render-context';
import { beginSsrHistoryFrame } from '../ssr-history-frame';

describe('SSR scene-color producer admission', () => {
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
          size: { width: 8, height: 8 },
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
      .importView(output, { dimension: '2d' }, () => {
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

  it.each([
    'none',
    'taa',
  ] as const)('uses accepted color under %s without allocating Water resolve history', async (antialias) => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const scope = DeviceScope.create(9, 'ssr-color-reader');
    const temporalView = new TemporalViewHistory();
    const accepted = createTemporalView({ antialias, width: 8, height: 8, deviceGeneration: 9 });
    temporalView.stage({ kind: antialias === 'taa' ? 'taa' : 'off', view: accepted });
    temporalView.commit();
    const frameState = { temporalView } as RenderFrameState;
    const color = getTemporalGpuState(
      frameState,
      device,
      scope,
      8,
      8,
      false,
      undefined,
      antialias === 'taa' ? 'taa' : 'scene-color',
    );
    stageTemporalGpuSubmit(color);
    commitTemporalGpuSubmit(color);
    frameState.activeTemporalGpuState = color;
    frameState.ssrHistoryOwner = createSsrHistoryOwner({
      device,
      scope,
      width: 8,
      height: 8,
    }).unwrap();
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    const errors = vi.fn();
    const result = beginSsrHistoryFrame(
      { device, errorRegistry: { fire: errors } } as unknown as RenderSystemInternals,
      frameState,
      {
        status: 'admitted',
        config: {
          maxDistance: 4,
          thickness: 0.1,
          maxRoughness: 1,
          waterTemporal: WaterSsrTemporalValue.off,
        },
      } as SsrSpatialAdmission,
      { kind: 'staged', cameraReset: undefined },
      accepted,
      true,
    );
    expect(result).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    expect(frameState.waterSsrHistoryOwner).toBeUndefined();
    const write = writes.mock.calls.find(
      ([buffer]) => buffer === frameState.ssrHistoryOwner?.resources.waterParamsBuffer,
    );
    expect(write).toBeDefined();
    const payload = write?.[2] as Uint8Array;
    expect(
      new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat32(64, true),
    ).toBe(1);
    frameState.ssrHistoryOwner.dispose();
    color.childScope.retire();
  });
});
