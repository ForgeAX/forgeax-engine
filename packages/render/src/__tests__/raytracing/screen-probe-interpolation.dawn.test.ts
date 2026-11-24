// Controlled geometric/history fields use unit angular measure; RGB is already normalized.
// Actual projected-area sampling is covered by the resolve and Renderer tests.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import {
  SCREEN_PROBE_BINDINGS,
  SCREEN_PROBE_IRRADIANCE_SLOTS,
  SCREEN_PROBE_STAGES,
  SCREEN_PROBE_TRACE_STAGES,
  type ScreenProbeSlot,
} from '../../raytracing/screen-probe-kernels';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_RECORD_BYTES,
} from '../../raytracing/screen-probe-plan';
import { SCREEN_PROBE_SCATTER_NOISE_DESCRIPTOR } from '../../raytracing/screen-probe-scatter-noise';
import { SCREEN_PROBE_SCATTER_NOISE_BASE64 } from '../../raytracing/screen-probe-scatter-noise-data';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import { gbufferNormalPixels } from './gbuffer-normal.fixture';
import {
  canonicalVisibilityPublisher,
  visibilityPlaneField,
} from './irradiance-field-visibility.fixture';
import { rayShaderTestImports } from './ray-shader-imports.fixture';
import {
  distributionPhase,
  packPointRadiance,
  unpackRadianceAmplitudes,
  verifyMixturePacket,
  writeDistributionSamples,
} from './screen-probe-radiance.fixture';

type BindingKind = (typeof SCREEN_PROBE_BINDINGS)[ScreenProbeSlot][1];
type WallMode = 'wall' | 'open' | 'missing-coverage';
type ScreenProbeFrame = Parameters<typeof packScreenProbeFrame>[0];
const PARALLAX_MODES = [
  'near-hit',
  'far-hit',
  'near-black',
  'refined-near',
  'unresolved-near',
  'unused-near',
  'unknown-distance',
] as const;
type ParallaxMode = (typeof PARALLAX_MODES)[number];
// Coplanar receivers sample the same direction at this texel.
const PARALLAX_TEXEL = 27;
const SDF_TEXELS = 33 ** 3;
type InterpolationSlot = (typeof SCREEN_PROBE_STAGES)[
  | 'filterProbeRadiance'
  | 'integrateScreenProbes']['slots'][number];

interface InterpolationStage {
  readonly entryPoint: 'filterProbeRadiance' | 'integrateScreenProbes';
  readonly pipeline: GPUComputePipeline;
  readonly group: GPUBindGroup;
  readonly dispatch: number;
}

interface InterpolationRig {
  readonly device: GPUDevice;
  readonly owned: GPUBuffer[];
  readonly textures: GPUTexture[];
  readonly module: GPUShaderModule;
  readonly frame: GPUBuffer;
  readonly view: GPUBuffer;
  readonly viewBytes: Uint8Array;
  readonly depth: GPUTexture;
  readonly normal: GPUTexture;
  readonly visibility: GPUTexture;
  readonly records: Uint8Array;
  readonly probes: GPUBuffer;
  readonly radiance: Float32Array;
  readonly input: GPUBuffer;
  readonly filtered: GPUBuffer;
  readonly integrated: GPUBuffer;
  readonly readback: GPUBuffer;
  readonly sampleLayout: GPUBindGroupLayout;
  sample: GPUBindGroup;
  readonly visibilitySamples: Record<WallMode, GPUBindGroup>;
  readonly stages: readonly InterpolationStage[];
  readonly controls: Record<string, number[]>;
}

function ownedBuffer(device: GPUDevice, owned: GPUBuffer[], data: Uint8Array, usage = 128 | 4) {
  const value = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
  owned.push(value);
  device.queue.writeBuffer(value, 0, data);
  return value;
}

function bytes(data: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(data.buffer);
}

async function compileInterpolationShader() {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  return (
    await compileShader(read('ray-screen-probe'), {
      id: 'screen-probe-interpolation-visibility',
      imports: await rayShaderTestImports(),
      defines: { IRRADIANCE_FIELD_VISIBILITY: true },
    })
  ).unwrap();
}

/** Two uniform probes over an 8x4 view; only the passed fields differ between phases. */
function packTwoProbeFrame(
  phase: Pick<ScreenProbeFrame, 'screenSteps' | 'maxDistance' | 'sceneHistory' | 'reprojection'>,
): Uint8Array {
  return packScreenProbeFrame({
    worldSource: { traversal: 'unused' },
    layout: {
      width: 8,
      height: 4,
      tilesX: 2,
      tilesY: 1,
      uniformCount: 2,
      adaptiveCapacity: 0,
      probeCount: 2,
    },
    downsample: 4,
    frameIndex: 0,
    importance: 'uniform',
    thickness: 0.02,
    environment: [0, 0, 0],
    shortRangeAo: 0,
    maxFrames: 8,
    pixelHistory: false,
    probeHistory: false,
    worldBias: 0.25,
    cardMargin: 0.125,
    query: new Uint8Array(8),
    ...phase,
  });
}

function textureSampleType(kind: BindingKind): GPUTextureSampleType {
  if (kind === 'depth') return 'depth';
  return kind === 'uint' ? 'uint' : 'unfilterable-float';
}

function bufferBindingType(kind: BindingKind): GPUBufferBindingType {
  if (kind === 'uniform') return 'uniform';
  return kind === 'storage' ? 'storage' : 'read-only-storage';
}

function screenProbeLayoutEntry(slot: ScreenProbeSlot): GPUBindGroupLayoutEntry {
  const [binding, kind] = SCREEN_PROBE_BINDINGS[slot];
  if (kind === 'depth' || kind === 'uint' || kind === 'float')
    return { binding, visibility: 4, texture: { sampleType: textureSampleType(kind) } };
  return { binding, visibility: 4, buffer: { type: bufferBindingType(kind) } };
}

/**
 * Distance/status texels of an edge-on wall at x=0 with 2-cm half thickness.
 * `open` places every texel far from geometry; `missing-coverage` keeps the
 * wall distance but marks its coverage unavailable.
 */
function wallSdf(mode: WallMode): Float32Array {
  const sdf = new Float32Array(SDF_TEXELS * 2);
  for (let i = 0; i < SDF_TEXELS; i++)
    sdf.set(
      [
        mode === 'open' ? 4 : Math.abs(-2 + (i % 33) * 0.125) - 0.02,
        Number(mode !== 'missing-coverage'),
      ],
      i * 2,
    );
  return sdf;
}

