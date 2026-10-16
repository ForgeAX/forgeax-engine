import type { RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';

/** Runs the cooked production reprojection function, not a CPU translation. */
export async function runSsrReprojectionProbe(device: RhiDevice, source: string) {
  const module = createShaderModuleImmediate(device, {
    code: `${source}
@group(1) @binding(0) var<storage, read_write> reprojectionProbe: array<vec4<f32>>;
@compute @workgroup_size(1) fn probe_ssr_reprojection() {
  reprojectionProbe[0] = vec4<f32>(reprojectUv(vec2<f32>(0.5), vec2<f32>(0.0)),
    reprojectUv(vec2<f32>(0.5), vec2<f32>(0.125, -0.0625)));
}`,
  }).unwrap();
  const paramsLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 6, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } }],
    })
    .unwrap();
  const outputLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } }],
    })
    .unwrap();
  const layout = device
    .createPipelineLayout({ bindGroupLayouts: [paramsLayout, outputLayout] })
    .unwrap();
  const pipeline = device
    .createComputePipeline({ layout, compute: { module, entryPoint: 'probe_ssr_reprojection' } })
    .unwrap();
  const params = device
    .createBuffer({ size: 32, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  const output = device
    .createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
    .unwrap();
  const readback = device
    .createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  try {
    const paramsGroup = device
      .createBindGroup({
        layout: paramsLayout,
        entries: [{ binding: 6, resource: { kind: 'buffer', value: { buffer: params } } }],
      })
      .unwrap();
    const outputGroup = device
      .createBindGroup({
        layout: outputLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
      })
      .unwrap();
    const samples = [];
    // No jitter, alternating subpixel jitter, and the reverse transition.
    // Fixed unjittered history must return the same motion-only coordinates.
    for (const jitter of [
      [0, 0, 0, 0],
      [0.25 / 64, -0.25 / 32, -0.25 / 64, 0.25 / 32],
      [-0.25 / 64, 0.25 / 32, 0.25 / 64, -0.25 / 32],
    ]) {
      const payload = new Float32Array(8);
      payload.set(jitter, 4);
      device.queue.writeBuffer(params, 0, payload).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, paramsGroup);
      pass.setBindGroup(1, outputGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
      samples.push([...new Float32Array(mapped.getMappedRange().unwrap().slice(0))]);
      mapped.unmap();
    }
    return samples;
  } finally {
    device.destroyBuffer(params).unwrap();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
}
