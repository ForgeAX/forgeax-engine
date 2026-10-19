import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

it('runs point power laws and preserves default/Spot near floors on the real GPU', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('point decay requires a real Dawn adapter');
  const device = await adapter.requestDevice();
  const cases = [0, 1.4, 2, 4, Math.fround(3.4028234663852886e38)].flatMap((decay) =>
    [0, 0.001, 0.01, 0.04, 0.5, 1, 2, 14.9, 15, 16, 2000, 5000].flatMap((distance) =>
      [0, 1 / 225].map((inverseRange) => ({ decay, distance, inverseRange })),
    ),
  );
  const input = device.createBuffer({
    size: cases.length * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: cases.length * 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: output.size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const validation: string[] = [];
  device.addEventListener('uncapturederror', (event) => validation.push(event.error.message));
  try {
    device.queue.writeBuffer(
      input,
      0,
      new Float32Array(cases.flatMap((row) => [row.distance, row.decay, row.inverseRange, 0])),
    );
    const volume = source('volume/volume-integrate.wgsl').match(
      /fn evalVolumePoint\([\s\S]*?\n\}/,
    )?.[0];
    if (volume === undefined) throw new Error('missing volume point evaluator');
    const module = device.createShaderModule({
      code: `
      ${source('lighting-attenuation.wgsl').replace(/^#define_import_path.*$/m, '')}
      const EPSILON: f32 = 1e-5;
      ${volume}
      @group(0) @binding(0) var<storage, read> cases: array<vec4<f32>>;
      @group(0) @binding(1) var<storage, read_write> result: array<vec4<f32>>;
      fn original(dSquared: f32, invRangeSquared: f32, nearFloor: f32) -> f32 {
        let safeDistance = max(dSquared, nearFloor);
        let window = clamp(1.0 - (safeDistance * invRangeSquared) * (safeDistance * invRangeSquared), 0.0, 1.0);
        return window * window / safeDistance;
      }
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let row = cases[id.x];
        let squared = row.x * row.x;
        let surface = evalDistanceAttenuation(squared, row.z, row.y, 1e-4);
        let volume = evalVolumePoint(vec3<f32>(0.0, 0.0, row.x), vec3<f32>(1.0), row.z, row.y, vec3<f32>(0.0));
        let spotDistance = max(row.x, 0.04);
        let spot = evalSpotAttenuation(vec3<f32>(0.0, 0.0, spotDistance), vec3<f32>(0.0, 0.0, -1.0), vec3<f32>(0.0), 0.95, 0.8, row.z);
        result[id.x * 2u] = vec4<f32>(surface, volume.x, spot, original(spotDistance * spotDistance, row.z, 1e-4));
        let angle = 0.49 + f32(id.x % 3u) * 0.01;
        result[id.x * 2u + 1u] = vec4<f32>(original(squared, row.z, 1e-4), original(squared, row.z, 1e-5), evalSpotCone(0.5, 0.5, angle), evalSpotCone(0.6, 0.4, angle));
      }`,
    });
    expect(
      (await module.getCompilationInfo()).messages.filter((row) => row.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(cases.length);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Float32Array(readback.getMappedRange()));
    readback.unmap();
    expect(values.every(Number.isFinite)).toBe(true);
    for (const [index, row] of cases.entries()) {
      for (const [channel, floor] of [1e-4, 1e-5].entries()) {
        const squared = Math.max(Math.fround(row.distance) ** 2, floor);
        const window = Math.max(0, 1 - (squared * Math.fround(row.inverseRange)) ** 2);
        const expected = window ** 2 / Math.max(squared ** (Math.fround(row.decay) / 2), floor);
        const actual = values[index * 8 + channel] ?? Number.NaN;
        expect(
          Math.abs(actual - expected),
          JSON.stringify({ ...row, floor, actual, expected }),
        ).toBeLessThanOrEqual(Math.max(1e-7, Math.abs(expected) * 3e-5));
        if (row.decay === 2) expect(actual).toBe(values[index * 8 + 4 + channel]);
      }
      expect(values[index * 8 + 2]).toBe(values[index * 8 + 3]);
      expect(values[index * 8 + 6]).toBe(index % 3 === 0 ? 0 : 1);
      const t = (0.49 + (index % 3) * 0.01 - 0.4) / 0.2;
      expect(values[index * 8 + 7]).toBeCloseTo(t * t * (3 - 2 * t), 5);
    }
    expect(validation).toEqual([]);
  } finally {
    input.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
