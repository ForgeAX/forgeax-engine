import { mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import {
  STANDARD_CLUSTER_TEST_ABI,
  selectTestStandardClusterTransport,
} from '../../__tests__/cluster-test-abi';
import { DeviceScope } from '../../device/device-scope';
import { RhiErrorListenerRegistry } from '../../lifecycle';
import { prepareStandardLighting } from '../../pipeline/standard-lighting/prepare';
import type { RenderPipeline } from '../../render-pipeline';
import { createTemporalFrameTransaction, TemporalViewHistory } from '../../temporal/frame';
import { viewGraphTarget } from '../../view-inspection';
import {
  beginClusterWorkConformanceFrame,
  readClusterWorkFrameTrace,
  recordClusterWorkFrameReceiptForConformance,
  settleClusterWorkConformanceFrame,
} from '../cluster-work-conformance';
import { writeHdrpClusterAndSsaoBuffers } from '../frame-lighting';
import { makeZeroCameraFallbackSnapshot, type RenderFrameState } from '../frame-snapshot';
import { adoptViewGraph } from '../graph-adoption';
import type { PipelineState, RenderSystemInternals } from '../render-context';
import {
  compileViewGraph,
  ensureShadowDepthLayers,
  promoteGraphCandidate,
  rollbackGraphCandidate,
} from '../typed-frame-graph';

describe('Cluster diagnostics use the installed compiled graph identity', () => {
  it.each([
    true,
    false,
  ])('retains trace and target identity across a rejected replacement (storage=%s)', async (storage) => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    Object.defineProperty(device, 'caps', { value: { ...device.caps, storageBuffer: storage } });
    // A different graph owner compiles first. A view's installation counter is
    // deliberately unrelated to the immutable compiled graph identity.
    const unrelatedBuilder = new RenderGraphBuilder();
    const bytes = unrelatedBuilder.createBuffer('unrelated-bytes', { size: 16 }).unwrap();
    unrelatedBuilder
      .addCopyPass('unrelated-write', {
        accesses: [{ resource: bytes, usage: 'copy-dst' }],
        encode() {},
      })
      .unwrap();
    const unrelated = unrelatedBuilder
      .compile({ device, surfaceSize: { width: 1, height: 1 } })
      .unwrap();
    const activePipeline: RenderPipeline = {
      build: ({ graph }) => {
        const texture = graph
          .createTexture('standard-cluster-tables', {
            size: { width: 2, height: 2 },
            format: 'rgba8unorm',
          })
          .unwrap();
        const view = graph.view(texture).unwrap();
        return graph.addRasterPass('cluster-owner-target', {
          accesses: [{ resource: view, usage: 'color-attachment' }],
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          encode() {},
        });
      },
    };
    const frameState = {
      frameNumber: 1,
      graphGeneration: 0,
      compiledFrameGraphGeneration: 0,
      compiledFrameGraph: null,
      retiredCompiledFrameGraphs: new Set(),
      standardLightingGraphSignature: '',
      activePipeline,
      installedPipelineConfig: undefined,
      standardClusterWorkConformance: { enabled: true },
      temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
      temporalView: new TemporalViewHistory(),
    } as unknown as RenderFrameState;
    const internals = {
      device,
      deviceScope: DeviceScope.create(0, 'cluster-graph-generation'),
      standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
      errorRegistry: new RhiErrorListenerRegistry(),
      lookupPostProcess: () => undefined,
      getPostProcessPipeline: () => null,
    } as unknown as RenderSystemInternals;
    const camera = makeZeroCameraFallbackSnapshot();
    const shadowDepthLayers = ensureShadowDepthLayers(frameState, device);
    const compile = (width: number) =>
      adoptViewGraph(
        internals,
        frameState,
        compileViewGraph({
          internals,
          frameState,
          camera,
          shadowDepthLayers,
          pipelineState: {
            format: 'rgba8unorm',
            colorAttachmentFormat: 'rgba8unorm',
          } as PipelineState,
          lights: { cascades: undefined, pointShadow: [], spot: [], shadowViews: [] } as never,
          surface: { width, height: 1 },
        }),
      );
    const prepared = prepareStandardLighting({
      directional: undefined,
      local: [],
      view: mat4.identity(mat4.create()),
      projection: mat4.identity(mat4.create()),
      near: 0.1,
      far: 100,
      grid: { x: 1, y: 1, z: 1 },
      lightCount: STANDARD_CLUSTER_TEST_ABI.directLightSlot.capacity,
      renderPath: 'forward',
    }).unwrap();
    const transport = selectTestStandardClusterTransport(
      {
        compute: false,
        storageBuffer: storage,
        membershipPipelineReady: false,
        maxTextureDimension2D: 4096,
      },
      prepared,
    ).unwrap();
    const observe = async () => {
      const recordFrame = frameState.frameNumber;
      const state = frameState.standardClusterWorkConformance;
      beginClusterWorkConformanceFrame(state, recordFrame, recordFrame + 1);
      expect(
        writeHdrpClusterAndSsaoBuffers(internals, frameState, camera, prepared, transport).ok,
      ).toBe(true);
      settleClusterWorkConformanceFrame(state, recordFrame, 'submitted');
      expect(
        recordClusterWorkFrameReceiptForConformance(state, {
          observationFrameId: recordFrame + 1,
          publicReceiptFrameId: recordFrame + 1,
          deviceGeneration: 0,
          presentation: 'ready',
          completed: Promise.resolve(),
        }),
      ).toBe(true);
      await Promise.resolve();
      frameState.frameNumber++;
      return {
        trace: readClusterWorkFrameTrace(state),
        target: viewGraphTarget({ frameState } as never, 'standard-cluster-tables'),
      };
    };
    const first = compile(1);
    if (first === null) throw new Error('The initial graph must compile');
    promoteGraphCandidate(frameState);
    const accepted = frameState.compiledFrameGraph;
    const acceptedCounter = frameState.graphGeneration;
    const acceptedCompiledCounter = frameState.compiledFrameGraphGeneration;
    expect(first.inspect().generation).not.toBe(acceptedCounter);
    const replacement = compile(2);
    if (replacement === null) throw new Error('The replacement graph must compile');
    expect(replacement).not.toBe(first);
    expect(frameState.graphGeneration).toBe(acceptedCounter + 1);
    try {
      const candidate = await observe();
      expect.soft(candidate.trace?.graphGeneration).toBe(replacement.inspect().generation);
      expect
        .soft(candidate.trace?.clusterWork)
        .toMatchObject({ graphGeneration: replacement.inspect().generation });
      expect.soft(candidate.target?.graphGeneration).toBe(replacement.inspect().generation);
      rollbackGraphCandidate(frameState, false);
      expect(frameState.compiledFrameGraph).toBe(accepted);
      expect(frameState.graphGeneration).toBe(acceptedCounter);
      expect(frameState.compiledFrameGraphGeneration).toBe(acceptedCompiledCounter);
      const retained = await observe();
      expect.soft(retained.trace?.graphGeneration).toBe(first.inspect().generation);
      expect.soft(retained.target?.graphGeneration).toBe(first.inspect().generation);
      expect(retained.trace?.receipt?.completion).toBe('completed');
    } finally {
      rollbackGraphCandidate(frameState, false);
      await first.retire();
      await unrelated.retire();
    }
  });
});
