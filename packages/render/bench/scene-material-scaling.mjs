// Built-package, real Renderer diagnostic. Run under the host's physical GPU lock.
// node packages/render/bench/scene-material-scaling.mjs [output-directory]
// Timing/readback/inspection facts come from Renderer; this adds no GPU registry.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { World } from '@forgeax/engine-ecs';
import { createMaterialLoader, installMaterialReadyShaders } from '@forgeax/engine-assets-runtime';
import { createBoxGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { buildProfileModel, createProfiler } from '@forgeax/engine-profiler';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { constructRendererHost } from '@forgeax/engine-render/internal/construct-renderer';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { MorphWeights, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { create, globals } from '@forgeax/engine-dawn-node';
import { writeReferencePng } from '../../../apps/shared/png-codec.mjs';

const root = resolve(import.meta.dirname, '../../..');
const output = resolve(process.argv[2] ?? 'artifacts/scene-material-scaling/scale');
const width = 512;
const height = 512;
const profiling = process.env.FORGEAX_SCALE_PROFILE === '1';
const sampling = { warmup: 16, groups: profiling ? 1 : 4, framesPerWindow: 8, order: profiling ? ['A', 'B'] : ['A', 'B', 'B', 'A'] };
export const value = (result) => {
  if (!result?.ok) throw new Error(JSON.stringify(result?.error ?? 'operation unavailable'));
  return result.value;
};
const quantile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
const summary = (samples, key) => ({ p50: quantile(samples.map((s) => s[key]), 0.5), p95: quantile(samples.map((s) => s[key]), 0.95) });

// Coverage comes from the existing timing owner. It includes gaps and is not
// a native outer query, a sum of overlapping passes, or device frame latency.
export function timingFacts(observation) {
  const timing = observation.timings;
  if (timing?.status !== 'complete') throw new Error(`Incomplete GPU timing: ${JSON.stringify(timing)}`);
  const coverage = value(summarizeGpuPassTimingIntervals(timing.frame.passes, timing.frame.timestampPeriodNanoseconds));
  const views = [...new Set(timing.frame.passes.map(pass => pass.viewId).filter(id => id !== undefined))];
  return { gpuPassEnvelopeMs: coverage.envelopeNanoseconds / 1e6, timingCoverage: coverage, gpuTiming: timing,
    viewTimings: views.map(viewId => ({ viewId, coverage: value(summarizeGpuPassTimingIntervals(timing.frame.passes.filter(pass => pass.viewId === viewId), timing.frame.timestampPeriodNanoseconds)) })) };
}

export function makeCanvas(devices, textures, errors = []) {
  let configuration;
  let texture;
  return {
    width, height,
    getContext: () => ({
      configure(options) { configuration = options; devices.add(options.device); options.device.addEventListener('uncapturederror', (event) => errors.push({code:'native-validation',message:event.error.message})); texture?.destroy(); texture = undefined; },
      unconfigure() {},
      getCurrentTexture() {
        if (texture === undefined) {
          texture = configuration.device.createTexture({ size: [width, height], format: configuration.format, viewFormats: configuration.viewFormats ?? [], usage: 0x11 });
          textures.push(texture);
        }
        return texture;
      },
    }),
    addEventListener() {}, removeEventListener() {},
  };
}

export function spawnScene(world, count, mixed, customMaterial) {
  const base = value(createBoxGeometry(0.14, 0.14, 0.14));
  const rigid = world.allocSharedRef('MeshAsset', base);
  const vertices = base.attributes.position.length / 3;
  const skinWeight = new Float32Array(vertices * 4);
  for (let i = 0; i < vertices; i++) skinWeight[i * 4] = 1;
  const attributes = { ...base.attributes, skinIndex: new Uint16Array(vertices * 4), skinWeight };
  const packed = value(packInterleavedVertexAttributes(attributes, vertices));
  const skinned = world.allocSharedRef('MeshAsset', { ...base, attributes, vertices: packed.vertices });
  const delta = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices; i++) delta[i * 3 + 1] = 0.04;
  const morph = world.allocSharedRef('MeshAsset', { ...base, morphTargets: [{ position: delta }] });
  const skeletonAsset = { kind: 'skeleton', jointCount: 1, inverseBindMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
  const skeleton = world.allocSharedRef('SkeletonAsset', skeletonAsset);
  const boundedSkeleton = world.allocSharedRef('SkeletonAsset', { ...skeletonAsset, bounds: new Float32Array([-0.1, -0.1, -0.1, 0.1, 0.1, 0.1]) });
  const opaque = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.2, 0.6, 0.3, 1], roughness: 0.7 }));
  const skinAsset = Materials.standard({ baseColor: [0.2, 0.6, 0.3, 1], roughness: 0.7 });
  const skinMaterial = world.allocSharedRef('MaterialAsset', { ...skinAsset, passes: skinAsset.passes.filter(pass => pass.name !== 'deferred').map(pass => pass.name === 'forward' ? { ...pass, program: { module: 'forgeax::pbr-skin', fragmentEntry: 'fs_main' } } : pass) });
  const unlit = world.allocSharedRef('MaterialAsset', Materials.unlit([0.3, 0.4, 0.8, 1]));
  const transparent = world.allocSharedRef('MaterialAsset', Materials.unlit([0.8, 0.3, 0.2, 0.5], { renderState: { blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } } }));
  const custom = customMaterial === undefined ? undefined : world.allocSharedRef('MaterialAsset', customMaterial);
  const entities = [];
  const categories = { rigid: 0, skin: 0, morph: 0, custom: 0, unlit: 0, transparent: 0 };
  const side = Math.ceil(Math.sqrt(count));
  for (let index = 0; index < count; index++) {
    const slot = mixed ? index % 20 : 0;
    const kind = mixed && custom !== undefined && slot === 0 ? 'custom' : slot < 14 ? 'rigid' : slot < 16 ? 'skin' : slot < 18 ? 'morph' : slot === 18 ? 'unlit' : 'transparent';
    categories[kind]++;
    const pos = [(index % side - (side - 1) / 2) * 0.18, (Math.floor(index / side) - (side - 1) / 2) * 0.18, 0];
    const entity = value(world.spawn(
      { component: Transform, data: { pos } },
      { component: MeshFilter, data: { assetHandle: kind === 'skin' ? skinned : kind === 'morph' ? morph : rigid } },
      { component: MeshRenderer, data: { materials: [kind === 'custom' ? custom : kind === 'transparent' ? transparent : kind === 'unlit' ? unlit : kind === 'skin' ? skinMaterial : opaque] } },
      ...(kind === 'morph' ? [{ component: MorphWeights, data: { weights: new Float32Array([0.5]) } }] : []),
    ));
    if (kind === 'skin') value(world.addComponent(entity, { component: Skin, data: { skeleton: slot === 14 ? boundedSkeleton : skeleton, joints: new Uint32Array([entity]) } }));
    entities.push({ entity, pos });
  }
  const camera = value(world.spawn({ component: Transform, data: { pos: [0, 0, side * 0.19] } }, { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100, antialias: 0, bloom: 0 } }));
  const light = value(world.spawn({ component: DirectionalLight, data: { intensity: 2, direction: [-0.3, -0.5, -1] } }));
  return { entities, categories, camera, light, side };
}