function writeVisibility(rig: InterpolationRig, mode: WallMode): void {
  const sdf = wallSdf(mode);
  rig.sample = rig.visibilitySamples[mode];
  rig.device.queue.writeTexture(
    { texture: rig.visibility },
    sdf,
    { bytesPerRow: 33 * 8, rowsPerImage: 33 },
    [33, 33, 33],
  );
}

function createSurface(device: GPUDevice, textures: GPUTexture[]) {
  const depth = device.createTexture({ size: [8, 4], format: 'depth32float', usage: 4 | 16 });
  const normal = device.createTexture({ size: [8, 4], format: 'rg32uint', usage: 4 | 2 });
  const visibility = device.createTexture({
    size: [33, 33, 33],
    dimension: '3d',
    format: 'rg32float',
    usage: 4 | 2,
  });
  textures.push(depth, normal, visibility);
  device.queue.writeTexture(
    { texture: normal },
    gbufferNormalPixels(32),
    { bytesPerRow: 64 },
    [8, 4],
  );
  const clear = device.createCommandEncoder();
  clear
    .beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0.5,
      },
    })
    .end();
  device.queue.submit([clear.finish()]);
  return { depth, normal, visibility };
}

/**
 * Explicit production layouts preserve the complete live-field ABI, even
 * when an entry references only its visibility projection.
 */
function createLiveFieldSample(
  device: GPUDevice,
  owned: GPUBuffer[],
  visibility: GPUTexture,
  sources: Record<WallMode, ReturnType<Awaited<ReturnType<typeof canonicalVisibilityPublisher>>>>,
) {
  const buffer = (data: Uint8Array, usage?: number) => ownedBuffer(device, owned, data, usage);
  const field = buffer(
    packIrradianceFieldUniform(
      { origin: [-1, -1, -1], spacing: 2, dimensions: [2, 2, 2], probeCount: 8, levels: 1 },
      [{ window: [0, 0, 0], min: [0, 0, 0], max: [2, 2, 2] }],
    ),
    64,
  );
  const retained = buffer(new Uint8Array(8 * 144 * 16));
  const moments = buffer(new Uint8Array(8 * 64 * 8));
  const meta = buffer(new Uint8Array(8 * 16));
  const sampleLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
      ...[1, 2, 3].map((binding) => ({
        binding,
        visibility: 4,
        buffer: { type: 'read-only-storage' as const },
      })),
      { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
      {
        binding: 5,
        visibility: 4,
        texture: { sampleType: 'unfilterable-float', viewDimension: '3d' },
      },
      { binding: 6, visibility: 4, texture: { sampleType: 'uint', viewDimension: '2d' } },
    ],
  });
  const group = (source: (typeof sources)[WallMode]) =>
    device.createBindGroup({
      layout: sampleLayout,
      entries: [
        ...[field, retained, moments, meta, source.settings].map((value, binding) => ({
          binding,
          resource: { buffer: value },
        })),
        { binding: 5, resource: visibility.createView() },
        { binding: 6, resource: source.view },
      ],
    });
  const visibilitySamples = {
    wall: group(sources.wall),
    open: group(sources.open),
    'missing-coverage': group(sources['missing-coverage']),
  };
  return { sampleLayout, sample: visibilitySamples.open, visibilitySamples };
}

function createScreenProbeStage(
  device: GPUDevice,
  module: GPUShaderModule,
  sampleLayout: GPUBindGroupLayout,
  entryPoint: InterpolationStage['entryPoint'],
  resources: Readonly<Record<InterpolationSlot, GPUBindingResource>>,
): InterpolationStage {
  const spec = SCREEN_PROBE_STAGES[entryPoint];
  const slots: readonly InterpolationSlot[] = spec.slots;
  const layout = device.createBindGroupLayout({ entries: slots.map(screenProbeLayoutEntry) });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sampleLayout] }),
    compute: { module, entryPoint },
  });
  const group = device.createBindGroup({
    layout,
    entries: slots.map((slot) => ({
      binding: SCREEN_PROBE_BINDINGS[slot][0],
      resource: resources[slot],
    })),
  });
  return { entryPoint, pipeline, group, dispatch: spec.dispatch === 'probes' ? 2 : 1 };
}

async function createInterpolationRig(
  device: GPUDevice,
  wgsl: string,
  owned: GPUBuffer[],
  textures: GPUTexture[],
  releases: (() => void)[],
): Promise<InterpolationRig> {
  const buffer = (data: Uint8Array, usage?: number) => ownedBuffer(device, owned, data, usage);
  const frame = buffer(
    packTwoProbeFrame({
      screenSteps: 0,
      maxDistance: 100,
      sceneHistory: false,
      reprojection: undefined,
    }),
    64,
  );
  const records = new Uint8Array(2 * SCREEN_PROBE_RECORD_BYTES);
  const floats = new Float32Array(records.buffer);
  const words = new Uint32Array(records.buffer);
  for (let i = 0; i < 2; i++) {
    floats.set([i - 0.5, 0, 0, 1, 0, 0, 1], i * (SCREEN_PROBE_RECORD_BYTES / 4));
    words[i * (SCREEN_PROBE_RECORD_BYTES / 4) + 7] = i;
  }
  const probes = buffer(records);
  const count = buffer(new Uint8Array(4));
  const radiance = new Float32Array(2 * 64 * 8);
  const input = buffer(new Uint8Array(2 * 64 * 40));
  const filtered = buffer(new Uint8Array(2 * 64 * 40));
  const integrated = buffer(new Uint8Array(8 * 4 * 16));
  const tileAdaptive = buffer(bytes(new Uint32Array(8).fill(0xffffffff)));
  const viewBytes = new Uint8Array(VIEW_UNIFORM_BYTES);
  const viewFloats = new Float32Array(viewBytes.buffer);
  viewFloats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1], 0);
  viewFloats.set([0, 0, 1], 24);
  viewFloats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1], 44);
  const view = buffer(viewBytes, 64);
  const { depth, normal, visibility } = createSurface(device, textures);
  const publish = await canonicalVisibilityPublisher(device);
  const wallField = await visibilityPlaneField(0);
  const wall = {
    instanceId: 7,
    geometryId: 9,
    mask: 255,
    surfaceCoverage: 'opaque' as const,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    field: wallField,
  };
  const grid = {
    origin: [-2, -2, -2] as const,
    dimensions: [33, 33, 33] as const,
    spacing: 0.125,
    maxDistance: 4,
    coverageDistance: 0.0625,
  };
  const sources = {
    wall: publish([wall], grid),
    open: publish([], grid),
    'missing-coverage': publish(
      [{ ...wall, field: { missing: true as const, bounds: wallField.bounds } }],
      grid,
    ),
  };
  const projected = device.createCommandEncoder();
  for (const source of Object.values(sources)) {
    releases.push(() => source.dispose());
    source.record(projected);
  }
  device.queue.submit([projected.finish()]);
  const { sampleLayout, sample, visibilitySamples } = createLiveFieldSample(
    device,
    owned,
    visibility,
    sources,
  );
  const module = device.createShaderModule({ code: wgsl });
  const resources = {
    frame: { buffer: frame },
    view: { buffer: view },
    depth: depth.createView(),
    normal: normal.createView(),
    probesIn: { buffer: probes },
    adaptiveCountIn: { buffer: count },
    radianceIn: { buffer: input },
    radianceOut: { buffer: filtered },
    probeRadiance: { buffer: input },
    tileAdaptiveIn: { buffer: tileAdaptive },
    integratedOut: { buffer: integrated },
  };
  const stages = [
    createScreenProbeStage(device, module, sampleLayout, 'filterProbeRadiance', resources),
    createScreenProbeStage(device, module, sampleLayout, 'integrateScreenProbes', resources),
  ];
  return {
    device,
    owned,
    textures,
    module,
    frame,
    view,
    viewBytes,
    depth,
    normal,
    visibility,
    records,
    probes,
    radiance,
    input,
    filtered,
    integrated,
    readback: buffer(new Uint8Array(filtered.size + integrated.size), 1),
    sampleLayout,
    sample,
    visibilitySamples,
    stages,
    controls: {},
  };
}

