import { readFileSync } from 'node:fs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { ShadowRasterLedger } from '../record/shadow-raster-ledger';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';
import { ShadowDepthLayers } from '../shadow-depth-layers';
import { addTypedShadowPasses } from '../typed-shadow-passes';

const typedShadowSource = readFileSync(
  new URL('../typed-shadow-passes.ts', import.meta.url),
  'utf8',
);
const shadowRecordSource = readFileSync(
  new URL('../record/shadow-pass.ts', import.meta.url),
  'utf8',
);

function topology(): RenderPipelineTopology {
  return {
    pipelineId: 'forgeax::standard',
    config: undefined,
    surface: {
      width: 64,
      height: 64,
      storageFormat: 'rgba8unorm',
      viewFormat: 'rgba8unorm',
    },
    camera: { tonemap: 'aces-filmic', antialias: 'fxaa', bloom: 'off', bloomIntensity: 1 },
    shadow: {
      directional: { mapSize: 32, cascadeCount: 2 },
      spotMapSize: 32,
      pointCount: 1,
      pointFaceSize: 16,
      spotCount: 1,
    },
    lane: {
      compute: true,
      storageBuffer: true,
      multisample: false,
      maxColorAttachments: 8,
    },
    featureTopologySignature: 'shadow-view-test',
    gpuDrivenTopologySignature: 'shadow-view-test',
    opaque: { lane: 'forward', lateOcclusion: true },
  };
}

function sourceRegion(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end < 0 ? source.length : end);
}

describe('GPU-driven shadow view graph integration', () => {
  it.each([
    false,
    true,
  ])('owns spot depth for exactly its submitted casting views, with features=%s', async (withFeatures) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const layers = new ShadowDepthLayers(device);
    const creates = vi.spyOn(device, 'createTexture');
    const destroys = vi.spyOn(device, 'destroyTexture');
    for (const spotCount of [0, 1, 0, 1, 0]) {
      creates.mockClear();
      destroys.mockClear();
      const prior = layers.allocation('spot-shadow-depth');
      const graph = new RenderGraphBuilder<RenderPipelineFrame>();
      const base = topology();
      const shadow = { ...base.shadow, directional: 'disabled' as const, pointCount: 0, spotCount };
      const products = addTypedShadowPasses(
        graph,
        { shadow },
        {
          depthLayers: layers,
          shadowFeatures: withFeatures ? { accesses: [], encode: vi.fn() } : undefined,
        },
      ).unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } }).unwrap();
      expect(products.spot !== undefined).toBe(spotCount > 0);
      expect(layers.allocation('spot-shadow-depth')).toBe(prior);
      let passes = 0;
      for (let frameId = 0; frameId < 3; frameId++) {
        const encoder = device.createCommandEncoder().unwrap();
        const begin = vi.spyOn(encoder, 'beginRenderPass');
        compiled
          .execute({
            encoder,
            frameState: { spotShadowSnapshots: [], shadowRaster: new ShadowRasterLedger() },
          } as unknown as RenderPipelineFrame)
          .unwrap();
        passes += begin.mock.calls.length;
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        if (frameId === 0) layers.acceptSubmittedTextures(compiled);
        layers._commit();
      }
      const texture = creates.mock.calls.find(
        ([descriptor]) => descriptor.label === 'spot-shadow-depth',
      );
      expect(texture?.[0].size).toEqual(
        spotCount === 0
          ? undefined
          : {
              width: shadow.spotMapSize,
              height: shadow.spotMapSize,
              depthOrArrayLayers: 4,
            },
      );
      expect(passes).toBe(spotCount === 0 ? 0 : 3);
      expect(layers.byteSize('spot-shadow-depth')).toBe(
        spotCount === 0 ? 0 : 4 * shadow.spotMapSize ** 2 * 4,
      );
      if (prior !== undefined && spotCount === 0) expect(destroys).toHaveBeenCalledWith(prior);
      (await compiled.retire()).unwrap();
    }
    layers.dispose();
  });

  it('keeps directional, point, and spot views in one typed graph', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const input = topology();

    const added = addTypedShadowPasses(graph, input);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const compiled = graph
      .compile({
        device,
        surfaceSize: { width: input.surface.width, height: input.surface.height },
      })
      .unwrap();
    expect(compiled.inspect().passes.map((pass) => pass.name)).toEqual([
      'shadowCascade0',
      'shadowCascade1',
      'directional-shadow-observation',
      'point-shadow-0-0',
      'point-shadow-0-1',
      'point-shadow-0-2',
      'point-shadow-0-3',
      'point-shadow-0-4',
      'point-shadow-0-5',
      'spot-shadow-0',
    ]);
  });

  it('exposes only the active spot prefix while keeping four physical layers', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const base = topology();
    const input: RenderPipelineTopology = {
      ...base,
      shadow: {
        ...base.shadow,
        directional: 'disabled',
        pointCount: 0,
        spotCount: 2,
      },
    };

    const added = addTypedShadowPasses(graph, input).unwrap();
    const spot = added.spot;
    if (spot === undefined) throw new Error('Two spot views require an atlas');
    graph
      .addCopyPass('consume-spot-shadow-prefix', {
        accesses: [{ resource: spot.view, usage: 'copy-src' }],
        encodeDirect: () => undefined,
      })
      .unwrap();

    const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(
      compiled.value.inspect().resources.find((resource) => resource.label === 'spot-shadow-depth')
        ?.extent?.depthOrArrayLayers,
    ).toBe(4);
    await compiled.value.retire();
  });

  it.each([
    ['point cube face', 'function addPointShadowFacePass(', 'function addPointShadowPasses('],
    ['spot atlas', 'function addSpotShadowPass(', 'function addSpotShadowPasses('],
  ])('%s carries an explicit cache predicate', (_name, start, end) => {
    const region = sourceRegion(typedShadowSource, start, end);
    expect(region).toMatch(/shadowViewRaster\(/);
  });

  it('separates the capable GPU shadow lane from the CPU caster enumerator', () => {
    expect(shadowRecordSource).toMatch(
      /\b(?:recordGpuDriven|recordIndirect|gpuDrivenShadow|gpuDrivenView|indirectShadow)\b/i,
    );
    expect(shadowRecordSource).toMatch(/recordCpuShadow|recordFallbackShadow|validatedOrdered/i);
  });
});
