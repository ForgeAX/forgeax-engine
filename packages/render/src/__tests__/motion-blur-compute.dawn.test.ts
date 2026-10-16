import { expect, it } from 'vitest';
import { MOTION_BLUR_COMPUTE_WGSL } from '../features/motion-blur/motion-blur-feature';

// The ordinary render project intentionally does not install browser WebGPU
// globals. Keep this maintained Dawn assertion portable across the `render`
// and `dawn` Vitest projects by using the WebGPU spec's stable bit values.
const COMPUTE_STAGE = 0x4;
const TEXTURE_COPY_SRC = 0x1;
const TEXTURE_COPY_DST = 0x2;
const TEXTURE_BINDING = 0x4;
const STORAGE_BINDING = 0x8;
const BUFFER_MAP_READ = 0x1;
const BUFFER_COPY_DST = 0x8;
const BUFFER_UNIFORM = 0x40;
const BUFFER_STORAGE = 0x80;

type MotionBlurProbe = {
  readonly name: string;
  readonly motionHalf: number;
  readonly motionHalfY?: number;
  readonly maxRadius: number;
  readonly receiverX: number;
  readonly receiverY?: number;
  readonly width: number;
  readonly height: number;
  readonly moverStart: number;
  readonly moverEnd: number;
  readonly moverYStart?: number;
  readonly moverYEnd?: number;
  readonly expectNonZero?: boolean;
  readonly sampleCount?: number;
  readonly expectedRowEnergy?: number;
  readonly expectedTotalEnergy?: number;
  readonly energyTolerance?: number;
};

