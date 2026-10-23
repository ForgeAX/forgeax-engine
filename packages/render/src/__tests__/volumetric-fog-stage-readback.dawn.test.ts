import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  RhiCommandEncoder,
  RhiDevice,
  Sampler,
  ShaderModule,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { describe, expect, it } from 'vitest';
import { BYTES_PER_DIRECT_LIGHT_SLOT } from '../light-buffer-layout';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import { MAX_VOLUMETRIC_FOG_OWNERS } from '../volume/component';
import { additionalVolumeDensityBinding } from '../volume/passes';
import { VOLUMETRIC_FOG_PARAMS_BYTES } from '../volume/resources';

const MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const TEXTURE_COPY_SRC = 0x0001;
const TEXTURE_COPY_DST = 0x0002;
const STORAGE_BINDING = 0x0008;
const TEXTURE_BINDING = 0x0004;
const RENDER_ATTACHMENT = 0x0010;
const STORAGE_BUFFER = 0x0080;
const SIZE = 8;
const PACKED_LAYERS = Math.ceil(SIZE / 4);
const BYTES_PER_ROW = 256;
const BYTES_PER_PIXEL = 8;
const MAX_CLUSTER_LIGHTS = 256;
const CLUSTER_LIGHT_DATA_BYTES = MAX_CLUSTER_LIGHTS * BYTES_PER_DIRECT_LIGHT_SLOT;
const CLUSTER_UNIFORM_BYTES = 32;
const VOLUME_BOUNDS_MIN_Z = 0.1;
const VOLUME_BOUNDS_MAX_Z = 0.9;
const NON_UNIFORM_BOUNDS_MAX_Z = 8.1;
const MAX_NON_UNIFORM_BEER_ERROR = 0.001;
const NON_UNIFORM_EXTINCTION = 0.05;
const MIN_NON_UNIFORM_REFERENCE_SEPARATION = 0.05;
const MIN_NON_UNIFORM_GPU_SEPARATION = 0.05;
const engineManifest = await buildEngineShaderManifest();

interface StageValues {
  readonly red: number[];
  readonly green: number[];
  readonly blue: number[];
  readonly alpha: number[];
}

interface VolumeStageReadbacks {
  readonly inject: StageValues;
  readonly temporal: StageValues;
  readonly integrate: StageValues;
  readonly shadowCalls?: readonly number[];
}

interface StageReadbackOptions {
  readonly injectScale?: 1 | 2;
  readonly owners?: number;
  readonly secondDensity?: number;
  readonly densityOwner?: number;
  readonly thinSeparated?: boolean;
  readonly reverse?: boolean;
  readonly sceneDepthClear?: number;
  readonly densityByte?: number;
  /** Optional RGBA8 density field for the production integrate stage. */
  readonly densityData?: Uint8Array;
  readonly densityFormat?: 'rgba8unorm' | 'rgba16float';
  readonly sampling?: 0 | 1 | 2;
  readonly boundsOffsetX?: number;
  readonly boundsMinZ?: number;
  readonly boundsMaxZ?: number;
  readonly maxDistance?: number;
  readonly viewDepthScale?: number;
  readonly extinction?: number;
  readonly frameIndex?: number;
  /** Depth clear used by the stable shadow receiver fixture. */
  readonly shadowDepthClear?: number;
  readonly directionalShadowFilter?: number;
  /** Test-only native call counts; the ordinary path keeps the production shader untouched. */
  readonly traceInjection?: boolean;
  /** Unshadowed punctual light isolates ray integration from packed visibility. */
  readonly localLight?: 'point' | 'spot';
  readonly spotShadow?: boolean;
  /** Uniform-step diagnostic; omitted means the untouched production shader. */
  readonly integratorStepCount?: number;
}

interface DensityField {
  readonly data: Uint8Array;
  readonly zRed: readonly number[];
}

function createNonUniformDensityField(redValues?: readonly number[]): DensityField {
  const data = new Uint8Array(4 * SIZE * SIZE * SIZE);
  const zRed: number[] = [];
  for (let z = 0; z < SIZE; z += 1) {
    // Keep X/Y constant. The default field changes only the first Z texel;
    // the fine-density probe supplies a faster, seam-matched sequence.
    // The exercised camera ray crosses the first-to-second texel transition
    // under all three production density scales, so flattening the field to
    // its first texel produces a measurable, independently falsifiable result.
    const red = redValues?.[z] ?? (z === 0 ? 128 : 255);
    zRed.push(red / 255);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const offset = ((z * SIZE + y) * SIZE + x) * 4;
        data[offset] = red;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
        data[offset + 3] = 255;
      }
    }
  }
  return { data, zRed };
}

function createFlattenedDensityField(field: DensityField): DensityField {
  const red = Math.round((field.zRed[0] ?? 0) * 255);
  const data = new Uint8Array(4 * SIZE * SIZE * SIZE);
  for (let z = 0; z < SIZE; z += 1) {
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const offset = ((z * SIZE + y) * SIZE + x) * 4;
        data[offset] = red;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
        data[offset + 3] = 255;
      }
    }
  }
  return { data, zRed: Array.from({ length: SIZE }, () => red / 255) };
}

function sampleClampedLinear(values: readonly number[], coordinate: number): number {
  const scaled = coordinate * values.length - 0.5;
  const lower = Math.floor(scaled);
  const upper = lower + 1;
  const interpolation = scaled - lower;
  const clampIndex = (index: number): number => Math.max(0, Math.min(values.length - 1, index));
  const lowerValue = values[clampIndex(lower)] ?? 0;
  const upperValue = values[clampIndex(upper)] ?? 0;
  return lowerValue + (upperValue - lowerValue) * interpolation;
}

function nonUniformScatteringDensity(field: DensityField, worldZ: number): number {
  let grain = sampleClampedLinear(field.zRed, (worldZ * 0.1) % 1) + 0.5;
  grain *= sampleClampedLinear(field.zRed, (worldZ * 0.05) % 1) + 0.5;
  grain *= sampleClampedLinear(field.zRed, (worldZ * 0.02) % 1) + 0.5;
  return Math.max(2 * grain - 1, 0);
}

function nonUniformBeerReference(
  field: DensityField,
  extinction = 1,
  sampleCount = 16_384,
  boundsMinZ = VOLUME_BOUNDS_MIN_Z,
  boundsMaxZ = VOLUME_BOUNDS_MAX_Z,
): number {
  const interval = boundsMaxZ - boundsMinZ;
  const segmentLength = interval / sampleCount;
  let opticalDepth = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const worldZ = boundsMinZ + (sample + 0.5) * segmentLength;
    opticalDepth += nonUniformScatteringDensity(field, worldZ) * segmentLength;
  }
  return Math.exp(-extinction * opticalDepth);
}

function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function firstStageValue(values: readonly number[], label: string): number {
  const value = values[0];
  if (value === undefined) throw new Error(`missing stage readback value: ${label}`);
  return value;
}

function manifestShader(marker: string): string {
  const entry = engineManifest.entries.find(({ wgsl }) => wgsl.includes(marker));
  if (entry === undefined) throw new Error(`missing cooked shader entry: ${marker}`);
  return entry.wgsl;
}

function injectionShader(trace: boolean): string {
  let source = manifestShader('fn volume_inject');
  if (!trace) return source;
  // Count actual native control-flow entries, not source-level texture estimates.
  // Binding 10 is intentionally absent from the production injection contract.
  for (const [index, name] of ['volume_cascade', 'spot_shadow_visibility_at'].entries()) {
    const declaration = new RegExp(`fn ${name}\\([^{}]+\\{`);
    if (!declaration.test(source)) throw new Error(`missing injection helper: ${name}`);
    source = source.replace(declaration, `$&\n atomicAdd(&shadow_calls[${index}], 1u);`);
  }
  return `@group(0) @binding(10) var<storage, read_write> shadow_calls: array<atomic<u32>, 2>;\n${source}`;
}

