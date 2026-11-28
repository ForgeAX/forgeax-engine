import { expect } from 'vitest';
import { projectShaderConditionals } from '../../../shader-compiler/src/conditionals';
import waterSource from '../water-waves.wgsl?raw';

export async function verifyWaterGerstnerSurface() {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Gerstner source conformance requires a real GPU');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const bodies = device.createBuffer({ size: 256, usage: 128 | 8 });
  const waves = device.createBuffer({ size: 48, usage: 128 | 8 });
  const output = device.createBuffer({ size: 128, usage: 128 | 4 });
  const readback = device.createBuffer({ size: 128, usage: 1 | 8 });
  try {
    const bodyData = new Float32Array(64);
    const bodyWords = new Uint32Array(bodyData.buffer);
    for (const offset of [0, 32]) {
      bodyWords.set([0, 1, 7, 3], offset);
      bodyData.set([0.75, -2, 0, 1], offset + 4);
      bodyData.set([20971.52, 4, 2, 0], offset + 16);
      bodyData.set([2, 10, 0, 0], offset + 20);
    }
    bodyWords[56] = 2; // The second body selects WaterInfo: outside this model.
    const k = (2 * Math.PI) / 10;
    const amplitude = 0.2;
    const q = 0.7;
    device.queue.writeBuffer(bodies, 0, bodyData);
    device.queue.writeBuffer(
      waves,
      0,
      new Float32Array([1, 0, amplitude, amplitude, q * amplitude * k, k, 1, q, 0, 0, 0, 0]),
    );
    const module = device.createShaderModule({
      code: `${projectShaderConditionals(waterSource, {}, 'all').replace(/^#define_import_path.*$/m, '')}
@group(0) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn main() {
  let parameter = vec2<f32>(0.7, -0.2);
  let sample = sampleWaterGerstnerSurface(0u, parameter, parameter, 0.002);
  result[0] = vec4<f32>(sample.positionM, select(0.0, 1.0, sample.valid));
  result[1] = vec4<f32>(sample.geometricNormal, 1.0);
  let direct = evaluateWaterWavesForward(0u, parameter, 10.0, waterBodyData[0].timeAndMask.x);
  result[2] = vec4<f32>(vec3<f32>(parameter.x, 2.0, parameter.y) + direct.displacement, 1.0);
  let zero = sampleWaterGerstnerSurface(0u, parameter, parameter, 0.0);
  result[3] = vec4<f32>(zero.positionM, select(0.0, 1.0, zero.valid));
  let unsupported = sampleWaterGerstnerSurface(1u, parameter, parameter, 0.002);
  result[4] = vec4<f32>(unsupported.positionM, select(0.0, 1.0, unsupported.valid));
  result[5] = vec4<f32>(sample.tangentU, 1.0);
  result[6] = vec4<f32>(sample.tangentV, 1.0);
  let missing = sampleWaterGerstnerSurface(9u, parameter, parameter, 0.002);
  result[7] = vec4<f32>(missing.positionM, select(0.0, 1.0, missing.valid));
}`,
    });
    expect(
      (await module.getCompilationInfo()).messages
        .filter((m) => m.type === 'error')
        .map((m) => m.message),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const results = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: output } }],
    });
    const source = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(2),
      entries: [
        { binding: 16, resource: { buffer: bodies } },
        { binding: 17, resource: { buffer: waves } },
      ],
    });
    const run = async () => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, results);
      pass.setBindGroup(2, source);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 128);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const values = new Float32Array(readback.getMappedRange()).slice();
      readback.unmap();
      return values;
    };
    const values = await run();
    expect(Array.from(values.subarray(0, 4))).toEqual(Array.from(values.subarray(8, 12)));
    const phase = k * 0.7 - 0.75;
    expect(values[0]).toBeCloseTo(0.7 - q * amplitude * Math.sin(phase), 5);
    // GPU sin/cos approximations are backend-dependent; shared geometry above
    // must still agree bit-for-bit, independently of this numerical oracle.
    expect(values[1]).toBeCloseTo(2 + amplitude * Math.cos(phase), 4);
    expect(values[2]).toBeCloseTo(-0.2, 6);
    // Independently differentiate the displaced parameterized geometry.
    const tangentX = 1 - q * amplitude * k * Math.cos(phase);
    const tangentY = -amplitude * k * Math.sin(phase);
    const length = Math.hypot(tangentX, tangentY);
    expect(values[4]).toBeCloseTo(-tangentY / length, 3);
    expect(values[5]).toBeCloseTo(tangentX / length, 3);
    expect(values[6]).toBeCloseTo(0, 4);
    expect(values[15]).toBe(0);
    expect(values[19]).toBe(0);
    expect(values[31]).toBe(0);
    bodyData[4] = 1.25;
    device.queue.writeBuffer(bodies, 0, bodyData);
    const advanced = await run();
    expect(advanced[1]).toBeCloseTo(2 + amplitude * Math.cos(k * 0.7 - 1.25), 4);
    expect(advanced[1]).not.toBe(values[1]);
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    for (const buffer of [bodies, waves, output, readback]) buffer.destroy();
    device.destroy();
  }
}
