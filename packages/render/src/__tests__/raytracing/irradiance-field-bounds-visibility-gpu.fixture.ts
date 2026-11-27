import type { prepareCanonicalVisibility } from './irradiance-field-bounds-visibility.fixture';

type Prepared = Awaited<ReturnType<typeof prepareCanonicalVisibility>>;

export const canonicalRawAdmissionCases = [
  { name: 'unused-origin-nan', word: 24, bits: 0x7fc00000, valid: false },
  { name: 'unused-origin-subnormal', word: 24, bits: 1, valid: false },
  { name: 'unused-spacing-nan', word: 27, bits: 0x7fc00000, valid: false },
  { name: 'invalid-affine-w', word: 3, bits: 0x3f800000, valid: false },
  { name: 'legal-affine-negative-zero', word: 3, bits: 0x80000000, valid: true },
] as const;

async function rawAdmissionControls(
  input: Prepared,
  upload: (words: Uint32Array<ArrayBuffer>) => void,
  read: () => Promise<number[]>,
) {
  const rows = [];
  for (const control of canonicalRawAdmissionCases) {
    const words = input.projected.slice();
    words[16 + control.word] = control.bits;
    upload(words);
    rows.push({ ...control, values: await read() });
  }
  upload(input.projected);
  return rows;
}

/** Explicit layouts let the old coarse-only baseline and the clear-only sampler
 * consume exactly the same resources, including the new independent source facts. */
export async function canonicalSegmentPipeline(
  device: GPUDevice,
  code: string,
  phase?: (name: string) => void,
) {
  const segments = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 4, buffer: { type: 'storage' } },
    ],
  });
  const field = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
      {
        binding: 5,
        visibility: 4,
        texture: { sampleType: 'unfilterable-float', viewDimension: '3d' },
      },
      { binding: 6, visibility: 4, texture: { sampleType: 'uint', viewDimension: '2d' } },
    ],
  });
  phase?.('module-begin');
  const module = device.createShaderModule({ code });
  phase?.('module-return');
  phase?.('pipeline-call');
  const pending = device.createComputePipelineAsync({
    label: 'field canonical segment regression',
    layout: device.createPipelineLayout({ bindGroupLayouts: [segments, field] }),
    compute: { module, entryPoint: 'verifySegmentEndpoint' },
  });
  phase?.('pipeline-promise-return');
  const pipeline = await pending;
  phase?.('pipeline-ready');
  return pipeline;
}

export async function runCanonicalSegments(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  input: Prepared,
) {
  const owned: GPUBuffer[] = [];
  const buffer = (data: Uint8Array<ArrayBuffer>, usage: number) => {
    const value = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
    device.queue.writeBuffer(value, 0, data);
    owned.push(value);
    return value;
  };
  const size = input.grid.dimensions[0];
  const coarse = device.createTexture({
    size: [size, size, size],
    dimension: '3d',
    format: 'rg32float',
    usage: 4 | 2,
  });
  const canonical = device.createTexture({
    size: [input.plan.width, input.plan.height],
    format: 'rgba32uint',
    usage: 4 | 2,
  });
  try {
    const segments = buffer(new Uint8Array(input.pairs.buffer), 128);
    const output = buffer(new Uint8Array(input.cases.length * 4), 128 | 4);
    const field = buffer(input.fieldUniform, 64),
      settings = buffer(input.visibilityInputs, 64);
    const staging = device.createBuffer({ size: output.size, usage: 1 | 8 });
    owned.push(staging);
    const uploadCanonical = (words: Uint32Array<ArrayBuffer>) =>
      device.queue.writeTexture(
        { texture: canonical },
        words,
        { bytesPerRow: input.plan.width * 16, rowsPerImage: input.plan.height },
        [input.plan.width, input.plan.height],
      );
    uploadCanonical(input.projected);
    const groups = [
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: segments } },
          { binding: 1, resource: { buffer: output } },
        ],
      }),
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: field } },
          { binding: 4, resource: { buffer: settings } },
          { binding: 5, resource: coarse.createView() },
          { binding: 6, resource: canonical.createView() },
        ],
      }),
    ];
    const samples = input.samples.slice();
    const read = async () => {
      device.queue.writeTexture(
        { texture: coarse },
        samples,
        { bytesPerRow: size * 8, rowsPerImage: size },
        [size, size, size],
      );
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      groups.forEach((group, index) => {
        pass.setBindGroup(index, group);
      });
      pass.dispatchWorkgroups(input.cases.length);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(1);
      const bytes = staging.getMappedRange().slice(0);
      staging.unmap();
      return Array.from(new Float32Array(bytes));
    };
    const covered = await read();
    if (!input.rotated) {
      // Preserve the original unavailable endpoint footprint byte for byte.
      for (let z = 3; z <= 5; z++)
        for (let y = 4; y <= 5; y++)
          for (let x = 3; x <= 5; x++) samples[((z * size + y) * size + x) * 2 + 1] = -1;
    } else {
      for (const query of input.cases) {
        const cell = query.endpoint.map((v, axis) => {
          const origin = input.grid.origin[axis];
          if (origin === undefined)
            throw new Error('Authored endpoint needs exactly three coordinates');
          return Math.floor((v - origin) / input.grid.spacing);
        });
        for (let k = 0; k < 8; k++) {
          const x = (cell[0] ?? 0) + (k & 1),
            y = (cell[1] ?? 0) + ((k >> 1) & 1),
            z = (cell[2] ?? 0) + (k >> 2);
          if (x < 0 || x >= size || y < 0 || y >= size || z < 0 || z >= size)
            throw new Error('Authored endpoint footprint outside grid');
          samples[((z * size + y) * size + x) * 2 + 1] = -1;
        }
      }
    }
    const unavailable = await read();
    samples.set(input.samples);
    const admission = input.rotated ? [] : await rawAdmissionControls(input, uploadCanonical, read);
    return { covered, unavailable, cases: input.cases, admission };
  } finally {
    try {
      await device.queue.onSubmittedWorkDone();
    } finally {
      coarse.destroy();
      canonical.destroy();
      for (const value of owned) value.destroy();
    }
  }
}
