import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../../gpu-usage';
import type { RenderPipelineFrame } from '../../render-pipeline';
import { createRenderPipelineTarget } from '../../render-pipeline';
import { addTransmissionBackdropPasses, type TransmissionBackdropGraph } from '../backdrop';

async function buildBackdrop(device: RhiDevice): Promise<TransmissionBackdropGraph> {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const source = createRenderPipelineTarget(graph, 'opaque-resolved', {
    format: 'rgba16float',
    size: 'surface',
    sampleCount: 1,
  });
  expect(source.ok).toBe(true);
  if (!source.ok) throw source.error;
  graph
    .addRasterPass('opaque', {
      accesses: [{ resource: source.value.view, usage: 'color-attachment' }],
      colorAttachments: [{ view: source.value.view, loadOp: 'clear', storeOp: 'store' }],
      encode: () => undefined,
    })
    .unwrap();
  const added = addTransmissionBackdropPasses({
    graph,
    source: source.value,
    demand: { activeCount: 2, needsRoughMips: true },
    copySize: { width: 4, height: 4 },
    surfaceSize: { width: 4, height: 4 },
    encodeRoughMip: ({ pass }) => {
      pass.draw(3, 1, 0, 0);
    },
  });
  expect(added.ok).toBe(true);
  if (!added.ok) throw added.error;
  const compiled = graph.compile({ device, surfaceSize: { width: 4, height: 4 } });
  if (!compiled.ok) throw compiled.error;
  const names = compiled.value.inspect().passes.map((pass) => pass.name);
  expect(names).toEqual([
    'opaque',
    'transmission-backdrop-copy',
    'transmission-backdrop-mip',
    'transmission-backdrop-mip-copy-1',
    'transmission-backdrop-mip-2',
    'transmission-backdrop-mip-copy-2',
    'transmission-forward',
    'transparent',
    'temporal',
  ]);
  expect(compiled.value.inspect().resources.map((resource) => resource.label)).toContain(
    'transmission-backdrop',
  );
  return added.value;
}

describe('TransmissionBackdrop Dawn topology', () => {
  it('compiles the single rgba16float backdrop with one copy and raster mip', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const result = await buildBackdrop(device);

    expect(result.topology).toMatchObject({
      active: true,
      copyCount: 1,
      mipCount: 1,
      submitCount: 1,
      aliasCount: 0,
    });
  });

  it('does not allocate a backdrop on exact-zero demand', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const source = createRenderPipelineTarget(graph, 'opaque-resolved', {
      format: 'rgba16float',
      size: 'surface',
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const added = addTransmissionBackdropPasses({
      graph,
      source: source.value,
      demand: { activeCount: 0, needsRoughMips: false },
      copySize: { width: 1, height: 1 },
      surfaceSize: { width: 1, height: 1 },
    });
    expect(added).toEqual({
      ok: true,
      value: {
        topology: {
          active: false,
          sourceSampleCount: 1,
          copyCount: 0,
          mipCount: 0,
          submitCount: 1,
          aliasCount: 0,
          phases: [],
        },
        backdrop: undefined,
        mipViews: [],
      },
    });
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.value.inspect().passes).toEqual([]);
  });
});

it('copies precise scene color into the actual F32 transmission backdrop without FP16 rounding', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice({
      requiredFeatures: ['float32-filterable', 'float32-blendable'],
    })
  ).unwrap();
  const readback = device
    .createBuffer({
      size: 256,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const source = createRenderPipelineTarget(graph, 'precise-opaque', {
    format: 'rgba32float',
    size: 'surface',
    sampleCount: 1,
  }).unwrap();
  // Every component is exactly F32-representable; the RGB values lose precision in F16.
  const expected = [1 + 2 ** -12, 0.25 + 2 ** -18, 8 + 2 ** -9, 1] as const;
  graph
    .addRasterPass('precise-opaque-clear', {
      accesses: [{ resource: source.view, usage: 'color-attachment' }],
      colorAttachments: [
        {
          view: source.view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: expected[0], g: expected[1], b: expected[2], a: expected[3] },
        },
      ],
      encode: () => undefined,
    })
    .unwrap();
  const backdrop = addTransmissionBackdropPasses({
    graph,
    source,
    demand: { activeCount: 1, needsRoughMips: false },
    copySize: { width: 1, height: 1 },
    surfaceSize: { width: 1, height: 1 },
  }).unwrap().backdrop;
  if (backdrop === undefined) throw new Error('active transmission must produce its backdrop');
  const buffer = graph
    .importBuffer(
      'precise-readback',
      { size: 256, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
      () => readback,
    )
    .unwrap();
  graph
    .addCopyPass('precise-backdrop-readback', {
      accesses: [
        { resource: backdrop.view, usage: 'copy-src' },
        { resource: buffer, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) => {
        encoder.copyTextureToBuffer(
          { texture: resources.texture(backdrop.texture).unwrap() },
          { buffer: resources.buffer(buffer).unwrap(), bytesPerRow: 256, rowsPerImage: 1 },
          { width: 1, height: 1, depthOrArrayLayers: 1 },
        );
      },
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  try {
    const resource = compiled
      .inspect()
      .resources.find((entry) => entry.label === 'transmission-backdrop');
    expect(resource?.descriptor).toMatchObject({ format: 'rgba32float', mipLevelCount: 1 });
    expect(resource?.byteSize).toBe(16);
    const encoder = device.createCommandEncoder({ label: 'precise-transmission-copy' }).unwrap();
    compiled.execute({ encoder } as RenderPipelineFrame).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const actual = Array.from(new Float32Array(mapped.getMappedRange().unwrap().slice(0, 16)));
    mapped.unmap();
    expect(actual).toEqual(expected);
  } finally {
    (await compiled.retire()).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});
