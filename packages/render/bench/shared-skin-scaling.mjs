// Built-package, real Renderer Skin diagnostic. Run under the host's physical GPU lock:
// node packages/render/bench/shared-skin-scaling.mjs [output-directory] [workload-id]
// The same file runs unchanged against another built checkout for A/B comparison.
// Timings are ordinary completed Dawn frames; GC/heap/upload facts come from Node
// and the Renderer inspection. It is not Browser Worker or whole-game evidence.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { cpus, platform } from 'node:os';
import { resolve } from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { create, globals } from '@forgeax/engine-dawn-node';
import { World } from '@forgeax/engine-ecs';
import { createCylinderGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { encodePng } from '@forgeax/engine-image/png';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';

const root = resolve(import.meta.dirname, '../../..');
const output = resolve(process.argv[2] ?? 'artifacts/shared-skin-scaling');
const width = 512;
const height = 512;
const sampling = { warmup: 24, windows: 4, framesPerWindow: 24 };

const WORKLOADS = {
  // Several mesh parts per character share one ordered joint list.
  'shared-parts': { characters: 8, parts: 6, joints: 64, radial: 12, rings: 24, animated: 'all' },
  'shared-sparse': { characters: 8, parts: 6, joints: 64, radial: 12, rings: 24, animated: 'one' },
  'shared-paused': { characters: 8, parts: 6, joints: 64, radial: 12, rings: 24, animated: 'none' },
  crowd: { characters: 64, parts: 1, joints: 32, radial: 16, rings: 32, animated: 'all' },
  'crowd-offscreen': { characters: 64, parts: 1, joints: 32, radial: 16, rings: 32, animated: 'all', offscreen: true },
  'crowd-shadow': { characters: 64, parts: 1, joints: 32, radial: 16, rings: 32, animated: 'all', shadow: true },
  'low-vertex-many-joints': { characters: 64, parts: 1, joints: 128, radial: 3, rings: 2, animated: 'all' },
};

const value = (result) => {
  if (!result?.ok) throw new Error(JSON.stringify(result?.error ?? 'operation unavailable'));
  return result.value;
};
async function drawReady(renderer, input) {
  const deadline = performance.now() + 60_000;
  for (;;) {
    const receipt = value(renderer.draw(input));
    if (receipt.presentation !== 'pending') return receipt;
    value(await receipt.completed);
    if (performance.now() >= deadline) throw new Error('Renderer preparation did not complete within 60 seconds');
    await new Promise((done) => setTimeout(done, 1));
  }
}
const quantile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
const summary = (samples, key) => {
  const values = samples.map((sample) => sample[key]);
  return {
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    mean: values.reduce((total, item) => total + item, 0) / values.length,
  };
};

function makeCanvas(devices, textures, errors, writes) {
  let configuration;
  let texture;
  return {
    width,
    height,
    getContext: () => ({
      configure(options) {
        configuration = options;
        if (!devices.has(options.device)) {
          devices.add(options.device);
          options.device.addEventListener('uncapturederror', (event) =>
            errors.push({ code: 'native-validation', message: event.error.message }),
          );
          const queue = options.device.queue;
          const write = queue.writeBuffer.bind(queue);
          queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
            const element = data?.BYTES_PER_ELEMENT ?? 1;
            writes.calls++;
            writes.bytes += size === undefined ? (data.byteLength ?? 0) - (dataOffset ?? 0) * element : size * element;
            return write(buffer, offset, data, dataOffset, size);
          };
        }
        texture?.destroy();
        texture = undefined;
      },
      unconfigure() {},
      getCurrentTexture() {
        if (texture === undefined) {
          texture = configuration.device.createTexture({
            size: [width, height],
            format: configuration.format,
            viewFormats: configuration.viewFormats ?? [],
            usage: 0x11,
          });
          textures.push(texture);
        }
        return texture;
      },
    }),
    addEventListener() {},
    removeEventListener() {},
  };
}