function productionIntegratorShader(stepCount?: number): string {
  const source = manifestShader('fn volume_integrate');
  if (stepCount === undefined) return source;
  if (!Number.isInteger(stepCount) || stepCount < 1) {
    throw new Error(`invalid production integrator step count: ${stepCount}`);
  }
  const functionStart = source.indexOf('fn volume_integrate');
  if (functionStart < 0) throw new Error('production integrator function missing');
  const prefix = source.slice(0, functionStart);
  const body = source.slice(functionStart);
  // The cooked manifest constant-folds the source-level loop count into the
  // step-length divisor and loop guard. Replace both literals in that one
  // production function to compile the same WGSL with a diagnostic schedule;
  // an omitted override always exercises the unmodified production manifest.
  // Diagnostic schedules disable local refinement to expose the old defect.
  const productionCount = body.match(/< (\d+)u\b/)?.[1];
  if (productionCount === undefined) throw new Error('production ray loop count missing');
  const stepLengthMarker = new RegExp(`f32\\(${productionCount}u\\)`, 'g');
  const loopGuardMarker = new RegExp(`< ${productionCount}u\\b`, 'g');
  const stepLengthOccurrences = body.match(stepLengthMarker)?.length ?? 0;
  const loopGuardOccurrences = body.match(loopGuardMarker)?.length ?? 0;
  if (stepLengthOccurrences !== 1 || loopGuardOccurrences !== 1) {
    throw new Error(
      `production integrator step markers: length=${stepLengthOccurrences}, guard=${loopGuardOccurrences}`,
    );
  }
  return `${prefix}${body
    .replace(stepLengthMarker, `f32(${stepCount}u)`)
    .replace(loopGuardMarker, `< ${stepCount}u`)
    .replace(/select\(1u, 4u,/, 'select(1u, 1u,')} `;
}

function identityMatrix(target: Float32Array, offset: number): void {
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 15] = 1;
}

function createView(
  device: RhiDevice,
  texture: Texture,
  dimension?: '2d' | '2d-array' | '3d',
): TextureView {
  const view = device.createTextureView(texture, dimension === undefined ? {} : { dimension });
  if (!view.ok) throw view.error;
  return view.value;
}

async function requestDevice(): Promise<RhiDevice> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw new Error(`Dawn volume stage readback unavailable: ${adapter.error.code}`);
  const device = await adapter.value.requestDevice();
  if (!device.ok) throw new Error(`Dawn volume stage readback unavailable: ${device.error.code}`);
  return device.value;
}

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Inject, temporal and integrate modules; inject optionally carries native call tracing. */
async function createStageModules(device: RhiDevice, options: StageReadbackOptions) {
  const moduleResult = await createShaderModule(device, {
    code: injectionShader(options.traceInjection === true),
    label: 'stage-readback.volume-inject',
  });
  if (!moduleResult.ok) throw moduleResult.error;
  const temporalModule = await createShaderModule(device, {
    code: manifestShader('fn volume_temporal'),
    label: 'stage-readback.volume-temporal',
  });
  const integrateModule = await createShaderModule(device, {
    code: productionIntegratorShader(options.integratorStepCount),
    label: 'stage-readback.volume-integrate',
  });
  if (!temporalModule.ok) throw temporalModule.error;
  if (!integrateModule.ok) throw integrateModule.error;
  return {
    inject: moduleResult.value,
    temporal: temporalModule.value,
    integrate: integrateModule.value,
  };
}

function createStageTexture(
  device: RhiDevice,
  label: string,
  descriptor: Omit<
    Parameters<RhiDevice['createTexture']>[0],
    'label' | 'textureBindingViewDimension'
  >,
) {
  return device.createTexture({ label, ...descriptor, textureBindingViewDimension: undefined });
}

const PLANE = { width: SIZE, height: SIZE, depthOrArrayLayers: 1 };
const VOLUME = { width: SIZE, height: SIZE, depthOrArrayLayers: SIZE };
const STORAGE_2D_USAGE = STORAGE_BINDING | TEXTURE_COPY_SRC | TEXTURE_BINDING;

function createStageTextures(
  device: RhiDevice,
  options: StageReadbackOptions,
  injectSize: number,
  owners: number,
) {
  const depthUsage = RENDER_ATTACHMENT | TEXTURE_BINDING;
  const sceneDepth = createStageTexture(device, 'stage-readback.scene-depth', {
    size: PLANE,
    format: 'depth32float',
    usage: depthUsage,
  });
  const shadow = createStageTexture(device, 'stage-readback.shadow-depth', {
    size: PLANE,
    format: 'depth32float',
    usage: depthUsage,
  });
  const density = createStageTexture(device, 'stage-readback.density', {
    size: VOLUME,
    dimension: '3d',
    format: options.densityFormat ?? 'rgba8unorm',
    usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
  });
  const secondDensity = createStageTexture(device, 'stage-readback.second-density', {
    size: VOLUME,
    dimension: '3d',
    format: 'rgba8unorm',
    usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
  });
  const output = createStageTexture(device, 'stage-readback.froxel', {
    size: { width: injectSize, height: injectSize, depthOrArrayLayers: PACKED_LAYERS * owners },
    dimension: '2d',
    format: 'rgba8unorm',
    usage: STORAGE_BINDING | TEXTURE_COPY_SRC | TEXTURE_COPY_DST | TEXTURE_BINDING,
  });
  const history = createStageTexture(device, 'stage-readback.history', {
    size: PLANE,
    dimension: '2d',
    format: 'rgba16float',
    usage: STORAGE_2D_USAGE,
  });
  const temporal = createStageTexture(device, 'stage-readback.temporal', {
    size: PLANE,
    dimension: '2d',
    format: 'rgba16float',
    usage: STORAGE_2D_USAGE,
  });
  const resolved = createStageTexture(device, 'stage-readback.resolved', {
    size: PLANE,
    dimension: '2d',
    format: 'rgba16float',
    usage: STORAGE_2D_USAGE,
  });
  // The production integrator always declares the shared projector pair. A
  // white 1x1 fallback keeps this no-projector fixture on the same BGL shape
  // while preserving the pre-projector radiance when a light is later added.
  const projector = createStageTexture(device, 'stage-readback.projector', {
    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    dimension: '2d',
    format: 'rgba8unorm',
    usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
  });
  if (
    !sceneDepth.ok ||
    !shadow.ok ||
    !density.ok ||
    !secondDensity.ok ||
    !output.ok ||
    !history.ok ||
    !temporal.ok ||
    !resolved.ok ||
    !projector.ok
  ) {
    throw new Error('Dawn volume stage readback unavailable: texture allocation failed');
  }
  return {
    sceneDepth: sceneDepth.value,
    shadow: shadow.value,
    density: density.value,
    secondDensity: secondDensity.value,
    output: output.value,
    history: history.value,
    temporal: temporal.value,
    resolved: resolved.value,
    projector: projector.value,
  };
}

type StageTextures = ReturnType<typeof createStageTextures>;

function createStageViews(device: RhiDevice, textures: StageTextures) {
  const sceneDepthView = device.createTextureView(textures.sceneDepth, { dimension: '2d' });
  const shadowView = device.createTextureView(textures.shadow, { dimension: '2d' });
  const shadowArrayView = device.createTextureView(textures.shadow, { dimension: '2d-array' });
  if (!sceneDepthView.ok || !shadowView.ok || !shadowArrayView.ok)
    throw new Error('Dawn volume stage readback unavailable: depth view allocation failed');
  return {
    sceneDepth: sceneDepthView.value,
    shadow: shadowView.value,
    shadowArray: shadowArrayView.value,
    density: createView(device, textures.density, '3d'),
    secondDensity: createView(device, textures.secondDensity, '3d'),
    output: createView(device, textures.output, '2d-array'),
    history: createView(device, textures.history, '2d'),
    temporal: createView(device, textures.temporal, '2d'),
    resolved: createView(device, textures.resolved, '2d'),
    projector: createView(device, textures.projector, '2d'),
  };
}

type StageViews = ReturnType<typeof createStageViews>;

