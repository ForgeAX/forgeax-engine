import { mat4 } from '@forgeax/engine-math';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
} from '../gpu-usage';
import { createSkinPaletteAllocator } from '../systems/skin-palette-allocator';

it('submits recycled persistent palettes with complete dynamic binding windows', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const allocator = createSkinPaletteAllocator(device, 65536, true);
  const output = device
    .createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
    .unwrap();
  const readback = device
    .createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  try {
    allocator.allocatePersistentSlice({ identity: 'full', generation: 1, jointCount: 255 });
    allocator.releasePersistentSlice('full');
    await device.queue.onSubmittedWorkDone();
    allocator.allocatePersistentSlice({ identity: 'first', generation: 1, jointCount: 1 });
    const second = allocator.allocatePersistentSlice({
      identity: 'second',
      generation: 1,
      jointCount: 1,
    });
    expect(second.byteOffset).toBeGreaterThan(0);
    const identity = mat4.create();
    mat4.identity(identity);
    const pose = mat4.create();
    mat4.identity(pose);
    pose[12] = 7;
    allocator.writePersistentJointPalette(second, [identity], [pose]);
    const module = createShaderModuleImmediate(device, {
      code: `@group(0) @binding(0) var<storage, read> palette: array<mat4x4<f32>, 255>;
@group(0) @binding(1) var<storage, read_write> result: vec4<f32>;
@compute @workgroup_size(1) fn probe() { result = palette[0][3]; }`,
    }).unwrap();
    const groupLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            buffer: {
              type: 'read-only-storage',
              hasDynamicOffset: true,
              minBindingSize: allocator.bindingWindowBytes,
            },
          },
          { binding: 1, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const layout = device.createPipelineLayout({ bindGroupLayouts: [groupLayout] }).unwrap();
    const pipeline = device
      .createComputePipeline({ layout, compute: { module, entryPoint: 'probe' } })
      .unwrap();
    const group = device
      .createBindGroup({
        layout: groupLayout,
        entries: [
          {
            binding: 0,
            resource: {
              kind: 'buffer',
              value: { buffer: second.buffer, offset: 0, size: allocator.bindingWindowBytes },
            },
          },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: output } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group, [second.byteOffset]);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const result = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    expect(Array.from(result)).toEqual([7, 0, 0, 1]);
  } finally {
    await device.queue.onSubmittedWorkDone();
    allocator.dispose();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});