/** One vertical cylinder per part; each ring blends its two nearest joints. */
function skinnedPart(assets, config, part) {
  const base = value(createCylinderGeometry(0.05 + part * 0.004, 0.06, 1.6, config.radial, config.rings));
  const positions = base.attributes.position;
  const vertices = positions.length / 3;
  const skinIndex = new Uint16Array(vertices * 4);
  const skinWeight = new Float32Array(vertices * 4);
  for (let vertex = 0; vertex < vertices; vertex++) {
    const t = Math.min(0.999999, Math.max(0, (positions[vertex * 3 + 1] + 0.8) / 1.6)) * (config.joints - 1);
    const lower = Math.floor(t);
    const upper = Math.min(config.joints - 1, lower + 1);
    skinIndex.set([lower, upper, 0, 0], vertex * 4);
    skinWeight.set([1 - (t - lower), t - lower, 0, 0], vertex * 4);
  }
  const attributes = { ...base.attributes, skinIndex, skinWeight };
  const packed = value(packInterleavedVertexAttributes(attributes, vertices));
  return { handle: value(assets.create({ ...base, attributes, vertices: packed.vertices })), vertices };
}

function spawnScene(world, config) {
  const assets = world.assets;
  const inverseBindMatrices = new Float32Array(config.joints * 16);
  for (let joint = 0; joint < config.joints; joint++) {
    const y = -0.8 + (1.6 * joint) / Math.max(1, config.joints - 1);
    inverseBindMatrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -y, 0, 1], joint * 16);
  }
  const skeleton = value(assets.create({ kind: 'skeleton', jointCount: config.joints, inverseBindMatrices }));
  const standard = Materials.standard({ baseColor: [0.25, 0.55, 0.85, 1], roughness: 0.6 });
  const material = value(
    assets.create({
      ...standard,
      passes: standard.passes
        .filter((pass) => pass.name !== 'deferred')
        .map((pass) => (pass.name === 'forward' ? { ...pass, program: { module: 'forgeax::pbr-skin', fragmentEntry: 'fs_main' } } : pass)),
    }),
  );
  const parts = Array.from({ length: config.parts }, (_, part) => skinnedPart(assets, config, part));
  const side = Math.ceil(Math.sqrt(config.characters));
  const characters = [];
  for (let character = 0; character < config.characters; character++) {
    const x = (character % side - (side - 1) / 2) * 0.5;
    const z = -Math.floor(character / side) * 0.5;
    const joints = [];
    for (let joint = 0; joint < config.joints; joint++) {
      const y = -0.8 + (1.6 * joint) / Math.max(1, config.joints - 1);
      joints.push({ entity: value(world.spawn({ component: Transform, data: { pos: [x, y, z] } })), pos: [x, y, z] });
    }
    const jointIds = new Uint32Array(joints.map((joint) => joint.entity));
    for (const part of parts)
      value(
        world.spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: part.handle } },
          { component: MeshRenderer, data: { materials: [material] } },
          { component: Skin, data: { skeleton, joints: jointIds } },
        ),
      );
    characters.push(joints);
  }
  value(
    world.spawn(
      { component: Transform, data: { pos: [0, 0.2, side * 0.6 + 1.5], ...(config.offscreen ? { quat: [0, 1, 0, 0] } : {}) } },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100, antialias: 0, bloom: 0 } },
    ),
  );
  value(world.spawn({ component: DirectionalLight, data: { intensity: 2, direction: [-0.3, -0.5, -1], castShadow: config.shadow === true } }));
  return { characters, verticesPerPart: parts.map((part) => part.vertices) };
}

function rgba(observation) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    pixels.set(observation.bytes.subarray(y * observation.metadata.bytesPerRow, y * observation.metadata.bytesPerRow + width * 4), y * width * 4);
  if (observation.metadata.format === 'bgra8unorm') for (let i = 0; i < pixels.length; i += 4) [pixels[i], pixels[i + 2]] = [pixels[i + 2], pixels[i]];
  return pixels;
}