function encodeStage(
  rig: InterpolationRig,
  encoder: GPUCommandEncoder,
  stage: InterpolationStage,
): void {
  const pass = encoder.beginComputePass();
  pass.setPipeline(stage.pipeline);
  pass.setBindGroup(0, stage.group);
  pass.setBindGroup(1, rig.sample);
  pass.dispatchWorkgroups(stage.dispatch);
  pass.end();
}

async function readFloats(
  rig: InterpolationRig,
  encoder: GPUCommandEncoder,
  decodeAmplitudes = true,
): Promise<Float32Array> {
  rig.device.queue.submit([encoder.finish()]);
  await rig.readback.mapAsync(1);
  const data = new Float32Array(rig.readback.getMappedRange()).slice();
  rig.readback.unmap();
  if (decodeAmplitudes) unpackRadianceAmplitudes(data, rig.filtered.size / (64 * 40));
  return data;
}

/** Run the production filter alone and read back its probe radiance. */
async function runFilter(rig: InterpolationRig, decodeAmplitudes = true): Promise<Float32Array> {
  const encoder = rig.device.createCommandEncoder();
  const value = rig.stages.find((stage) => stage.entryPoint === 'filterProbeRadiance');
  if (value === undefined) throw new Error('production filter pipeline required');
  encodeStage(rig, encoder, value);
  encoder.copyBufferToBuffer(rig.filtered, 0, rig.readback, 0, rig.filtered.size);
  return readFloats(rig, encoder, decodeAmplitudes);
}

/** Filter and integrate across one edge-on wall, recording each side's receiver probe and pixel. */
async function recordWallControls(rig: InterpolationRig): Promise<void> {
  const { radiance, filtered, integrated } = rig;
  for (const side of [-1, 1]) {
    for (const mode of ['wall', 'open', 'constant', 'missing-coverage'] as const) {
      for (let i = 0; i < 128; i++) {
        const value = mode === 'constant' || (i < 64 ? side < 0 : side > 0) ? 0.25 : 3;
        radiance.set([value, value, value, 1, -1, 1], i * 8);
      }
      rig.device.queue.writeBuffer(
        rig.input,
        0,
        packPointRadiance(radiance, radiance.length / (64 * 8)),
      );
      writeVisibility(rig, mode === 'constant' ? 'wall' : mode);
      const encoder = rig.device.createCommandEncoder();
      for (const stage of rig.stages) encodeStage(rig, encoder, stage);
      encoder.copyBufferToBuffer(filtered, 0, rig.readback, 0, filtered.size);
      encoder.copyBufferToBuffer(integrated, 0, rig.readback, filtered.size, integrated.size);
      const data = await readFloats(rig, encoder);
      const probe = side < 0 ? 0 : 1;
      const pixel = side < 0 ? 3 : 4;
      rig.controls[`${side}:${mode}:filter`] = Array.from(
        data.slice(probe * 64 * 8, probe * 64 * 8 + 4),
      );
      rig.controls[`${side}:${mode}:integrate`] = Array.from(
        data.slice(filtered.size / 4 + pixel * 4, filtered.size / 4 + pixel * 4 + 4),
      );
    }
  }
}

/**
 * Resolve owns the endpoint metadata; these filter controls isolate its
 * consumption. The support suite verifies packed/refined ray reduction on
 * the actual resolve kernel independently.
 */
function parallaxHitDistance(mode: ParallaxMode, receiverProbe: boolean): number {
  if (mode === 'unknown-distance') return -1;
  const near = !['far-hit', 'unresolved-near', 'unused-near'].includes(mode);
  return receiverProbe && near ? 0.02 : 100;
}

/**
 * Coplanar receivers can see different radiance along the same direction:
 * a near hit at the dark receiver must reject a distant bright neighbor.
 * The far/far control keeps useful spatial filtering across an open plane.
 */
async function recordParallaxControls(rig: InterpolationRig): Promise<void> {
  const { radiance } = rig;
  for (const side of [-1, 1]) {
    for (const mode of PARALLAX_MODES) {
      const receiver = side < 0 ? 0 : 1;
      for (let i = 0; i < 128; i++) {
        const probe = Math.floor(i / 64);
        const value = probe === receiver ? (mode === 'near-black' ? 0 : 0.25) : 3;
        radiance.set([value, value, value, 1, -1, 1], i * 8);
        radiance[i * 8 + 4] = parallaxHitDistance(mode, probe === receiver);
      }
      rig.device.queue.writeBuffer(
        rig.input,
        0,
        packPointRadiance(radiance, radiance.length / (64 * 8)),
      );
      writeVisibility(rig, 'open');
      const data = await runFilter(rig);
      const offset = (receiver * 64 + PARALLAX_TEXEL) * 8;
      rig.controls[`${side}:${mode}:filter`] = Array.from(data.slice(offset, offset + 4));
    }
  }
}

function writeDirectionalSupportRadiance(radiance: Float32Array): void {
  for (let texel = 0; texel < 64; texel++) {
    const support = texel % 3 === 0 ? 0 : texel % 3 === 1 ? -1 : 1;
    radiance.set([texel / 64, 0, 0, support, -1, 1], texel * 8);
    radiance.set([2 + texel / 64, 0, 0, texel % 4 === 0 ? 0 : 1, -1, 1], (64 + texel) * 8);
  }
}

