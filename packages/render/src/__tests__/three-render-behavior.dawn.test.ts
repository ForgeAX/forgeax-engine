import { readFileSync } from 'node:fs';
import { halfFloat } from '@forgeax/engine-math';
import { expect, it } from 'vitest';

const source = (name: string) => readFileSync(`packages/shader/src/${name}.wgsl`, 'utf8');
function kernel(file: string, name: string): string {
  const match = source(file).match(new RegExp(`(?:fn|struct) ${name}\\b[\\s\\S]*?\\n\\};?`));
  if (!match) throw new Error(`Missing production declaration ${file}:${name}`);
  return match[0];
}

async function evaluate(code: string, count: number, withLut = false): Promise<Float32Array> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const output = device.createBuffer({
    size: count * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: count * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const lut = withLut
    ? device.createTexture({
        size: [1, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      })
    : undefined;
  try {
    if (lut)
      device.queue.writeTexture(
        { texture: lut },
        Uint16Array.from([0.5, 0.125, 0, 1], halfFloat.f32ToF16),
        {},
        [1, 1],
      );
    const module = device.createShaderModule({
      code: `@group(0) @binding(0) var<storage, read_write> output: array<vec4f>;\n${code}`,
    });
    expect(
      (await module.getCompilationInfo()).messages
        .filter((message) => message.type === 'error')
        .map((message) => message.message),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: output } },
        ...(lut
          ? [
              { binding: 1, resource: lut.createView() },
              {
                binding: 2,
                resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
              },
            ]
          : []),
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(count);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, count * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    expect(errors).toEqual([]);
    return result;
  } finally {
    output.destroy();
    readback.destroy();
    lut?.destroy();
    device.destroy();
  }
}

it('IBL separates reflected single scattering from diffuse multiple scattering', async () => {
  const values = await evaluate(
    `
    ${kernel('ibl-sampling', 'EnvironmentScattering')}
    ${kernel('brdf', 'specularF90')}
    ${kernel('ibl-sampling', 'environmentMultiScattering')}
    ${kernel('ibl-sampling', 'environmentScatteringFromDfg')}
    ${kernel('ibl-sampling', 'environmentScattering')}
    ${kernel('ibl-sampling', 'projectSpecularRadiance')}
    @group(0) @binding(1) var lut: texture_2d<f32>;
    @group(0) @binding(2) var lutSampler: sampler;
    @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
      let f0 = vec3f(array<f32, 3>(0.04, 0.344, 1.0)[id.x]);
      let scatter = environmentScattering(0.5, 0.8, f0, lut, lutSampler);
      let reflected = projectSpecularRadiance(vec3f(8.0), vec3f(0, 0, 1), vec3f(0, 0, 1), 0.8, f0, lut, lutSampler);
      output[id.x] = vec4f(scatter.single.x, scatter.multi.x, reflected.x, reflected.x + scatter.multi.x * 0.25);
    }`,
    3,
    true,
  );
  for (const [index, f0] of [0.04, 0.344, 1].entries()) {
    // Three r184 PhysicalLightingModel.computeMultiscattering, same DFG input.
    const single = f0 * 0.5 + 0.125;
    const favg = f0 + (1 - f0) / 21;
    const multi = ((single * favg) / (1 - 0.375 * favg)) * 0.375;
    const actual = values.slice(index * 4, index * 4 + 4);
    for (const [channel, expected] of [
      single,
      multi,
      8 * single,
      8 * single + 0.25 * multi,
    ].entries())
      expect(actual[channel]).toBeCloseTo(expected, 5);
    // Falsifier: source-independent energy compensation over-brightens this environment.
    expect(Math.abs((actual[3] ?? NaN) - 8 * (single + multi))).toBeGreaterThan(0.02);
  }
});

it('TAA motion response uses input pixels and TAAU starts at 2.5% current color', async () => {
  const values = await evaluate(
    `${kernel('taa-resolve', 'taaMotionCurrentWeight')}
    @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
      let size = vec2f(256.0 * f32(id.x + 1u), 128.0);
      output[id.x] = vec4f(
        taaMotionCurrentWeight(vec2f(0), size, false),
        taaMotionCurrentWeight(vec2f(0), size, true),
        taaMotionCurrentWeight(vec2f(64.0 / size.x, 0), size, false),
        taaMotionCurrentWeight(vec2f(0.5 / size.x, 0), size, false));
    }`,
    3,
  );
  for (let i = 0; i < 3; i++) {
    expect(values[i * 4]).toBeCloseTo(0.05, 6);
    expect(values[i * 4 + 1]).toBeCloseTo(0.025, 6);
    expect(values[i * 4 + 2]).toBeCloseTo(0.55, 6);
    expect(values[i * 4 + 3]).toBeCloseTo(0.05 + 0.25 * (0.5 / 0.75) + 0.5 / 128, 6);
  }
});
