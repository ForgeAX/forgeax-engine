import { expect, it } from 'vitest';
import { reflectVfxLayoutV3 } from '../reflection';

it.each([
  '',
  'direction: vec3<f32>,',
  'pair: vec2<f32>,',
])('matches authored WGSL order and storage stride (%s)', async (extra) => {
  const source = `struct VfxParameters { z: f32, a: f32, }
struct VfxCustom { value: f32, ${extra} }`;
  const reflected = reflectVfxLayoutV3({ root: source });
  if (!reflected.ok) throw reflected.error;
  const layout = reflected.value;
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn unavailable');
  const device = await adapter.requestDevice();
  const buffers: GPUBuffer[] = [];
  const make = (size: number, usage: number) => {
    const buffer = device.createBuffer({ size, usage });
    buffers.push(buffer);
    return buffer;
  };
  try {
    device.pushErrorScope('validation');
    const parameters = make(
      Math.max(16, layout.parameters.size),
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const custom = make(
      layout.customLayout.stride * 2,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    );
    const output = make(8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = make(
      8 + layout.customLayout.stride * 2,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const values: Record<string, number> = { z: 2, a: 7 };
    const payload = new ArrayBuffer(Math.max(16, layout.parameters.size));
    for (const field of layout.parameters.fields)
      new DataView(payload).setFloat32(field.offset, values[field.name] ?? 0, true);
    device.queue.writeBuffer(parameters, 0, payload);
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({
          code: `${source}
@group(0) @binding(0) var<uniform> parameters: VfxParameters;
@group(0) @binding(1) var<storage, read_write> custom: array<VfxCustom>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;
@compute @workgroup_size(1) fn main() {
  output[0] = parameters.z; output[1] = parameters.a;
  custom[0].value = 3.; custom[1].value = 9.;
}`,
        }),
        entryPoint: 'main',
      },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [parameters, custom, output].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 8);
    encoder.copyBufferToBuffer(custom, 0, readback, 8, layout.customLayout.stride * 2);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = new DataView(readback.getMappedRange());
    const valueOffset = layout.customLayout.fields.find((field) => field.name === 'value')?.offset;
    if (valueOffset === undefined) throw new Error('Missing reflected Custom field');
    const actual = {
      parameters: [bytes.getFloat32(0, true), bytes.getFloat32(4, true)],
      custom: [
        bytes.getFloat32(8 + valueOffset, true),
        bytes.getFloat32(8 + layout.customLayout.stride + valueOffset, true),
      ],
    };
    readback.unmap();
    expect(await device.popErrorScope()).toBeNull();
    expect(actual).toEqual({ parameters: [2, 7], custom: [3, 9] });
  } finally {
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
});