export function rgba(observation) {
  if (observation.metadata.format !== 'rgba8unorm' && observation.metadata.format !== 'bgra8unorm') throw new Error(`unexpected display format ${observation.metadata.format}`);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) pixels.set(observation.bytes.subarray(y * observation.metadata.bytesPerRow, y * observation.metadata.bytesPerRow + width * 4), y * width * 4);
  if (observation.metadata.format === 'bgra8unorm') for (let i = 0; i < pixels.length; i += 4) [pixels[i], pixels[i + 2]] = [pixels[i + 2], pixels[i]];
  return pixels;
}

async function loadCustomMaterial(world, assets) {
  // Reuse the actual custom-shader carrier's cooked publication and loader.
  // Build that app first; no benchmark-side WGSL or fake scene-index ABI.
  const packagePath = resolve(root, 'apps/hello/custom-shader/dist/assets/01935b00-7d8c-7c4e-9f12-345678abcd02.pack.json');
  const pack = JSON.parse(await readFile(packagePath, 'utf8'));
  const record = pack.assets.find(asset => asset.payload?.cooked)?.payload.cooked;
  if (record === undefined) throw new Error('custom-shader cooked publication unavailable');
  const texturePayload = { kind: 'texture', shape: { viewDimension: '2d', extent: { width: 1, height: 1 } }, format: 'rgba8unorm-srgb', data: new Uint8Array([192, 192, 192, 255]), colorSpace: 'srgb', mips: { kind: 'none' } };
  for (const guid of record.refs.textures) value(assets.catalog(assets.parseGuid(guid), texturePayload));
  const loaded = await createMaterialLoader({
    loadPublication: async guid => guid === record.guid ? { guid, record, artifacts: Object.fromEntries(record.programs.map(({ artifact }) => [artifact.path, { bytes: new Uint8Array(artifact.bytes), digest: artifact.digest }])) } : undefined,
    // Module references are already in the validated cooked source closure;
    // texture references resolve through the actual runtime catalog.
    loadReference: async reference => record.refs.modules.includes(reference)
      ? record.programs.some(program => program.artifact.bytes.length > 0)
      : (await assets.loadByGuid(assets.parseGuid(reference))).ok,
  }).load({ guid: record.guid, specializationKey: record.specializationKey });
  if (loaded.status !== 'Ready') throw new Error(`custom material not ready: ${JSON.stringify(loaded)}`);
  installMaterialReadyShaders(assets.shaderRegistry, loaded, assets.materialArtifactRegistry);
  const texture = world.allocSharedRef('TextureAsset', texturePayload);
  return { kind: 'material', passes: record.resolved.passes, parameters: record.resolved.parameters,
    values: { ...record.resolved.values, time: 0, baseColorTexture: { texture }, normalTexture: { texture }, baseColorUvTransform: [0, 0, 1, 1], normalUvTransform: [0, 0, 1, 1] } };
}

