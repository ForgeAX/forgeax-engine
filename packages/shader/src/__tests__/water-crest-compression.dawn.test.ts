import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../water-waves.wgsl', import.meta.url), 'utf8');
const production = (kind: 'fn' | 'struct', name: string) => {
  const match = new RegExp(`${kind} ${name}\\b[\\s\\S]*?\\n\\}`).exec(source)?.[0];
  if (match === undefined) throw new Error(`Missing production ${name}`);
  return match;
};

it('derives breaking tendency from the same Gerstner compression at peaks, troughs and later phases', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Crest compression requires a real Dawn adapter');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const samples = new Float32Array([
    0,
    0,
    0,
    1,
    2.5,
    0,
    0,
    1,
    5,
    0,
    0,
    1,
    0,
    0,
    Math.PI,
    1,
    0,
    0,
    2 * Math.PI,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0.5,
  ]);
  const make = (size: number, usage: number) => device.createBuffer({ size, usage });
  const bodies = make(128, 128 | 8);
  const waves = make(96, 128 | 8);
  const input = make(samples.byteLength, 128 | 8);
  const output = make(samples.byteLength, 128 | 4);
  const readback = make(samples.byteLength, 1 | 8);
  try {
    const body = new Float32Array(32);
    new Uint32Array(body.buffer).set([0, 1, 0, 0]);
    body.set([10000, 4, 0, 0], 16);
    device.queue.writeBuffer(bodies, 0, body);
    device.queue.writeBuffer(
      waves,
      0,
      new Float32Array([1, 0, 0.2, 0.2, 0.1, Math.PI / 5, 1, 5, 0, 0, 0, 0]),
    );
    device.queue.writeBuffer(input, 0, samples);
    const module = device.createShaderModule({
      code: `
${production('struct', 'WaterBodyData')}
${production('struct', 'WaterGerstnerWave')}
${production('struct', 'WaterWaveResult')}
@group(0) @binding(0) var<storage, read> waterBodyData: array<WaterBodyData>;
@group(0) @binding(1) var<storage, read> waterGerstnerWaves: array<WaterGerstnerWave>;
@group(0) @binding(2) var<storage, read> samples: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> results: array<vec4<f32>>;
${production('fn', 'waterWaveSinCos')}
${production('fn', 'evaluateWaterWavesAtAttenuation')}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let sample = samples[id.x];
  let wave = evaluateWaterWavesAtAttenuation(0u, sample.xy, sample.w, sample.z);
  results[id.x] = vec4<f32>(wave.displacement.y, wave.compression, wave.normal.x, 1.0);
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
      entries: [bodies, waves, input, output].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(7);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, samples.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    const compression = Array.from({ length: 7 }, (_, index) => values[index * 4 + 1]);
    expect(compression[0]).toBeCloseTo(Math.PI / 5, 5);
    expect(compression[1]).toBeCloseTo(0, 5);
    expect(compression[2]).toBeCloseTo(0, 5);
    expect(compression[3]).toBeCloseTo(0, 5);
    expect(compression[4]).toBeCloseTo(requiredFixtureValue(compression[0]), 5);
    expect(compression[5]).toBe(0);
    expect(compression[6]).toBeCloseTo(Math.PI / 10, 5);
    expect(values[0]).toBeCloseTo(0.2, 5);
    expect(values[8]).toBeCloseTo(-0.2, 5);

    // M = .4 xx^T + .25 dd^T, d=(.5,sqrt(3)/2): eigenvalues .5 and .15.
    new Uint32Array(body.buffer)[1] = 2;
    device.queue.writeBuffer(bodies, 0, body);
    device.queue.writeBuffer(
      waves,
      0,
      new Float32Array([
        1,
        0,
        0.4,
        0.4,
        0.1,
        1,
        1,
        1,
        0,
        0,
        0,
        0,
        0.5,
        Math.sqrt(3) / 2,
        0.25,
        0.25,
        0.1,
        1,
        1,
        1,
        0,
        0,
        0,
        0,
      ]),
    );
    const twoWaveEncoder = device.createCommandEncoder();
    const twoWavePass = twoWaveEncoder.beginComputePass();
    twoWavePass.setPipeline(pipeline);
    twoWavePass.setBindGroup(0, bindings);
    twoWavePass.dispatchWorkgroups(7);
    twoWavePass.end();
    twoWaveEncoder.copyBufferToBuffer(output, 0, readback, 0, samples.byteLength);
    device.queue.submit([twoWaveEncoder.finish()]);
    await readback.mapAsync(1);
    const twoWaveValues = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    expect(twoWaveValues[1]).toBeCloseTo(0.5, 5);
    expect(twoWaveValues[6 * 4 + 1]).toBeCloseTo(0.25, 5);
    expect(twoWaveValues[5 * 4 + 1]).toBe(0);
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    for (const buffer of [bodies, waves, input, output, readback]) buffer.destroy();
    device.destroy();
  }
});

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Required native fixture value is absent');
  return value;
}