/** Native shadow-call counter and its readback, only for traced injection. */
function createShadowCallBuffers(device: RhiDevice, traced: boolean) {
  if (!traced) return undefined;
  const calls = device.createBuffer({ size: 8, usage: STORAGE_BUFFER | 0x0004 });
  const readback = device.createBuffer({ size: 8, usage: MAP_READ | BUFFER_COPY_DST });
  if (!calls.ok) throw calls.error;
  if (!readback.ok) throw readback.error;
  return { calls: calls.value, readback: readback.value };
}

function createStageBuffers(device: RhiDevice) {
  const view = device.createBuffer({
    label: 'stage-readback.view',
    size: VIEW_UNIFORM_BYTES,
    usage: 0x0040 | BUFFER_COPY_DST,
  });
  const params = device.createBuffer({
    label: 'stage-readback.params',
    size: VOLUMETRIC_FOG_PARAMS_BYTES,
    usage: 0x0040 | BUFFER_COPY_DST,
  });
  const lightData = device.createBuffer({
    label: 'stage-readback.cluster-light-data',
    size: CLUSTER_LIGHT_DATA_BYTES,
    usage: STORAGE_BUFFER | BUFFER_COPY_DST,
  });
  const clusterUniform = device.createBuffer({
    label: 'stage-readback.cluster-uniform',
    size: CLUSTER_UNIFORM_BYTES,
    usage: 0x0040 | BUFFER_COPY_DST,
  });
  return { view, params, lightData, clusterUniform };
}

function createStageReadbacks(device: RhiDevice, injectSize: number, owners: number) {
  const inject = device.createBuffer({
    label: 'stage-readback.inject',
    size: BYTES_PER_ROW * injectSize * PACKED_LAYERS * owners,
    usage: MAP_READ | BUFFER_COPY_DST,
  });
  const temporal = device.createBuffer({
    label: 'stage-readback.temporal',
    size: BYTES_PER_ROW * SIZE * SIZE,
    usage: MAP_READ | BUFFER_COPY_DST,
  });
  const integrate = device.createBuffer({
    label: 'stage-readback.integrate',
    size: BYTES_PER_ROW * SIZE * SIZE,
    usage: MAP_READ | BUFFER_COPY_DST,
  });
  return { inject, temporal, integrate };
}

function viewUniformData(options: StageReadbackOptions): Float32Array {
  const viewDepthScale = options.viewDepthScale ?? 1;
  const viewData = new Float32Array(VIEW_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT);
  for (const offset of [0, 28, 44, 60, 76, 92, 196, 212]) {
    identityMatrix(viewData, offset);
    viewData[offset + 10] = -1;
    viewData[offset + 14] = 1;
  }
  if (options.spotShadow) viewData.set(viewData.subarray(28, 44), 132);
  viewData[44 + 10] = -viewDepthScale;
  viewData[44 + 14] = viewDepthScale;
  viewData[24] = 0;
  viewData[25] = 0;
  viewData[26] = -1;
  // Enable one real shadow cascade. Otherwise the stability falsifier sees
  // only unshadowed texels (the old overlong readback supplied fake zeros).
  viewData[108] = 10;
  viewData[124] = 1;
  viewData[128] = options.directionalShadowFilter ?? 1;
  viewData[228] = 0.1;
  viewData[229] = 10;
  viewData[230] = 0;
  viewData[235] = 1;
  return viewData;
}

/** The first owner's 36-float volume record before owner replication. */
function baseVolumeParams(options: StageReadbackOptions): Float32Array {
  const extinction = options.extinction ?? 1;
  const boundsOffsetX = options.boundsOffsetX ?? 0;
  const paramsData = new Float32Array(VOLUMETRIC_FOG_PARAMS_BYTES / 4);
  paramsData.set([-1 + boundsOffsetX, -1, options.boundsMinZ ?? VOLUME_BOUNDS_MIN_Z, 0], 0);
  paramsData.set(
    [1 + boundsOffsetX, 1, options.boundsMaxZ ?? VOLUME_BOUNDS_MAX_Z, options.sampling ?? 0],
    4,
  );
  paramsData.set([extinction, extinction, extinction, 0], 8);
  paramsData.set([1, 1, 1, 0], 12);
  paramsData.set([0, 0, 0, 0], 16);
  paramsData.set([0, -1, 0, options.frameIndex ?? 0], 20);
  paramsData.set([1, 1, 1, 0], 24);
  paramsData.set([options.maxDistance ?? 2, 0, 0, 0], 28);
  // `simulation.w` is the renderer-owned selected-sun cloud transmittance
  // carrier. A fixture without a CloudLayer must retain the unshadowed
  // #3197 baseline instead of reading the typed-array zero value.
  paramsData[35] = 1;
  return paramsData;
}

/** Cluster light slot for the optional punctual light; also selects its kind in params. */
function localLightData(options: StageReadbackOptions, paramsData: Float32Array): Uint8Array {
  const lightData = new Uint8Array(CLUSTER_LIGHT_DATA_BYTES);
  if (options.localLight === undefined) return lightData;
  const point = options.localLight === 'point';
  paramsData[30] = point ? 1 : 2;
  const light = new Float32Array(lightData.buffer);
  // Point owns the decay lane; Spot uses the same lane for its inner cone.
  // Keep the Point fixture inverse-square, matching punctualReference.
  light.set([
    0,
    0,
    5.37,
    0,
    1,
    1,
    1,
    point ? 2 : Math.cos(Math.PI / 8),
    0,
    0,
    -1,
    Math.cos(Math.PI / 6),
  ]);
  // Zero shadow intensity makes this a pure punctual-light integral. No
  // projected image or shadow map can hide an undersampled light peak.
  new Uint32Array(lightData.buffer).set([point ? 0 : 1, 0xffffffff, 0xffffffff, 0xffffffff], 16);
  if (options.spotShadow) {
    new Uint32Array(lightData.buffer)[17] = 0;
    light[14] = 1;
  }
  return lightData;
}

/** Replicate the base record per owner, then apply the multi-volume fixture edits. */
function replicateVolumeOwners(
  paramsData: Float32Array,
  options: StageReadbackOptions,
  owners: number,
): void {
  for (let index = 0; index < owners; index++)
    paramsData.set(paramsData.slice(0, 36), 36 * (index + 1));
  paramsData[3] = owners;
  if (options.secondDensity !== undefined || options.thinSeparated) {
    for (let index = 0; index < owners; index++) paramsData[36 * (index + 1) + 7] = 1;
  }
  if (options.thinSeparated) {
    paramsData[38] = 0.1;
    paramsData[42] = 0.101;
    paramsData[74] = 0.899;
    paramsData[78] = 0.9;
    for (const offset of [44, 80]) paramsData.set([100, 100, 100], offset);
  }
  if (options.reverse) {
    const first = paramsData.slice(36, 72);
    paramsData.copyWithin(36, 72, 108);
    paramsData.set(first, 72);
  }
}

function uploadStageUniforms(
  device: RhiDevice,
  buffers: StageBuffers,
  options: StageReadbackOptions,
  owners: number,
): void {
  const viewData = viewUniformData(options);
  const paramsData = baseVolumeParams(options);
  const lightData = localLightData(options, paramsData);
  replicateVolumeOwners(paramsData, options, owners);
  const clusterUniformData = new Float32Array(8);
  const clusterGrid = new Uint32Array(clusterUniformData.buffer);
  clusterGrid[0] = 1;
  clusterGrid[1] = 1;
  clusterGrid[2] = 1;
  clusterGrid[3] = 1;
  const viewWrite = device.queue.writeBuffer(buffers.view, 0, viewData);
  const paramsWrite = device.queue.writeBuffer(buffers.params, 0, paramsData);
  const lightDataWrite = device.queue.writeBuffer(buffers.lightData, 0, lightData);
  const clusterUniformWrite = device.queue.writeBuffer(
    buffers.clusterUniform,
    0,
    clusterUniformData,
  );
  if (!viewWrite.ok || !paramsWrite.ok || !lightDataWrite.ok || !clusterUniformWrite.ok)
    throw new Error('Dawn volume stage readback unavailable: uniform upload failed');
}

