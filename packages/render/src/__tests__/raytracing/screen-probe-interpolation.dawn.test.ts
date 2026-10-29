import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import {
  SCREEN_PROBE_BINDINGS,
  SCREEN_PROBE_STAGES,
  type ScreenProbeSlot,
} from '../../raytracing/screen-probe-kernels';
import { packScreenProbeFrame } from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';

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
  readonly sample: GPUBindGroup;
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
      imports: {
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
      },
      defines: { IRRADIANCE_FIELD_VISIBILITY: true },
    })
  ).unwrap();
}

/** Two uniform probes over an 8x4 view; only the passed fields differ between phases. */
function packTwoProbeFrame(
  phase: Pick<ScreenProbeFrame, 'screenSteps' | 'maxDistance' | 'sceneHistory' | 'reprojection'>,
): Uint8Array {
  return packScreenProbeFrame({
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

function writeVisibility(rig: InterpolationRig, sdf: Float32Array): void {
  rig.device.queue.writeTexture(
    { texture: rig.visibility },
    sdf,
    { bytesPerRow: 33 * 8, rowsPerImage: 33 },
    [33, 33, 33],
  );
}

function createSurface(device: GPUDevice, textures: GPUTexture[]) {
  const depth = device.createTexture({ size: [8, 4], format: 'depth32float', usage: 4 | 16 });
  const normal = device.createTexture({ size: [8, 4], format: 'r32uint', usage: 4 | 2 });
  const visibility = device.createTexture({
    size: [33, 33, 33],
    dimension: '3d',
    format: 'rg32float',
    usage: 4 | 2,
  });
  textures.push(depth, normal, visibility);
  device.queue.writeTexture(
    { texture: normal },
    new Uint32Array(32).fill(2048 | (2048 << 12)),
    { bytesPerRow: 32 },
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
): { readonly sampleLayout: GPUBindGroupLayout; readonly sample: GPUBindGroup } {
  const buffer = (data: Uint8Array, usage?: number) => ownedBuffer(device, owned, data, usage);
  const field = buffer(
    packIrradianceFieldUniform(
      { origin: [-1, -1, -1], spacing: 2, dimensions: [2, 2, 2], probeCount: 8, levels: 1 },
      [{ window: [0, 0, 0], min: [0, 0, 0], max: [2, 2, 2] }],
    ),
    64,
  );
  const gridBytes = new Uint8Array(48);
  new Float32Array(gridBytes.buffer).set([-2, -2, -2, 0.125]);
  new Uint32Array(gridBytes.buffer).set([33, 33, 33, SDF_TEXELS], 4);
  new Float32Array(gridBytes.buffer).set([4, 0.0625, 0, 0], 8);
  const grid = buffer(gridBytes, 64);
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
    ],
  });
  const sample = device.createBindGroup({
    layout: sampleLayout,
    entries: [
      ...[field, retained, moments, meta, grid].map((value, binding) => ({
        binding,
        resource: { buffer: value },
      })),
      { binding: 5, resource: visibility.createView() },
    ],
  });
  return { sampleLayout, sample };
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

function createInterpolationRig(
  device: GPUDevice,
  wgsl: string,
  owned: GPUBuffer[],
  textures: GPUTexture[],
): InterpolationRig {
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
  const records = new Uint8Array(64);
  const floats = new Float32Array(records.buffer);
  const words = new Uint32Array(records.buffer);
  for (let i = 0; i < 2; i++) {
    floats.set([i - 0.5, 0, 0, 1, 0, 0, 1], i * 8);
    words[i * 8 + 7] = i;
  }
  const probes = buffer(records);
  const count = buffer(new Uint8Array(4));
  const radiance = new Float32Array(2 * 64 * 8);
  const input = buffer(bytes(radiance));
  const filtered = buffer(new Uint8Array(radiance.byteLength));
  const integrated = buffer(new Uint8Array(8 * 4 * 16));
  const tileAdaptive = buffer(bytes(new Uint32Array(8).fill(0xffffffff)));
  const viewBytes = new Uint8Array(VIEW_UNIFORM_BYTES);
  new Float32Array(viewBytes.buffer).set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1], 44);
  new Float32Array(viewBytes.buffer).set([0, 0, 1], 24);
  const view = buffer(viewBytes, 64);
  const { depth, normal, visibility } = createSurface(device, textures);
  const { sampleLayout, sample } = createLiveFieldSample(device, owned, visibility);
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
): Promise<Float32Array> {
  rig.device.queue.submit([encoder.finish()]);
  await rig.readback.mapAsync(1);
  const data = new Float32Array(rig.readback.getMappedRange()).slice();
  rig.readback.unmap();
  return data;
}

