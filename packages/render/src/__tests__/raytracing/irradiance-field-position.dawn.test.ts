import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';

it('samples a spatially varying diffuse field at the receiver independently of view clearance', async () => {
  const source = `
#import forgeax_ray::irradiance_field_sample::sampleIrradianceField
@group(0) @binding(0) var<storage,read_write> output: array<vec4f>;
@compute @workgroup_size(1) fn samplePosition(@builtin(global_invocation_id) id: vec3u) {
 let direction=select(vec3f(0,0,-1),vec3f(0,0,1),(id.x&1u)==1u);
 let y=select(0.1,0.0,id.x>=2u);
 output[id.x]=sampleIrradianceField(vec3f(0.25,y,0.25),vec3f(0,1,0),direction);
}`;
  const compiled = (
    await compileShader(source, {
      id: 'irradiance-field-receiver-position',
      imports: {
        'forgeax_ray::irradiance_field_sample': readFileSync(
          new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
          'utf8',
        ),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Receiver position test requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const buffer = (data: Uint8Array, usage: number) => {
    const result = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
    device.queue.writeBuffer(result, 0, data);
    owned.push(result);
    return result;
  };
  const bytes = (data: Float32Array | Uint32Array) => new Uint8Array(data.buffer);
  try {
    const fieldBytes = packIrradianceFieldUniform(
      { origin: [-1, -1, -1], spacing: 1, dimensions: [4, 4, 4], probeCount: 64, levels: 1 },
      [{ window: [0, 0, 0], min: [0, 0, 0], max: [4, 4, 4] }],
    );
    const field = buffer(fieldBytes, 64);
    const radiance = new Float32Array(64 * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
    for (let probe = 0; probe < 64; probe++)
      for (let texel = 0; texel < IRRADIANCE_FIELD_PROBE_STRIDE; texel++) {
        const z = Math.floor(probe / 16) - 1;
        // Positive affine spatial irradiance. Trilinear reconstruction at z=.25
        // is exactly [1.25, .625, .3125], independently of angular filtering.
        radiance.set(
          [1 + z, (1 + z) * 0.5, (1 + z) * 0.25, 1],
          (probe * IRRADIANCE_FIELD_PROBE_STRIDE + texel) * 4,
        );
      }
    const probes = buffer(bytes(radiance), 128);
    const momentData = new Float32Array(64 * 64 * 2);
    for (let texel = 0; texel < 64 * 64; texel++) momentData.set([8, 64], texel * 2);
    const moments = buffer(bytes(momentData), 128);
    const states = new Uint32Array(64 * 4);
    for (let probe = 0; probe < 64; probe++) states.set([1, 1, 0, 0], probe * 4);
    const meta = buffer(bytes(states), 128);
    // The second receiver lies exactly on a probe plane: dropping normal
    // clearance too would leave every positive-side corner with zero weight.
    const output = device.createBuffer({ size: 64, usage: 128 | 4 });
    const readback = device.createBuffer({ size: 64, usage: 1 | 8 });
    owned.push(output, readback);
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: compiled.wgsl }),
        entryPoint: 'samplePosition',
      },
    });
    const groups = [
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: output } }],
      }),
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [field, probes, moments, meta].map((value, binding) => ({
          binding,
          resource: { buffer: value },
        })),
      }),
    ];
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    for (const [index, group] of groups.entries()) pass.setBindGroup(index, group);
    pass.dispatchWorkgroups(4);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 64);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const values = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    if (process.env.FORGEAX_GI_POSITION_RESULT)
      writeFileSync(
        process.env.FORGEAX_GI_POSITION_RESULT,
        JSON.stringify(
          {
            adapter: {
              vendor: adapter.info.vendor,
              architecture: adapter.info.architecture,
              device: adapter.info.device,
              description: adapter.info.description,
            },
            expected: [1.25, 0.625, 0.3125],
            actual: Array.from(values),
            errors,
          },
          null,
          2,
        ),
      );
    for (let sample = 0; sample < 4; sample++) {
      for (const [channel, expected] of [1.25, 0.625, 0.3125].entries())
        expect(values[sample * 4 + channel]).toBeCloseTo(expected, 5);
      expect(values[sample * 4 + 3]).toBe(1);
    }
    expect(errors).toEqual([]);
  } finally {
    for (const value of owned) value.destroy();
    device.destroy();
  }
});