function uploadStageTextures(
  device: RhiDevice,
  textures: StageTextures,
  options: StageReadbackOptions,
  injectSize: number,
  owners: number,
): void {
  const densityBytesPerTexel = options.densityFormat === 'rgba16float' ? 8 : 4;
  const densityData =
    options.densityData ?? new Uint8Array((BYTES_PER_PIXEL / 2) * SIZE * SIZE * SIZE);
  if (options.densityData === undefined) densityData.fill(options.densityByte ?? 255);
  if (densityData.length !== densityBytesPerTexel * SIZE * SIZE * SIZE) {
    throw new Error(`Dawn volume stage readback density field length: ${densityData.length}`);
  }
  const densityWrite = device.queue.writeTexture(
    { texture: textures.density },
    densityData,
    { offset: 0, bytesPerRow: SIZE * densityBytesPerTexel, rowsPerImage: SIZE },
    VOLUME,
  );
  if (!densityWrite.ok)
    throw new Error('Dawn volume stage readback unavailable: density upload failed');
  const secondDensityWrite = device.queue.writeTexture(
    { texture: textures.secondDensity },
    new Uint8Array(densityData.length).fill(options.secondDensity ?? 255),
    { offset: 0, bytesPerRow: SIZE * 4, rowsPerImage: SIZE },
    VOLUME,
  );
  if (!secondDensityWrite.ok) throw secondDensityWrite.error;
  const projectorWrite = device.queue.writeTexture(
    { texture: textures.projector },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  if (!projectorWrite.ok)
    throw new Error('Dawn volume stage readback unavailable: projector upload failed');
  if (!options.traceInjection) return;
  // A miss must overwrite old visibility, not merely leave an unwritten texel.
  const prefill = device.queue.writeTexture(
    { texture: textures.output },
    new Uint8Array(4 * injectSize * injectSize * PACKED_LAYERS * owners).fill(255),
    { bytesPerRow: 4 * injectSize, rowsPerImage: injectSize },
    { width: injectSize, height: injectSize, depthOrArrayLayers: PACKED_LAYERS * owners },
  );
  if (!prefill.ok) throw prefill.error;
}

interface StageBuffers {
  readonly view: Buffer;
  readonly params: Buffer;
  readonly lightData: Buffer;
  readonly clusterUniform: Buffer;
}

function createComputePipeline(
  device: RhiDevice,
  label: string,
  layout: BindGroupLayout,
  module: ShaderModule,
  entryPoint: string,
): ComputePipeline {
  const pipelineLayout = requireOk(device.createPipelineLayout({ bindGroupLayouts: [layout] }));
  return requireOk(
    device.createComputePipeline({
      label,
      layout: pipelineLayout,
      compute: { module, entryPoint },
    }),
  );
}

function createInjectLayout(device: RhiDevice, traced: boolean): BindGroupLayout {
  return requireOk(
    device.createBindGroupLayout({
      label: 'stage-readback.volume-inject.layout',
      entries: [
        { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
        { binding: 3, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 4, visibility: 4, sampler: { type: 'comparison' } },
        { binding: 5, visibility: 4, buffer: { type: 'uniform' } },
        {
          binding: 6,
          visibility: 4,
          storageTexture: {
            access: 'write-only',
            format: 'rgba8unorm',
            viewDimension: '2d-array',
          },
        },
        { binding: 7, visibility: 4, buffer: { type: 'read-only-storage' } },
        { binding: 8, visibility: 4, buffer: { type: 'uniform' } },
        { binding: 9, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        ...(traced ? [{ binding: 10, visibility: 4, buffer: { type: 'storage' as const } }] : []),
      ],
    }),
  );
}

function createTemporalLayout(device: RhiDevice) {
  return device.createBindGroupLayout({
    label: 'stage-readback.volume-temporal.layout',
    entries: [
      { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 1, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
      {
        binding: 2,
        visibility: 4,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
      },
      { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
    ],
  });
}

function createIntegrateLayout(device: RhiDevice) {
  return device.createBindGroupLayout({
    label: 'stage-readback.volume-integrate.layout',
    entries: [
      { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 1, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d' } },
      {
        binding: 2,
        visibility: 4,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
      },
      { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 5, visibility: 4, sampler: { type: 'filtering' } },
      { binding: 6, visibility: 4, texture: { sampleType: 'float', viewDimension: '3d' } },
      { binding: 7, visibility: 4, sampler: { type: 'filtering' } },
      {
        binding: 8,
        visibility: 4,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
      },
      {
        binding: 9,
        visibility: 4,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
      },
      { binding: 10, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 11, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 12, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 13, visibility: 4, sampler: { type: 'filtering' } },
      { binding: 16, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 17, visibility: 4, sampler: { type: 'filtering' } },
      { binding: 25, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 26, visibility: 4, sampler: { type: 'filtering' } },
      ...Array.from({ length: MAX_VOLUMETRIC_FOG_OWNERS - 1 }, (_, index) => ({
        binding: additionalVolumeDensityBinding(index),
        visibility: 4,
        texture: { sampleType: 'float' as const, viewDimension: '3d' as const },
      })),
    ],
  });
}

function createStageSamplers(device: RhiDevice, options: StageReadbackOptions) {
  const comparisonSampler = device.createSampler({ compare: 'greater' });
  const densitySampler = device.createSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    ...(options.sampling === 2
      ? {
          addressModeU: 'repeat' as const,
          addressModeV: 'repeat' as const,
          addressModeW: 'repeat' as const,
        }
      : {}),
  });
  if (!comparisonSampler.ok || !densitySampler.ok)
    throw new Error('Dawn volume stage readback unavailable: sampler allocation failed');
  return { comparison: comparisonSampler.value, density: densitySampler.value };
}

function createInjectBindings(
  device: RhiDevice,
  layout: BindGroupLayout,
  views: StageViews,
  buffers: StageBuffers,
  comparison: Sampler,
  shadowCalls: Buffer | undefined,
) {
  return requireOk(
    device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: buffers.view } } },
        { binding: 3, resource: { kind: 'textureView', value: views.shadowArray } },
        { binding: 4, resource: { kind: 'sampler', value: comparison } },
        { binding: 5, resource: { kind: 'buffer', value: { buffer: buffers.params } } },
        { binding: 6, resource: { kind: 'textureView', value: views.output } },
        { binding: 7, resource: { kind: 'buffer', value: { buffer: buffers.lightData } } },
        { binding: 8, resource: { kind: 'buffer', value: { buffer: buffers.clusterUniform } } },
        { binding: 9, resource: { kind: 'textureView', value: views.shadowArray } },
        ...(shadowCalls === undefined
          ? []
          : [
              {
                binding: 10,
                resource: { kind: 'buffer' as const, value: { buffer: shadowCalls } },
              },
            ]),
      ],
    }),
  );
}

function createTemporalBindings(
  device: RhiDevice,
  layout: BindGroupLayout,
  views: StageViews,
  buffers: StageBuffers,
) {
  return device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { kind: 'textureView', value: views.resolved } },
      { binding: 1, resource: { kind: 'textureView', value: views.history } },
      { binding: 2, resource: { kind: 'textureView', value: views.temporal } },
      { binding: 3, resource: { kind: 'buffer', value: { buffer: buffers.params } } },
      { binding: 4, resource: { kind: 'buffer', value: { buffer: buffers.view } } },
    ],
  });
}

/** Owner density slots: one owner may read the second field unless the order is reversed. */
function ownerDensityView(views: StageViews, options: StageReadbackOptions, index: number) {
  return index === (options.densityOwner ?? 1) - 1 && !options.reverse
    ? views.secondDensity
    : views.density;
}

