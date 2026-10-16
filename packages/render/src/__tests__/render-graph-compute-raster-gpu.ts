import { type CompiledRenderGraphInfo, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  RenderPipeline,
  RhiCommandEncoder,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';

const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;

const PREPARE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> args: array<u32>;
@group(0) @binding(1) var<storage, read_write> pingA: array<u32>;

@compute @workgroup_size(1)
fn prepare() {
  args[0] = 1u;
  args[1] = 1u;
  args[2] = 1u;
  args[4] = 3u;
  args[5] = 1u;
  args[6] = 0u;
  args[7] = 0u;
  pingA[0] = 32u;
}
`;

const PING_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> pingA: array<u32>;
@group(0) @binding(1) var<storage, read_write> pingB: array<u32>;

@compute @workgroup_size(1)
fn ping() {
  pingB[0] = pingA[0] * 2u;
}
`;

const SHADE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> pingB: array<u32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(1)
fn shade() {
  textureStore(
    outputTexture,
    vec2<i32>(0, 0),
    vec4<f32>(f32(pingB[0]) / 255.0, 128.0 / 255.0, 0.75, 1.0),
  );
}
`;

const RASTER_WGSL = /* wgsl */ `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(positions[vertex], 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return textureLoad(sourceTexture, vec2<i32>(0, 0), 0);
}
`;

interface ComputeResources {
  readonly layout: BindGroupLayout;
  readonly pipeline: ComputePipeline;
}

function bufferBinding(buffer: Buffer) {
  return { kind: 'buffer' as const, value: { buffer } };
}

async function computeResources(
  device: RhiDevice,
  code: string,
  entries: Parameters<RhiDevice['createBindGroupLayout']>[0]['entries'],
  entryPoint: string,
): Promise<ComputeResources> {
  const module = (await createShaderModule(device, { code })).unwrap();
  const layout = device.createBindGroupLayout({ entries }).unwrap();
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
  const pipeline = device
    .createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } })
    .unwrap();
  return { layout, pipeline };
}

export interface ComputeRasterEvidence {
  readonly graph: CompiledRenderGraphInfo;
  readonly pixel: readonly number[];
}

export async function runComputeRasterGraph(): Promise<ComputeRasterEvidence> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  if (
    !device.caps.compute ||
    !device.caps.storageBuffer ||
    !device.caps.storageTexture ||
    !device.caps.indirectDrawing
  ) {
    throw new Error(`required graph capabilities unavailable: ${JSON.stringify(device.caps)}`);
  }

  const prepare = await computeResources(
    device,
    PREPARE_WGSL,
    [
      { binding: 0, visibility: 0x4, buffer: { type: 'storage' } },
      { binding: 1, visibility: 0x4, buffer: { type: 'storage' } },
    ],
    'prepare',
  );
  const ping = await computeResources(
    device,
    PING_WGSL,
    [
      { binding: 0, visibility: 0x4, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 0x4, buffer: { type: 'storage' } },
    ],
    'ping',
  );
  const shade = await computeResources(
    device,
    SHADE_WGSL,
    [
      { binding: 0, visibility: 0x4, buffer: { type: 'read-only-storage' } },
      {
        binding: 1,
        visibility: 0x4,
        storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
      },
    ],
    'shade',
  );
  const rasterModule = (await createShaderModule(device, { code: RASTER_WGSL })).unwrap();
  const rasterLayout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x2, texture: { sampleType: 'float', viewDimension: '2d' } },
      ],
    })
    .unwrap();
  const rasterPipelineLayout = device
    .createPipelineLayout({ bindGroupLayouts: [rasterLayout] })
    .unwrap();
  const rasterPipeline: RenderPipeline = device
    .createRenderPipeline({
      layout: rasterPipelineLayout as never,
      vertex: { module: rasterModule as never, entryPoint: 'vs', buffers: [] },
      fragment: {
        module: rasterModule as never,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();

  const readbackBuffer = device
    .createBuffer({
      label: 'compute-raster-readback',
      size: 256,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    })
    .unwrap();

  const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
  const args = graph.createBuffer('gpu-args', { size: 32 }).unwrap();
  const pingA = graph.createBuffer('ping-a', { size: 16 }).unwrap();
  const pingB = graph.createBuffer('ping-b', { size: 16 }).unwrap();
  const storageTexture = graph
    .createTexture('storage-texture', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
    .unwrap();
  const storageView = graph.view(storageTexture, { label: 'storage-texture.view' }).unwrap();
  const outputTexture = graph
    .createTexture('raster-output', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
    .unwrap();
  const outputView = graph.view(outputTexture, { label: 'raster-output.view' }).unwrap();
  const readback = graph
    .importBuffer(
      'readback',
      { size: 256, usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST },
      () => readbackBuffer,
    )
    .unwrap();

  graph
    .addComputePass('prepare-args-and-ping', {
      accesses: [
        { resource: args, usage: 'storage-write' },
        { resource: pingA, usage: 'storage-write' },
      ],
      encode: ({ pass, resources }) => {
        const bindings = device
          .createBindGroup({
            layout: prepare.layout,
            entries: [
              { binding: 0, resource: bufferBinding(resources.buffer(args).unwrap()) },
              { binding: 1, resource: bufferBinding(resources.buffer(pingA).unwrap()) },
            ],
          })
          .unwrap();
        pass.setPipeline(prepare.pipeline);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(1);
      },
    })
    .unwrap();
  graph
    .addComputePass('ping-pong', {
      accesses: [
        { resource: args, usage: 'indirect-read' },
        { resource: pingA, usage: 'storage-read' },
        { resource: pingB, usage: 'storage-write' },
      ],
      encode: ({ pass, resources }) => {
        const bindings = device
          .createBindGroup({
            layout: ping.layout,
            entries: [
              { binding: 0, resource: bufferBinding(resources.buffer(pingA).unwrap()) },
              { binding: 1, resource: bufferBinding(resources.buffer(pingB).unwrap()) },
            ],
          })
          .unwrap();
        pass.setPipeline(ping.pipeline);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroupsIndirect(resources.buffer(args).unwrap(), 0);
      },
    })
    .unwrap();
  graph
    .addComputePass('storage-texture', {
      accesses: [
        { resource: pingB, usage: 'storage-read' },
        { resource: storageView, usage: 'storage-write' },
      ],
      encode: ({ pass, resources }) => {
        const bindings = device
          .createBindGroup({
            layout: shade.layout,
            entries: [
              { binding: 0, resource: bufferBinding(resources.buffer(pingB).unwrap()) },
              {
                binding: 1,
                resource: {
                  kind: 'textureView',
                  value: resources.textureView(storageView).unwrap(),
                },
              },
            ],
          })
          .unwrap();
        pass.setPipeline(shade.pipeline);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(1);
      },
    })
    .unwrap();
  graph
    .addRasterPass('indirect-raster', {
      accesses: [
        { resource: storageView, usage: 'sampled-read' },
        { resource: args, usage: 'indirect-read' },
        { resource: outputView, usage: 'color-attachment' },
      ],
      colorAttachments: [
        {
          view: outputView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      encode: ({ pass, resources }) => {
        const bindings = device
          .createBindGroup({
            layout: rasterLayout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'textureView',
                  value: resources.textureView(storageView).unwrap(),
                },
              },
            ],
          })
          .unwrap();
        pass.setPipeline(rasterPipeline);
        pass.setBindGroup(0, bindings);
        pass.drawIndirect(resources.buffer(args).unwrap(), 16);
      },
    })
    .unwrap();
  graph
    .addCopyPass('readback', {
      accesses: [
        { resource: outputView, usage: 'copy-src' },
        { resource: readback, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) => {
        encoder.copyTextureToBuffer(
          { texture: resources.texture(outputTexture).unwrap() as unknown as GPUTexture },
          {
            buffer: resources.buffer(readback).unwrap() as unknown as GPUBuffer,
            bytesPerRow: 256,
            rowsPerImage: 1,
          },
          { width: 1, height: 1, depthOrArrayLayers: 1 },
        );
      },
    })
    .unwrap();

  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const encoder = device.createCommandEncoder({ label: 'compute-raster-frame' }).unwrap();
  compiled.execute({ encoder }).unwrap();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();

  const mapped = (await readbackBuffer.mapAsync(BUFFER_USAGE_MAP_READ)).unwrap();
  const range = mapped.getMappedRange().unwrap();
  const pixel = [...new Uint8Array(range.slice(0, 4))];
  mapped.unmap();
  const inspected = compiled.inspect();
  (await compiled.retire()).unwrap();
  device.destroyBuffer(readbackBuffer).unwrap();
  return { graph: inspected, pixel };
}
