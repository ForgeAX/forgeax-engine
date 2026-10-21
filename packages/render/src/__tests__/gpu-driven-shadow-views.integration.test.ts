import { readFileSync } from 'node:fs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { ShadowRasterLedger } from '../record/shadow-raster-ledger';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';
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
  ])('initializes the empty spot atlas once, including with shadow features=%s', async (withFeatures) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const textures = vi.spyOn(device, 'createTexture');
    // Rebuilding as lights enter/leave must reinitialize each graph's atlas.
    for (const spotCount of [0, 1, 0]) {
      textures.mockClear();
      const graph = new RenderGraphBuilder<RenderPipelineFrame>();
      const base = topology();
      const input = {
        ...base,
        shadow: { ...base.shadow, directional: 'disabled' as const, pointCount: 0, spotCount },
      };
      addTypedShadowPasses(graph, input, {
        shadowFeatures: withFeatures ? { accesses: [], encode: vi.fn() } : undefined,
      }).unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } }).unwrap();
      const spot = textures.mock.calls
        .map(([descriptor]) => descriptor)
        .find((descriptor) => descriptor.label === 'spot-shadow-depth');
      // An absent shadow needs only initialized depth; an actual light keeps
      // its authored resolution across the same enter/leave graph rebuilds.
      expect(spot?.size).toEqual({
        width: spotCount === 0 ? 1 : input.shadow.spotMapSize,
        height: spotCount === 0 ? 1 : input.shadow.spotMapSize,
        depthOrArrayLayers: 4,
      });
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
      }
      expect(passes).toBe(spotCount === 0 ? 1 : 3);
      (await compiled.retire()).unwrap();
    }
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

  it.each([
    ['point cube face', 'if (topology.shadow.pointCount > 0)', 'const spot ='],
    ['spot atlas', 'const spot =', 'return ok({ directional, spot'],
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