function createIntegrateBindings(
  device: RhiDevice,
  layout: BindGroupLayout,
  views: StageViews,
  buffers: StageBuffers,
  densitySampler: Sampler,
  options: StageReadbackOptions,
) {
  return device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { kind: 'textureView', value: views.output } },
      { binding: 1, resource: { kind: 'textureView', value: views.sceneDepth } },
      { binding: 2, resource: { kind: 'textureView', value: views.resolved } },
      { binding: 3, resource: { kind: 'buffer', value: { buffer: buffers.params } } },
      { binding: 4, resource: { kind: 'buffer', value: { buffer: buffers.view } } },
      { binding: 5, resource: { kind: 'sampler', value: densitySampler } },
      {
        binding: 6,
        resource: {
          kind: 'textureView',
          value: options.reverse ? views.secondDensity : views.density,
        },
      },
      { binding: 7, resource: { kind: 'sampler', value: densitySampler } },
      { binding: 8, resource: { kind: 'textureView', value: views.history } },
      { binding: 9, resource: { kind: 'textureView', value: views.temporal } },
      { binding: 10, resource: { kind: 'buffer', value: { buffer: buffers.lightData } } },
      { binding: 11, resource: { kind: 'buffer', value: { buffer: buffers.clusterUniform } } },
      { binding: 12, resource: { kind: 'textureView', value: views.projector } },
      { binding: 13, resource: { kind: 'sampler', value: densitySampler } },
      { binding: 16, resource: { kind: 'textureView', value: views.projector } },
      { binding: 17, resource: { kind: 'sampler', value: densitySampler } },
      { binding: 25, resource: { kind: 'textureView', value: views.projector } },
      { binding: 26, resource: { kind: 'sampler', value: densitySampler } },
      ...Array.from({ length: MAX_VOLUMETRIC_FOG_OWNERS - 1 }, (_, index) => ({
        binding: additionalVolumeDensityBinding(index),
        resource: {
          kind: 'textureView' as const,
          value: ownerDensityView(views, options, index),
        },
      })),
    ],
  });
}

async function decodeStageValues(
  buffer: Buffer,
  layers: number,
  bytesPerPixel: number,
  halfFloat: boolean,
  size = SIZE,
): Promise<StageValues> {
  const mapped = await buffer.mapAsync(MAP_READ);
  if (!mapped.ok) throw mapped.error;
  const range = mapped.value.getMappedRange();
  if (!range.ok) throw range.error;
  const bytes = new Uint8Array(range.value);
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  const alpha: number[] = [];
  for (let z = 0; z < layers; z += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const offset = z * BYTES_PER_ROW * size + y * BYTES_PER_ROW + x * bytesPerPixel;
        const read = (channel: number): number => {
          if (!halfFloat) return (bytes[offset + channel] ?? 0) / 255;
          const halfOffset = offset + channel * 2;
          return halfToFloat((bytes[halfOffset] ?? 0) | ((bytes[halfOffset + 1] ?? 0) << 8));
        };
        red.push(read(0));
        green.push(read(1));
        blue.push(read(2));
        alpha.push(read(3));
      }
    }
  }
  mapped.value.unmap();
  return { red, green, blue, alpha };
}

async function readShadowCalls(readback: Buffer): Promise<number[]> {
  const mapped = await readback.mapAsync(MAP_READ);
  if (!mapped.ok) throw mapped.error;
  const range = mapped.value.getMappedRange();
  if (!range.ok) throw range.error;
  const calls = Array.from(new Uint32Array(range.value));
  mapped.value.unmap();
  return calls;
}

/** Clear scene depth and the shadow map to their fixture depths. */
function clearStageDepths(
  encoder: RhiCommandEncoder,
  views: StageViews,
  options: StageReadbackOptions,
): void {
  for (const [index, view] of [views.sceneDepth, views.shadow].entries()) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view,
        depthClearValue:
          index === 0 ? (options.sceneDepthClear ?? 0) : (options.shadowDepthClear ?? 0),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    } as never);
    pass.end();
  }
}

function dispatchStage(
  encoder: RhiCommandEncoder,
  pipeline: ComputePipeline,
  bindings: BindGroup,
  workgroups: readonly [number, number, number],
): void {
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindings);
  pass.dispatchWorkgroups(...workgroups);
  pass.end();
}

function copyPlaneToBuffer(encoder: RhiCommandEncoder, texture: Texture, buffer: Buffer): void {
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: SIZE },
    PLANE,
  );
}

async function runInjectReadback(
  options: StageReadbackOptions = {},
): Promise<VolumeStageReadbacks> {
  const owners = options.owners ?? 1;
  const injectScale = options.injectScale ?? 1;
  const injectSize = SIZE * injectScale;
  const device = await requestDevice();
  const modules = await createStageModules(device, options);
  const textures = createStageTextures(device, options, injectSize, owners);
  const views = createStageViews(device, textures);
  const buffers = createStageBuffers(device);
  const shadowCalls = createShadowCallBuffers(device, options.traceInjection === true);
  const readbacks = createStageReadbacks(device, injectSize, owners);
  if (
    !buffers.view.ok ||
    !buffers.params.ok ||
    !buffers.lightData.ok ||
    !buffers.clusterUniform.ok ||
    !readbacks.inject.ok ||
    !readbacks.temporal.ok ||
    !readbacks.integrate.ok
  )
    throw new Error('Dawn volume stage readback unavailable: readback allocation failed');
  const uniforms: StageBuffers = {
    view: buffers.view.value,
    params: buffers.params.value,
    lightData: buffers.lightData.value,
    clusterUniform: buffers.clusterUniform.value,
  };
  uploadStageUniforms(device, uniforms, options, owners);
  uploadStageTextures(device, textures, options, injectSize, owners);

  const injectLayout = createInjectLayout(device, shadowCalls !== undefined);
  const injectPipeline = createComputePipeline(
    device,
    'stage-readback.volume-inject',
    injectLayout,
    modules.inject,
    'volume_inject',
  );
  const temporalLayout = requireOk(createTemporalLayout(device));
  const integrateLayout = requireOk(createIntegrateLayout(device));
  const temporalPipeline = createComputePipeline(
    device,
    'stage-readback.volume-temporal',
    temporalLayout,
    modules.temporal,
    'volume_temporal',
  );
  const integratePipeline = createComputePipeline(
    device,
    'stage-readback.volume-integrate',
    integrateLayout,
    modules.integrate,
    'volume_integrate',
  );
  const samplers = createStageSamplers(device, options);
  const injectBindings = createInjectBindings(
    device,
    injectLayout,
    views,
    uniforms,
    samplers.comparison,
    shadowCalls?.calls,
  );
  const temporalBindings = requireOk(
    createTemporalBindings(device, temporalLayout, views, uniforms),
  );
  const integrateBindings = requireOk(
    createIntegrateBindings(device, integrateLayout, views, uniforms, samplers.density, options),
  );
  const encoder = requireOk(device.createCommandEncoder({ label: 'stage-readback.volume-inject' }));
  clearStageDepths(encoder, views, options);
  dispatchStage(encoder, injectPipeline, injectBindings, [
    injectScale,
    injectScale,
    PACKED_LAYERS * owners,
  ]);
  if (shadowCalls !== undefined)
    encoder.copyBufferToBuffer(shadowCalls.calls, 0, shadowCalls.readback, 0, 8);
  encoder.copyTextureToBuffer(
    { texture: textures.output },
    { buffer: readbacks.inject.value, bytesPerRow: BYTES_PER_ROW, rowsPerImage: injectSize },
    { width: injectSize, height: injectSize, depthOrArrayLayers: PACKED_LAYERS * owners },
  );
  dispatchStage(encoder, integratePipeline, integrateBindings, [1, 1, 1]);
  copyPlaneToBuffer(encoder, textures.resolved, readbacks.integrate.value);
  dispatchStage(encoder, temporalPipeline, temporalBindings, [1, 1, 1]);
  copyPlaneToBuffer(encoder, textures.temporal, readbacks.temporal.value);
  const command = requireOk(encoder.finish());
  requireOk(device.queue.submit([command]));
  await device.queue.onSubmittedWorkDone();
  const calls = shadowCalls === undefined ? undefined : await readShadowCalls(shadowCalls.readback);
  return {
    inject: await decodeStageValues(
      readbacks.inject.value,
      PACKED_LAYERS * owners,
      4,
      false,
      injectSize,
    ),
    temporal: await decodeStageValues(readbacks.temporal.value, 1, BYTES_PER_PIXEL, true),
    integrate: await decodeStageValues(readbacks.integrate.value, 1, BYTES_PER_PIXEL, true),
    ...(calls === undefined ? {} : { shadowCalls: calls }),
  };
}

