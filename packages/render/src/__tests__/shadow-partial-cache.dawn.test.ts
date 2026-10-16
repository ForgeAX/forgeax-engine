import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RenderPipeline, RhiDevice, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { ShadowViewIdentity } from '../gpu-driven/shadow-views';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { ShadowRasterLedger } from '../record/shadow-raster-ledger';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';
import { addTypedShadowPasses } from '../typed-shadow-passes';

// The caster encoders are replaced by one depth-only full-viewport draw per
// view so the test observes exactly what the typed graph's attachment/loadOp
// policy preserves when only some views re-raster.
const raster = vi.hoisted(() => ({
  depthByView: new Map<string, number>(),
  spotViewport: undefined as ((spot: number) => ShadowViewport | undefined) | undefined,
  draw: undefined as
    | ((pass: RhiRenderPassEncoder, key: string, viewport?: ShadowViewport) => void)
    | undefined,
}));

interface ShadowViewport {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

vi.mock('../record/shadow-pass', () => ({
  encodeDirectionalShadowPass: (
    _frame: unknown,
    pass: RhiRenderPassEncoder,
    cascade: number,
    viewport: ShadowViewport,
  ) => raster.draw?.(pass, `directional:${cascade}`, viewport),
  encodeSpotShadowPass: (_frame: unknown, pass: RhiRenderPassEncoder, spot: number) =>
    raster.draw?.(pass, `spot:${spot}`, raster.spotViewport?.(spot)),
  encodePointShadowPass: () => undefined,
}));

const GPU_MAP_MODE_READ = 0x0001;
const MAP_SIZE = 16;
const CASCADES = 4;
const SPOTS = 4;

function topology(): RenderPipelineTopology {
  return {
    pipelineId: 'forgeax::standard',
    config: undefined,
    surface: { width: 64, height: 64, storageFormat: 'rgba8unorm', viewFormat: 'rgba8unorm' },
    camera: { tonemap: 'aces-filmic', antialias: 'fxaa', bloom: 'off', bloomIntensity: 1 },
    shadow: {
      directional: { mapSize: MAP_SIZE, cascadeCount: CASCADES },
      spotMapSize: MAP_SIZE,
      pointCount: 0,
      pointFaceSize: 16,
      spotCount: SPOTS,
    },
    lane: { compute: true, storageBuffer: true, multisample: false, maxColorAttachments: 8 },
    featureTopologySignature: 'shadow-partial-cache-dawn',
    gpuDrivenTopologySignature: 'shadow-partial-cache-dawn',
  };
}

function depthPipeline(device: RhiDevice, depth: number): RenderPipeline {
  const module = createShaderModuleImmediate(device, {
    code: `@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], ${depth.toFixed(6)}, 1.0);
}`,
  }).unwrap();
  const layout = device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap();
  return device
    .createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vs_main', buffers: [] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    } as never)
    .unwrap();
}

interface ShadowRegion {
  readonly layer: number;
  readonly x: number;
  readonly y: number;
}

/**
 * A layered target gives every view its own full layer; a single-layer atlas
 * packs views into a 2x2 tile grid. The test follows whichever layout the
 * typed graph allocates so it measures retention rather than layout.
 */
function viewRegion(layers: number, index: number): ShadowRegion {
  if (layers > 1) return { layer: index, x: 0, y: 0 };
  return { layer: 0, x: (index % 2) * MAP_SIZE, y: Math.floor(index / 2) * MAP_SIZE };
}

describe('typed shadow layers with partial per-view cache hits', () => {
  it('keeps a cache-hit view depth when another view of the same target re-rasters', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const pipelines = new Map<number, RenderPipeline>();
    const pipelineFor = (depth: number) => {
      const cached = pipelines.get(depth);
      if (cached !== undefined) return cached;
      const created = depthPipeline(device, depth);
      pipelines.set(depth, created);
      return created;
    };
    raster.draw = (pass, key, viewport) => {
      const depth = raster.depthByView.get(key);
      if (depth === undefined) return;
      if (viewport !== undefined)
        pass.setViewport(viewport.x, viewport.y, viewport.w, viewport.h, 0, 1);
      pass.setPipeline(pipelineFor(depth));
      pass.draw(3);
    };

    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const targets = addTypedShadowPasses(graph, topology()).unwrap();
    const directional = targets.directional;
    if (directional === undefined) throw new Error('directional shadow target missing');
    const readTarget = async (
      compiledTexture: GPUTexture,
    ): Promise<{
      readonly layers: number;
      readonly width: number;
      readonly data: Float32Array;
    }> => {
      const width = compiledTexture.width;
      const height = compiledTexture.height;
      const layers = compiledTexture.depthOrArrayLayers;
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const size = bytesPerRow * height * layers;
      const buffer = device
        .createBuffer({ size, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
        .unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      encoder.copyTextureToBuffer(
        { texture: compiledTexture },
        { buffer: buffer as unknown as GPUBuffer, bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: layers },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await buffer.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const raw = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      device.destroyBuffer(buffer).unwrap();
      const data = new Float32Array(width * height * layers);
      const rowFloats = bytesPerRow / 4;
      for (let layer = 0; layer < layers; layer++)
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            data[(layer * height + y) * width + x] =
              raw[(layer * height + y) * rowFloats + x] ?? -1;
      return { layers, width, data };
    };

    const captured: { directional?: GPUTexture; spot?: GPUTexture } = {};
    graph
      .addCopyPass('capture-shadow-textures', {
        accesses: [
          { resource: directional.view, usage: 'copy-src' },
          { resource: targets.spot.view, usage: 'copy-src' },
        ],
        encode: ({ resources }) => {
          captured.directional = resources
            .texture(directional.texture)
            .unwrap() as unknown as GPUTexture;
          captured.spot = resources.texture(targets.spot.texture).unwrap() as unknown as GPUTexture;
        },
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } }).unwrap();

    const shadowRaster = new ShadowRasterLedger();
    const executeFrame = async (hits: ReadonlySet<string>) => {
      let rasterPasses = 0;
      const frame = {
        encoder: device.createCommandEncoder().unwrap(),
        frameState: { spotShadowSnapshots: [], shadowRaster },
        directionalShadowCacheMiss: 'uncached',
        gpuDrivenShadowViews: {
          invalidationReason: (identity: ShadowViewIdentity) =>
            hits.has(`${identity.kind}:${identity.index}`) ? undefined : 'content-changed',
          texelCulled: () => undefined,
          cameraCulled: () => undefined,
          dirtyRects: () => undefined,
        },
        pipelineState: { perPassResources: {} },
      };
      const begin = vi.spyOn(frame.encoder, 'beginRenderPass');
      shadowRaster.begin();
      compiled.execute(frame as unknown as RenderPipelineFrame).unwrap();
      shadowRaster.commit();
      rasterPasses += begin.mock.calls.length;
      device.queue.submit([frame.encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      return rasterPasses;
    };

    await executeFrame(new Set());
    const warmDirectional = captured.directional;
    if (warmDirectional === undefined) throw new Error('shadow textures were not captured');
    const layers = warmDirectional.depthOrArrayLayers;
    raster.spotViewport = (spot) => {
      const region = viewRegion(layers, spot);
      return { x: region.x, y: region.y, w: MAP_SIZE, h: MAP_SIZE };
    };

    const expectedDepth = new Map<string, number>();
    for (let index = 0; index < CASCADES; index++) {
      expectedDepth.set(`directional:${index}`, 0.1 + index * 0.1);
      expectedDepth.set(`spot:${index}`, 0.15 + index * 0.1);
    }
    for (const [key, value] of expectedDepth) raster.depthByView.set(key, value);
    expect(await executeFrame(new Set())).toBe(CASCADES + SPOTS);

    // Frame 2: only view 0 of each target misses and re-rasters with new depth;
    // every other view reports a cache hit and must keep its retained depth.
    raster.depthByView.set('directional:0', 0.55);
    raster.depthByView.set('spot:0', 0.65);
    expectedDepth.set('directional:0', 0.55);
    expectedDepth.set('spot:0', 0.65);
    const hits = new Set<string>();
    for (let index = 1; index < CASCADES; index++) {
      hits.add(`directional:${index}`);
      hits.add(`spot:${index}`);
    }
    expect(await executeFrame(hits)).toBe(2);
    const ledger = shadowRaster.inspect();
    expect(ledger.passCount).toBe(2);
    expect(ledger.drawCount).toBe(2);
    expect(ledger.views).toHaveLength(CASCADES + SPOTS);
    for (const view of ledger.views) {
      const key = `${view.identity.kind}:${view.identity.index}`;
      if (hits.has(key))
        expect(view, key).toEqual({
          identity: view.identity,
          cache: 'hit',
          drawCount: 0,
          statistics: {
            decisions: 3,
            hits: 1,
            rebuilds: 2,
            drawCount: 1,
            invalidations: { 'graph-compiled': 1, 'content-changed': 1 },
          },
        });
      else
        expect(view, key).toEqual({
          identity: view.identity,
          cache: 'miss',
          invalidationReason: 'content-changed',
          drawCount: 1,
          statistics: {
            decisions: 3,
            hits: 0,
            rebuilds: 3,
            drawCount: 2,
            invalidations: { 'graph-compiled': 1, 'content-changed': 2 },
          },
        });
    }

    const directionalTexture = captured.directional;
    const spotTexture = captured.spot;
    if (directionalTexture === undefined || spotTexture === undefined)
      throw new Error('shadow textures were not captured');
    const directionalPixels = await readTarget(directionalTexture);
    const spotPixels = await readTarget(spotTexture);
    const sample = (
      pixels: { readonly layers: number; readonly width: number; readonly data: Float32Array },
      index: number,
    ) => {
      const region = viewRegion(pixels.layers, index);
      const height = pixels.data.length / (pixels.width * pixels.layers);
      const x = region.x + MAP_SIZE / 2;
      const y = region.y + MAP_SIZE / 2;
      return pixels.data[(region.layer * height + y) * pixels.width + x];
    };

    const observed: Record<string, number | undefined> = {};
    const expected: Record<string, number> = {};
    for (let index = 0; index < CASCADES; index++) {
      const dKey = `directional:${index}`;
      const sKey = `spot:${index}`;
      observed[dKey] = sample(directionalPixels, index);
      observed[sKey] = sample(spotPixels, index);
      expected[dKey] = expectedDepth.get(dKey) ?? -1;
      expected[sKey] = expectedDepth.get(sKey) ?? -1;
    }
    for (const key of Object.keys(expected))
      expect(observed[key], key).toBeCloseTo(expected[key] ?? -1, 4);

    (await compiled.retire()).unwrap();
    raster.draw = undefined;
    raster.spotViewport = undefined;
  });
});
