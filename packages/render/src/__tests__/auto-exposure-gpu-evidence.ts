import type { RhiCaps } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { AUTO_EXPOSURE_METER_WGSL } from '@forgeax/engine-shader';
import { createAutoExposureGraphPlan } from '../pipeline/standard-output/auto-exposure/graph';
import {
  adaptExposure,
  autoExposureTarget,
  weightedLuminanceHistogram,
} from '../pipeline/standard-output/auto-exposure/oracle';

const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_SRC = 0x0004;
const BUFFER_USAGE_COPY_DST = 0x0008;
const BUFFER_USAGE_STORAGE = 0x0080;
const TEXTURE_USAGE_COPY_DST = 0x0002;
const TEXTURE_USAGE_TEXTURE_BINDING = 0x0004;

export const AUTO_EXPOSURE_GPU_FIXTURE_ID = 'auto-exposure-uniform-outlier-v1';
export const AUTO_EXPOSURE_GPU_RESOLUTION = Object.freeze({ width: 9, height: 9 });

const FIXTURE_EDGE_VALUE = 1;
const FIXTURE_CENTER_VALUE = 64 / 255;
const FIXTURE_BASE_VALUE = 32 / 255;

/** The nine 4x4-block samples used by the real readback equivalence gate. */
export const AUTO_EXPOSURE_GPU_SAMPLED_PIXELS = Object.freeze(
  Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 3 }, (_, column) => {
      const value =
        row === 0 && column === 0
          ? FIXTURE_EDGE_VALUE
          : row === 1 && column === 1
            ? FIXTURE_CENTER_VALUE
            : FIXTURE_BASE_VALUE;
      return [value, value, value, 1] as const;
    }),
  ).flat(),
);

export const AUTO_EXPOSURE_GPU_ORACLE_HISTOGRAM = Object.freeze([
  ...weightedLuminanceHistogram(AUTO_EXPOSURE_GPU_SAMPLED_PIXELS, [3, 3]),
]);

/** CPU oracle for the decoded first lane of the same-frame GPU candidate. */
export const AUTO_EXPOSURE_GPU_EXPECTED_CANDIDATE = adaptExposure(
  1,
  autoExposureTarget(new Uint32Array(AUTO_EXPOSURE_GPU_ORACLE_HISTOGRAM), 0, [-8, 8], 1),
  1 / 60,
  3,
  1,
);

export interface AutoExposureGpuEvidence {
  readonly fixtureId: typeof AUTO_EXPOSURE_GPU_FIXTURE_ID;
  readonly backend: RhiCaps['backendKind'] | 'unavailable';
  readonly runner: 'browser-vitest' | 'dawn-node';
  readonly resolution: typeof AUTO_EXPOSURE_GPU_RESOLUTION;
  readonly status: 'available' | 'unavailable' | 'missing-auto-exposure-graph';
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly graph: {
    readonly passes: readonly string[];
    readonly physicalPass: string;
    readonly physicalPassCount: number;
    readonly resources: readonly string[];
  };
  /** Raw state bytes prove the previous-state slot was initialized and advanced. */
  readonly stateReadback: readonly number[];
  /** Decoded candidate vector; the first lane is the same-frame exposure value. */
  readonly candidateValues: readonly number[];
  /** Raw 256-bin histogram readback used for CPU-oracle equivalence. */
  readonly histogramReadback: readonly number[];
  readonly readback: readonly number[];
}

function unavailable(runner: AutoExposureGpuEvidence['runner']): AutoExposureGpuEvidence {
  return {
    fixtureId: AUTO_EXPOSURE_GPU_FIXTURE_ID,
    backend: 'unavailable',
    runner,
    resolution: AUTO_EXPOSURE_GPU_RESOLUTION,
    status: 'unavailable',
    graph: { passes: [], physicalPass: '', physicalPassCount: 0, resources: [] },
    stateReadback: [],
    candidateValues: [],
    histogramReadback: [],
    readback: [],
  };
}

/**
 * Exercise the real adapter/device and a real GPU buffer copy before checking
 * the feature-specific graph. The same helper is used by Browser and Dawn so
 * backend identity and raw readback remain comparable.
 */
