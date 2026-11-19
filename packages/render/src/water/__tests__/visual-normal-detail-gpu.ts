import { halfFloat } from '@forgeax/engine-math';
import { advancedFftShader } from '../advanced-fft-shader';

const SIZE = 64;
const TEXTURE_BINDING = 0x04;
const STORAGE_BINDING = 0x08;
const COPY_SRC = 0x01;
const TEXTURE_COPY_DST = 0x02;
const BUFFER_COPY_DST = 0x08;
const MAP_READ = 0x0001;
const STORAGE = 0x0080;
const MAP_MODE_READ = 0x0001;
const WORKGROUP_SIZE = 8;

type ProbeDefinition = Readonly<{
  name: string;
  spacingM: number;
  centerHeightM: number;
  deltaHeightXM: number;
  deltaHeightZM: number;
}>;

const PROBES: readonly ProbeDefinition[] = [
  {
    name: 'flat',
    spacingM: 1,
    centerHeightM: 0.375,
    deltaHeightXM: 0,
    deltaHeightZM: 0,
  },
  {
    name: 'positive-x-ramp',
    spacingM: 1,
    centerHeightM: 0.25,
    deltaHeightXM: 0.5,
    deltaHeightZM: 0,
  },
  {
    name: 'positive-z-ramp',
    spacingM: 1,
    centerHeightM: 0.25,
    deltaHeightXM: 0,
    deltaHeightZM: 0.75,
  },
  {
    name: 'small-spacing-ramp',
    spacingM: 1e-4,
    centerHeightM: 0,
    deltaHeightXM: 1e-4,
    deltaHeightZM: 0,
  },
  {
    name: 'near-zero-ramp',
    spacingM: 1e-4,
    centerHeightM: 0,
    deltaHeightXM: 1e-12,
    deltaHeightZM: 0,
  },
  {
    name: 'large-spacing-ramp',
    spacingM: 1e10,
    centerHeightM: 0,
    deltaHeightXM: 0.5,
    deltaHeightZM: 0,
  },
];

export type VisualNormalDetailProbe = Readonly<{
  name: string;
  format: 'rgba16float' | 'rgba32float';
  extent: Readonly<{ width: number; height: number }>;
  bytesPerRow: number;
  spacingM: number;
  centerHeightM: number;
  deltaHeightXM: number;
  deltaHeightZM: number;
  expected: readonly [number, number, number, number];
  actual: readonly [number, number, number, number];
  maxNormalError: number;
  heightError: number;
  rawBytes: Uint8Array;
}>;

export type VisualNormalDetailGpuEvidence = Readonly<{
  schemaVersion: 1;
  shaderEntryPoint: 'publishVisualNormalDetail';
  adapter: Readonly<{
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    fallback: boolean | null;
    maxTextureDimension2D: number;
  }>;
  validationErrors: readonly string[];
  uncapturedErrors: readonly string[];
  probes: readonly VisualNormalDetailProbe[];
}>;

export type VisualNormalDetailGpuEvidenceJson = Omit<VisualNormalDetailGpuEvidence, 'probes'> &
  Readonly<{
    probes: readonly (Omit<VisualNormalDetailProbe, 'rawBytes'> &
      Readonly<{ rawBytesBase64: string; rawBytesLength: number }>)[];
  }>;

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function expectedNormal(probe: ProbeDefinition): readonly [number, number, number] {
  const x = -probe.deltaHeightXM;
  const y = probe.spacingM;
  const z = -probe.deltaHeightZM;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

function inputGrid(probe: ProbeDefinition): Float32Array {
  const data = new Float32Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const height = probe.centerHeightM + x * probe.deltaHeightXM + y * probe.deltaHeightZM;
      data.set([height, 0, 0, 0], (y * SIZE + x) * 4);
    }
  }
  return data;
}

function targetPixel(
  format: 'rgba16float' | 'rgba32float',
  bytes: Uint8Array,
): readonly [number, number, number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === 'rgba32float') {
    return [0, 1, 2, 3].map((channel) => view.getFloat32(channel * 4, true)) as [
      number,
      number,
      number,
      number,
    ];
  }
  return [0, 1, 2, 3].map((channel) => halfFloat.f16ToF32(view.getUint16(channel * 2, true))) as [
    number,
    number,
    number,
    number,
  ];
}

