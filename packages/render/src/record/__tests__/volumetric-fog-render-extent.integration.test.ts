import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { compileAndAdoptViewGraph } from '../../__tests__/graph-compile.fixture';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_TAA,
  ANTIALIAS_TSR,
  antialiasFromF32,
} from '../../components/camera';
import { DeviceScope } from '../../device/device-scope';
import { RhiErrorListenerRegistry } from '../../lifecycle';
import { deriveRenderExtent } from '../../pipeline/render-extent';
import type { RenderPipeline, RenderPipelineTopology } from '../../render-pipeline';
import type { ExtractedVolumetricFog } from '../../render-system-extract';
import { createTemporalFrameTransaction, TemporalViewHistory } from '../../temporal/frame';
import type { ViewLights } from '../../world/render-lights';
import { makeZeroCameraFallbackSnapshot, type RenderFrameState } from '../frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../render-context';
import { ensureShadowDepthLayers } from '../typed-frame-graph';

it.each([
  [ANTIALIAS_FXAA, undefined, 1280, 720, 640, 360, 320, 180],
  [ANTIALIAS_FXAA, undefined, 640, 360, 320, 180, 160, 90],
  [ANTIALIAS_TAA, 1, 1280, 720, 640, 360, 320, 180],
  [ANTIALIAS_TAA, 0.75, 1280, 720, 480, 268, 240, 134],
  [ANTIALIAS_TAA, 0.5, 1280, 720, 320, 180, 160, 90],
  [ANTIALIAS_TSR, 0.5, 1280, 720, 320, 180, 160, 90],
] as const)('compiles scene-domain fog work at temporal input extent (AA=%s scale=%s surface=%sx%s)', async (antialias, scale, surfaceWidth, surfaceHeight, gridWidth, gridHeight, resolveWidth, resolveHeight) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const errors: unknown[] = [];
  const errorRegistry = new RhiErrorListenerRegistry();
  errorRegistry.add((error) => errors.push(error));
  let captured: RenderPipelineTopology | undefined;
  const activePipeline: RenderPipeline = {
    build: (_context, topology) => {
      captured = topology;
      return ok(undefined);
    },
  };
  const frameState = {
    temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
    temporalView: new TemporalViewHistory(),
    compiledFrameGraph: null,
    retiredCompiledFrameGraphs: new Set(),
    activePipeline,
  } as unknown as RenderFrameState;
  const internals = {
    device,
    errorRegistry,
    deviceScope: DeviceScope.create(0, 'volume-temporal-extent'),
    volumetricFogShaders: {},
    standardProfile: { volumetricFog: { quality: 'high', depth: 64, tileSize: 4 } },
  } as unknown as RenderSystemInternals;
  const densityAsset = {
    format: 'r8unorm',
    shape: { viewDimension: '3d', extent: { width: 4, height: 4, depth: 4 } },
  };
  const graph = compileAndAdoptViewGraph({
    internals,
    frameState,
    pipelineState: { format: 'rgba8unorm', colorAttachmentFormat: 'rgba8unorm' } as PipelineState,
    camera: { ...makeZeroCameraFallbackSnapshot(), antialias: antialiasFromF32(antialias) },
    lights: {
      directional: { entity: 1 },
      pointShadow: [],
      spot: [],
      shadowViews: [],
    } as unknown as ViewLights,
    surface: { width: surfaceWidth, height: surfaceHeight },
    shadowDepthLayers: ensureShadowDepthLayers(frameState, device),
    ...(scale === undefined
      ? {}
      : {
          renderExtent: deriveRenderExtent({
            outputWidth: surfaceWidth,
            outputHeight: surfaceHeight,
            requestedScale: scale,
            generation: 1,
          }),
        }),
    volumetricFog: {
      status: 'available',
      densityAsset,
      additional: [{ densityAsset }],
    } as unknown as ExtractedVolumetricFog,
  });
  try {
    expect(errors).toEqual([]);
    expect(graph).not.toBeNull();
    expect(captured?.surface).toMatchObject({ width: surfaceWidth, height: surfaceHeight });
    expect(captured?.volumetricFog).toMatchObject({
      enabled: true,
      froxelExtent: { width: gridWidth, height: gridHeight, depth: 128 },
      resolvedExtent: { width: resolveWidth, height: resolveHeight, depth: 1 },
    });
  } finally {
    await graph?.retire();
  }
});
