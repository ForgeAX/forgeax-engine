import { type CompiledRenderGraphInfo, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';

const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const BUFFER_USAGE_INDIRECT = 0x0100;

const STORAGE_TEXTURE_WGSL = /* wgsl */ `
@group(0) @binding(0) var outputTexture: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(1)
fn fill(@builtin(global_invocation_id) id: vec3<u32>) {
  textureStore(outputTexture, vec2<i32>(id.xy), vec4<f32>(0.25, 0.5, 0.75, 1.0));
}
`;

export interface StorageIndirectEvidence {
  readonly caps: {
    readonly compute: boolean;
    readonly storageTexture: boolean;
    readonly indirectDrawing: boolean;
  };
  readonly graph: CompiledRenderGraphInfo;
  readonly pixel: readonly number[];
}

export async function runStorageIndirectGraph(): Promise<StorageIndirectEvidence> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const caps = {
    compute: device.caps.compute,
    storageTexture: device.caps.storageTexture,
    indirectDrawing: device.caps.indirectDrawing,
  };
  if (!caps.compute || !caps.storageTexture || !caps.indirectDrawing) {
    throw new Error(`required graph capabilities unavailable: ${JSON.stringify(caps)}`);
  }

  const module = (await createShaderModule(device, { code: STORAGE_TEXTURE_WGSL })).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 0x4,
          storageTexture: {
            access: 'write-only',
            format: 'rgba8unorm',
            viewDimension: '2d',
          },
        },
      ],
    })
    .unwrap();
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: pipelineLayout,
      compute: { module, entryPoint: 'fill' },
    })
    .unwrap();
  const indirectBuffer = device
    .createBuffer({
      size: 12,
      usage: BUFFER_USAGE_INDIRECT | BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  device.queue.writeBuffer(indirectBuffer, 0, new Uint32Array([1, 1, 1])).unwrap();
  const readbackBuffer = device
    .createBuffer({
      size: 256,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    })
    .unwrap();

  const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
  const output = graph
    .createTexture('storage-output', {
      format: 'rgba8unorm',
      size: { width: 1, height: 1 },
    })
    .unwrap();
  const outputView = graph.view(output, { label: 'storage-output.view' }).unwrap();
  const indirect = graph
    .importBuffer(
      'dispatch-args',
      { size: 12, usage: BUFFER_USAGE_INDIRECT | BUFFER_USAGE_COPY_DST },
      () => indirectBuffer,
    )
    .unwrap();
  const readback = graph
    .importBuffer(
      'readback',
      { size: 256, usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST },
      () => readbackBuffer,
    )
    .unwrap();
  graph
    .addComputePass('storage-write', {
      accesses: [
        { resource: outputView, usage: 'storage-write' },
        { resource: indirect, usage: 'indirect-read' },
      ],
      encode: ({ pass, resources }) => {
        const bindings = device
          .createBindGroup({
            layout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'textureView',
                  value: resources.textureView(outputView).unwrap(),
                },
              },
            ],
          })
          .unwrap();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroupsIndirect(resources.buffer(indirect).unwrap(), 0);
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
          { texture: resources.texture(output).unwrap() as unknown as GPUTexture },
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
  const encoder = device.createCommandEncoder({ label: 'storage-indirect-frame' }).unwrap();
  compiled.execute({ encoder }).unwrap();
  const command = encoder.finish().unwrap();
  device.queue.submit([command]).unwrap();
  await device.queue.onSubmittedWorkDone();

  const mapped = (await readbackBuffer.mapAsync(BUFFER_USAGE_MAP_READ)).unwrap();
  const range = mapped.getMappedRange().unwrap();
  const pixel = [...new Uint8Array(range.slice(0, 4))];
  mapped.unmap();
  const inspected = compiled.inspect();
  (await compiled.retire()).unwrap();
  device.destroyBuffer(indirectBuffer).unwrap();
  device.destroyBuffer(readbackBuffer).unwrap();
  return { caps, graph: inspected, pixel };
}