function expectDirectionalSupport(
  mode: WallMode,
  radiance: Float32Array,
  data: Float32Array,
): void {
  for (let probe = 0; probe < 2; probe++) {
    for (let texel = 0; texel < 64; texel++) {
      const index = (probe * 64 + texel) * 8;
      const neighbor = ((1 - probe) * 64 + texel) * 8;
      const mixed = mode === 'open' && radiance[index + 3] === 1 && radiance[neighbor + 3] === 1;
      for (let c = 0; c < 3; c++) {
        const expected = c === 0 ? texel / 64 + (mixed ? 1 : 2 * probe) : 0;
        expect(data[index + c], `${mode}:${probe}:${texel}:${c}`).toBeCloseTo(expected, 5);
      }
      expect(data[index + 3], `${mode}:${probe}:${texel}:support`).toBe(radiance[index + 3]);
    }
  }
}

/**
 * Shared geometric weights must not share directional transport support.
 * Every lane crosses the workgroup barrier, including missing/black lanes.
 */
async function verifyDirectionalSupport(rig: InterpolationRig): Promise<void> {
  for (const mode of ['open', 'wall', 'missing-coverage'] as const) {
    writeDirectionalSupportRadiance(rig.radiance);
    rig.device.queue.writeBuffer(
      rig.input,
      0,
      packPointRadiance(rig.radiance, rig.radiance.length / (64 * 8)),
    );
    writeVisibility(rig, mode);
    const data = (await runFilter(rig)).slice(0, rig.filtered.size / 4);
    rig.controls[`${mode}:directional-support`] = Array.from(data);
    expectDirectionalSupport(mode, rig.radiance, data);
  }
}

/** Constant physical radiance with unequal, direction-dependent angular areas. */
async function verifyVaryingMeasure(rig: InterpolationRig): Promise<void> {
  for (let p = 0; p < 2; p++)
    for (let t = 0; t < 64; t++) {
      const measure = p === 0 ? 0.5 + 0.05 * t : 3 + 0.02 * t;
      rig.radiance.set(
        [0.25 * measure, 0.25 * measure, 0.25 * measure, 1, -1, measure],
        (p * 64 + t) * 8,
      );
    }
  rig.device.queue.writeBuffer(
    rig.input,
    0,
    packPointRadiance(rig.radiance, rig.radiance.length / (64 * 8)),
  );
  writeVisibility(rig, 'open');
  const encoder = rig.device.createCommandEncoder();
  for (const stage of rig.stages) encodeStage(rig, encoder, stage);
  encoder.copyBufferToBuffer(rig.filtered, 0, rig.readback, 0, rig.filtered.size);
  encoder.copyBufferToBuffer(
    rig.integrated,
    0,
    rig.readback,
    rig.filtered.size,
    rig.integrated.size,
  );
  const data = await readFloats(rig, encoder);
  rig.controls['varying-measure'] = Array.from(data);
  for (let p = 0; p < 2; p++)
    for (let t = 0; t < 64; t++) {
      const index = (p * 64 + t) * 8;
      const measure = (0.5 + 0.05 * t + 3 + 0.02 * t) / 2;
      expect(data[index + 5], `measure:${p}:${t}`).toBeCloseTo(measure, 5);
      expect(data[index + 3]).toBe(1);
      for (let c = 0; c < 3; c++)
        expect(data[index + c], `numerator:${p}:${t}:${c}`).toBeCloseTo(0.25 * measure, 5);
    }
  for (const pixel of [3, 4]) {
    const index = rig.filtered.size / 4 + pixel * 4;
    for (let c = 0; c < 3; c++) expect(data[index + c]).toBeCloseTo(0.25, 5);
    expect(data[index + 3]).toBe(1);
  }
}

/** Actual filter kernel must copy the independently selected distribution. */
async function verifyMixedDirections(rig: InterpolationRig): Promise<void> {
  const logical = new Float32Array(rig.radiance.length);
  for (let i = 0; i < 128; i++) {
    logical[i * 8 + 3] = 1;
    logical[i * 8 + 4] = -1;
    logical[i * 8 + 5] = 1;
  }
  const packets = packPointRadiance(logical, 2);
  for (let p = 0; p < 2; p++)
    for (let t = 0; t < 64; t++) writeDistributionSamples(packets, (p * 64 + t) * 10, p, t);
  rig.device.queue.writeBuffer(rig.input, 0, packets);
  const pixels = new Uint32Array(rig.records.buffer);
  const recordWords = SCREEN_PROBE_RECORD_BYTES / Uint32Array.BYTES_PER_ELEMENT;
  for (const mode of ['open', 'wall', 'missing-coverage'] as const) {
    writeVisibility(rig, mode);
    const result = await runFilter(rig, false),
      words = new Uint32Array(result.buffer, result.byteOffset, result.length),
      measurements: number[] = [];
    rig.controls[`${mode}:mixed-directions`] = measurements;
    for (let p = 0; p < 2; p++)
      for (let t = 0; t < 64; t++) {
        const offset = (p * 64 + t) * 10,
          phase = distributionPhase(pixels[p * recordWords + 7] ?? NaN, t, 0xf177e);
        const inputs = [{ data: packets, offset, weight: 1 }];
        if (mode === 'open')
          inputs.push({ data: packets, offset: ((1 - p) * 64 + t) * 10, weight: 1 });
        const actual = verifyMixturePacket(result, offset, t, inputs, phase);
        expect(words[offset + 8] ?? 0).toBe(0x3f800000);
        expect(result[offset + 9]).toBe(-1);
        measurements.push(phase, ...actual);
      }
  }
}

