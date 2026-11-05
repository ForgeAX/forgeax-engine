import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { Result, RhiDevice, RhiError, ShaderModule } from '@forgeax/engine-rhi';
import { addDepthPyramidPasses } from '../depth-pyramid/graph';
import {
  addAutoExposureGraphPasses,
  createAutoExposureGpuResources,
  importAutoExposureGraphResources,
  retireAutoExposureGpuResources,
  writeAutoExposureParameters,
} from '../pipeline/standard-output/auto-exposure/gpu';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { DepthPyramidShaderSources } from '../render-contract';
import type { RenderPipelineFrame } from '../render-pipeline';

export type ModuleFactory = (
  descriptor: GPUShaderModuleDescriptor,
) => Result<ShaderModule, RhiError>;

function runtime(device: RhiDevice, createShaderModule: ModuleFactory) {
  const factory = { createShaderModule };
  return { device, shaderModuleFactory: factory, immediateShaderModuleFactory: factory };
}

/** A varying raw-depth field with one hole has an independent closed-form reference. */
export async function runPortablePyramid(
  device: RhiDevice,
  factory: ModuleFactory,
  sources: DepthPyramidShaderSources,
  width: number,
  height: number,
  reduction: 'closest' | 'furthest',
  execution: 'compute' | 'fragment',
) {
  const depth = device
    .createTexture({
      format: 'depth32float',
      size: { width, height, depthOrArrayLayers: 1 },
      usage: 4 | 16,
    })
    .unwrap();
  const depthView = device.createTextureView(depth, {}).unwrap();
  const uniform = device.createBuffer({ size: VIEW_UNIFORM_BYTES, usage: 64 | 8 }).unwrap();
  const payload = new Float32Array(VIEW_UNIFORM_BYTES / 4);
  // Independent fixture ABI, matching the pre-existing depth-pyramid oracle.
  payload.set([1, 10, 0, 0], 228);
  device.queue.writeBuffer(uniform, 0, payload).unwrap();
  const module = factory({
    code: `
    @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
      let p=array<vec2<f32>,3>(vec2<f32>(-1.,-1.),vec2<f32>(3.,-1.),vec2<f32>(-1.,3.));
      return vec4<f32>(p[i],0.,1.);
    }
    @fragment fn fs(@builtin(position) p:vec4<f32>)->@builtin(frag_depth) f32 {
      if (u32(p.x)==${width - 1}u && u32(p.y)==${height - 1}u) { return 0.; }
      return 0.25+0.125*f32(u32(p.x)%3u);
    }
  `,
  }).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
      vertex: { module, entryPoint: 'vs', buffers: [] },
      fragment: { module, entryPoint: 'fs', targets: [] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    })
    .unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const imported = graph
    .importTexture(
      'fixture-depth',
      { format: 'depth32float', size: { width, height }, usage: 4 | 16 },
      () => depth,
    )
    .unwrap();
  const source = graph.importView(imported, {}, () => depthView).unwrap();
  const view = graph
    .importBuffer('fixture-view', { size: VIEW_UNIFORM_BYTES, usage: 64 }, () => uniform)
    .unwrap();
  graph
    .addRasterPass('fixture-depth-write', {
      accesses: [{ resource: source, usage: 'depth-stencil-write' }],
      colorAttachments: [],
      depthStencilAttachment: {
        view: source,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
      encodeDirect: (pass) => {
        pass.setPipeline(pipeline);
        pass.draw(3);
      },
    })
    .unwrap();
  const pyramid = addDepthPyramidPasses(graph, {
    depth: source,
    view,
    width,
    height,
    reduction,
    execution,
  }).unwrap().pyramid;
  let byteLength = 0;
  const offsets = pyramid.plan.levels.map((level) => {
    const offset = byteLength;
    byteLength += 256 * level.height;
    return offset;
  });
  const buffer = device.createBuffer({ size: byteLength, usage: 1 | 8 }).unwrap();
  const destination = graph
    .importBuffer('fixture-readback', { size: byteLength, usage: 1 | 8 }, () => buffer)
    .unwrap();
  for (const level of pyramid.plan.levels) {
    const levelView = pyramid.levels[level.level];
    if (levelView === undefined) throw new Error('missing planned pyramid level');
    graph
      .addCopyPass(`readback-${level.level}`, {
        accesses: [
          { resource: levelView, usage: 'copy-src' },
          { resource: destination, usage: 'copy-dst' },
        ],
        encodeDirect: (encoder, _frame, resources) =>
          encoder.copyTextureToBuffer(
            { texture: resources.texture(pyramid.texture).unwrap(), mipLevel: level.level },
            {
              buffer,
              offset: offsets[level.level] ?? 0,
              bytesPerRow: 256,
              rowsPerImage: level.height,
            },
            { width: level.width, height: level.height, depthOrArrayLayers: 1 },
          ),
      })
      .unwrap();
  }
  const compiled = graph.compile({ device, surfaceSize: { width, height } }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    const frame = {
      runtime: runtime(device, factory),
      encoder,
      bindGroupCounts: { createBindGroup: 0, keys: [] },
      depthPyramidShaders: sources,
    } as unknown as RenderPipelineFrame;
    const executed = compiled.execute(frame);
    if (!executed.ok) throw new Error(JSON.stringify(executed.error));
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await buffer.mapAsync(1)).unwrap();
    const bytes = mapped.getMappedRange().unwrap().slice(0);
    mapped.unmap();
    const actual = pyramid.plan.levels.map((level) => {
      const values: number[] = [];
      for (let y = 0; y < level.height; y++)
        values.push(...new Float32Array(bytes, (offsets[level.level] ?? 0) + y * 256, level.width));
      return values;
    });
    let sourceWidth = width;
    let sourceHeight = height;
    let values = Array.from({ length: width * height }, (_, index) => {
      const x = index % width;
      if (index === width * height - 1) return Math.fround(3.402823e38);
      const raw = 0.25 + 0.125 * (x % 3);
      return 1 / (raw + (1 - raw) / 10);
    });
    const expected = pyramid.plan.levels.map((level) => {
      const output = Array.from({ length: level.width * level.height }, (_, index) => {
        const x = index % level.width;
        const y = Math.floor(index / level.width);
        const samples: number[] = [];
        for (
          let sy = Math.floor((y * sourceHeight) / level.height);
          sy < Math.ceil(((y + 1) * sourceHeight) / level.height);
          sy++
        )
          for (
            let sx = Math.floor((x * sourceWidth) / level.width);
            sx < Math.ceil(((x + 1) * sourceWidth) / level.width);
            sx++
          )
            samples.push(values[sy * sourceWidth + sx] ?? Math.fround(3.402823e38));
        return reduction === 'closest' ? Math.min(...samples) : Math.max(...samples);
      });
      values = output;
      sourceWidth = level.width;
      sourceHeight = level.height;
      return output;
    });
    return { actual, expected };
  } finally {
    await compiled.retire();
    device.destroyTexture(depth);
    device.destroyBuffer(uniform);
    device.destroyBuffer(buffer);
  }
}