async function workload(id) {
  const config = WORKLOADS[id];
  if (config === undefined) throw new Error(`Unknown workload ${id}`);
  const devices = new Set();
  const textures = [];
  const errors = [];
  const writes = { calls: 0, bytes: 0 };
  const manifest = await readFile(resolve(root, 'shared-build-inputs/shaders/manifest.json'), 'utf8');
  const host = value(
    await constructRuntimeRendererHost(makeCanvas(devices, textures, errors, writes), { rhi, gpuPassTiming: {} }, { shaderManifestUrl: `data:application/json,${encodeURIComponent(manifest)}` }),
  );
  const renderer = host.renderer;
  const world = new World({ assets: host.assets });
  const { characters, verticesPerPart } = spawnScene(world, config);
  const lease = value(renderer.attach(world));
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const gc = { count: 0, durationMs: 0 };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count++;
      gc.durationMs += entry.duration;
    }
  });
  observer.observe({ entryTypes: ['gc'] });
  let phase = 0;
  const animate = () => {
    for (let character = 0; character < characters.length; character++) {
      const joints = characters[character];
      const count = config.animated === 'all' ? joints.length : config.animated === 'one' ? 1 : 0;
      for (let index = 0; index < count; index++) {
        const joint = config.animated === 'one' ? (phase + character) % joints.length : index;
        const angle = Math.sin(phase * 0.15 + joint * 0.3 + character) * 0.25;
        value(world.set(joints[joint].entity, Transform, { pos: joints[joint].pos, quat: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)] }));
      }
    }
    phase++;
  };
  const frame = async (color = false) => {
    const updateStart = performance.now();
    animate();
    value(world.update(1 / 60));
    value(propagateTransforms(world));
    const cpuUpdateMs = performance.now() - updateStart;
    if (color) value(renderer.requestObservation(['final-display']));
    const writeCalls = writes.calls;
    const writeBytes = writes.bytes;
    const drawStart = performance.now();
    const receipt = await drawReady(renderer, { leases: [lease], camera: { lease }, environment: { lease } });
    const cpuDrawMs = performance.now() - drawStart;
    const frameWriteCalls = writes.calls - writeCalls;
    const frameWriteBytes = writes.bytes - writeBytes;
    value(await receipt.completed);
    const observed = value(await renderer.observe(receipt, { include: color ? ['timings', 'final-display'] : ['timings'] }));
    if (errors.length > 0) throw new Error(`Renderer/native failure: ${JSON.stringify(errors)}`);
    const timing = observed.timings;
    if (timing?.status !== 'complete') throw new Error(`Incomplete GPU timing: ${JSON.stringify(timing)}`);
    const coverage = value(summarizeGpuPassTimingIntervals(timing.frame.passes, timing.frame.timestampPeriodNanoseconds));
    // Timestamp ticks are coarse on some adapters; busy time and per-pass means
    // over every measured frame resolve differences below one tick.
    let gpuBusyNanoseconds = 0;
    for (const pass of timing.frame.passes) gpuBusyNanoseconds += Number(pass.durationNanoseconds);
    const gpu = renderer.inspect().renderScene.gpuDriven;
    const image = color ? rgba(observed.observations.find((item) => item.domain === 'final-display')) : undefined;
    return {
      sample: {
        cpuUpdateMs,
        cpuDrawMs,
        gpuPassEnvelopeMs: coverage.envelopeNanoseconds / 1e6,
        gpuBusyMs: gpuBusyNanoseconds / 1e6,
        writeCalls: frameWriteCalls,
        writeBytes: frameWriteBytes,
        paletteUploadBytes: gpu?.paletteUploadBytes ?? 0,
        sceneTableUploadBytes: gpu?.sceneTableUploadBytes ?? 0,
        gpuDraws: gpu?.indirectDrawCount ?? 0,
      },
      image,
      passes: timing.frame.passes,
    };
  };
  try {
    for (let i = 0; i < sampling.warmup; i++) await frame();
    const raw = [];
    const windows = [];
    const passMeans = {};
    let passes;
    for (let window = 0; window < sampling.windows; window++) {
      globalThis.gc?.();
      const heapStart = process.memoryUsage().heapUsed;
      const gcStart = { ...gc };
      const windowStart = performance.now();
      for (let index = 0; index < sampling.framesPerWindow; index++) {
        const result = await frame();
        raw.push({ window, index, ...result.sample });
        passes = result.passes;
        for (const pass of result.passes)
          passMeans[pass.passName] = (passMeans[pass.passName] ?? 0) + Number(pass.durationNanoseconds) / 1e6;
      }
      // Observer entries are delivered asynchronously after the collection.
      await new Promise((done) => setTimeout(done, 0));
      windows.push({
        wallMs: performance.now() - windowStart,
        gcCount: gc.count - gcStart.count,
        gcMs: gc.durationMs - gcStart.durationMs,
        heapDeltaBytes: process.memoryUsage().heapUsed - heapStart,
      });
    }
    phase = 0;
    const { image } = await frame(true);
    let lit = 0;
    for (let i = 0; i < image.length; i += 4) if (image[i] + image[i + 1] + image[i + 2] > 48) lit++;
    await writeFile(resolve(output, `${id}.png`), encodePng(width, height, image));
    await writeFile(resolve(output, `${id}-raw.json`), JSON.stringify({ raw, windows, passes }));
    const statistics = Object.fromEntries(
      ['cpuUpdateMs', 'cpuDrawMs', 'gpuPassEnvelopeMs', 'gpuBusyMs', 'writeCalls', 'writeBytes', 'paletteUploadBytes', 'sceneTableUploadBytes', 'gpuDraws'].map((key) => [key, summary(raw, key)]),
    );
    const frames = sampling.windows * sampling.framesPerWindow;
    for (const name of Object.keys(passMeans)) passMeans[name] /= frames;
    const result = {
      id,
      config,
      skinnedDraws: config.characters * config.parts,
      joints: config.characters * config.joints,
      verticesPerPart,
      statistics,
      gpuPassMeanMs: passMeans,
      gc: {
        countPerFrame: windows.reduce((total, item) => total + item.gcCount, 0) / frames,
        msPerFrame: windows.reduce((total, item) => total + item.gcMs, 0) / frames,
        heapDeltaBytesPerFrame: windows.map((item) => item.heapDeltaBytes / sampling.framesPerWindow),
      },
      litPixels: lit,
      errors,
    };
    console.error(JSON.stringify({ id, cpuDrawP50: statistics.cpuDrawMs.p50, gpuEnvelopeP50: statistics.gpuPassEnvelopeMs.p50, gpuBusyMean: statistics.gpuBusyMs.mean, writeCalls: statistics.writeCalls.p50, gc: result.gc }));
    if (!config.offscreen && lit === 0) throw new Error(`No rendered Skin pixels: ${id}`);
    return result;
  } finally {
    observer.disconnect();
    unsubscribe();
    lease.dispose();
    await renderer.dispose();
    for (const device of devices) await device.queue.onSubmittedWorkDone();
    for (const texture of textures) texture.destroy();
    for (const device of devices) device.destroy();
  }
}

Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu } });
const adapter = await gpu.requestAdapter();
if (adapter === null) throw new Error('Dawn adapter unavailable');
await mkdir(output, { recursive: true });
const adapterInfo = Object.fromEntries(['vendor', 'architecture', 'device', 'description', 'backendType'].map((key) => [key, adapter.info?.[key] ?? null]));
const selected = process.argv[3] === undefined ? Object.keys(WORKLOADS) : process.argv[3].split(',');
const report = {
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain', '--', 'packages'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  backend: { runner: `dawn-node/${process.version}`, info: adapterInfo, timestampQuery: adapter.features.has('timestamp-query'), cpu: cpus()[0]?.model, platform: platform() },
  resolution: { width, height },
  sampling,
  scope: 'ordinary completed Dawn frames of one Renderer; whole-process Node GC and heap; not Browser Worker evidence',
  workloads: [],
};
for (const id of selected) report.workloads.push(await workload(id));
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
process.exit(0);