function createScreenTrace(rig: InterpolationRig) {
  const { device } = rig;
  const buffer = (data: Uint8Array, usage?: number) => ownedBuffer(device, rig.owned, data, usage);
  const screenPyramid = device.createTexture({ size: [8, 4], format: 'r32float', usage: 4 | 2 });
  rig.textures.push(screenPyramid);
  const rays = buffer(new Uint8Array(2 * 64 * 32));
  const previousScene = buffer(new Uint8Array(new Uint32Array(64).fill(0x42004200).buffer));
  const previousWords = new Uint32Array(64);
  for (let i = 0; i < 32; i++) previousWords.set([0x42004200, 0x3c004200], i * 2);
  device.queue.writeBuffer(previousScene, 0, previousWords);
  const screenReadback = buffer(new Uint8Array(rays.size), 1);
  const screenLayout = device.createBindGroupLayout({
    entries: SCREEN_PROBE_STAGES.traceScreenProbes.slots.map(screenProbeLayoutEntry),
  });
  const screen = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [screenLayout, rig.sampleLayout] }),
    compute: { module: rig.module, entryPoint: 'traceScreenProbes' },
  });
  const screenResources = {
    frame: { buffer: rig.frame },
    view: { buffer: rig.view },
    depth: rig.depth.createView(),
    normal: rig.normal.createView(),
    depthPyramid: screenPyramid.createView(),
    probesIn: { buffer: rig.probes },
    rays: { buffer: rays },
    previousScene: { buffer: previousScene },
  };
  const screenGroup = device.createBindGroup({
    layout: screen.getBindGroupLayout(0),
    entries: SCREEN_PROBE_STAGES.traceScreenProbes.slots.map((slot) => ({
      binding: SCREEN_PROBE_BINDINGS[slot][0],
      resource: screenResources[slot],
    })),
  });
  const vf = new Float32Array(rig.viewBytes.buffer);
  vf.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  vf.set([0, 1, 1, 0], 228);
  device.queue.writeBuffer(rig.view, 0, rig.viewBytes);
  device.queue.writeBuffer(
    rig.frame,
    0,
    packTwoProbeFrame({
      screenSteps: 32,
      maxDistance: 1.4,
      sceneHistory: true,
      reprojection: {
        viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        cameraPosition: [0, 0, 1],
      },
    }),
  );
  return { screenPyramid, rays, screenReadback, screen, screenGroup };
}

/** A front-hemisphere ray crosses x=0; HZB covers only its far endpoint. */
function writeScreenTraceSide(
  rig: InterpolationRig,
  trace: ReturnType<typeof createScreenTrace>,
  side: number,
): void {
  const { device } = rig;
  // Keep the open-field positive control eligible for Screen resolution.
  // An exactly tangent ray now conservatively delegates to world traversal,
  // which would make all three visibility cases reject before checking a wall.
  // The separate Screen-origin owner retains that tangent-route regression.
  new Float32Array(rig.records.buffer).set([side * 0.5, 0, 0, 1, -side * 0.1, 0, Math.sqrt(0.99)]);
  new Uint32Array(rig.records.buffer)[7] = 0;
  device.queue.writeBuffer(rig.probes, 0, rig.records);
  const pyramid = new Float32Array(32);
  for (let i = 0; i < 32; i++)
    pyramid[i] = (side < 0 ? i % 8 >= 6 : i % 8 < 2) ? 0.75 : 3.402823e38;
  device.queue.writeTexture({ texture: trace.screenPyramid }, pyramid, { bytesPerRow: 32 }, [8, 4]);
  device.queue.writeTexture(
    { texture: rig.normal },
    gbufferNormalPixels(32, [side, 0, 0]),
    { bytesPerRow: 64 },
    [8, 4],
  );
}

function writeScreenTraceRays(
  rig: InterpolationRig,
  trace: ReturnType<typeof createScreenTrace>,
  side: number,
): void {
  const rayBytes = new Uint8Array(trace.rays.size);
  const ru = new Uint32Array(rayBytes.buffer);
  const rf = new Float32Array(rayBytes.buffer);
  for (let i = 0; i < 128; i++) {
    ru[i * 8 + 3] = 3 << 12;
    rf[i * 8 + 7] = -1;
  }
  rf.set([-side, 0, 0]);
  ru[3] = (1 << 12) | 512;
  rig.device.queue.writeBuffer(trace.rays, 0, rayBytes);
}

async function traceScreenRay(
  rig: InterpolationRig,
  trace: ReturnType<typeof createScreenTrace>,
): Promise<Uint8Array> {
  const encoder = rig.device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(trace.screen);
  pass.setBindGroup(0, trace.screenGroup);
  pass.setBindGroup(1, rig.sample);
  pass.dispatchWorkgroups(2);
  pass.end();
  encoder.copyBufferToBuffer(trace.rays, 0, trace.screenReadback, 0, trace.rays.size);
  rig.device.queue.submit([encoder.finish()]);
  await trace.screenReadback.mapAsync(1);
  const actual = new Uint8Array(trace.screenReadback.getMappedRange()).slice();
  trace.screenReadback.unmap();
  return actual;
}

function expectScreenTrace(label: string, mode: WallMode, values: Float32Array, state: number) {
  expect(state, `${label}:screen`).toBe(mode === 'open' ? 0 : 1);
  for (let c = 4; c < 7; c++) expect(values[c]).toBe(mode === 'open' ? 3 : 0);
  if (mode === 'open') expect(values[7], `${label}:hit-distance`).toBeGreaterThan(0);
  else expect(values[7], `${label}:hit-distance`).toBe(-1);
}

/**
 * A visible bright endpoint across an edge-on wall must not bypass world
 * tracing merely because HZB lacks the intervening occluder's coverage.
 * Reuse the same actual production field ABI and mirrored 4-cm wall.
 */
async function verifyScreenTraceRejection(rig: InterpolationRig): Promise<void> {
  const trace = createScreenTrace(rig);
  for (const side of [-1, 1]) {
    for (const mode of ['wall', 'open', 'missing-coverage'] as const) {
      writeScreenTraceSide(rig, trace, side);
      writeVisibility(rig, mode);
      writeScreenTraceRays(rig, trace, side);
      const actual = await traceScreenRay(rig, trace);
      const values = new Float32Array(actual.buffer);
      const state = (new DataView(actual.buffer).getUint32(12, true) >>> 12) & 7;
      rig.controls[`${side}:${mode}:screen`] = [state, ...values.slice(4, 8)];
      expectScreenTrace(`${side}:${mode}`, mode, values, state);
    }
  }
}

function expectParallaxControls(controls: Record<string, number[]>, side: number): void {
  for (const c of [0, 1, 2]) {
    expect(controls[`${side}:near-hit:filter`]?.[c], `${side}:near-hit:${c}`).toBeCloseTo(0.25, 5);
    expect(controls[`${side}:near-black:filter`]?.[c], `${side}:near-black:${c}`).toBe(0);
    expect(controls[`${side}:refined-near:filter`]?.[c], `${side}:refined-near:${c}`).toBeCloseTo(
      0.25,
      5,
    );
    expect(controls[`${side}:far-hit:filter`]?.[c], `${side}:far-hit:${c}`).toBeGreaterThan(1.5);
    for (const mode of ['unresolved-near', 'unused-near'])
      expect(controls[`${side}:${mode}:filter`]?.[c], `${side}:${mode}:${c}`).toBeGreaterThan(1.5);
    expect(controls[`${side}:unknown-distance:filter`]?.[c], `${side}:unknown-distance:${c}`).toBe(
      1.625,
    );
  }
  for (const mode of [
    'near-hit',
    'near-black',
    'far-hit',
    'refined-near',
    'unresolved-near',
    'unused-near',
    'unknown-distance',
  ])
    expect(controls[`${side}:${mode}:filter`]?.[3]).toBe(1);
}