const PROBES: readonly MotionBlurProbe[] = [
  {
    name: 'short vector reaches a static receiver beside the mover',
    motionHalf: 0x3400,
    maxRadius: 32,
    receiverX: 30,
    width: 65,
    height: 16,
    moverStart: 32,
    moverEnd: 35,
  },
  {
    name: 'long vector reaches a static receiver through an adjacent tile',
    motionHalf: 0x3c00,
    maxRadius: 64,
    receiverX: 30,
    width: 64,
    height: 16,
    moverStart: 32,
    moverEnd: 35,
  },
  {
    name: 'long vector reaches a static receiver at the support boundary tile',
    motionHalf: 0x4000,
    maxRadius: 64,
    receiverX: 30,
    width: 128,
    height: 16,
    moverStart: 86,
    moverEnd: 89,
  },
  {
    name: 'cap32 derives the positive offset-plus-two tile',
    motionHalf: 0x4400,
    maxRadius: 32,
    receiverX: 30,
    width: 64,
    height: 16,
    // The seven support taps reserve one receiver slot. For radius32 the
    // +18.3 pixel tap lands in this tile-3 strip, exercising the +2 tile
    // summary walk without relying on a hand-picked unreachable pixel.
    moverStart: 48,
    moverEnd: 51,
  },
  {
    name: 'cap64 derives the positive offset-plus-two tile',
    motionHalf: 0x4400,
    maxRadius: 64,
    receiverX: 30,
    width: 64,
    height: 16,
    // For radius64 the bounded +18.3 pixel tap also lands in tile 3.
    moverStart: 48,
    moverEnd: 51,
  },
  {
    name: 'cap32 derives the positive diagonal offset-plus-two tile',
    motionHalf: 0x4400,
    motionHalfY: 0x4400,
    maxRadius: 32,
    receiverX: 14,
    receiverY: 14,
    width: 64,
    height: 64,
    // The capped +45 degree support tap lands at (32,32), in tile (2,2), which is
    // the diagonal +2 candidate from receiver tile (0,0).
    moverStart: 32,
    moverEnd: 35,
    moverYStart: 32,
    moverYEnd: 35,
  },
  {
    name: 'diagonal card conserves total energy at 4 taps',
    motionHalf: 0x4000,
    motionHalfY: 0x4000,
    maxRadius: 32,
    receiverX: 0,
    receiverY: 0,
    width: 64,
    height: 64,
    moverStart: 30,
    moverEnd: 33,
    moverYStart: 30,
    moverYEnd: 33,
    expectNonZero: false,
    sampleCount: 4,
    expectedTotalEnergy: 16,
  },
  {
    name: 'diagonal card conserves total energy at 8 taps',
    motionHalf: 0x4000,
    motionHalfY: 0x4000,
    maxRadius: 32,
    receiverX: 0,
    receiverY: 0,
    width: 64,
    height: 64,
    moverStart: 30,
    moverEnd: 33,
    moverYStart: 30,
    moverYEnd: 33,
    expectNonZero: false,
    sampleCount: 8,
    expectedTotalEnergy: 16,
  },
  {
    name: 'diagonal card conserves total energy at 16 taps',
    motionHalf: 0x4000,
    motionHalfY: 0x4000,
    maxRadius: 32,
    receiverX: 0,
    receiverY: 0,
    width: 64,
    height: 64,
    moverStart: 30,
    moverEnd: 33,
    moverYStart: 30,
    moverYEnd: 33,
    expectNonZero: false,
    sampleCount: 16,
    expectedTotalEnergy: 16,
  },
  {
    name: 'horizontal card conserves total energy on a square canvas',
    motionHalf: 0x4000,
    maxRadius: 32,
    receiverX: 0,
    receiverY: 0,
    width: 128,
    height: 128,
    moverStart: 62,
    moverEnd: 65,
    moverYStart: 62,
    moverYEnd: 65,
    expectNonZero: false,
    sampleCount: 8,
    expectedTotalEnergy: 16,
  },
  {
    name: 'vertical card conserves total energy on a square canvas',
    motionHalf: 0,
    motionHalfY: 0x4000,
    maxRadius: 32,
    receiverX: 0,
    receiverY: 0,
    width: 128,
    height: 128,
    moverStart: 62,
    moverEnd: 65,
    moverYStart: 62,
    moverYEnd: 65,
    expectNonZero: false,
    sampleCount: 8,
    expectedTotalEnergy: 16,
  },
  {
    name: 'cap64 derives the negative offset-plus-one tile',
    motionHalf: 0xc000,
    maxRadius: 64,
    receiverX: 110,
    width: 128,
    height: 16,
    moverStart: 91,
    moverEnd: 94,
  },
  {
    name: 'cap32 rejects a tile outside the support boundary',
    motionHalf: 0x4000,
    maxRadius: 32,
    receiverX: 30,
    width: 128,
    height: 16,
    moverStart: 102,
    moverEnd: 105,
    expectNonZero: false,
  },
  {
    name: 'long vector preserves energy at half-cell translation 0',
    motionHalf: 0x4000,
    maxRadius: 32,
    receiverX: 30,
    width: 128,
    height: 16,
    moverStart: 62,
    moverEnd: 65,
    expectNonZero: false,
    expectedRowEnergy: 4,
  },
  {
    name: 'long vector preserves energy at half-cell translation 1',
    motionHalf: 0x4000,
    maxRadius: 32,
    receiverX: 30,
    width: 128,
    height: 16,
    moverStart: 63,
    moverEnd: 66,
    expectNonZero: false,
    expectedRowEnergy: 4,
  },
  {
    name: 'long vector preserves energy at half-cell translation 2',
    motionHalf: 0x4000,
    maxRadius: 32,
    receiverX: 30,
    width: 128,
    height: 16,
    moverStart: 64,
    moverEnd: 67,
    expectNonZero: false,
    expectedRowEnergy: 4,
  },
  {
    name: 'long vector preserves energy at half-cell translation 3',
    motionHalf: 0x4000,
    maxRadius: 32,
    receiverX: 30,
    width: 128,
    height: 16,
    moverStart: 65,
    moverEnd: 68,
    expectNonZero: false,
    expectedRowEnergy: 4,
  },
  {
    name: 'long vector preserves energy at half-cell translation 4',
    motionHalf: 0x4000,
    maxRadius: 32,
    receiverX: 30,
    width: 128,
    height: 16,
    moverStart: 66,
    moverEnd: 69,
    expectNonZero: false,
    expectedRowEnergy: 4,
  },
  {
    name: 'cap64 sparse source closes the bounded midpoint gap at 4 taps',
    motionHalf: 0x4000,
    maxRadius: 64,
    receiverX: 30,
    width: 128,
    height: 16,
    moverStart: 54,
    moverEnd: 57,
    sampleCount: 4,
  },
  {
    name: 'cap64 sparse source preserves row energy at 8 taps',
    motionHalf: 0x4000,
    maxRadius: 64,
    receiverX: 30,
    width: 128,
    height: 16,
    moverStart: 54,
    moverEnd: 57,
    sampleCount: 8,
    expectedRowEnergy: 4,
  },
  {
    name: 'cap64 sparse source remains reachable at 16 taps',
    motionHalf: 0x4000,
    maxRadius: 64,
    receiverX: 30,
    width: 128,
    height: 16,
    moverStart: 54,
    moverEnd: 57,
    sampleCount: 16,
  },
  {
    name: 'cap64 full support conserves energy at 4 taps',
    motionHalf: 0x4000,
    maxRadius: 64,
    receiverX: 30,
    width: 256,
    height: 16,
    moverStart: 126,
    moverEnd: 129,
    expectNonZero: false,
    sampleCount: 4,
    expectedRowEnergy: 4,
  },
  {
    name: 'cap64 full support conserves energy at 8 taps',
    motionHalf: 0x4000,
    maxRadius: 64,
    receiverX: 30,
    width: 256,
    height: 16,
    moverStart: 126,
    moverEnd: 129,
    expectNonZero: false,
    sampleCount: 8,
    expectedRowEnergy: 4,
  },
  {
    name: 'cap64 full support conserves energy at 16 taps',
    motionHalf: 0x4000,
    maxRadius: 64,
    receiverX: 30,
    width: 256,
    height: 16,
    moverStart: 126,
    moverEnd: 129,
    expectNonZero: false,
    sampleCount: 16,
    expectedRowEnergy: 4,
  },
  {
    name: 'cap64 full support keeps translated phase energy',
    motionHalf: 0x4000,
    maxRadius: 64,
    receiverX: 30,
    width: 256,
    height: 16,
    moverStart: 127,
    moverEnd: 130,
    expectNonZero: false,
    sampleCount: 8,
    expectedRowEnergy: 4,
  },
  {
    name: 'cap64 full support keeps reverse motion energy',
    motionHalf: 0xc000,
    maxRadius: 64,
    receiverX: 94,
    width: 256,
    height: 16,
    moverStart: 126,
    moverEnd: 129,
    sampleCount: 8,
    expectedRowEnergy: 4,
  },
  {
    name: 'cap64 translated sparse source stays reachable in view',
    motionHalf: 0x4000,
    maxRadius: 64,
    receiverX: 94,
    width: 256,
    height: 16,
    moverStart: 118,
    moverEnd: 121,
    sampleCount: 8,
    expectedRowEnergy: 4,
  },
];

