import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice, TextureFormat } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { SINGLE_LAYER_MEDIUM_RAW_DEPTH_WGSL } from '@forgeax/engine-shader';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSingleLayerMediumMsaaPairProducer,
  addSingleLayerMediumPasses,
  addSingleLayerMediumRawDepthProducer,
  SINGLE_LAYER_MEDIUM_RAW_DEPTH_POST_PROCESS_ID,
  type SingleLayerMediumPassInput,
} from '../pipeline/single-layer-medium-passes';
import type {
  RenderPipelineFrame,
  RenderPipelineSurfaceMediumPair,
  RenderPipelineTarget,
} from '../render-pipeline';

let device: RhiDevice;

beforeAll(async () => {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const created = await adapter.value.requestDevice();
  if (!created.ok) throw created.error;
  device = created.value;
});

function target(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  format: TextureFormat,
): RenderPipelineTarget {
  const texture = graph.createTexture(label, {
    format,
    size: { width: 1, height: 1 },
    sampleCount: 1,
  });
  if (!texture.ok) throw texture.error;
  const view = graph.view(texture.value, { label: `${label}.view` });
  if (!view.ok) throw view.error;
  return { texture: texture.value, view: view.value, format, sampleCount: 1 };
}

function mediumInput(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  surfacePair: RenderPipelineSurfaceMediumPair,
): SingleLayerMediumPassInput {
  return {
    graph,
    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    nearestLayer: target(graph, 'medium-nearest-layer', 'rgba8unorm'),
    nearestDepth: target(graph, 'medium-nearest-depth', 'depth24plus-stencil8'),
    color: target(graph, 'medium-color', 'rgba8unorm'),
    depth: target(graph, 'scene-depth', 'depth24plus-stencil8'),
    surfacePair,
  };
}