function expectWallControls(controls: Record<string, number[]>, side: number): void {
  for (const stage of ['filter', 'integrate']) {
    for (const mode of ['wall', 'constant']) {
      const value = controls[`${side}:${mode}:${stage}`];
      for (let c = 0; c < 3; c++)
        expect(value?.[c], `${side}:${mode}:${stage}`).toBeCloseTo(0.25, 5);
      expect(value?.[3]).toBe(1);
    }
    expect(controls[`${side}:open:${stage}`]?.[0]).toBeGreaterThan(1);
  }
  expect(controls[`${side}:missing-coverage:filter`]?.[0]).toBeCloseTo(0.25, 5);
  expect(controls[`${side}:missing-coverage:integrate`]).toEqual([0, 0, 0, 0]);
}

function writeInterpolationArtifact(
  status: string,
  controls: Record<string, number[]>,
  errors: readonly string[],
): void {
  mkdirSync('artifacts/screen-probe/interpolation', { recursive: true });
  writeFileSync(
    'artifacts/screen-probe/interpolation/result.json',
    JSON.stringify(
      { status, backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn', controls, errors },
      null,
      2,
    ),
  );
}

it('reconstructs Screen Probe lighting from plane-compatible uniform and adaptive samples', async () => {
  const compiled = await compileInterpolationShader();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe interpolation requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const buffers: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  const makeBuffer = (data: Uint8Array, usage?: number) =>
    ownedBuffer(device, buffers, data, usage);
  const results: Record<string, number[]> = {};
  try {
    const { depth, normal } = createSurface(device, textures);
    const frameData = packTwoProbeFrame({
      screenSteps: 0,
      maxDistance: 100,
      sceneHistory: false,
      reprojection: undefined,
    });
    new Uint32Array(frameData.buffer)[5] = 1;
    const viewData = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    viewData.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1], 0);
    viewData.set([0, 0, 1], 24);
    viewData.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1], 44);
    const frame = makeBuffer(frameData, 64);
    const view = makeBuffer(bytes(viewData), 64);
    const records = new Float32Array((3 * SCREEN_PROBE_RECORD_BYTES) / 4);
    const stride = SCREEN_PROBE_RECORD_BYTES / 4;
    const probes = makeBuffer(bytes(records));
    const adaptiveCount = makeBuffer(bytes(new Uint32Array([1])));
    const quadrants = new Uint32Array(8).fill(0xffffffff);
    const adaptive = makeBuffer(bytes(quadrants));
    const octahedral = new Float32Array(3 * 16 * 10);
    for (let texel = 0; texel < 16; texel++) {
      octahedral.set([0, 0, 0, 3], texel * 10);
      octahedral.set([7, 5, 3, 3], (32 + texel) * 10);
    }
    const radiance = makeBuffer(bytes(octahedral));
    const output = makeBuffer(new Uint8Array(8 * 4 * 16));
    const readback = makeBuffer(new Uint8Array(16), 1);
    const resources = {
      frame: { buffer: frame },
      view: { buffer: view },
      depth: depth.createView(),
      normal: normal.createView(),
      probesIn: { buffer: probes },
      adaptiveCountIn: { buffer: adaptiveCount },
      tileAdaptiveIn: { buffer: adaptive },
      probeRadiance: { buffer: radiance },
      integratedOut: { buffer: output },
    };
    const slots = SCREEN_PROBE_STAGES.integrateScreenProbes.slots;
    const layout = device.createBindGroupLayout({ entries: slots.map(screenProbeLayoutEntry) });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: compiled.wgsl }),
        entryPoint: 'integrateScreenSpaceScreenProbes',
      },
    });
    const group = device.createBindGroup({
      layout,
      entries: slots.map((slot) => ({
        binding: SCREEN_PROBE_BINDINGS[slot][0],
        resource: resources[slot],
      })),
    });
    const integrateAt = async (pixel: number) => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, pixel * 16, readback, 0, 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const result = Array.from(new Float32Array(readback.getMappedRange()));
      readback.unmap();
      return result;
    };
    for (const [name, probeZ, adaptiveIndex, expected] of [
      ['known-black', 0, 2, [0, 0, 0, 3]],
      ['wrong-plane', 1, 0xffffffff, [0, 0, 0, 0]],
      ['adaptive-replacement', 1, 2, [7, 5, 3, 3]],
      ['stale-adaptive', 1, 3, [0, 0, 0, 0]],
      // At view depth 1, this offset fails the preferred weight floor and
      // retains the soft plane weight with the encoded half-confidence penalty.
      ['soft-plane-fallback', 0.035, 0xffffffff, [0, 0, 0, 2 + 0.5 * 2 ** (-1000 * 0.035 ** 2)]],
    ] as const) {
      records.set([-0.875, 0.75, probeZ, 1, 0, 0, 1], 0);
      records.set([-0.875, 0.75, 0, 1, 0, 0, 1], 2 * stride);
      quadrants[0] = adaptiveIndex;
      device.queue.writeBuffer(probes, 0, records);
      device.queue.writeBuffer(adaptive, 0, quadrants);
      const result = await integrateAt(0);
      results[name] = result;
      for (const [channel, value] of expected.entries()) {
        expect(result[channel], name).toBeCloseTo(value, 4);
      }
    }
    const frameWords = new Uint32Array(frameData.buffer);
    frameWords[5] = 0;
    frameWords[10] = 2;
    frameWords[23] = 4 | 32;
    records.set([-0.875, 0.75, 0, 1, 0, 0, 1], 0);
    records.set([0.875, 0.75, 0, 1, 0, 0, 1], stride);
    device.queue.writeBuffer(probes, 0, records);
    for (let texel = 0; texel < 16; texel++) {
      octahedral.set([1, 1, 1, 3], texel * 10);
      octahedral.set([5, 5, 5, 3], (16 + texel) * 10);
    }
    device.queue.writeBuffer(radiance, 0, octahedral);
    const samples = [];
    for (let seed = 0; seed < 96; seed++) {
      frameWords[7] = seed;
      device.queue.writeBuffer(frame, 0, frameData);
      const value = (await integrateAt(3))[0] ?? 0;
      expect([1, 5]).toContain(value);
      samples.push(value);
    }
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    expect(Math.abs(mean - (1 + (4 * 3) / 7))).toBeLessThan(0.5);
    results['stochastic-counts-and-mean'] = [
      samples.filter((value) => value === 1).length,
      samples.filter((value) => value === 5).length,
      mean,
    ];
    octahedral.fill(0, 16 * 10, 32 * 10);
    device.queue.writeBuffer(radiance, 0, octahedral);
    for (let seed = 0; seed < 12; seed++) {
      frameWords[7] = seed;
      device.queue.writeBuffer(frame, 0, frameData);
      expect((await integrateAt(3))[0]).toBeCloseTo(1, 5);
    }
    const measure = (4 * Math.PI) / 64;
    const input = new Float32Array(2 * 64 * 8);
    for (let texel = 0; texel < 128; texel++) {
      input.set([3 * measure, 2 * measure, measure, 1, 1, measure, 0, 0], texel * 8);
    }
    const source = makeBuffer(bytes(packPointRadiance(input, 2)));
    const projectionSlots = SCREEN_PROBE_IRRADIANCE_SLOTS;
    const projectionLayout = device.createBindGroupLayout({
      entries: projectionSlots.map(screenProbeLayoutEntry),
    });
    const projection = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [projectionLayout] }),
      compute: {
        module: device.createShaderModule({ code: compiled.wgsl }),
        entryPoint: 'preintegrateScreenProbes',
      },
    });
    const projectionResources = {
      ...resources,
      probeRadiance: { buffer: source },
      radianceOut: { buffer: radiance },
    };
    const projectionGroup = device.createBindGroup({
      layout: projectionLayout,
      entries: projectionSlots.map((slot) => ({
        binding: SCREEN_PROBE_BINDINGS[slot][0],
        resource: projectionResources[slot],
      })),
    });
    frameWords[10] = 24; // Current hardware support, with no pixel history.
    frameWords[23] = 4 | 64;
    device.queue.writeBuffer(frame, 0, frameData);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(projection);
    pass.setBindGroup(0, projectionGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(radiance, 0, readback, 0, 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const dc = Array.from(new Float32Array(readback.getMappedRange()));
    readback.unmap();
    const dcMass = (4 * Math.PI) / Math.sqrt(4 * Math.PI);
    for (const [channel, gain] of [3, 2, 1, 1].entries()) {
      expect(dc[channel]).toBeCloseTo(dcMass * gain, 4);
    }
    const diffuse = await integrateAt(3);
    expect(diffuse.slice(0, 3)).toEqual([3, 2, 1].map((value) => expect.closeTo(value, 5)));
    results['sh3-uniform-dc'] = dc;
    results['sh3-uniform-diffuse'] = diffuse;
    const aoData = new Float32Array(4 * 2 * 4);
    const aoBuffer = makeBuffer(bytes(aoData));
    const noiseDesc = SCREEN_PROBE_SCATTER_NOISE_DESCRIPTOR;
    const noise = device.createTexture(noiseDesc);
    textures.push(noise);
    device.queue.writeTexture(
      { texture: noise },
      Uint8Array.from(atob(SCREEN_PROBE_SCATTER_NOISE_BASE64), (byte) => byte.charCodeAt(0)),
      { bytesPerRow: noiseDesc.size.width * 2, rowsPerImage: noiseDesc.size.height },
      noiseDesc.size,
    );
    const albedo = device.createTexture({ size: [8, 4], format: 'r32uint', usage: 2 | 4 });
    textures.push(albedo);
    const writeBaseColor = (packed: number) =>
      device.queue.writeTexture(
        { texture: albedo },
        new Uint32Array(32).fill(packed),
        { bytesPerRow: 32 },
        [8, 4],
      );
    const furthestDepth = device.createTexture({ size: [4, 2], format: 'r32float', usage: 4 | 8 });
    textures.push(furthestDepth);
    const furthestDepthView = furthestDepth.createView();
    const seedAoDepth = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: compiled.wgsl }),
        entryPoint: 'seedScreenProbeFurthestDepth',
      },
    });
    const seedAoDepthInputs = device.createBindGroup({
      layout: seedAoDepth.getBindGroupLayout(0),
      entries: [
        { binding: SCREEN_PROBE_BINDINGS.depth[0], resource: depth.createView() },
        {
          binding: SCREEN_PROBE_BINDINGS.shortRangeAoFurthestDepthOut[0],
          resource: furthestDepthView,
        },
      ],
    });
    const aoMeta = new Uint32Array(32 * 4);
    const metaIn = makeBuffer(bytes(aoMeta));
    const aoResources = {
      ...resources,
      depthPyramid: furthestDepthView,
      shortRangeAoOut: { buffer: aoBuffer },
      scatterNoise: noise.createView(),
      albedo: albedo.createView(),
      metaIn: { buffer: metaIn },
    };
    const makeAoStage = (
      entryPoint:
        | 'computeScreenProbeShortRangeAo'
        | 'applyScreenProbeShortRangeAo'
        | 'applyScreenProbeAoHistory'
        | 'applyScreenProbeAoHistoryCompact',
    ) => {
      const aoInput = {
        ...aoResources,
        shortRangeAoIn: { buffer: aoBuffer },
        integrated: {
          buffer: makeBuffer(
            bytes(Float32Array.from({ length: 8 * 4 * 4 }, (_, i) => [3, 2, 1, 3][i % 4] ?? 0)),
          ),
        },
      };
      const aoSlots = SCREEN_PROBE_TRACE_STAGES[entryPoint].slots;
      const layout = device.createBindGroupLayout({ entries: aoSlots.map(screenProbeLayoutEntry) });
      const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: device.createShaderModule({ code: compiled.wgsl }), entryPoint },
      });
      const bind = device.createBindGroup({
        layout,
        entries: aoSlots.map((slot) => ({
          binding: SCREEN_PROBE_BINDINGS[slot][0],
          resource: aoInput[slot],
        })),
      });
      return async (buffer: GPUBuffer, offset: number) => {
        const encoder = device.createCommandEncoder();
        if (entryPoint === 'computeScreenProbeShortRangeAo') {
          const seed = encoder.beginComputePass();
          seed.setPipeline(seedAoDepth);
          seed.setBindGroup(0, seedAoDepthInputs);
          seed.dispatchWorkgroups(1);
          seed.end();
        }
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(buffer, offset, readback, 0, 16);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(1);
        const result = Array.from(new Float32Array(readback.getMappedRange()));
        readback.unmap();
        return result;
      };
    };
    viewData.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1], 0);
    device.queue.writeBuffer(view, 0, viewData);
    frameWords[23] = 4 | 128 | 256;
    new Float32Array(frameData.buffer)[17] = 0.5;
    device.queue.writeBuffer(frame, 0, frameData);
    const computeAo = makeAoStage('computeScreenProbeShortRangeAo');
    const applyAo = makeAoStage('applyScreenProbeShortRangeAo');
    const open = await computeAo(aoBuffer, 5 * 16);
    expect(open[3]).toBeCloseTo(1, 3);
    const savedPhase = frameWords[7] ?? 0;
    for (let phase = 0; phase < 8; phase++) {
      frameWords[7] = phase;
      device.queue.writeBuffer(frame, 0, frameData);
      expect((await computeAo(aoBuffer, 5 * 16))[3]).toBeCloseTo(1, 3);
    }
    frameWords[7] = savedPhase;
    device.queue.writeBuffer(frame, 0, frameData);
    const foreground = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({
          code: `@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
            let corners = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
            return vec4f(corners[i], 0.5, 1.0);
          }`,
        }),
        entryPoint: 'vertex',
      },
      depthStencil: { format: 'depth32float', depthCompare: 'always', depthWriteEnabled: true },
    });
    const placeForeground = (depthValue?: number) => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0.5,
        },
      });
      if (depthValue !== undefined) {
        pass.setPipeline(foreground);
        pass.setViewport(0, 0, 8, 4, depthValue, depthValue);
        pass.setScissorRect(6, 0, 2, 4);
        pass.draw(3);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    };
    // At view depth 1, a 0.32 depth step exceeds the foreground rejection
    // distance (0.30), even though the off-axis receiver ray shortens its projection.
    const offAxisOffset = 2 * 16;
    new Float32Array(frameData.buffer)[17] = 0.6;
    device.queue.writeBuffer(frame, 0, frameData);
    const offAxisOpen = await computeAo(aoBuffer, offAxisOffset);
    placeForeground(0.73);
    const nearForeground = await computeAo(aoBuffer, offAxisOffset);
    placeForeground(0.82);
    const farForeground = await computeAo(aoBuffer, offAxisOffset);
    placeForeground();
    new Float32Array(frameData.buffer)[17] = 0.5;
    device.queue.writeBuffer(frame, 0, frameData);
    results['short-range-ao-orthographic-off-axis-open'] = offAxisOpen;
    results['short-range-ao-orthographic-off-axis-near'] = nearForeground;
    results['short-range-ao-orthographic-off-axis-far'] = farForeground;
    // Rejecting the step can also remove the open plane's small self-occlusion.
    expect(farForeground[3]).toBeGreaterThanOrEqual((offAxisOpen[3] ?? 0) - 0.001);
    expect(nearForeground[3]).toBeLessThan((offAxisOpen[3] ?? 0) - 0.005);
    for (let i = 0; i < 8; i++) aoData.set([0, 0, 1, 0.4], i * 4);
    device.queue.writeBuffer(aoBuffer, 0, aoData);
    writeBaseColor(0);
    const receiver = 8 * 2 + 3;
    const attenuated = await applyAo(output, receiver * 16);
    expect(attenuated).toEqual([1.2, 0.8, 0.4, 3].map((value) => expect.closeTo(value, 5)));

    const applyHistory = makeAoStage('applyScreenProbeAoHistory');
    const applyCompactHistory = makeAoStage('applyScreenProbeAoHistoryCompact');
    writeBaseColor(0x0080ff00);
    // Binary16 0.5, with retained AO valid and an occupied receiver.
    aoMeta[receiver * 4 + 3] = 0x38000005;
    device.queue.writeBuffer(metaIn, 0, aoMeta);
    // At AO=0.5 the reference cubic reduces to this affine expression.
    const visibility = (albedo: number) => 0.464025 + 0.433875 * albedo;
    const expectedFull = [1.5, 2 * visibility(0.5), visibility((128 / 255) ** 2), 3];
    const expectedCompact = [
      1.5,
      2 * visibility(0.5),
      visibility(((128 / 255 + 0.055) / 1.055) ** 2.4),
      3,
    ];
    const full = await applyHistory(output, receiver * 16);
    const compact = await applyCompactHistory(output, receiver * 16);
    expect(full).toEqual(expectedFull.map((value) => expect.closeTo(value, 5)));
    expect(compact).toEqual(expectedCompact.map((value) => expect.closeTo(value, 5)));
    expect(await applyHistory(output, (receiver - 1) * 16)).toEqual([3, 2, 1, 3]);
    for (let i = 0; i < 8; i++) aoData.set([0, 0, 1, 0.5], i * 4);
    device.queue.writeBuffer(aoBuffer, 0, aoData);
    const current = await applyAo(output, receiver * 16);
    expect(current).toEqual(expectedFull.map((value) => expect.closeTo(value, 5)));
    results['short-range-ao-multibounce-current'] = current;
    results['short-range-ao-multibounce-history'] = full;
    results['short-range-ao-multibounce-compact-history'] = compact;
    for (let i = 0; i < 8; i++) aoData.set([0, 1, 0, 0.03], i * 4);
    device.queue.writeBuffer(aoBuffer, 0, aoData);
    expect(await applyAo(output, (8 * 2 + 3) * 16)).toEqual([3, 2, 1, 3]);
    results['short-range-ao-open-plane'] = open;
    results['short-range-ao-edge-aware-composition'] = attenuated;
  } finally {
    mkdirSync('artifacts/screen-probe/interpolation', { recursive: true });
    writeFileSync(
      'artifacts/screen-probe/interpolation/screen-space-result.json',
      JSON.stringify(results, null, 2),
    );
    for (const buffer of buffers) buffer.destroy();
    for (const texture of textures) texture.destroy();
    device.destroy();
  }
});

// The complete cold native interpolation fixture took 84 seconds on CI.
it('rejects cross-wall coplanar Screen Probe filtering and pixel interpolation', {
  timeout: 120_000,
}, async () => {
  const compiled = await compileInterpolationShader();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe interpolation requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  const releases: (() => void)[] = [];
  let controls: Record<string, number[]> = {};
  let status = 'running';
  try {
    const rig = await createInterpolationRig(device, compiled.wgsl, owned, textures, releases);
    controls = rig.controls;
    await recordWallControls(rig);
    await recordParallaxControls(rig);
    await verifyDirectionalSupport(rig);
    await verifyVaryingMeasure(rig);
    await verifyMixedDirections(rig);
    await verifyScreenTraceRejection(rig);
    expect(errors).toEqual([]);
    for (const side of [-1, 1]) {
      expectParallaxControls(controls, side);
      expectWallControls(controls, side);
    }
    status = 'pass';
  } catch (cause) {
    status = 'fail';
    throw cause;
  } finally {
    writeInterpolationArtifact(status, controls, errors);
    for (const release of releases) release();
    for (const value of owned) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
});