const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

it.each(PROBES)('production compute lane: $name', async ({
  name,
  motionHalf,
  maxRadius,
  receiverX,
  receiverY = 8,
  width,
  height,
  moverStart,
  moverEnd,
  moverYStart = 0,
  moverYEnd = height - 1,
  motionHalfY = 0,
  expectNonZero = true,
  sampleCount = 8,
  expectedRowEnergy,
  expectedTotalEnergy,
  energyTolerance = 0.03,
}) => {
  const adapter = await globalThis.navigator.gpu.requestAdapter();
  if (adapter === null)
    throw new Error('Dawn adapter unavailable for Motion Blur production probe');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: MOTION_BLUR_COMPUTE_WGSL });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter((message) => message.type === 'error');
  expect(errors, errors.map((message) => message.message).join('\n')).toHaveLength(0);

  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: COMPUTE_STAGE, texture: { sampleType: 'float' } },
      { binding: 1, visibility: COMPUTE_STAGE, texture: { sampleType: 'float' } },
      { binding: 2, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
      {
        binding: 3,
        visibility: COMPUTE_STAGE,
        storageTexture: { access: 'write-only', format: 'rgba16float' },
      },
      { binding: 4, visibility: COMPUTE_STAGE, buffer: { type: 'uniform' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const summary = device.createComputePipeline({
    layout: pipelineLayout,
    compute: { module, entryPoint: 'tile_summary' },
  });
  const reconstruct = device.createComputePipeline({
    layout: pipelineLayout,
    compute: { module, entryPoint: 'reconstruct' },
  });

  const texture = (usage: number) =>
    device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'rgba16float',
      usage,
    });
  const color = texture(TEXTURE_BINDING | TEXTURE_COPY_DST);
  const temporal = texture(TEXTURE_BINDING | TEXTURE_COPY_DST);
  const output = texture(STORAGE_BINDING | TEXTURE_COPY_SRC);
  const colorData = new Uint16Array(width * height * 4);
  const temporalData = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const mover = x >= moverStart && x <= moverEnd && y >= moverYStart && y <= moverYEnd;
      colorData[index] = mover ? 0x3c00 : 0;
      colorData[index + 1] = mover ? 0x3c00 : 0;
      colorData[index + 2] = mover ? 0x3c00 : 0;
      colorData[index + 3] = 0x3c00;
      temporalData[index] = mover ? motionHalf : 0;
      temporalData[index + 1] = mover ? motionHalfY : 0;
      temporalData[index + 2] = mover ? 0x4000 : 0x4400;
    }
  }
  device.queue.writeTexture(
    { texture: color },
    colorData,
    { bytesPerRow: width * 8, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.writeTexture(
    { texture: temporal },
    temporalData,
    { bytesPerRow: width * 8, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  const tileSummary = device.createBuffer({
    size: Math.ceil(width / 16) * Math.ceil(height / 16) * 32,
    usage: BUFFER_STORAGE,
  });
  const params = device.createBuffer({
    size: 32,
    usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
  });
  const paramsData = new ArrayBuffer(32);
  const paramsView = new DataView(paramsData);
  paramsView.setFloat32(0, 180, true);
  paramsView.setFloat32(4, maxRadius, true);
  paramsView.setUint32(8, sampleCount, true);
  paramsView.setFloat32(16, 60, true);
  paramsView.setFloat32(20, 1, true);
  paramsView.setFloat32(24, 1 / 60, true);
  device.queue.writeBuffer(params, 0, paramsData);
  const bindGroup = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: color.createView() },
      { binding: 1, resource: temporal.createView() },
      { binding: 2, resource: { buffer: tileSummary } },
      { binding: 3, resource: output.createView() },
      { binding: 4, resource: { buffer: params } },
    ],
  });
  const readback = device.createBuffer({
    size:
      Math.ceil((width * 8) / COPY_BYTES_PER_ROW_ALIGNMENT) * COPY_BYTES_PER_ROW_ALIGNMENT * height,
    usage: BUFFER_COPY_DST | BUFFER_MAP_READ,
  });
  const readbackBytesPerRow =
    Math.ceil((width * 8) / COPY_BYTES_PER_ROW_ALIGNMENT) * COPY_BYTES_PER_ROW_ALIGNMENT;
  try {
    const encoder = device.createCommandEncoder();
    const summaryPass = encoder.beginComputePass();
    summaryPass.setPipeline(summary);
    summaryPass.setBindGroup(0, bindGroup);
    summaryPass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    summaryPass.end();
    const reconstructPass = encoder.beginComputePass();
    reconstructPass.setPipeline(reconstruct);
    reconstructPass.setBindGroup(0, bindGroup);
    reconstructPass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    reconstructPass.end();
    encoder.copyTextureToBuffer(
      { texture: output },
      { buffer: readback, bytesPerRow: readbackBytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const validationError = await device.popErrorScope();
    expect(validationError, `${name} emitted a Dawn validation error`).toBeNull();
    await readback.mapAsync(BUFFER_MAP_READ);
    const result = new Uint16Array(readback.getMappedRange());
    const receiver = result[receiverY * (readbackBytesPerRow / 2) + receiverX * 4];
    if (expectNonZero) {
      expect(
        receiver,
        `${name} output was black at receiver (${receiverX},${receiverY})`,
      ).toBeGreaterThan(0);
    } else {
      expect(receiver, `${name} outside-support receiver unexpectedly received motion`).toBe(0);
    }
    const decodeFloat16 = (bits: number | undefined): number => {
      if (bits === undefined) throw new Error('Readback omitted a required pixel');
      const sign = (bits & 0x8000) === 0 ? 1 : -1;
      const exponent = (bits >>> 10) & 0x1f;
      const mantissa = bits & 0x03ff;
      if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
      if (exponent === 0x1f) return Number.POSITIVE_INFINITY;
      return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
    };
    if (expectedRowEnergy !== undefined) {
      const rowEnergy = Array.from({ length: width }, (_, x) => {
        const bits = result[receiverY * (readbackBytesPerRow / 2) + x * 4];
        if (bits === undefined) throw new Error(`${name} row readback is truncated at x=${x}`);
        return decodeFloat16(bits);
      }).reduce((sum, value) => sum + value, 0);
      const relativeError =
        Math.abs(rowEnergy - expectedRowEnergy) / Math.max(expectedRowEnergy, 1);
      expect(
        relativeError,
        `${name} row energy ${rowEnergy} differs from ${expectedRowEnergy}`,
      ).toBeLessThanOrEqual(energyTolerance);
    }
    if (expectedTotalEnergy !== undefined) {
      const totalEnergy = Array.from({ length: height }, (_, y) =>
        Array.from({ length: width }, (_, x) => {
          const bits = result[y * (readbackBytesPerRow / 2) + x * 4];
          if (bits === undefined)
            throw new Error(`${name} total readback is truncated at y=${y}, x=${x}`);
          return decodeFloat16(bits);
        }).reduce((sum, value) => sum + value, 0),
      ).reduce((sum, value) => sum + value, 0);
      const relativeError =
        Math.abs(totalEnergy - expectedTotalEnergy) / Math.max(expectedTotalEnergy, 1);
      expect(
        relativeError,
        `${name} total energy ${totalEnergy} differs from ${expectedTotalEnergy}`,
      ).toBeLessThanOrEqual(energyTolerance);
    }
    readback.unmap();
  } finally {
    readback.destroy();
    tileSummary.destroy();
    params.destroy();
    color.destroy();
    temporal.destroy();
    output.destroy();
    device.destroy();
  }
});