// Independent radiative-transfer quadrature: a homogeneous medium and an
// unshadowed punctual source. The near-light peak and spot cone make the old
// 24 midpoint schedule visibly wrong even though its Beer transmittance passes.
function punctualReference(kind: 'point' | 'spot', samples = 16_384): number[] {
  const sigma = 0.01 * (2 * (128 / 255 + 0.5) ** 3 - 1);
  return Array.from({ length: SIZE * SIZE }, (_, pixel) => {
    const x = (((pixel % SIZE) + 0.5) / SIZE) * 2 - 1;
    const y = 1 - ((Math.floor(pixel / SIZE) + 0.5) / SIZE) * 2;
    const ds = 20 / samples;
    let radiance = 0;
    for (let i = 0; i < samples; i += 1) {
      const s = (i + 0.5) * ds;
      const z = 0.1 + s;
      const distanceSquared = x * x + y * y + (5.37 - z) ** 2;
      const cosine = (5.37 - z) / Math.sqrt(distanceSquared);
      const t = Math.max(
        0,
        Math.min(
          1,
          (cosine - Math.cos(Math.PI / 6)) / (Math.cos(Math.PI / 8) - Math.cos(Math.PI / 6)),
        ),
      );
      const cone = kind === 'point' ? 1 : t * t * (3 - 2 * t);
      radiance += ((sigma * Math.exp(-sigma * s) * cone) / distanceSquared) * ds;
    }
    return radiance;
  });
}

