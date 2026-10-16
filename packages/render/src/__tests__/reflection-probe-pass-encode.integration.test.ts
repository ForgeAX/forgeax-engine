import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import {
  addReflectionProbeGraphPasses,
  type ReflectionProbeGraphState,
} from '../record/typed-frame-graph';
import type { RenderPipelineFrame } from '../render-pipeline';

describe('ReflectionProbe capture pass encoding', () => {
  it('resolves imported capture views through the execution resolver', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const rawTexture = device
      .createTexture({
        label: 'reflection-test-raw',
        format: 'rgba8unorm',
        size: { width: 1, height: 1, depthOrArrayLayers: 6 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        usage: 0x15,
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    const rawCubeView = device
      .createTextureView(rawTexture, { dimension: 'cube', arrayLayerCount: 6 })
      .unwrap();
    const rawFaceViews = Array.from({ length: 6 }, (_, face) =>
      device
        .createTextureView(rawTexture, {
          dimension: '2d',
          baseArrayLayer: face,
          arrayLayerCount: 1,
        })
        .unwrap(),
    );
    const depthTexture = device
      .createTexture({
        label: 'reflection-test-depth',
        format: 'depth24plus-stencil8',
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        usage: 0x10,
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    const depthView = device.createTextureView(depthTexture, { dimension: '2d' }).unwrap();
    const sampler = device.createSampler().unwrap();
    const emptyLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const filterGroup1 = device.createBindGroup({ layout: emptyLayout, entries: [] }).unwrap();
    const cubeVertexBuffer = device.createBuffer({ size: 16, usage: 0x20 }).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const filterPipeline = device
      .createRenderPipeline({
        label: 'reflection-test-filter',
        layout: 'auto',
        vertex: { module: shader, entryPoint: 'main', buffers: [] },
        fragment: { module: shader, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const work: ReflectionProbeGraphState['work'][number] = {
      probeIndex: 0,
      rawTexture,
      rawCubeView,
      rawFaceViews,
      rawDepthTexture: depthTexture,
      rawCaptureFace: 0,
      rawDepthView: depthView,
      rawSize: 1,
      filteredTexture: rawTexture,
      filteredCubeView: rawCubeView,
      filteredFaceViewsByMip: [rawFaceViews],
      outputFormat: 'rgba8unorm',
      sampler,
      filterPipeline,
      filterGroup0: undefined,
      filterGroup1,
      cubeVertexBuffer,
      filteredSize: 1,
      step: undefined,
    };
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    expect(addReflectionProbeGraphPasses(graph, { work: [work] }).ok).toBe(true);
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const encoder = device.createCommandEncoder({ label: 'reflection-test-frame' }).unwrap();
    const frame = {
      runtime: { device },
      validatedOrdered: [],
      frameState: { standardLighting: undefined, installedPipelineConfig: undefined },
      msaaActive: false,
      splitLdrSprite: false,
    } as unknown as RenderPipelineFrame;
    const executed = compiled.execute({ ...frame, encoder });
    expect(executed.ok).toBe(true);
    expect(encoder.finish().ok).toBe(true);
  });
});