/** Run the production filter alone and read back its probe radiance. */
async function runFilter(rig: InterpolationRig): Promise<Float32Array> {
  const encoder = rig.device.createCommandEncoder();
  const value = rig.stages.find((stage) => stage.entryPoint === 'filterProbeRadiance');
  if (value === undefined) throw new Error('production filter pipeline required');
  encodeStage(rig, encoder, value);
  encoder.copyBufferToBuffer(rig.filtered, 0, rig.readback, 0, rig.filtered.size);
  return readFloats(rig, encoder);
}

/** Filter and integrate across one edge-on wall, recording each side's receiver probe and pixel. */
async function recordWallControls(rig: InterpolationRig): Promise<void> {
  const { radiance, filtered, integrated } = rig;
  for (const side of [-1, 1]) {
    for (const mode of ['wall', 'open', 'constant', 'missing-coverage'] as const) {
      for (let i = 0; i < 128; i++) {
        const value = mode === 'constant' || (i < 64 ? side < 0 : side > 0) ? 0.25 : 3;
        radiance.set([value, value, value, 1, -1], i * 8);
      }
      rig.device.queue.writeBuffer(rig.input, 0, radiance);
      writeVisibility(rig, wallSdf(mode === 'constant' ? 'wall' : mode));
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
        radiance.set([value, value, value, 1, -1], i * 8);
        radiance[i * 8 + 4] = parallaxHitDistance(mode, probe === receiver);
      }
      rig.device.queue.writeBuffer(rig.input, 0, radiance);
      writeVisibility(rig, wallSdf('open'));
      const data = await runFilter(rig);
      const offset = (receiver * 64 + PARALLAX_TEXEL) * 8;
      rig.controls[`${side}:${mode}:filter`] = Array.from(data.slice(offset, offset + 4));
    }
  }
}

function writeDirectionalSupportRadiance(radiance: Float32Array): void {
  for (let texel = 0; texel < 64; texel++) {
    const support = texel % 3 === 0 ? 0 : texel % 3 === 1 ? -1 : 1;
    radiance.set([texel / 64, 0, 0, support, -1], texel * 8);
    radiance.set([2 + texel / 64, 0, 0, texel % 4 === 0 ? 0 : 1, -1], (64 + texel) * 8);
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
    rig.device.queue.writeBuffer(rig.input, 0, rig.radiance);
    writeVisibility(rig, wallSdf(mode));
    const data = (await runFilter(rig)).slice(0, rig.filtered.size / 4);
    rig.controls[`${mode}:directional-support`] = Array.from(data);
    expectDirectionalSupport(mode, rig.radiance, data);
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

/** One probe on `side` whose HZB covers only the far edge and whose single ray points across x=0. */
function writeScreenTraceSide(
  rig: InterpolationRig,
  trace: ReturnType<typeof createScreenTrace>,
  side: number,
): void {
  const { device } = rig;
  new Float32Array(rig.records.buffer).set([side * 0.5, 0, 0, 1, 0, 0, 1]);
  new Uint32Array(rig.records.buffer)[7] = 0;
  device.queue.writeBuffer(rig.probes, 0, rig.records);
  const pyramid = new Float32Array(32);
  for (let i = 0; i < 32; i++)
    pyramid[i] = (side < 0 ? i % 8 >= 6 : i % 8 < 2) ? 0.75 : 3.402823e38;
  device.queue.writeTexture({ texture: trace.screenPyramid }, pyramid, { bytesPerRow: 32 }, [8, 4]);
  device.queue.writeTexture(
    { texture: rig.normal },
    new Uint32Array(32).fill((side < 0 ? 0 : 4095) | (2048 << 12)),
    { bytesPerRow: 32 },
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
      writeVisibility(rig, wallSdf(mode));
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

it('rejects cross-wall coplanar Screen Probe filtering and pixel interpolation', async () => {
  const compiled = await compileInterpolationShader();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe interpolation requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  let controls: Record<string, number[]> = {};
  let status = 'running';
  try {
    const rig = createInterpolationRig(device, compiled.wgsl, owned, textures);
    controls = rig.controls;
    await recordWallControls(rig);
    await recordParallaxControls(rig);
    await verifyDirectionalSupport(rig);
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
    for (const value of owned) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
});
