import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  surfaceAcceptCases,
  surfaceAcceptKernel,
  surfaceAcceptMismatches,
  surfaceAcceptMutants,
  surfaceAcceptSource,
  surfaceAcceptWords,
} from './sdf-surface-accept.fixture';

it('preserves actual accumulator tuple words and catches wrong branch source', async () => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw Error('Surface accumulator requires an actual GPU adapter');
  const device = await adapter.requestDevice(),
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const directory = process.env.FORGEAX_SURFACE_ACCEPT_OUTPUT ?? 'artifacts/sdf-surface-accept';
  mkdirSync(directory, { recursive: true });
  const cases = surfaceAcceptCases(),
    input = new Uint32Array(cases.length * 24),
    expected = new Uint32Array(cases.length * 12);
  cases.forEach((row, index) => {
    input.set(surfaceAcceptWords(row.best), index * 24);
    input.set(surfaceAcceptWords(row.hit), index * 24 + 12);
    expected.set(surfaceAcceptWords(row.expected), index * 12);
  });
  writeFileSync(join(directory, 'input.bin'), new Uint8Array(input.buffer));
  writeFileSync(join(directory, 'expected.bin'), new Uint8Array(expected.buffer));
  const variants = [
    { name: 'actual', source: surfaceAcceptKernel, negative: false },
    ...surfaceAcceptMutants().map((mutant) => ({
      name: mutant.name,
      source: surfaceAcceptKernel.replace(surfaceAcceptSource, mutant.source),
      negative: true,
    })),
  ];
  const rows: { name: string; negative: boolean; mismatchWords: number[] }[] = [];
  try {
    for (const variant of variants) {
      writeFileSync(join(directory, `${variant.name}.wgsl`), variant.source);
      const actual = await runSurfaceAcceptWork(
        device,
        variant.source,
        new Uint8Array(input.buffer),
        cases.length,
      );
      writeFileSync(join(directory, `${variant.name}.bin`), new Uint8Array(actual.buffer));
      const mismatchWords = surfaceAcceptMismatches(actual, expected);
      rows.push({ name: variant.name, negative: variant.negative, mismatchWords });
      if (variant.negative) expect(mismatchWords.length, variant.name).toBeGreaterThan(0);
      else expect(mismatchWords, variant.name).toEqual([]);
    }
    await device.queue.onSubmittedWorkDone();
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
    writeFileSync(
      join(directory, 'result.json'),
      JSON.stringify(
        {
          rows,
          errors,
          cases: cases.map((row) => row.name),
          recordWords: 12,
          adapter: {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
          },
          scope:
            'Actual ten-field accumulator component only; no World, BVH, Card, GI or performance qualification.',
        },
        null,
        2,
      ),
    );
  }
});

async function runSurfaceAcceptWork(
  device: GPUDevice,
  code: string,
  bytes: Uint8Array<ArrayBuffer>,
  count: number,
) {
  const owned: GPUBuffer[] = [];
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size, usage });
    owned.push(value);
    return value;
  };
  try {
    const input = buffer(bytes.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const output = buffer(count * 48, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const staging = buffer(output.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(input, 0, bytes);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(count);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const actual = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    return actual;
  } finally {
    for (const value of owned) value.destroy();
  }
}
