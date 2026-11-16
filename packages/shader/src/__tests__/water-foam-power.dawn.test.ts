import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const surface = readFileSync(new URL('../water-surface.wgsl', import.meta.url), 'utf8');
const phase = /let foamPhase = [\s\S]*?;/.exec(surface)?.[0];
if (phase === undefined) throw new Error('Missing production Water foam phase');
const helper = /fn waterPositiveClampedPow\([\s\S]*?\n\}/.exec(surface)?.[0] ?? '';
const samples = [
  [-1, 0],
  [0, 0],
  [1e-10, 0],
  [2.980233e-8, 0],
  [4e-8, 0.2],
  [0.25, 0.2],
  [0.5, 2],
  [2, -1],
] as const;

it('keeps the exposed Power parameter on UE positive-clamped zero-base semantics', async () => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === null) throw new Error('Water foam Power regression requires a Dawn adapter');
  const identity = {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
    isFallbackAdapter: adapter.info.isFallbackAdapter,
  };
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('internal');
  device.pushErrorScope('validation');
  const values = device.createBuffer({
    size: samples.length * 8,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: samples.length * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: samples.length * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  let actual: number[] = [];
  try {
    device.queue.writeBuffer(values, 0, new Float32Array(samples.flatMap((pair) => [...pair])));
    const module = device.createShaderModule({
      code: `
${helper}
struct Parameters { foamPower: f32, foamBoost: f32, foamMaskNearFluid: f32 }
@group(0) @binding(0) var<storage, read> samples: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> result: array<f32>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let simulationFoam = samples[id.x].x;
  let material = Parameters(samples[id.x].y, 1.0, 0.0);
  let eraseMask = 1.0;
  ${phase}
  result[id.x] = foamPhase;
}`,
    });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: values } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(samples.length);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, samples.length * 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    actual = Array.from(new Float32Array(readback.getMappedRange()));
    readback.unmap();
    for (const [index, [base, exponent]] of samples.entries()) {
      const f32Base = Math.fround(base);
      const expected = f32Base <= Math.fround(2.980233e-8) ? 0 : f32Base ** Math.fround(exponent);
      expect(actual[index]).toBeCloseTo(expected, 6);
    }
  } finally {
    const scopes = {
      validation: (await device.popErrorScope())?.message ?? null,
      internal: (await device.popErrorScope())?.message ?? null,
      outOfMemory: (await device.popErrorScope())?.message ?? null,
    };
    values.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
    console.info(
      '[water-foam-power]',
      JSON.stringify({
        requestedBackend: process.env.DAWNNODE_BACKEND ?? null,
        identity,
        samples,
        actual,
        scopes,
        uncapturedErrors: errors,
      }),
    );
    expect(scopes).toEqual({ validation: null, internal: null, outOfMemory: null });
    expect(errors).toEqual([]);
  }
});