const workloadId = ({ count, mixed, dirtyRatio }) => `${count}-${mixed ? 'mixed' : 'rigid'}-${dirtyRatio === 0 ? 'stable' : dirtyRatio === 1 ? 'churn' : 'local-dirty'}`;
async function workload({ count, mixed, dirtyRatio }) {
  const id = workloadId({ count, mixed, dirtyRatio });
  const devices = new Set();
  const textures = [];
  const manifest = await readFile(resolve(root, 'shared-build-inputs/shaders/manifest.json'), 'utf8');
  const errors = [];
  const restoreDiagnostics = trackDiagnosticErrors(errors);
  const profiler = profiling ? createProfiler() : undefined;
  const host = value(await constructRendererHost(makeCanvas(devices, textures, errors), { rhi, gpuPassTiming: {}, ...(profiler === undefined ? {} : { profiler }) }, { shaderManifestUrl: `data:application/json,${encodeURIComponent(manifest)}` }));
  const renderer = host.renderer;
  const world = new World();
  const customMaterial = mixed ? await loadCustomMaterial(world, host.assets) : undefined;
  const { entities, categories } = spawnScene(world, count, mixed, customMaterial);
  const lease = value(renderer.attach(world));
  value(renderer.setProfile({ ...renderer.inspect().profile, gpuOcclusion: false }));
  const unsubscribe = renderer.subscribe((event) => { if (event.kind === 'error') errors.push(event.error); });
  const raw = { A: [], B: [] };
  const images = {};
  const inspections = {};
  let phase = 0;
  const frame = async (mode, color = false) => {
    const cpuStart = performance.now();
    for (let i = 0; i < Math.ceil(count * dirtyRatio); i++) {
      const { entity, pos } = entities[i];
      value(world.set(entity, Transform, { pos: [pos[0], pos[1], Math.sin(phase * 0.1 + i) * 0.005] }));
    }
    phase++;
    value(world.update(1 / 60));
    value(propagateTransforms(world));
    const cpuWorldMs = performance.now() - cpuStart;
    if (color) value(renderer.requestObservation(['final-display']));
    const drawStart = performance.now();
    const receipt = value(renderer.draw({ leases: [lease], camera: { lease }, environment: { lease }, geometryLane: mode === 'A' ? 'direct' : 'automatic' }));
    const cpuDrawMs = performance.now() - drawStart;
    const waitStart = performance.now();
    value(await receipt.completed);
    const completionWaitMs = performance.now() - waitStart;
    const observed = value(await renderer.observe(receipt, { include: color ? ['timings', 'final-display'] : ['timings'] }));
    const inspection = renderer.inspect();
    if (errors.length > 0) throw new Error(`Renderer/World/native failure: ${JSON.stringify(errors)}`);
    const gpu = inspection.renderScene.gpuDriven;
    if (color) {
      images[mode] = rgba(observed.observations.find((item) => item.domain === 'final-display'));
      inspections[mode] = inspection;
    }
    return { cpuWorldMs, cpuDrawMs, cpuTotalMs: cpuWorldMs + cpuDrawMs, completionWaitMs, ...timingFacts(observed), uploads: { scene: gpu.sceneTableUploadBytes, palette: gpu.paletteUploadBytes, candidate: gpu.candidateUploadBytes, batch: gpu.batchUploadBytes, view: gpu.viewConstantsUploadBytes }, lane: gpu.channels, gpuDraws: gpu.indirectDrawCount, resources: { graph: inspection.renderGraphResourceAllocation, generations: inspection.renderGraphGenerationAllocation, gpuLane: gpu.resourceAllocation }, frameCaches: inspection.renderScene.frameCaches };
  };
  try {
    for (const mode of ['A', 'B']) {
      for (let i = 0; i < sampling.warmup; i++) await frame(mode);
      phase = 0; // both lane images use the same authored transforms
      await frame(mode, true);
    }
    const profileSession = profiler === undefined ? undefined : value(profiler.startCapture({ frameLimit: 32, eventLimit: 500000, detail: 'nested' }));
    for (let group = 0; group < sampling.groups; group++) for (let window = 0; window < sampling.order.length; window++) {
      const mode = sampling.order[window];
      await frame(mode); // absorb lane transition outside measured window
      for (let index = 0; index < sampling.framesPerWindow; index++) raw[mode].push({ group, window, index, ...(await frame(mode)) });
    }
    if (profileSession !== undefined) {
      const capture = value(profileSession.finish());
      await writeFile(resolve(output, `${id}-cpu-profile.json`), JSON.stringify(capture));
      await writeFile(resolve(output, `${id}-cpu-profile-model.json`), JSON.stringify(value(buildProfileModel(capture)), null, 2));
    }
    let squared = 0;
    let maxError = 0;
    let lit = 0;
    for (let i = 0; i < images.A.length; i++) if (i % 4 !== 3) {
      const error = Math.abs(images.A[i] - images.B[i]) / 255;
      squared += error * error;
      maxError = Math.max(maxError, error);
      if (images.A[i] > 16) lit++;
    }
    const rms = Math.sqrt(squared / (width * height * 3));
    const statistics = Object.fromEntries(['A', 'B'].map((mode) => [mode, Object.fromEntries(['cpuWorldMs', 'cpuDrawMs', 'cpuTotalMs', 'completionWaitMs', 'gpuPassEnvelopeMs'].map((key) => [key, summary(raw[mode], key)]))]));
    await writeFile(resolve(output, `${id}-raw.json`), JSON.stringify(raw));
    await writeFile(resolve(output, `${id}-inspection.json`), JSON.stringify(inspections, null, 2));
    for (const mode of ['A', 'B']) await writeFile(resolve(output, `${id}-${mode}.png`), writeReferencePng(images[mode], width, height));
    const result = { id, count, categories, dirtyRatio, statistics, parity: { rms, maxError, litChannels: lit, thresholdRms: 0.05 }, errors };
    console.error(JSON.stringify(result));
    if (errors.length > 0 || rms > 0.05 || lit === 0) throw new Error(`scale correctness failed: ${id}`);
    return result;
  } finally {
    unsubscribe(); lease.dispose(); await renderer.dispose();
    for (const device of devices) await device.queue.onSubmittedWorkDone();
    for (const texture of textures) texture.destroy();
    for (const device of devices) device.destroy();
    restoreDiagnostics();
  }
}

