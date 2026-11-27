import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { GlobalSdfQueryStatus } from '../../raytracing/global-sdf-query';
import {
  cardVisibilityCases,
  cardVisibilityFixture,
  packCardVisibilityCases,
  packCardVisibilityDistances,
} from './card-radiosity-visibility.fixture';

it('executes the production hemisphere visibility and records its soft/angular limits', async () => {
  const directory = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'actual.wgsl'), cardVisibilityFixture);
    writeFileSync(join(directory, 'cases.json'), JSON.stringify(cardVisibilityCases, null, 2));
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw Error('Card visibility requires an actual GPU adapter');
  const device = await adapter.requestDevice();
  const owned: GPUBuffer[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    const buffer = (size: number, usage: number) => {
      const value = device.createBuffer({ size, usage });
      owned.push(value);
      return value;
    };
    const bytes = packCardVisibilityCases(cardVisibilityCases);
    const inputs = buffer(bytes.byteLength, 128 | 8),
      output = buffer(cardVisibilityCases.length * 32, 128 | 4),
      readback = buffer(cardVisibilityCases.length * 32, 1 | 8);
    device.queue.writeBuffer(inputs, 0, bytes);
    const distanceWords = packCardVisibilityDistances(cardVisibilityCases);
    const distances = buffer(distanceWords.byteLength, 128 | 8);
    device.queue.writeBuffer(distances, 0, distanceWords);
    if (directory) {
      writeFileSync(join(directory, 'cases.bin'), bytes);
      writeFileSync(join(directory, 'distances.bin'), new Uint8Array(distanceWords.buffer));
    }
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: cardVisibilityFixture }),
        entryPoint: 'auditCardProbeVisibility',
      },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [inputs, output, distances].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(cardVisibilityCases.length / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const observed = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    if (directory) {
      writeFileSync(join(directory, 'observed.bin'), new Uint8Array(observed.buffer));
      writeFileSync(
        join(directory, 'result.json'),
        JSON.stringify(
          {
            scope:
              'Actual helper/distance/bin qualification only; soft and angular physical limitations remain; not fresh thin-wall Renderer or Sponza acceptance',
            rows: cardVisibilityCases.map((row, i) => ({
              ...row,
              observed: [...observed.subarray(i * 8, i * 8 + 8)],
            })),
            errors,
          },
          null,
          2,
        ),
      );
    }
    for (const [i, row] of cardVisibilityCases.entries()) {
      const values = observed.subarray(i * 8, i * 8 + 8);
      expect(values[0], row.name).toBeCloseTo(row.expected, 6);
      expect(values[1], row.name).toBe(row.available); // Controlled old plane-only visibility.
      expect(values[2], row.name).toBe(row.expectedRay);
      expect(values[3], row.name).toBe(1);
      const valid = row.status !== GlobalSdfQueryStatus.missingField;
      expect(values[6], row.name).toBe(Number(valid));
      expect(values[7], row.name).toBe(row.expectedAvailable ?? 1);
      if (valid) {
        const endpoint = row.direction.map(
          (value, axis) =>
            (row.offset[axis] ?? NaN) +
            value * (row.status === GlobalSdfQueryStatus.miss ? 2 : row.parameter),
        );
        const distance = row.stratified
          ? row.parameter
          : row.status === GlobalSdfQueryStatus.negativeStart
            ? 0
            : Math.hypot(...endpoint);
        expect(values[5], row.name).toBeCloseTo(distance, 6);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    for (const value of owned) value.destroy();
    device.destroy();
  }
}, 30_000);