export async function runVisualNormalDetailPublishGpuProbes(): Promise<VisualNormalDetailGpuEvidence> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === null) throw new Error('WebGPU adapter unavailable for visual FFT probe');
  const device = await adapter.requestDevice();
  const uncapturedErrors: string[] = [];
  const validationErrors: string[] = [];
  device.addEventListener('uncapturederror', (event) => {
    uncapturedErrors.push((event as GPUUncapturedErrorEvent).error.message);
  });

  const adapterInfo = adapter.info;
  const fallback = (adapter as GPUAdapter & { readonly isFallbackAdapter?: boolean })
    .isFallbackAdapter;
  const probes: VisualNormalDetailProbe[] = [];
  let operation = 'create production shader pipeline';
  try {
    for (const format of ['rgba16float', 'rgba32float'] as const) {
      operation = `compile ${format} production shader pipeline`;
      device.pushErrorScope('validation');
      const module = device.createShaderModule({ code: advancedFftShader(format) });
      const compilation = await module.getCompilationInfo();
      const compilationErrors = compilation.messages
        .filter((message) => message.type === 'error')
        .map((message) => message.message);
      if (compilationErrors.length > 0) {
        validationErrors.push(...compilationErrors);
        throw new Error(
          `visual FFT ${format} shader compilation failed: ${compilationErrors.join('; ')}`,
        );
      }
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'publishVisualNormalDetail' },
      });

      for (const probe of PROBES) {
        operation = `${format}/${probe.name} create input texture`;
        const input = device.createTexture({
          size: [SIZE, SIZE],
          format: 'rgba32float',
          usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
        });
        operation = `${format}/${probe.name} create output texture`;
        const output = device.createTexture({
          size: [SIZE, SIZE],
          format,
          usage: STORAGE_BINDING | COPY_SRC,
        });
        operation = `${format}/${probe.name} create parameter buffer`;
        const parameters = device.createBuffer({ size: 192, usage: STORAGE | BUFFER_COPY_DST });
        const pixelBytes = format === 'rgba32float' ? 16 : 8;
        const bytesPerRow = Math.ceil((SIZE * pixelBytes) / 256) * 256;
        const readback = device.createBuffer({
          size: bytesPerRow * SIZE,
          usage: MAP_READ | BUFFER_COPY_DST,
        });
        try {
          operation = `${format}/${probe.name} upload input grid and parameters`;
          const values = new Float32Array(48);
          values[0] = SIZE;
          values[11] = SIZE * probe.spacingM;
          device.queue.writeTexture(
            { texture: input },
            inputGrid(probe),
            { bytesPerRow: SIZE * 16, rowsPerImage: SIZE },
            { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
          );
          device.queue.writeBuffer(parameters, 0, values);

          operation = `${format}/${probe.name} create bind group`;
          const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: input.createView() },
              { binding: 2, resource: { buffer: parameters } },
              { binding: 7, resource: output.createView() },
            ],
          });
          operation = `${format}/${probe.name} encode and submit compute dispatch`;
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(
            Math.ceil(SIZE / WORKGROUP_SIZE),
            Math.ceil(SIZE / WORKGROUP_SIZE),
          );
          pass.end();
          encoder.copyTextureToBuffer(
            { texture: output },
            { buffer: readback, bytesPerRow, rowsPerImage: SIZE },
            { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
          );
          device.queue.submit([encoder.finish()]);
          await device.queue.onSubmittedWorkDone();
          operation = `${format}/${probe.name} map GPU readback`;
          await readback.mapAsync(MAP_MODE_READ);
          const rawBytes = new Uint8Array(readback.getMappedRange().slice(0));
          readback.unmap();

          const actual = targetPixel(format, rawBytes);
          const expectedNormalValue = expectedNormal(probe);
          const expected = [
            expectedNormalValue[0],
            expectedNormalValue[1],
            expectedNormalValue[2],
            probe.centerHeightM,
          ] as const;
          probes.push({
            name: probe.name,
            format,
            extent: { width: SIZE, height: SIZE },
            bytesPerRow,
            spacingM: probe.spacingM,
            centerHeightM: probe.centerHeightM,
            deltaHeightXM: probe.deltaHeightXM,
            deltaHeightZM: probe.deltaHeightZM,
            expected,
            actual,
            maxNormalError: Math.max(
              Math.abs(actual[0] - expected[0]),
              Math.abs(actual[1] - expected[1]),
              Math.abs(actual[2] - expected[2]),
            ),
            heightError: Math.abs(actual[3] - expected[3]),
            rawBytes,
          });
        } finally {
          input.destroy();
          output.destroy();
          parameters.destroy();
          readback.destroy();
        }
      }
      const validationError = await device.popErrorScope();
      if (validationError !== null) validationErrors.push(validationError.message);
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${operation}: ${detail}`, { cause });
  } finally {
    device.destroy();
  }

  return {
    schemaVersion: 1,
    shaderEntryPoint: 'publishVisualNormalDetail',
    adapter: {
      vendor: adapterInfo.vendor,
      architecture: adapterInfo.architecture,
      device: adapterInfo.device,
      description: adapterInfo.description,
      fallback: fallback ?? null,
      maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
    },
    validationErrors,
    uncapturedErrors,
    probes,
  };
}

export function visualNormalDetailGpuEvidenceJson(
  evidence: VisualNormalDetailGpuEvidence,
): VisualNormalDetailGpuEvidenceJson {
  return {
    schemaVersion: evidence.schemaVersion,
    shaderEntryPoint: evidence.shaderEntryPoint,
    adapter: evidence.adapter,
    validationErrors: evidence.validationErrors,
    uncapturedErrors: evidence.uncapturedErrors,
    probes: evidence.probes.map(({ rawBytes, ...probe }) => ({
      ...probe,
      rawBytesBase64: encodeBase64(rawBytes),
      rawBytesLength: rawBytes.byteLength,
    })),
  };
}