// World reports expected extraction failures through the Host diagnostic sink.
// Renderer events alone cannot prove that every authored object was extracted.
export function trackDiagnosticErrors(errors) {
  const previous = console.error;
  console.error = (...args) => { for (const arg of args) if (arg && typeof arg === 'object' && typeof arg.code === 'string') errors.push({ code: arg.code, detail: arg.detail }); previous(...args); };
  return () => { console.error = previous; };
}

if (/(?:^|[/\\])scene-material-scaling\.mjs$/.test(process.argv[1] ?? '')) {
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu } });
const adapter = await gpu.requestAdapter();
if (adapter === null) throw new Error('Dawn adapter unavailable');
await mkdir(output, { recursive: true });
const adapterInfo = Object.fromEntries(['vendor', 'architecture', 'device', 'description', 'backendType'].map((key) => [key, adapter.info?.[key] ?? null]));
const report = { sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), backend: { runner: `dawn-node/${process.version}`, info: adapterInfo, realGpu: /apple|intel|nvidia|amd/i.test(JSON.stringify(adapterInfo)) && !/software|swiftshader|lavapipe|fallback/i.test(JSON.stringify(adapterInfo)), timestampQuery: adapter.features.has('timestamp-query'), cpu: cpus()[0]?.model, platform: platform() }, resolution: { width, height }, sampling, controls: { A: 'direct', B: 'automatic', lightCasting: 'default on (the removed profile flag never controlled casting)', gpuOcclusion: false }, resourceScope: 'Renderer graph generations and GPU lane logical allocations; not driver allocation or total native residency', workloads: [] };
{
  report.scope=profiling?'cpu-profile-diagnostic, first A/B pair only':'four-group ABBA lane diagnostic';
  const cases=[1000,10000].flatMap(count=>(process.env.FORGEAX_SCALE_MIXED_ONLY==='1'?[true]:[false,true]).flatMap(mixed=>[0,.01,1].map(dirtyRatio=>({count,mixed,dirtyRatio}))));
  const selection=process.argv[3] ?? (profiling?'10000-rigid-stable':undefined);
  const selected=cases.filter(config=>selection===undefined||workloadId(config)===selection);
  if(selected.length===0)throw new Error(`Unknown scale case ${process.argv[3]}`);
  for(const config of selected)report.workloads.push(await workload(config));
}
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
process.exit(0);
}
