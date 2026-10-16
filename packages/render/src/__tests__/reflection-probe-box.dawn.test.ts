import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
} from '../gpu-usage';

it('projects only interior probe rays and preserves the sign of nearly parallel axes', async () => {
  const source = readFileSync('packages/shader/src/ibl-sampling.wgsl', 'utf8');
  const helper = source.slice(
    source.indexOf('fn box_project('),
    source.indexOf('// Split-sum probe sample.'),
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const output = device.createBuffer({
    size: 48,
    usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 48,
    usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
  });
  try {
    const module = device.createShaderModule({
      code: `${helper}
      @group(0) @binding(0) var<storage, read_write> result: array<vec4f>;
      @compute @workgroup_size(1) fn main() {
        result[0] = vec4f(box_project(vec3f(4,-1,3),vec3f(0,1,0),vec3f(0),vec3f(1)),0);
        result[1] = vec4f(box_project(vec3f(4,-1,3),vec3f(0,-1,0),vec3f(0),vec3f(1)),0);
        result[2] = vec4f(box_project(vec3f(0.5,0.25,-0.2),vec3f(-0.000001,0.6,0.8),vec3f(0),vec3f(1)),0);
      }`,
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: output } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 48);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    expect(Array.from(values.slice(0, 3))).toEqual([0, 1, 0]);
    expect(Array.from(values.slice(4, 7))).toEqual([0, -1, 0]);
    // The finite ray exits the y=1 face at t=1.25, independently of its tiny x component.
    const intersection = [0.5 - 0.000001 * 1.25, 1, 0.8] as const;
    const length = Math.hypot(...intersection);
    for (const axis of [0, 1, 2] as const)
      expect(values[8 + axis]).toBeCloseTo(intersection[axis] / length, 5);
    expect(errors).toEqual([]);
  } finally {
    readback.destroy();
    output.destroy();
    device.destroy();
  }
});
