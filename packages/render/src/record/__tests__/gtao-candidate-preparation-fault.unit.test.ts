import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { RhiErrorListenerRegistry } from '../../lifecycle';
import type { RenderPipeline } from '../../render-pipeline';
import { ShadowDepthLayers } from '../../shadow-depth-layers';
import { createTemporalFrameTransaction, TemporalViewHistory } from '../../temporal/frame';
import { makeZeroCameraFallbackSnapshot, type RenderFrameState } from '../frame-snapshot';
import { adoptViewGraph } from '../graph-adoption';
import {
  armGtaoCandidatePreparationFault,
  clearGtaoCandidatePreparationFault,
  consumeGtaoCandidatePreparationFault,
} from '../gtao-candidate-preparation-fault';
import type { PipelineState, RenderSystemInternals } from '../render-context';
import { compileViewGraph, inspectRenderGraphGenerationAllocation } from '../typed-frame-graph';

describe('GTAO candidate-preparation fault owner', () => {
  it('is default-off, preserves non-AO attempts, consumes once, and clears across generations', () => {
    const state: { gtaoCandidatePreparationFailureGeneration?: number | undefined } = {};

    expect(consumeGtaoCandidatePreparationFault(state, 4, ['main'])).toBe(false);
    expect(state.gtaoCandidatePreparationFailureGeneration).toBeUndefined();

    armGtaoCandidatePreparationFault(state, 4);
    expect(consumeGtaoCandidatePreparationFault(state, 4, ['main', 'ssao-blur'])).toBe(false);
    expect(state.gtaoCandidatePreparationFailureGeneration).toBe(4);
    expect(consumeGtaoCandidatePreparationFault(state, 5, ['ssao-calc', 'ssao-blur'])).toBe(false);
    expect(state.gtaoCandidatePreparationFailureGeneration).toBeUndefined();

    armGtaoCandidatePreparationFault(state, 5);
    expect(consumeGtaoCandidatePreparationFault(state, 5, ['ssao-calc', 'ssao-blur'])).toBe(true);
    expect(consumeGtaoCandidatePreparationFault(state, 5, ['ssao-calc', 'ssao-blur'])).toBe(false);

    armGtaoCandidatePreparationFault(state, 5);
    clearGtaoCandidatePreparationFault(state);
    expect(state.gtaoCandidatePreparationFailureGeneration).toBeUndefined();
  });

  it('retires a compiled AO candidate before promotion and allows a clean retry', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const activePipeline: RenderPipeline = {
      build: ({ graph }) => {
        const raw = graph.createTexture('ssao-raw', {
          size: { width: 2, height: 2 },
          format: 'rgba8unorm',
        });
        if (!raw.ok) return raw;
        const filtered = graph.createTexture('ssao-blurred', {
          size: { width: 2, height: 2 },
          format: 'rgba8unorm',
        });
        if (!filtered.ok) return filtered;
        const rawView = graph.view(raw.value);
        if (!rawView.ok) return rawView;
        const filteredView = graph.view(filtered.value);
        if (!filteredView.ok) return filteredView;
        const calc = graph.addRasterPass('ssao-calc', {
          accesses: [{ resource: rawView.value, usage: 'color-attachment' }],
          colorAttachments: [
            {
              view: rawView.value,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [1, 1, 1, 1],
            },
          ],
          encode() {},
        });
        if (!calc.ok) return calc;
        return graph.addRasterPass('ssao-blur', {
          accesses: [
            { resource: rawView.value, usage: 'sampled-read' },
            { resource: filteredView.value, usage: 'color-attachment' },
          ],
          colorAttachments: [
            {
              view: filteredView.value,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [1, 1, 1, 1],
            },
          ],
          encode() {},
        });
      },
    };
    const frameState = {
      frameNumber: 0,
      temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
      temporalView: new TemporalViewHistory(),
      compiledFrameGraph: null,
      graphGeneration: 0,
      compiledFrameGraphGeneration: 0,
      standardLightingGraphSignature: '',
      retiredCompiledFrameGraphs: new Set(),
      activePipeline,
      installedPipelineConfig: undefined,
      gtaoCandidatePreparationFailureGeneration: 7,
    } as unknown as RenderFrameState;
    const errors: unknown[] = [];
    const errorRegistry = new RhiErrorListenerRegistry();
    errorRegistry.add((error) => errors.push(error));
    const internals = {
      device,
      deviceScope: { generation: 7 },
      errorRegistry,
      lookupPostProcess: () => ({
        source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }',
      }),
      buildPostProcessPipeline() {
        throw new Error('pipeline build is not used by graph preparation');
      },
      getPostProcessPipeline: () => null,
    } as unknown as RenderSystemInternals;
    const pipelineState = {
      format: 'rgba8unorm',
      colorAttachmentFormat: 'rgba8unorm',
    } as unknown as PipelineState;
    const lights = {
      cascades: undefined,
      pointShadow: [],
      spot: [],
      shadowViews: [],
    } as never;
    const shadowDepthLayers = new ShadowDepthLayers(device);
    const compile = () =>
      adoptViewGraph(
        internals,
        frameState,
        compileViewGraph({
          internals,
          frameState,
          pipelineState,
          camera: makeZeroCameraFallbackSnapshot(),
          lights,
          surface: { width: 2, height: 2 },
          shadowDepthLayers,
        }),
      );

    const rejected = compile();
    expect(rejected).toBeNull();
    expect(frameState.compiledFrameGraph).toBeNull();
    expect(frameState.compiledFrameGraphCandidate).toBeUndefined();
    expect(frameState.graphGeneration).toBe(0);
    expect(frameState.compiledFrameGraphGeneration).toBe(0);
    expect(frameState.gtaoCandidatePreparationFailureGeneration).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'graph-build-failed',
      detail: {
        cause: {
          code: 'gtao-candidate-preparation-fault-injected',
          detail: { phase: 'post-allocation-before-promotion', deviceGeneration: 7 },
        },
      },
    });
    const allocatedThenRetired = inspectRenderGraphGenerationAllocation(frameState);
    expect(allocatedThenRetired.peakBytes).toBeGreaterThan(0);
    expect(allocatedThenRetired.liveBytes).toBe(0);
    expect(allocatedThenRetired.pendingRetirementBytes).toBeGreaterThan(0);
    await device.queue.onSubmittedWorkDone();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(inspectRenderGraphGenerationAllocation(frameState)).toMatchObject({
      entries: [],
      liveBytes: 0,
      pendingRetirementBytes: 0,
    });

    const retry = compile();
    expect(retry).not.toBeNull();
    expect(errors).toHaveLength(1);
    expect(frameState.compiledFrameGraph?.graph).toBe(retry);
    expect(frameState.graphGeneration).toBe(1);

    await retry?.retire();
    await device.queue.onSubmittedWorkDone();
  });
});