export async function runAutoExposureGpuEvidence(
  runner: AutoExposureGpuEvidence['runner'],
): Promise<AutoExposureGpuEvidence> {
  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) return unavailable(runner);
  const deviceResult = await adapterResult.value.requestDevice();
  if (!deviceResult.ok) return unavailable(runner);

  const device = deviceResult.value;
  const plan = createAutoExposureGraphPlan(AUTO_EXPOSURE_GPU_RESOLUTION);
  const source = device
    .createTexture({
      label: `${AUTO_EXPOSURE_GPU_FIXTURE_ID}.source`,
      size: {
        width: AUTO_EXPOSURE_GPU_RESOLUTION.width,
        height: AUTO_EXPOSURE_GPU_RESOLUTION.height,
        depthOrArrayLayers: 1,
      },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
      textureBindingViewDimension: undefined,
    })
    .unwrap();
  const sourceView = device.createTextureView(source, {}).unwrap();
  const pixels = new Uint8Array(256 * AUTO_EXPOSURE_GPU_RESOLUTION.height);
  for (let row = 0; row < AUTO_EXPOSURE_GPU_RESOLUTION.height; row += 1) {
    for (let column = 0; column < AUTO_EXPOSURE_GPU_RESOLUTION.width; column += 1) {
      const offset = row * 256 + column * 4;
      const edge = row === 2 && column === 2;
      const center = row === 6 && column === 6;
      const value = edge ? 255 : center ? 64 : 32;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  device.queue
    .writeTexture(
      { texture: source, mipLevel: 0, origin: [0, 0, 0] },
      pixels,
      {
        offset: 0,
        bytesPerRow: 256,
        rowsPerImage: AUTO_EXPOSURE_GPU_RESOLUTION.height,
      },
      {
        width: AUTO_EXPOSURE_GPU_RESOLUTION.width,
        height: AUTO_EXPOSURE_GPU_RESOLUTION.height,
        depthOrArrayLayers: 1,
      },
    )
    .unwrap();
  const histogram = device
    .createBuffer({
      label: `${AUTO_EXPOSURE_GPU_FIXTURE_ID}.histogram`,
      size: plan.histogramBytes,
      usage: BUFFER_USAGE_STORAGE | BUFFER_USAGE_COPY_SRC,
    })
    .unwrap();
  const state = device
    .createBuffer({
      label: `${AUTO_EXPOSURE_GPU_FIXTURE_ID}.state`,
      size: plan.stateBytes,
      usage: BUFFER_USAGE_STORAGE | BUFFER_USAGE_COPY_DST | BUFFER_USAGE_COPY_SRC,
    })
    .unwrap();
  const candidate = device
    .createBuffer({
      label: `${AUTO_EXPOSURE_GPU_FIXTURE_ID}.candidate`,
      size: 16,
      usage: BUFFER_USAGE_STORAGE | BUFFER_USAGE_COPY_SRC,
    })
    .unwrap();
  const parameters = device
    .createBuffer({
      label: `${AUTO_EXPOSURE_GPU_FIXTURE_ID}.parameters`,
      size: 32,
      usage: BUFFER_USAGE_STORAGE | BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const readback = device
    .createBuffer({
      label: `${AUTO_EXPOSURE_GPU_FIXTURE_ID}.readback`,
      size: plan.histogramBytes + plan.stateBytes + 16,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  device.queue.writeBuffer(state, 0, new Uint8Array(plan.stateBytes)).unwrap();
  device.queue
    .writeBuffer(parameters, 0, new Float32Array([0, -8, 8, 3, 1, 1 / 60, 1, 1]))
    .unwrap();
  const meterModule = await createShaderModule(device, {
    label: `${AUTO_EXPOSURE_GPU_FIXTURE_ID}.meter`,
    code: AUTO_EXPOSURE_METER_WGSL,
  });
  if (!meterModule.ok) return unavailable(runner);
  const meterLayout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: 4, buffer: { type: 'storage' } },
        { binding: 2, visibility: 4, buffer: { type: 'storage' } },
        { binding: 3, visibility: 4, buffer: { type: 'storage' } },
        { binding: 4, visibility: 4, buffer: { type: 'read-only-storage' } },
      ],
    })
    .unwrap();
  const meterPipelineLayout = device
    .createPipelineLayout({ bindGroupLayouts: [meterLayout] })
    .unwrap();
  const clearPipeline = device
    .createComputePipeline({
      layout: meterPipelineLayout,
      compute: { module: meterModule.value, entryPoint: 'auto_exposure_clear' },
    })
    .unwrap();
  const histogramPipeline = device
    .createComputePipeline({
      layout: meterPipelineLayout,
      compute: { module: meterModule.value, entryPoint: 'auto_exposure_histogram' },
    })
    .unwrap();
  const adaptPipeline = device
    .createComputePipeline({
      layout: meterPipelineLayout,
      compute: { module: meterModule.value, entryPoint: 'auto_exposure_adapt' },
    })
    .unwrap();
  const meterBindGroup = device
    .createBindGroup({
      layout: meterLayout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: sourceView } },
        { binding: 1, resource: { kind: 'buffer', value: { buffer: histogram } } },
        { binding: 2, resource: { kind: 'buffer', value: { buffer: state } } },
        { binding: 3, resource: { kind: 'buffer', value: { buffer: candidate } } },
        { binding: 4, resource: { kind: 'buffer', value: { buffer: parameters } } },
      ],
    })
    .unwrap();
  const encoder = device.createCommandEncoder({ label: AUTO_EXPOSURE_GPU_FIXTURE_ID }).unwrap();
  const meterPass = encoder.beginComputePass({ label: plan.physicalPass });
  meterPass.setBindGroup(0, meterBindGroup);
  meterPass.setPipeline(clearPipeline);
  meterPass.dispatchWorkgroups(1, 1, 1);
  meterPass.setPipeline(histogramPipeline);
  meterPass.dispatchWorkgroups(plan.dispatch.x, plan.dispatch.y, plan.dispatch.z);
  meterPass.setPipeline(adaptPipeline);
  meterPass.dispatchWorkgroups(1, 1, 1);
  meterPass.end();
  encoder.copyBufferToBuffer(histogram, 0, readback, 0, plan.histogramBytes);
  encoder.copyBufferToBuffer(state, 0, readback, plan.histogramBytes, plan.stateBytes);
  encoder.copyBufferToBuffer(candidate, 0, readback, plan.histogramBytes + plan.stateBytes, 16);
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const mapped = (await readback.mapAsync(BUFFER_USAGE_MAP_READ)).unwrap();
  const mappedBytes = mapped.getMappedRange().unwrap();
  const histogramBytes = new Uint8Array(mappedBytes.slice(0, plan.histogramBytes));
  const stateBytes = new Uint8Array(
    mappedBytes.slice(plan.histogramBytes, plan.histogramBytes + plan.stateBytes),
  );
  const rawReadback = new Uint8Array(
    mappedBytes.slice(
      plan.histogramBytes + plan.stateBytes,
      plan.histogramBytes + plan.stateBytes + 16,
    ),
  );
  const histogramReadback = [...new Uint32Array(histogramBytes.buffer.slice(0))];
  const candidateValues = [...new Float32Array(rawReadback.buffer.slice(0))];
  mapped.unmap();
  device.destroyTexture(source).unwrap();
  device.destroyBuffer(histogram).unwrap();
  device.destroyBuffer(state).unwrap();
  device.destroyBuffer(candidate).unwrap();
  device.destroyBuffer(parameters).unwrap();
  device.destroyBuffer(readback).unwrap();

  return {
    fixtureId: AUTO_EXPOSURE_GPU_FIXTURE_ID,
    backend: device.caps.backendKind,
    runner,
    resolution: AUTO_EXPOSURE_GPU_RESOLUTION,
    status: 'available',
    capabilities: { ...device.caps },
    graph: {
      passes: [...plan.passes.map((pass) => pass.name)],
      physicalPass: plan.physicalPass,
      physicalPassCount: plan.physicalPassCount,
      resources: [...plan.resources],
    },
    stateReadback: [...stateBytes],
    candidateValues,
    histogramReadback,
    readback: [...rawReadback],
  };
}
