import { writeFileSync } from 'node:fs';
import { buildMeshDistanceField } from '@forgeax/engine-geometry';
import { assert, expect, it } from 'vitest';
import { SdfFieldUpload } from '../raytracing/sdf-field-storage';
import { packSdfSceneWithStaticFields } from '../raytracing/sdf-query';
import { ADVANCED_RIGID_COLLISION_WGSL } from '../water/advanced-rigid-collision-shader';
import { sdfCubeIndices, sdfCubePositions } from './raytracing/sdf-cards.geometry';

it('samples accepted static SDF rows without imposing GI normal-only admission', async () => {
  const field = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 8 })
  ).unwrap();
  assert(field.policy.kind === 'signed-solid');
  // The unmodified closed cube has signed distance -1 at its center.
  // This is a lattice node, so interpolation adds no geometric approximation.
  expect(field.origin.map((origin) => origin + 5 * field.spacing)).toEqual([0, 0, 0]);
  const upload = SdfFieldUpload.capture(field).unwrap();
  const initialization = {
    version: 'rigid-sdf-domain/1',
    byteLength: upload.length * 4,
    copyInto(target: Uint8Array) {
      if (target.byteLength !== upload.length * 4 || target.byteOffset % 4 !== 0) return false;
      upload.copyInto(new Uint32Array(target.buffer, target.byteOffset, upload.length), 0);
      return true;
    },
  };
  const source = [0, 1e-40, -1e-40].map((translation, index) => ({
    instanceId: index + 1,
    geometryId: 1,
    mask: 255,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, translation, 0, 0, 1],
    field,
    fieldUpload: upload,
  }));
  const packed = packSdfSceneWithStaticFields(source, 3, {
    wordLength: upload.length,
    initialization,
    uploads: [upload],
    offsets: new Map([[upload, 0]]),
  }).unwrap();
  const words = new Uint32Array(packed.instances.buffer);
  for (const row of [1, 2]) {
    const magnitude = (words[row * 36 + 12] ?? 0) & 0x7fffffff;
    expect(magnitude).toBeGreaterThan(0);
    expect(magnitude).toBeLessThan(0x00800000);
  }
  const samples = new Uint8Array(initialization.byteLength);
  expect(initialization.copyInto(samples)).toBe(true);

  const adapter = await navigator.gpu.requestAdapter();
  assert(adapter, 'Static rigid SDF sampling requires a real GPU');
  const device = await adapter.requestDevice();
  const buffers: GPUBuffer[] = [];
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    const module = device.createShaderModule({
      code: `
@group(0) @binding(0) var<storage,read> p:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
fn rotate(value:vec2f,angle:f32)->vec2f {
 return vec2f(cos(angle)*value.x-sin(angle)*value.y,sin(angle)*value.x+cos(angle)*value.y);
}
${ADVANCED_RIGID_COLLISION_WGSL}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u) {
 output[id.x]=rigidSample(id.x,vec3f(0.0));
}`,
    });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const input = (bytes: Uint8Array | Float32Array) => {
      const buffer = device.createBuffer({
        size: bytes.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      buffers.push(buffer);
      device.queue.writeBuffer(buffer, 0, bytes);
      return buffer;
    };
    const params = new Float32Array(100);
    params[96] = 1;
    params[97] = 1;
    const primitives = new Float32Array(5 * 40);
    // Three admitted rows, one out-of-range row, and an SDF-disabled primitive.
    for (const [index, fieldIndex] of [1, 2, 3, 5, 0].entries()) {
      const offset = index * 40;
      for (const matrix of [0, 16])
        for (const diagonal of [0, 5, 10, 15]) primitives[offset + matrix + diagonal] = 1;
      primitives[offset + 33] = 7;
      primitives[offset + 36] = fieldIndex;
    }
    const output = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    buffers.push(output, readback);
    const bindings = [
      { binding: 0, resource: { buffer: input(params) } },
      { binding: 1, resource: { buffer: output } },
      { binding: 17, resource: { buffer: input(primitives) } },
      { binding: 18, resource: { buffer: input(packed.instances) } },
      { binding: 19, resource: { buffer: input(samples) } },
    ];
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: bindings,
      }),
    );
    pass.dispatchWorkgroups(5);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 80);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange());
    const expected = -1;
    const artifacts = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
    if (artifacts)
      writeFileSync(
        `${artifacts}/water-static-sdf-samples.json`,
        JSON.stringify({
          expected,
          actual: Array.from(actual),
          translations: [0, 1e-40, -1e-40],
        }),
        { flag: 'wx' },
      );
    for (let row = 0; row < 5; row++) {
      expect(Array.from(actual.subarray(row * 4, row * 4 + 3))).toEqual([0, 0, 0]);
      expect(Math.abs((actual[row * 4 + 3] ?? NaN) - (row < 3 ? expected : -7))).toBeLessThan(
        0.00001,
      );
    }
    readback.unmap();
    expect(errors).toEqual([]);
  } finally {
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
});