function addColorProducer(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  output: RenderPipelineTarget,
  name: string,
): void {
  const result = graph.addRasterPass(name, {
    accesses: [{ resource: output.view, usage: 'color-attachment' }],
    colorAttachments: [
      {
        view: output.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
    encode: () => undefined,
  });
  if (!result.ok) throw result.error;
}

function addDepthProducer(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  output: RenderPipelineTarget,
  name: string,
): void {
  const result = graph.addRasterPass(name, {
    accesses: [{ resource: output.view, usage: 'depth-stencil-write' }],
    colorAttachments: [],
    depthStencilAttachment: {
      view: output.view,
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      stencilClearValue: 0,
      stencilLoadOp: 'clear',
      stencilStoreOp: 'store',
    },
    encode: () => undefined,
  });
  if (!result.ok) throw result.error;
}

describe('single-layer medium graph producer pair', () => {
  it('fails closed from the producer unavailable fact without adding passes', () => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const backdrop = target(graph, 'medium-backdrop', 'rgba8unorm');
    addColorProducer(graph, backdrop, 'medium-backdrop-producer');
    const result = addSingleLayerMediumPasses(
      mediumInput(graph, {
        opaqueColor: backdrop.view,
        rawDepth: { status: 'unavailable', reason: 'depth-copy-unavailable' },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'resource-descriptor-invalid',
        detail: {
          field: 'surfacePair.rawDepth',
          actual: 'depth-copy-unavailable',
        },
      },
    });
  });

  it('routes an available producer pair into both typed medium passes', async () => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const backdrop = target(graph, 'medium-backdrop', 'rgba8unorm');
    addColorProducer(graph, backdrop, 'medium-backdrop-producer');
    const input = mediumInput(graph, {
      opaqueColor: backdrop.view,
      rawDepth: { status: 'unavailable', reason: 'depth-copy-unavailable' },
    });
    addColorProducer(graph, input.color, 'medium-color-producer');
    addDepthProducer(graph, input.depth, 'scene-depth-producer');

    const rawDepth = addSingleLayerMediumRawDepthProducer({
      graph,
      sourceColor: backdrop,
      sourceDepth: input.depth,
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    });
    expect(rawDepth.ok).toBe(true);
    if (!rawDepth.ok) return;
    const availableInput: SingleLayerMediumPassInput = {
      ...input,
      surfacePair: {
        opaqueColor: backdrop.view,
        rawDepth: { status: 'available', view: rawDepth.value.view },
      },
    };

    const result = addSingleLayerMediumPasses(availableInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const createTextureView = vi.spyOn(device, 'createTextureView');
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
    const viewCalls = createTextureView.mock.calls;
    createTextureView.mockRestore();
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(viewCalls).toContainEqual([
      expect.anything(),
      expect.objectContaining({ label: 'single-layer-medium-nearest-depth-sampled.view' }),
    ]);
    const passes = compiled.value
      .inspect()
      .passes.filter(
        (pass) =>
          pass.name === 'single-layer-medium-nearest-layer' ||
          pass.name === 'single-layer-medium-color',
      );
    expect(passes.map((pass) => pass.name)).toEqual([
      'single-layer-medium-nearest-layer',
      'single-layer-medium-color',
    ]);
    for (const pass of passes) {
      expect(pass.accesses).toContainEqual({
        resource: 'single-layer-medium-raw-depth',
        usage: 'sampled-read',
      });
    }
    expect(compiled.value.inspect().passes).toContainEqual(
      expect.objectContaining({ name: 'single-layer-medium-nearest-depth-sampled-producer' }),
    );
  });

  it('encodes the registered raw-depth producer through the Null RHI', async () => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const sourceColor = target(graph, 'raw-depth-source-color', 'rgba8unorm');
    const sourceDepth = target(graph, 'raw-depth-source-depth', 'depth24plus-stencil8');
    addColorProducer(graph, sourceColor, 'raw-depth-color-producer');
    addDepthProducer(graph, sourceDepth, 'raw-depth-depth-producer');
    const producer = addSingleLayerMediumRawDepthProducer({
      graph,
      sourceColor,
      sourceDepth,
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    });
    expect(producer.ok).toBe(true);
    if (!producer.ok) return;
    expect(producer.value.format).toBe('r32float');
    expect(producer.value.view).toBeDefined();

    const createBindGroup = vi.spyOn(device, 'createBindGroup');
    const errors: unknown[] = [];
    const encoder = device.createCommandEncoder({ label: 'raw-depth-producer-encode' }).unwrap();
    const frame = {
      encoder,
      runtime: {
        device,
        errorRegistry: { fire: (error: unknown) => errors.push(error) },
        lookupPostProcess: (id: string) =>
          id === SINGLE_LAYER_MEDIUM_RAW_DEPTH_POST_PROCESS_ID
            ? {
                source: SINGLE_LAYER_MEDIUM_RAW_DEPTH_WGSL,
                reads: ['input', { key: 'scene-depth', sampleType: 'depth' as const }],
              }
            : undefined,
        getPostProcessPipeline: () => ({}) as never,
      },
      pipelineState: { colorAttachmentFormat: 'r32float', format: 'rgba8unorm' },
      frameState: { compiledFrameGraph: null },
      bindGroupCounts: {},
      geometryDepthKey: 'scene-depth',
      postProcessParams: new Map(),
      msaaActive: false,
      targetW: 1,
      targetH: 1,
      view: undefined,
      currentTexture: undefined,
      clear: [0, 0, 0, 1],
      geometryColorResolveView: null,
      ldrSpriteColorView: null,
    } as unknown as RenderPipelineFrame;
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const executed = compiled.value.execute(frame);
    expect(executed.ok).toBe(true);
    expect(errors).toEqual([]);
    expect(createBindGroup).toHaveBeenCalled();
    const entries = createBindGroup.mock.calls.at(-1)?.[0].entries as readonly {
      binding: number;
    }[];
    expect(entries.map((entry) => entry.binding)).toEqual([0, 1, 3, 4]);
    expect(encoder.finish().ok).toBe(true);
    createBindGroup.mockRestore();
  });

  it('rejects a non-4x input at the paired resolver boundary', () => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const sourceColor = target(graph, 'paired-source-color', 'rgba16float');
    const sourceDepth = target(graph, 'paired-source-depth', 'depth24plus-stencil8');
    const result = addSingleLayerMediumMsaaPairProducer({
      graph,
      label: 'paired-invalid',
      sourceColor,
      sourceDepth,
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'resource-descriptor-invalid',
        detail: {
          field: 'source.sampleCount',
          expected: 'color=4,depth=4',
          actual: 'color=1,depth=1',
        },
      },
    });
  });
});