describe('volumetric fog production stage readback on Dawn', () => {
  it.each([
    undefined,
    'point',
  ] as const)('skips both injection shadow paths for missed %s volume rays and clears old visibility', async (localLight) => {
    const values = await runInjectReadback({
      ...(localLight === undefined ? {} : { localLight }),
      boundsOffsetX: 3,
      traceInjection: true,
      directionalShadowFilter: 3,
    });
    expect(values.shadowCalls).toEqual([0, 0]);
    for (const channel of [
      values.inject.red,
      values.inject.green,
      values.inject.blue,
      values.inject.alpha,
    ]) {
      expect(channel.every((value) => value === 0)).toBe(true);
    }
    expect(values.integrate.red.every((value) => value === 0)).toBe(true);
    expect(values.integrate.alpha.every((value) => value === 1)).toBe(true);
  });

  it.each([
    undefined,
    'spot',
  ] as const)('evaluates only the selected %s shadow path for intersecting rays', async (localLight) => {
    const values = await runInjectReadback({
      ...(localLight === undefined ? {} : { localLight, spotShadow: true }),
      boundsOffsetX: 1,
      shadowDepthClear: 0.5,
      directionalShadowFilter: 3,
      traceInjection: true,
    });
    const samples = (SIZE / 2) * SIZE * PACKED_LAYERS * 4;
    expect(values.shadowCalls).toEqual(localLight === 'spot' ? [0, samples * 2] : [samples, 0]);
    // Half-screen coverage must preserve both dark and illuminated samples.
    expect(values.inject.red.some((value) => value === 0)).toBe(true);
    expect(values.inject.alpha.some((value) => value > 0)).toBe(true);
  });

  it('skips shadow injection when maxDistance ends at the volume entry boundary', async () => {
    const values = await runInjectReadback({
      maxDistance: VOLUME_BOUNDS_MIN_Z,
      traceInjection: true,
    });
    expect(values.shadowCalls).toEqual([0, 0]);
    expect(values.inject.red.every((value) => value === 0)).toBe(true);
    expect(values.integrate.alpha.every((value) => value === 1)).toBe(true);
  });

  it('retains spot visibility outside the volume for interpolation at the resolve boundary', async () => {
    const options = {
      localLight: 'spot' as const,
      spotShadow: true,
      injectScale: 2 as const,
      sampling: 2 as const,
      densityByte: 128,
    };
    const values = await runInjectReadback({ ...options, boundsOffsetX: 1.35 });
    // The resolve ray at X=.375 lies inside the volume, while its injection
    // neighbors at X=.3125 and X=.4375 straddle the local volume boundary.
    // Both unoccluded spot samples must stay lit for linear reconstruction.
    const injectionPixel = 8 * (SIZE * 2) + 10;
    expect(values.inject.red[injectionPixel]).toBe(1);
    expect(values.inject.red[injectionPixel + 1]).toBe(1);
    const outputPixel = 4 * SIZE + 5;
    const unbounded = await runInjectReadback(options);
    expect(values.integrate.red[outputPixel]).toBeGreaterThan(0);
    expect(values.integrate.red[outputPixel]).toBe(unbounded.integrate.red[outputPixel]);
  });

  it('filters premultiplied albedo and density without darkening empty field boundaries twice', async () => {
    const red = [0, 64, 0, 128, 0, 32, 0, 96];
    const green = [0, 16, 0, 64, 0, 128, 0, 48];
    // Even UNORM8 values keep half-texel interpolation exactly representable
    // in the hardware normalized texture precision. Uniform 255 is tested below.
    const alpha = [0, 128, 0, 254, 0, 192, 0, 128];
    const data = new Uint8Array(4 * SIZE ** 3);
    for (let z = 0; z < SIZE; z++)
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
          data.set([red[x] ?? 0, green[x] ?? 0, 0, alpha[x] ?? 0], ((z * SIZE + y) * SIZE + x) * 4);
        }
    // Half a texel translation exercises the field/vacuum interpolation,
    // independently of the view's pixel-center placement.
    const offset = 1 / SIZE;
    const result = await runInjectReadback({
      sampling: 2,
      densityData: data,
      boundsOffsetX: offset,
      sceneDepthClear: 0.43,
    });
    // UV 0 must not wrap the last colored texel into the empty first texel.
    expect(result.integrate.alpha[0]).toBe(1);
    expect(result.integrate.red[0]).toBe(0);
    for (let x = 1; x < SIZE; x++) {
      const coordinate = (x + 0.5) / SIZE - offset / 2;
      const density = sampleClampedLinear(alpha, coordinate) / 255;
      const transmission = Math.exp(-0.47 * density);
      const scattering = (channel: readonly number[]): number =>
        (sampleClampedLinear(channel, coordinate) / 255 / density) * (1 - transmission);
      expect(result.integrate.alpha[x]).toBeCloseTo(transmission, 3);
      expect(result.integrate.red[x]).toBeCloseTo(scattering(red), 3);
      expect(result.integrate.green[x]).toBeCloseTo(scattering(green), 3);
      // A second density multiply would halve the field/vacuum boundary.
      expect(Math.abs(scattering(red) - scattering(red) * density)).toBeGreaterThan(0.015);
    }
  });

  it('retains absorption with zero scattering color and accepts a fully empty optical field', async () => {
    const black = new Uint8Array(4 * SIZE ** 3);
    for (let index = 3; index < black.length; index += 4) black[index] = 255;
    const absorbing = await runInjectReadback({
      sampling: 2,
      densityData: black,
      sceneDepthClear: 0.43,
    });
    const empty = await runInjectReadback({
      sampling: 2,
      densityData: new Uint8Array(black.length),
    });
    expect(absorbing.integrate.alpha[0]).toBeCloseTo(Math.exp(-0.47), 3);
    expect(absorbing.integrate.red.every((value) => value === 0)).toBe(true);
    expect(empty.integrate.alpha.every((value) => value === 1)).toBe(true);
    expect(empty.integrate.red.every((value) => value === 0)).toBe(true);
  });

  it('samples float16 optical coefficients with the same independent density and color semantics', async () => {
    const half = new Uint16Array(4 * SIZE ** 3);
    for (let index = 0; index < half.length; index += 4) {
      // Exact half floats: premultiplied RGB [.125, .25, .5], density .5.
      half.set([0x3000, 0x3400, 0x3800, 0x3800], index);
    }
    const result = await runInjectReadback({
      sampling: 2,
      densityFormat: 'rgba16float',
      densityData: new Uint8Array(half.buffer),
      sceneDepthClear: 0.43,
    });
    const transmission = Math.exp(-0.47 * 0.5);
    expect(result.integrate.alpha[0]).toBeCloseTo(transmission, 3);
    expect(result.integrate.red[0]).toBeCloseTo(0.25 * (1 - transmission), 3);
    expect(result.integrate.green[0]).toBeCloseTo(0.5 * (1 - transmission), 3);
  });

  it('keeps static shadow visibility stable across renderer frame phases', async () => {
    const first = await runInjectReadback({ frameIndex: 0, shadowDepthClear: 0.5 });
    const next = await runInjectReadback({ frameIndex: 1, shadowDepthClear: 0.5 });
    expect(first.inject.red).toHaveLength(SIZE * SIZE * PACKED_LAYERS);
    expect(first.inject).toEqual(next.inject);
    expect(first.inject.red.some((value) => value === 0)).toBe(true);
    expect(first.inject.red.some((value) => value > 0.9)).toBe(true);
  });

  it('keeps fog beyond the spot shadow far plane fully visible', async () => {
    const result = await runInjectReadback({
      localLight: 'spot',
      spotShadow: true,
      boundsMinZ: 2,
      boundsMaxZ: 3,
      viewDepthScale: 4,
      maxDistance: 4,
    });
    expect(result.inject.red.every((value) => value === 1)).toBe(true);
  });

  it.each([
    'point',
    'spot',
  ] as const)('resolves the %s light peak without coherent ray bands', async (localLight) => {
    const reference = punctualReference(localLight);
    const refined = punctualReference(localLight, 32_768);
    expect(Math.max(...reference.map((v, i) => Math.abs(v - (refined[i] ?? 0)) / v))).toBeLessThan(
      0.0001,
    );
    const options = {
      localLight,
      densityByte: 128,
      extinction: 0.01,
      boundsMaxZ: 20.1,
      maxDistance: 20.1,
      viewDepthScale: 21,
    };
    const maximumRelativeError = (values: VolumeStageReadbacks): number =>
      Math.max(
        ...values.integrate.red.map(
          (v, i) => Math.abs(v - (reference[i] ?? 0)) / (reference[i] ?? 1),
        ),
      );
    const production = await runInjectReadback(options);
    const undersampled = await runInjectReadback({ ...options, integratorStepCount: 24 });
    const resolved = await runInjectReadback({ ...options, integratorStepCount: 96 });
    const refinedGpu = await runInjectReadback({ ...options, integratorStepCount: 384 });
    const errors = {
      refined: maximumRelativeError(refinedGpu),
      production: maximumRelativeError(production),
      undersampled: maximumRelativeError(undersampled),
      resolved: maximumRelativeError(resolved),
    };
    // biome-ignore lint/suspicious/noConsole: production GPU spatial regression evidence.
    console.info('[volumetric-fog-stage-readback] punctual-convergence', localLight, errors);
    expect(errors.undersampled).toBeGreaterThan(0.1);
    expect(errors.refined).toBeLessThan(0.003);
    expect(errors.production).toBeLessThan(0.03);
  });

  it('retains fine density variation away from punctual light refinement', async () => {
    // Matching end texels avoid an artificial discontinuity at the repeated
    // texture seam. The interior stripes expose coarse-step density aliasing.
    const field = createNonUniformDensityField([0, 255, 0, 255, 0, 255, 0, 0]);
    const reference = nonUniformBeerReference(field, 0.05, 16_384, 0.1, 20.1);
    const refined = nonUniformBeerReference(field, 0.05, 32_768, 0.1, 20.1);
    expect(Math.abs(reference - refined)).toBeLessThan(0.0001);
    const options = {
      densityData: field.data,
      extinction: 0.05,
      boundsMaxZ: 20.1,
      maxDistance: 20.1,
      viewDepthScale: 21,
    };
    const production = firstStageValue(
      (await runInjectReadback(options)).integrate.alpha,
      'fine density',
    );
    const coarse = firstStageValue(
      (await runInjectReadback({ ...options, integratorStepCount: 24 })).integrate.alpha,
      'coarse density',
    );
    // biome-ignore lint/suspicious/noConsole: independent fine-density regression evidence.
    console.info('[volumetric-fog-stage-readback] fine-density', { reference, production, coarse });
    expect(Math.abs(coarse - reference)).toBeGreaterThan(0.005);
    expect(Math.abs(production - reference)).toBeLessThan(0.002);
  });

  it('samples independent density textures and is invariant under owner permutation', async () => {
    const transparent = await runInjectReadback({
      sceneDepthClear: 0.43,
      owners: 2,
      secondDensity: 0,
    });
    const half = await runInjectReadback({ sceneDepthClear: 0.43, owners: 2, secondDensity: 128 });
    const reversed = await runInjectReadback({
      sceneDepthClear: 0.43,
      owners: 2,
      secondDensity: 128,
      reverse: true,
    });
    expect(transparent.integrate.alpha[0]).toBeCloseTo(Math.exp(-0.47), 3);
    expect(half.integrate.alpha[0]).toBeCloseTo(Math.exp(-0.47 * (1 + 128 / 255)), 3);
    expect(reversed.integrate.alpha).toEqual(half.integrate.alpha);
    expect(reversed.integrate.red).toEqual(half.integrate.red);
  });
  it('does not miss thin local volumes separated by empty space', async () => {
    const values = await runInjectReadback({ owners: 2, thinSeparated: true });
    expect(values.integrate.alpha[0]).toBeCloseTo(Math.exp(-0.002 * 100), 3);
  });
  it('adds overlapping optical depth instead of rejecting or selecting one volume', async () => {
    const one = await runInjectReadback({ sceneDepthClear: 0.43 });
    const two = await runInjectReadback({ sceneDepthClear: 0.43, owners: 2 });
    const expected = Math.exp(-0.47 * (2 * 1.5 ** 3 - 1) * 2);
    expect(two.integrate.alpha[0]).toBeCloseTo(expected, 3);
    expect(two.integrate.alpha[0]).toBeLessThan(one.integrate.alpha[0] ?? 0);
    expect(two.integrate.red[0]).toBeGreaterThan(one.integrate.red[0] ?? 0);
  });
  it.each([
    8, 9, 11,
  ])('integrates all %i admitted owners through the production parameter layout', async (owners) => {
    const values = await runInjectReadback({ sceneDepthClear: 0.43, owners, extinction: 0.1 });
    expect(values.integrate.alpha[0]).toBeCloseTo(
      Math.exp(-0.47 * (2 * 1.5 ** 3 - 1) * owners * 0.1),
      3,
    );
  });
  it.each([
    8, 9, 10,
  ])('samples independent density from extended owner slot %i', async (densityOwner) => {
    const values = await runInjectReadback({
      sceneDepthClear: 0.43,
      owners: 11,
      extinction: 0.1,
      secondDensity: 128,
      densityOwner,
    });
    expect(values.integrate.alpha[0]).toBeCloseTo(Math.exp(-0.47 * (10 + 128 / 255) * 0.1), 3);
  });
  it('injects raw density then resolves a 2d integrated volume', async () => {
    const values = await runInjectReadback();
    // biome-ignore lint/suspicious/noConsole: stage readback is machine evidence
    console.log(
      JSON.stringify({
        inject: [Math.min(...values.inject.red), Math.max(...values.inject.red)],
        temporal: [Math.min(...values.temporal.red), Math.max(...values.temporal.red)],
        integrate: [Math.min(...values.integrate.red), Math.max(...values.integrate.red)],
      }),
    );
    expect(values.inject.red.filter((value) => value > 0.01).length).toBeGreaterThan(0);
    expect(values.inject.green.some((value) => value > 0.9)).toBe(true);
    expect(values.inject.green.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(values.temporal.red.some((value) => value > 0)).toBe(true);
    expect(values.temporal.alpha.every((value) => value <= 1)).toBe(true);
    expect(values.integrate.red.some((value) => value > 0)).toBe(true);
    expect(values.integrate.alpha.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('clips the final ray step to the scene-depth segment', async () => {
    const values = await runInjectReadback({ sceneDepthClear: 0.43 });
    const transmittance = values.integrate.alpha[0];
    // The fixture uploads an all-white source texture. The authored Three
    // smoke expression therefore evaluates to 2 * 1.5^3 - 1 = 5.75 before
    // Beer-Lambert consumes it; only the final 0.47-unit segment is allowed
    // to contribute after the scene-depth clip.
    const sourceDensity = 2 * 1.5 ** 3 - 1;
    expect(transmittance).toBeCloseTo(Math.exp(-0.47 * sourceDensity), 2);
    expect(values.integrate.red[0]).toBeGreaterThan(0);
  });

  it('keeps a zero medium transparent and applies Beer-Lambert monotonically', async () => {
    const empty = await runInjectReadback({ densityByte: 0 });
    const medium = await runInjectReadback({ densityByte: 128 });
    const dense = await runInjectReadback({ densityByte: 255 });
    const emptyScattering = firstStageValue(empty.integrate.red, 'empty scattering');
    const denseScattering = firstStageValue(dense.integrate.red, 'dense scattering');
    const mediumScattering = firstStageValue(medium.integrate.red, 'medium scattering');
    const emptyTransmission = firstStageValue(empty.integrate.alpha, 'empty transmission');
    const mediumTransmission = firstStageValue(medium.integrate.alpha, 'medium transmission');
    const denseTransmission = firstStageValue(dense.integrate.alpha, 'dense transmission');
    expect(emptyScattering).toBeCloseTo(0, 2);
    expect(emptyTransmission).toBeCloseTo(1, 2);
    expect(denseTransmission).toBeLessThan(mediumTransmission);
    expect(mediumTransmission).toBeLessThan(emptyTransmission);
    expect(denseScattering).toBeGreaterThan(mediumScattering);
  });

  it('keeps extinction monotonic and bounds temporal jitter spread', async () => {
    const lowExtinction = await runInjectReadback({ densityByte: 128, extinction: 0.25 });
    const highExtinction = await runInjectReadback({ densityByte: 128, extinction: 1 });
    const lowTransmission = firstStageValue(lowExtinction.integrate.alpha, 'low extinction');
    const highTransmission = firstStageValue(highExtinction.integrate.alpha, 'high extinction');
    expect(highTransmission).toBeLessThan(lowTransmission);

    const samples: number[] = [];
    for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
      const value = await runInjectReadback({ densityByte: 128, frameIndex });
      const transmission = firstStageValue(value.integrate.alpha, `frame ${frameIndex}`);
      expect(Number.isFinite(transmission)).toBe(true);
      samples.push(transmission);
    }
    const spread = Math.max(...samples) - Math.min(...samples);
    // Frame ordinals must not change a fixed World-time density integral.
    // This remains separate from continuous-frame history and spatial accuracy.
    expect(spread).toBeLessThan(0.2);
  });

  it('converges production step-count variants to the homogeneous Beer oracle', async () => {
    const sceneDepthClear = 0.43;
    const sourceDensity = 2 * 1.5 ** 3 - 1;
    const oracle = Math.exp(-0.47 * sourceDensity);
    const transmissions = await Promise.all(
      [6, 12, 24].map(async (integratorStepCount) => {
        const values = await runInjectReadback({
          sceneDepthClear,
          integratorStepCount,
        });
        return firstStageValue(values.integrate.alpha, `${integratorStepCount}-step transmission`);
      }),
    );
    for (const transmission of transmissions) {
      expect(transmission).toBeCloseTo(oracle, 2);
    }
    expect(Math.max(...transmissions) - Math.min(...transmissions)).toBeLessThan(0.01);
  });

  it('converges production steps against an independent non-uniform Beer reference', async () => {
    const field = createNonUniformDensityField();
    const flattenedField = createFlattenedDensityField(field);
    const reference = nonUniformBeerReference(
      field,
      NON_UNIFORM_EXTINCTION,
      16_384,
      VOLUME_BOUNDS_MIN_Z,
      NON_UNIFORM_BOUNDS_MAX_Z,
    );
    const refinedReference = nonUniformBeerReference(
      field,
      NON_UNIFORM_EXTINCTION,
      32_768,
      VOLUME_BOUNDS_MIN_Z,
      NON_UNIFORM_BOUNDS_MAX_Z,
    );
    const flattenedReference = nonUniformBeerReference(
      flattenedField,
      NON_UNIFORM_EXTINCTION,
      16_384,
      VOLUME_BOUNDS_MIN_Z,
      NON_UNIFORM_BOUNDS_MAX_Z,
    );
    expect(Math.abs(reference - refinedReference)).toBeLessThan(MAX_NON_UNIFORM_BEER_ERROR / 10);
    expect(Math.abs(reference - flattenedReference)).toBeGreaterThan(
      MIN_NON_UNIFORM_REFERENCE_SEPARATION,
    );
    const stepCounts = [24, 48, 96] as const;
    const transmissions = await Promise.all(
      stepCounts.map(async (integratorStepCount) => {
        const values = await runInjectReadback({
          boundsMaxZ: NON_UNIFORM_BOUNDS_MAX_Z,
          densityData: field.data,
          extinction: NON_UNIFORM_EXTINCTION,
          integratorStepCount,
          maxDistance: NON_UNIFORM_BOUNDS_MAX_Z,
          viewDepthScale: 10,
        });
        return firstStageValue(
          values.integrate.alpha,
          `${integratorStepCount}-step non-uniform transmission`,
        );
      }),
    );
    const flattenedValues = await runInjectReadback({
      boundsMaxZ: NON_UNIFORM_BOUNDS_MAX_Z,
      densityData: flattenedField.data,
      extinction: NON_UNIFORM_EXTINCTION,
      integratorStepCount: 96,
      maxDistance: NON_UNIFORM_BOUNDS_MAX_Z,
      viewDepthScale: 10,
    });
    const flattenedTransmission = firstStageValue(
      flattenedValues.integrate.alpha,
      'flattened-field transmission',
    );
    const defaultValues = await runInjectReadback({
      boundsMaxZ: NON_UNIFORM_BOUNDS_MAX_Z,
      densityData: field.data,
      extinction: NON_UNIFORM_EXTINCTION,
      maxDistance: NON_UNIFORM_BOUNDS_MAX_Z,
      viewDepthScale: 10,
    });
    const defaultTransmission = firstStageValue(
      defaultValues.integrate.alpha,
      'production transmission',
    );
    const errors = transmissions.map((transmission) => Math.abs(transmission - reference));
    const flattenedError = Math.abs(flattenedTransmission - flattenedReference);
    const defaultError = Math.abs(defaultTransmission - reference);
    // biome-ignore lint/suspicious/noConsole: non-uniform production convergence receipt.
    console.info(
      '[volumetric-fog-stage-readback] non-uniform-convergence',
      JSON.stringify({
        reference,
        refinedReference,
        flattenedReference,
        stepCounts,
        transmissions,
        errors,
        flattenedTransmission,
        flattenedError,
        defaultTransmission,
        defaultError,
      }),
    );
    for (const error of errors) expect(error).toBeLessThan(MAX_NON_UNIFORM_BEER_ERROR);
    expect(flattenedError).toBeLessThan(MAX_NON_UNIFORM_BEER_ERROR);
    expect(defaultError).toBeLessThan(MAX_NON_UNIFORM_BEER_ERROR);
    expect(Math.abs((transmissions[2] ?? NaN) - flattenedTransmission)).toBeGreaterThan(
      MIN_NON_UNIFORM_GPU_SEPARATION,
    );
    const spread = Math.max(...transmissions) - Math.min(...transmissions);
    // rgba16float readback quantizes nearby step variants onto the same value,
    // so strict error ordering is not a stable production contract. Keep the
    // independent reference and require a bounded cross-step spread instead.
    expect(spread).toBeLessThan(MAX_NON_UNIFORM_BEER_ERROR);
  });
});
