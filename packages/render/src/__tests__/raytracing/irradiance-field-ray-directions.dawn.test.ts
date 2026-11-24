import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';

it('stratifies near directions and keeps far cache directions at fixed cell centers', async () => {
  const budgets = [16, 17, 64, 256];
  const probes = 8;
  const updates = 64;
  const records: number[] = [];
  for (const rays of budgets)
    for (let probe = 0; probe < probes; probe++)
      for (let update = 0; update < updates; update++)
        for (let ray = 0; ray < rays; ray++) records.push(probe, update, ray, rays);
  // The same committed ordinal is independent of its place in a dispatch.
  records.push(0, 0, 0, 16);
  const nearCount = records.length / 4;
  const farBudgets = [16, 17, 64, 256];
  for (const rays of farBudgets) {
    for (const [probe, update] of [
      [0, 0],
      [0, 41],
      [7, 0],
    ] as const) {
      for (let ray = 0; ray < rays; ray++) records.push(probe, update, ray, rays);
    }
  }
  const parameters = new Uint32Array(records);
  const source = `${irradianceFieldKernelWgsl('global-sdf').traceProbes}
@group(1) @binding(0) var<storage,read> directionInputs: array<vec4u>;
@group(1) @binding(1) var<storage,read_write> directionResults: array<vec4f>;
@compute @workgroup_size(64) fn auditDirections(@builtin(global_invocation_id) gid: vec3u) {
 if(gid.x>=arrayLength(&directionInputs)){return;}
 let p=directionInputs[gid.x];
 directionResults[gid.x]=vec4f(traceProbeDirection(p.x,p.y,p.z,p.w,gid.x>=${nearCount}u),1.0);
}`;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('probe direction audit requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const statistics: Record<string, unknown> = {};
  let values = new Float32Array();
  try {
    const input = device.createBuffer({ size: parameters.byteLength, usage: 128 | 8 });
    const output = device.createBuffer({ size: parameters.byteLength, usage: 128 | 4 });
    const staging = device.createBuffer({ size: parameters.byteLength, usage: 1 | 8 });
    owned.push(input, output, staging);
    device.queue.writeBuffer(input, 0, parameters);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: source }),
        entryPoint: 'auditDirections',
      },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, group);
    pass.dispatchWorkgroups(Math.ceil(records.length / 4 / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    values = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    expect(errors).toEqual([]);
    const assertNearUniformIntegrals = () => {
      let first = 0;
      for (const rays of budgets) {
        const count = rays * probes * updates;
        const mean = [0, 0, 0];
        const second = [0, 0, 0];
        const cosine = [0, 0, 0];
        let maxLengthError = 0;
        let allFinite = true;
        for (let sample = first; sample < first + count; sample++) {
          const vector = values.subarray(sample * 4, sample * 4 + 3);
          allFinite &&= vector.every(Number.isFinite);
          maxLengthError = Math.max(maxLengthError, Math.abs(Math.hypot(...vector) - 1));
          for (let axis = 0; axis < 3; axis++) {
            const value = vector[axis] ?? Number.NaN;
            mean[axis] = (mean[axis] ?? 0) + value / count;
            second[axis] = (second[axis] ?? 0) + (value * value) / count;
            cosine[axis] = (cosine[axis] ?? 0) + Math.max(value, 0) / count;
          }
        }
        statistics[rays] = { count, maxLengthError, mean, second, cosine };
        expect(allFinite).toBe(true);
        expect(maxLengthError).toBeLessThan(2e-5);
        // Analytic uniform-sphere integrals, independent of sample construction.
        for (let axis = 0; axis < 3; axis++) {
          expect(Math.abs(mean[axis] ?? Number.NaN)).toBeLessThan(0.02);
          expect(Math.abs((second[axis] ?? Number.NaN) - 1 / 3)).toBeLessThan(0.02);
          expect(Math.abs((cosine[axis] ?? Number.NaN) - 1 / 4)).toBeLessThan(0.02);
        }
        first += count;
      }
    };
    assertNearUniformIntegrals();
    expect([...values.subarray((nearCount - 1) * 4, nearCount * 4)]).toEqual([
      ...values.subarray(0, 4),
    ]);
    expect([...values.subarray(16 * 4, 16 * 4 + 3)]).not.toEqual([...values.subarray(0, 3)]);
    expect([...values.subarray(16 * updates * 4, 16 * updates * 4 + 3)]).not.toEqual([
      ...values.subarray(0, 3),
    ]);

    let firstFar = nearCount * 4;
    for (const rays of farBudgets) {
      const span = rays * 4;
      const center = values.slice(firstFar, firstFar + span);
      expect(values.slice(firstFar + span, firstFar + 2 * span), `refresh ${rays}`).toEqual(center);
      expect(values.slice(firstFar + 2 * span, firstFar + 3 * span), `probe ${rays}`).toEqual(
        center,
      );
      const rows = Math.floor(Math.sqrt(rays));
      const baseColumns = Math.floor(rays / rows);
      let ray = 0;
      for (let row = 0; row < rows; row++) {
        const columns = baseColumns + Number(row < rays % rows);
        const y = (2 * (ray + columns / 2)) / rays - 1;
        for (let column = 0; column < columns; column++, ray++) {
          const x = (2 * (column + 0.5)) / columns - 1;
          const z = 1 - Math.abs(x) - Math.abs(y);
          const direction =
            z < 0
              ? [(1 - Math.abs(y)) * Math.sign(x), (1 - Math.abs(x)) * Math.sign(y), z]
              : [x, y, z];
          const length = Math.hypot(...direction);
          for (const [axis, value] of direction.entries()) {
            expect(center[ray * 4 + axis], `stratum ${rays}:${ray}:${axis}`).toBeCloseTo(
              value / length,
              5,
            );
          }
        }
      }
      expect(ray).toBe(rays);
      firstFar += 3 * span;
    }
  } finally {
    const directory = 'artifacts/irradiance-field/dawn';
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      `${directory}/directions-result.json`,
      JSON.stringify({ statistics, errors }, null, 2),
    );
    writeFileSync(`${directory}/directions.f32`, new Uint8Array(values.buffer));
    for (const buffer of owned) buffer.destroy();
    device.destroy();
  }
});
