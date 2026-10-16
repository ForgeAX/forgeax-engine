import { expect } from 'vitest';

export async function verifyMipDispatchChain(): Promise<void> {
  const adapter = await navigator.gpu.requestAdapter();
  expect(adapter).not.toBeNull();
  if (!adapter) throw new Error('adapter-unavailable');
  const device = await adapter.requestDevice();
  const texture = device.createTexture({
    label: 'mip-dispatch-regression',
    size: [16, 16],
    mipLevelCount: 5,
    format: 'r32float',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST,
  });
  const buffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const sampled = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const seedValue = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  try {
    device.pushErrorScope('validation');
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'r32float' },
        },
      ],
    });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({
          code: `
          @group(0) @binding(0) var source: texture_2d<f32>;
          @group(0) @binding(1) var destination: texture_storage_2d<r32float, write>;
          @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
            textureStore(destination, vec2i(id.xy), vec4f(textureLoad(source, vec2i(id.xy * 2u), 0).x + 1.0));
          }`,
        }),
      },
    });
    const groups = Array.from({ length: 4 }, (_, mip) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: texture.createView({ baseMipLevel: mip, mipLevelCount: 1 }) },
          { binding: 1, resource: texture.createView({ baseMipLevel: mip + 1, mipLevelCount: 1 }) },
        ],
      }),
    );
    const sampleLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const samplePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [sampleLayout] }),
      compute: {
        module: device.createShaderModule({
          code: `
        @group(0) @binding(0) var pyramid: texture_2d<f32>;
        @group(0) @binding(1) var<storage,read_write> result: array<f32>;
        @compute @workgroup_size(1) fn main() { result[0] = textureLoad(pyramid, vec2i(0), 4).x; }
      `,
        }),
      },
    });
    const sampleGroup = device.createBindGroup({
      layout: sampleLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: { buffer: sampled } },
      ],
    });
    const seedLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'r32float' },
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const seedPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [seedLayout] }),
      compute: {
        module: device.createShaderModule({
          code: `
        @group(0) @binding(0) var destination: texture_storage_2d<r32float,write>;
        @group(0) @binding(1) var<uniform> params: vec4f;
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) { textureStore(destination, vec2i(id.xy), params); }
      `,
        }),
      },
    });
    const seedGroup = device.createBindGroup({
      layout: seedLayout,
      entries: [
        { binding: 0, resource: texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 1, resource: { buffer: seedValue } },
      ],
    });
    for (let frame = 0; frame < 3; frame++) {
      device.queue.writeBuffer(seedValue, 0, new Float32Array([frame + 1, 0, 0, 0]));
      const encoder = device.createCommandEncoder();
      const seed = encoder.beginComputePass({ label: 'mip-dispatch-storage-seed' });
      seed.setPipeline(seedPipeline);
      seed.setBindGroup(0, seedGroup);
      seed.dispatchWorkgroups(16, 16);
      seed.end();
      const pass = encoder.beginComputePass({ label: 'mip-dispatch-chain' });
      pass.setPipeline(pipeline);
      for (const [mip, group] of groups.entries()) {
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(8 >> mip, 8 >> mip);
      }
      pass.end();
      const consumer = encoder.beginComputePass({ label: 'mip-dispatch-all-mips-consumer' });
      consumer.setPipeline(samplePipeline);
      consumer.setBindGroup(0, sampleGroup);
      consumer.dispatchWorkgroups(1);
      consumer.end();
      encoder.copyBufferToBuffer(sampled, 0, buffer, 0, 4);
      device.queue.submit([encoder.finish()]);
      expect(await device.popErrorScope()).toBeNull();
      device.pushErrorScope('validation');
      await buffer.mapAsync(GPUMapMode.READ);
      expect(new Float32Array(buffer.getMappedRange())[0]).toBe(frame + 5);
      buffer.unmap();
    }
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    buffer.destroy();
    sampled.destroy();
    seedValue.destroy();
    texture.destroy();
    device.destroy();
  }
}
