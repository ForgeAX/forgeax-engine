/// <reference types="@webgpu/types" />
import { readFileSync } from 'node:fs';
import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';

it('reconstructs smooth perspective rays at orbital altitude with a 10 cm near plane', async () => {
  const source = readFileSync(
    new URL('../../../shader/src/atmosphere-coordinates.wgsl', import.meta.url),
    'utf8',
  );
  const ray = source.slice(
    source.indexOf('struct AtmosphereRay'),
    source.indexOf('fn atmosphere_observer'),
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('GPU unavailable');
  const device = await adapter.requestDevice();
  const uniform = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: 512 * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: output.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const module = device.createShaderModule({
      code: `
      struct View { inverseViewProj:mat4x4<f32>, cameraPos:vec3<f32>, pad:f32, temporalProjection:vec4<f32> };
      ${ray}
      @group(0) @binding(0) var<uniform> view:View;
      @group(0) @binding(1) var<storage,read_write> result:array<vec4<f32>>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>) {
        result[id.x]=vec4<f32>(atmosphere_view_ray(view,vec2<f32>(0.5,(f32(id.x)+0.5)/512.0)).direction,1.0);
      }`,
    });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    for (const altitude of [2, 65000, 1000000]) {
      const projection = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.1, 150000);
      const camera = mat4.lookAt(mat4.create(), [0, altitude, 0], [0, altitude, -1], [0, 1, 0]);
      const inverse = mat4.invert(mat4.create(), mat4.multiply(mat4.create(), projection, camera));
      const data = new Float32Array(24);
      data.set(inverse);
      data.set([0, altitude, 0, 0, 0.1, 150000, 0, 0], 16);
      device.queue.writeBuffer(uniform, 0, data);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(8);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(readback.getMappedRange());
      let maximumError = 0;
      for (let y = 0; y < 512; y++) {
        const dy = (1 - (2 * (y + 0.5)) / 512) * Math.tan(Math.PI / 6),
          length = Math.hypot(dy, 1);
        maximumError = Math.max(
          maximumError,
          Math.abs((values[y * 4 + 1] ?? Number.NaN) - dy / length),
          Math.abs((values[y * 4 + 2] ?? Number.NaN) + 1 / length),
        );
      }
      readback.unmap();
      expect(maximumError, `altitude=${altitude}`).toBeLessThan(0.0001);
    }
  } finally {
    uniform.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
