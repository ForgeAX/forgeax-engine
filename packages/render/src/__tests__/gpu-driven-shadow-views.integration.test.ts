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

  it('initializes missing layers before the full variance array is read', async () => {
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
        spotCount: 4,
        variance: { directional: false, spots: [3] },
      },
    };

    const added = addTypedShadowPasses(graph, input).unwrap();
    expect(added.moments).toBeDefined();
    if (added.moments === undefined) return;
    graph
      .addCopyPass('consume-shadow-variance-array', {
        accesses: [{ resource: added.moments.view, usage: 'copy-src' }],
        encodeDirect: () => undefined,
      })
      .unwrap();

    const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const names = compiled.value.inspect().passes.map((pass) => pass.name);
    expect(names).toContain('shadow-variance-0-initialize');
    expect(names).toContain('shadow-variance-6-initialize');
    expect(names).not.toContain('shadow-variance-7-initialize');
    await compiled.value.retire();
  });

  it('retries missing variance clears after abort and retains them after submit', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const retained = new ShadowDepthLayers(device);
    retained.texture('shadow-variance', 32, 8, 'rg16float');
    for (let layer = 0; layer < 8; layer += 1) retained.rastered('shadow-variance', layer);
    retained._commit();

    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const base = topology();
    const input: RenderPipelineTopology = {
      ...base,
      shadow: {
        ...base.shadow,
        directional: 'disabled',
        pointCount: 0,
        spotCount: 4,
        variance: { directional: false, spots: [3] },
      },
    };
    const added = addTypedShadowPasses(graph, input, { depthLayers: retained }).unwrap();
    expect(added.moments).toBeDefined();
    if (added.moments === undefined) return;
    graph
      .addCopyPass('consume-shadow-variance-array', {
        accesses: [{ resource: added.moments.view, usage: 'copy-src' }],
        encodeDirect: () => undefined,
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const executeInitializers = (submit: boolean): string[] => {
      const ledger = new ShadowRasterLedger();
      ledger.begin();
      const encoder = device.createCommandEncoder().unwrap();
      const initialized: string[] = [];
      compiled.value
        .execute(
          {
            encoder,
            frameState: {
              spotShadowSnapshots: [],
              pointShadowSnapshots: [],
              shadowRaster: ledger,
            },
            runtime: { device },
          } as unknown as RenderPipelineFrame,
          (pass, encode) => {
            if (!pass.name.endsWith('-initialize')) return;
            initialized.push(pass.name);
            encode();
          },
        )
        .unwrap();
      const commandBuffer = encoder.finish().unwrap();
      if (submit) {
        device.queue.submit([commandBuffer]).unwrap();
        compiled.value.commitExecution();
        retained._commit();
        ledger.commit();
      } else {
        compiled.value.discardExecution();
        retained._abort();
      }
      return initialized;
    };

    expect(executeInitializers(false)).toHaveLength(7);
    for (let layer = 0; layer < 7; layer += 1)
      expect(retained.retained('shadow-variance', layer)).toBe(false);
    expect(executeInitializers(true)).toHaveLength(7);
    for (let layer = 0; layer < 7; layer += 1)
      expect(retained.retained('shadow-variance', layer)).toBe(true);
    expect(executeInitializers(true)).toEqual([]);

    await compiled.value.retire();
    retained.dispose();
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
    graph
      .addCopyPass('consume-spot-shadow-prefix', {
        accesses: [{ resource: added.spot.view, usage: 'copy-src' }],
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
