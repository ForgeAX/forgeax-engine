import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';

it('samples diffuse, radiance, mip and depth continuously across octahedral seams', async () => {
  const source = `
#import forgeax_ray::irradiance_field_sample::{irradianceFieldLevel, irradianceFieldDepth}
@group(0) @binding(0) var<storage, read> directions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4f>;
@compute @workgroup_size(1) fn angularSampling(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&directions)) { return; }
  let direction = normalize(directions[i].xyz);
  results[i * 4u] = irradianceFieldLevel(0u, 0u, 8u, direction);
  results[i * 4u + 1u] = irradianceFieldLevel(0u, 64u, 8u, direction);
  results[i * 4u + 2u] = irradianceFieldLevel(0u, 128u, 4u, direction);
  results[i * 4u + 3u] = vec4f(irradianceFieldDepth(0u, direction), 0.0, 1.0);
}`;
  const compiled = (
    await compileShader(source, {
      id: 'irradiance-field-angular-seams',
      imports: {
        'forgeax_ray::irradiance_field_sample': readFileSync(
          new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
          'utf8',
        ),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('angular sampling requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const buffer = (data: Float32Array, usage: number) => {
    const value = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
    device.queue.writeBuffer(value, 0, data);
    owned.push(value);
    return value;
  };
  const directions = new Float32Array(
    [-1, 1]
      .flatMap((sign) =>
        [0.25, 0.5, 1, 2].flatMap((z) =>
          [1e-6, -1e-6].flatMap((epsilon) => [sign, epsilon, -z, 0]),
        ),
      )
      .concat(
        [-1, 1].flatMap((sign) =>
          [0.25, 0.5, 1, 2].flatMap((z) =>
            [1e-6, -1e-6].flatMap((epsilon) => [epsilon, sign, -z, 0]),
          ),
        ),
      )
      .concat([
        1e-6, 1e-6, -1, 0, -1e-6, 1e-6, -1, 0, 1e-6, -1e-6, -1, 0, -1e-6, -1e-6, -1, 0, 1e-6, 1e-6,
        -1, 0, 1e-6, -1e-6, -1, 0, -1e-6, 1e-6, -1, 0, -1e-6, -1e-6, -1, 0,
      ]),
  );
  const field = new Float32Array(IRRADIANCE_FIELD_PROBE_STRIDE * 4);
  const moments = new Float32Array(64 * 2);
  // A continuous, positive directional signal; constant fields would conceal
  // the discontinuity. D is the analytic cosine convolution of the linear L.
  for (const [first, size] of [
    [0, 8],
    [64, 8],
    [128, 4],
  ] as const) {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let nx = ((x + 0.5) / size) * 2 - 1;
        let ny = ((y + 0.5) / size) * 2 - 1;
        const nz = 1 - Math.abs(nx) - Math.abs(ny);
        if (nz < 0) {
          const oldX = nx;
          nx = (1 - Math.abs(ny)) * (nx >= 0 ? 1 : -1);
          ny = (1 - Math.abs(oldX)) * (ny >= 0 ? 1 : -1);
        }
        const length = Math.hypot(nx, ny, nz);
        const angular = (0.2 * nx + 0.3 * ny + 0.4 * nz) / length;
        const value = 1 + angular * (first === 0 ? 2 / 3 : 1);
        field.set([value, value * 0.7, value * 0.4, 1], (first + y * size + x) * 4);
        if (first === 0) {
          const depth = 2 + angular;
          moments.set([depth, depth * depth + 0.1], (y * size + x) * 2);
        }
      }
  }
  let values: number[] = [];
  try {
    const input = buffer(directions, 128);
    const irradiance = buffer(field, 128);
    const depth = buffer(moments, 128);
    const output = device.createBuffer({ size: directions.length * 16, usage: 128 | 4 });
    const staging = device.createBuffer({ size: output.size, usage: 1 | 8 });
    owned.push(output, staging);
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: compiled.wgsl }),
        entryPoint: 'angularSampling',
      },
    });
    const groups = [
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
        ],
      }),
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 1, resource: { buffer: irradiance } },
          { binding: 2, resource: { buffer: depth } },
        ],
      }),
    ];
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    groups.forEach((group, index) => {
      pass.setBindGroup(index, group);
    });
    pass.dispatchWorkgroups(directions.length / 4);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    values = Array.from(new Float32Array(staging.getMappedRange().slice(0)));
    staging.unmap();
    expect(errors).toEqual([]);
    expect(values.every(Number.isFinite)).toBe(true);
    for (let pair = 0; pair < directions.length / 8; pair++)
      for (let stage = 0; stage < 4; stage++) {
        const a = pair * 32 + stage * 4;
        const b = a + 16;
        expect(values[a + 3]).toBe(1);
        expect(values[b + 3]).toBe(1);
        for (let channel = 0; channel < (stage === 3 ? 2 : 3); channel++)
          expect(
            Math.abs((values[a + channel] ?? NaN) - (values[b + channel] ?? NaN)),
            `pair ${pair}, stage ${stage}, channel ${channel}`,
          ).toBeLessThan(1e-4);
      }
  } finally {
    mkdirSync('artifacts/irradiance-field/dawn', { recursive: true });
    writeFileSync(
      'artifacts/irradiance-field/dawn/angular-result.json',
      JSON.stringify(
        {
          backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          adapter: { vendor: adapter.info.vendor, device: adapter.info.device },
          compiledShaderSha256: createHash('sha256').update(compiled.wgsl).digest('hex'),
          directions: Array.from(directions),
          values,
          errors,
        },
        null,
        2,
      ),
    );
    owned.forEach((value) => {
      value.destroy();
    });
    device.destroy();
  }
});