export async function runPortableExposure(
  device: RhiDevice,
  factory: ModuleFactory,
  execution: 'compute' | 'fragment',
  width: number,
  height: number,
  inputPixels?: Float32Array,
) {
  const gpu = createAutoExposureGpuResources(device, 7, execution).unwrap();
  writeAutoExposureParameters(gpu, {
    compensationEv: 0,
    rangeMinEv: -8,
    rangeMaxEv: 8,
    upRate: 3,
    downRate: 1,
    deltaTime: 1 / 60,
    fallback: 1,
    generation: 7,
  }).unwrap();
  const source = device
    .createTexture({
      format: 'rgba32float',
      size: { width, height, depthOrArrayLayers: 1 },
      usage: 2 | 4,
    })
    .unwrap();
  const pixels = inputPixels ?? new Float32Array(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    if (inputPixels !== undefined) break;
    const value = 2 ** (-4 + ((index * 7) % 64) * 0.09375 + 0.03125);
    pixels.set([value, value, value, 1], index * 4);
  }
  device.queue
    .writeTexture(
      { texture: source },
      pixels,
      { bytesPerRow: width * 16, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    )
    .unwrap();
  const sourceView = device.createTextureView(source, {}).unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const imported = graph
    .importTexture(
      'fixture-hdr',
      { format: 'rgba32float', size: { width, height }, usage: 2 | 4 },
      () => source,
    )
    .unwrap();
  const view = graph.importView(imported, {}, () => sourceView).unwrap();
  const resources = importAutoExposureGraphResources(graph, execution).unwrap();
  addAutoExposureGraphPasses(
    { graph } as unknown as Parameters<typeof addAutoExposureGraphPasses>[0],
    {
      source: { texture: imported, view, format: 'rgba32float', sampleCount: 1 },
      resources,
      width,
      height,
    },
  ).unwrap();
  const readback = device.createBuffer({ size: 1040, usage: 1 | 8 }).unwrap();
  const output = graph
    .importBuffer('fixture-readback', { size: 1040, usage: 1 | 8 }, () => readback)
    .unwrap();
  graph
    .addCopyPass('fixture-readback', {
      accesses: [
        { resource: resources.histogram, usage: 'copy-src' },
        { resource: resources.candidate, usage: 'copy-src' },
        { resource: output, usage: 'copy-dst' },
      ],
      encodeDirect: (encoder) => {
        encoder.copyBufferToBuffer(gpu.histogram, 0, readback, 0, 1024);
        encoder.copyBufferToBuffer(gpu.candidate, 0, readback, 1024, 16);
      },
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width, height } }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    const executed = compiled.execute({
      runtime: runtime(device, factory),
      encoder,
      bindGroupCounts: { createBindGroup: 0, keys: [] },
      frameState: { autoExposureGpuResources: gpu },
    } as unknown as RenderPipelineFrame);
    if (!executed.ok) throw new Error(JSON.stringify(executed.error));
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const bytes = mapped.getMappedRange().unwrap().slice(0);
    mapped.unmap();
    return {
      histogram: [...new Uint32Array(bytes, 0, 256)],
      candidate: [...new Float32Array(bytes, 1024, 4)],
      pixels,
    };
  } finally {
    await compiled.retire();
    retireAutoExposureGpuResources(gpu);
    device.destroyTexture(source);
    device.destroyBuffer(readback);
  }
}
