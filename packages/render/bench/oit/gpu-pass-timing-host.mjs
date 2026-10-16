#!/usr/bin/env node

/**
 * Weighted blended OIT GPU pass timing host (AC-3 evidence).
 *
 * Consumer of the renderer-owned receipt timing primitive (`gpuPassTiming` +
 * `observe(frame, { include: ['timings'] })`), following the auto-exposure host
 * precedent: it adds no query set and infers no GPU time from wall clocks.
 * One Dawn device and one Renderer run each workload; windows alternate the
 * camera between `sorted` and `weighted-blended`, so both modes share the
 * device, the run and the scene. The per-frame entries keep the renderer's
 * `GpuPassTimingFrame` schema (1.0) and are retained raw.
 *
 * Usage (built engine packages required):
 *   node packages/render/bench/oit/gpu-pass-timing-host.mjs --output-dir=artifacts/oit/perf
 * Software adapters (lavapipe/SwiftShader) are labelled `realGpu: false`;
 * their numbers are measurements on that device only. There is no threshold.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  TRANSPARENCY_SORTED,
  TRANSPARENCY_WEIGHTED_BLENDED,
} from '@forgeax/engine-render';
import { constructRendererHost } from '@forgeax/engine-render/internal/construct-renderer';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';

export const OIT_TIMING_SCHEMA_VERSION = 'forgeax-oit-gpu-pass-timing/1';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const WIDTH = Number(process.env.FORGEAX_OIT_TIMING_WIDTH ?? 1920);
const HEIGHT = Number(process.env.FORGEAX_OIT_TIMING_HEIGHT ?? 1080);
export const OIT_TIMING_SAMPLING = Object.freeze({
  warmupFrames: Number(process.env.FORGEAX_OIT_TIMING_WARMUP ?? 8),
  groups: Number(process.env.FORGEAX_OIT_TIMING_GROUPS ?? 4),
  framesPerWindow: Number(process.env.FORGEAX_OIT_TIMING_FRAMES ?? 10),
  quantiles: ['p50', 'p95-nearest-rank'],
});
export const OIT_WORKLOADS = Object.freeze([
  Object.freeze({ id: 'low-overdraw', layers: 4 }),
  Object.freeze({ id: 'high-overdraw', layers: 64 }),
]);
const SOFTWARE_PROVENANCE = /swiftshader|lavapipe|llvmpipe|software|fallback|paravirtual/i;
const STRAIGHT_OVER = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const GPU_TEXTURE_USAGE_COPY_SRC = 0x01;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

/** Analytic added-target memory: accum rgba16float 8 B + weight r16float 2 B. */
export function oitTargetMemory(width, height) {
  const pixels = width * height;
  return {
    formula:
      'accum rgba16float (8 B) + weight r16float (2 B) = 10 B/px; MSAA 4x adds 4x samples plus 1x resolves',
    sampleCount1Bytes: pixels * 10,
    sampleCount4Bytes: pixels * 10 * 4 + pixels * 10,
  };
}

function sourceHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

let cachedManifestUrl;
async function manifestUrl() {
  if (cachedManifestUrl !== undefined) return cachedManifestUrl;
  const failures = [];
  for (const relativePath of [
    'shared-app-inputs/shaders/manifest.json',
    'shared-build-inputs/shaders/manifest.json',
  ]) {
    try {
      const manifest = await readFile(resolve(REPO_ROOT, relativePath), 'utf8');
      cachedManifestUrl = `data:application/json,${encodeURIComponent(manifest)}`;
      return cachedManifestUrl;
    } catch (error) {
      // Local engine builds use shared-build-inputs; CI hydrates shared-app-inputs.
      failures.push(`${relativePath}: ${error}`);
    }
  }
  throw new Error(`OIT timing host requires a built shader manifest (${failures.join('; ')})`);
}

async function installDawn() {
  const { create, globals } = await import('@forgeax/engine-dawn-node');
  Object.assign(globalThis, globals);
  const gpu = create([]);
  if (globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });
  return gpu;
}

function canvas(devices, textures) {
  let configuration = { device: undefined, format: 'rgba8unorm', viewFormats: [] };
  let current;
  return {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind) {
      if (kind !== 'webgpu') return null;
      return {
        configure(descriptor) {
          configuration = {
            device: descriptor.device,
            format: descriptor.format ?? 'rgba8unorm',
            viewFormats: descriptor.viewFormats ?? [],
          };
          current?.destroy();
          current = undefined;
          if (descriptor.device !== undefined) devices.add(descriptor.device);
        },
        unconfigure() {},
        getConfiguration() {
          return null;
        },
        getCurrentTexture() {
          if (current !== undefined) return current;
          if (configuration.device === undefined)
            throw new Error('Dawn GPUDevice was not configured');
          current = configuration.device.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: configuration.format,
            ...(configuration.viewFormats.length > 0
              ? { viewFormats: [...configuration.viewFormats] }
              : {}),
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
          });
          textures.push(current);
          return current;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function unwrap(result, label) {
  if (result === undefined) throw new Error(`${label}: operation unavailable`);
  if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  return result.value;
}

function hash01(seed) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Large interpenetrating layers covering the view. Tilts alternate sign about
 * +Y so neighbouring layers cross; with 64 layers every pixel sees ~64
 * transparent fragments and no object order is correct.
 */
function spawnWorkload(world, layers) {
  const backdrop = world.allocSharedRef('MeshAsset', createPlaneGeometry(60, 40).unwrap());
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -12] } },
      { component: MeshFilter, data: { assetHandle: backdrop } },
      {
        component: MeshRenderer,
        data: {
          materials: [
            world.allocSharedRef(
              'MaterialAsset',
              Materials.unlit([0.2, 0.2, 0.25, 1]),
            ),
          ],
        },
      },
    )
    .unwrap();
  const layer = world.allocSharedRef('MeshAsset', createPlaneGeometry(24, 14).unwrap());
  for (let index = 0; index < layers; index++) {
    const tilt = (index % 2 === 0 ? 1 : -1) * (0.1 + 0.5 * hash01(index + 1));
    const color = [hash01(index * 3 + 11), hash01(index * 3 + 12), hash01(index * 3 + 13)];
    const alpha = 0.15 + 0.3 * hash01(index + 101);
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [0, 0, -4 + (8 * (index + 0.5)) / layers - 4],
            quat: [0, Math.sin(tilt / 2), 0, Math.cos(tilt / 2)],
          },
        },
        { component: MeshFilter, data: { assetHandle: layer } },
        {
          component: MeshRenderer,
          data: {
            materials: [
              world.allocSharedRef(
                'MaterialAsset',
                Materials.unlit([...color, alpha], {
                  renderState: { cullMode: 'none', blend: STRAIGHT_OVER },
                }),
              ),
            ],
          },
        },
      )
      .unwrap();
  }
  return world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 6] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: WIDTH / HEIGHT,
          near: 0.1,
          far: 50,
          antialias: 0,
          bloom: 0,
          transparency: TRANSPARENCY_SORTED,
        },
      },
    )
    .unwrap();
}

function halfIsNonFinite(bits) {
  return ((bits >>> 10) & 31) === 31;
}

function countNonFinite(observation) {
  const { bytes, metadata } = observation;
  if (metadata.format !== 'rgba16float')
    return { format: metadata.format, nonFinite: 0, checked: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let nonFinite = 0;
  let checked = 0;
  let max = 0;
  const sum = [0, 0, 0, 0];
  for (let y = 0; y < metadata.height; y++) {
    const row = y * metadata.bytesPerRow;
    for (let x = 0; x < metadata.width * 4; x++) {
      const bits = view.getUint16(row + x * 2, true);
      checked += 1;
      if (halfIsNonFinite(bits)) nonFinite += 1;
      else {
        const exponent = (bits >>> 10) & 31;
        const value =
          exponent === 0
            ? (bits & 1023) * 2 ** -24
            : (1 + (bits & 1023) / 1024) * 2 ** (exponent - 15);
        if (value > max) max = value;
        sum[x % 4] += value;
      }
    }
  }
  const pixels = metadata.width * metadata.height;
  return {
    format: metadata.format,
    nonFinite,
    checked,
    maxFiniteChannel: max,
    meanRgba: sum.map((channel) => channel / pixels),
  };
}

const TIMED_PASSES = ['transparent', 'oit-accumulate', 'oit-composite'];

function passSums(frame) {
  const sums = Object.fromEntries(TIMED_PASSES.map((name) => [name, 0]));
  const unmeasured = [];
  for (const entry of frame.passes) {
    if (!TIMED_PASSES.includes(entry.passName)) continue;
    if (entry.status === 'measured') sums[entry.passName] += entry.durationNanoseconds;
    else unmeasured.push(entry.passName);
  }
  return { sums, unmeasured, frameNanoseconds: frame.measuredPassNanoseconds };
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
}

function summarize(samples, key) {
  const values = samples.map((sample) => key(sample) / 1e6);
  return { p50Ms: quantile(values, 0.5), p95Ms: quantile(values, 0.95), frames: values.length };
}

async function runWorkload(workload, backend) {
  const devices = new Set();
  const textures = [];
  const constructed = await constructRendererHost(
    canvas(devices, textures),
    { rhi, gpuPassTiming: { maxPassesPerFrame: 256, maxFramesInFlight: 2, retentionFrames: 8 } },
    { shaderManifestUrl: await manifestUrl() },
  );
  const renderer = unwrap(constructed, 'construct renderer').renderer;
  const world = new World();
  const lease = unwrap(renderer.attach(world), 'attach');
  const errors = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(String(event.error?.code ?? event.error));
  });
  const camera = spawnWorkload(world, workload.layers);
  const setMode = (mode) =>
    world
      .set(camera, Camera, {
        transparency: mode === 'sorted' ? TRANSPARENCY_SORTED : TRANSPARENCY_WEIGHTED_BLENDED,
      })
      .unwrap();
  const frame = async (includeColor) => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    if (includeColor) unwrap(renderer.requestObservation?.(['linear-hdr']), 'request observation');
    const started = performance.now();
    const drawn = unwrap(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
      'draw',
    );
    const cpuMs = performance.now() - started;
    unwrap(await drawn.completed, 'completion');
    // Wall-clock draw-to-completion corroborates the timestamps; software
    // rasterizers may defer binned raster work outside a pass's timestamp pair.
    const completionMs = performance.now() - started;
    const observed = unwrap(
      await renderer.observe(drawn, {
        include: includeColor ? ['timings', 'linear-hdr'] : ['timings'],
      }),
      'observe',
    );
    return { observed, cpuMs, completionMs, passNames: renderer.inspect().perFramePassNames };
  };
  const raw = { sorted: [], 'weighted-blended': [] };
  const statuses = { sorted: {}, 'weighted-blended': {} };
  const nonFinite = {};
  const inspection = {};
  try {
    for (const mode of ['sorted', 'weighted-blended']) {
      setMode(mode);
      for (let i = 0; i < OIT_TIMING_SAMPLING.warmupFrames; i++) await frame(false);
      const checked = await frame(true);
      const color = checked.observed.observations?.find((entry) => entry.domain === 'linear-hdr');
      nonFinite[mode] = color === undefined ? { unavailable: true } : countNonFinite(color);
      inspection[mode] = {
        transparency: renderer.inspect().transparency,
        passNames: checked.passNames,
      };
    }
    for (let group = 0; group < OIT_TIMING_SAMPLING.groups; group++) {
      for (const mode of ['sorted', 'weighted-blended']) {
        setMode(mode);
        // One unsampled frame absorbs the topology change between windows.
        await frame(false);
        for (let i = 0; i < OIT_TIMING_SAMPLING.framesPerWindow; i++) {
          const { observed, cpuMs, completionMs } = await frame(false);
          const status = observed.timings?.status ?? 'unavailable';
          statuses[mode][status] = (statuses[mode][status] ?? 0) + 1;
          if (observed.timings?.frame === undefined) continue;
          raw[mode].push({
            group,
            cpuDrawMs: cpuMs,
            completionMs,
            status,
            ...passSums(observed.timings.frame),
            frame: observed.timings.frame,
          });
        }
      }
    }
  } finally {
    unsubscribe();
    lease.dispose();
    await renderer.dispose();
    for (const device of devices) {
      try {
        await device.queue.onSubmittedWorkDone();
      } catch {
        // Best-effort cleanup after device loss.
      }
    }
    for (const texture of textures) texture.destroy();
    for (const device of devices) device.destroy();
  }
  const oitSum = (sample) =>
    sample.sums['oit-accumulate'] + sample.sums['oit-composite'] + sample.sums.transparent;
  return {
    summary: {
      id: workload.id,
      layers: workload.layers,
      resolution: { width: WIDTH, height: HEIGHT },
      sampleCount: 1,
      timingStatus: statuses,
      errors,
      nonFinite,
      inspection,
      sorted: {
        transparent: summarize(raw.sorted, (sample) => sample.sums.transparent),
        frameMeasuredPasses: summarize(raw.sorted, (sample) => sample.frameNanoseconds),
        cpuDrawP50Ms: quantile(
          raw.sorted.map((sample) => sample.cpuDrawMs),
          0.5,
        ),
        drawToCompletionMs: summarize(raw.sorted, (sample) => sample.completionMs * 1e6),
      },
      weightedBlended: {
        accumulate: summarize(raw['weighted-blended'], (sample) => sample.sums['oit-accumulate']),
        composite: summarize(raw['weighted-blended'], (sample) => sample.sums['oit-composite']),
        residualTransparent: summarize(
          raw['weighted-blended'],
          (sample) => sample.sums.transparent,
        ),
        total: summarize(raw['weighted-blended'], oitSum),
        frameMeasuredPasses: summarize(
          raw['weighted-blended'],
          (sample) => sample.frameNanoseconds,
        ),
        cpuDrawP50Ms: quantile(
          raw['weighted-blended'].map((sample) => sample.cpuDrawMs),
          0.5,
        ),
        drawToCompletionMs: summarize(
          raw['weighted-blended'],
          (sample) => sample.completionMs * 1e6,
        ),
      },
      backend,
    },
    raw,
  };
}

export async function runOitGpuPassTiming({ outputDir }) {
  const gpu = await installDawn();
  const adapter = await gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn requestAdapter returned null');
  const info = adapter.info ?? {};
  const adapterName =
    [info.vendor, info.architecture, info.device, info.description]
      .filter((v) => typeof v === 'string' && v.length > 0)
      .join('/') || 'unknown';
  const backend = {
    kind: 'webgpu',
    runner: `dawn-node/${process.version}`,
    adapter: adapterName,
    realGpu: !SOFTWARE_PROVENANCE.test(adapterName),
    timestampQuery: adapter.features?.has?.('timestamp-query') === true,
  };
  await mkdir(outputDir, { recursive: true });
  const workloads = [];
  for (const workload of OIT_WORKLOADS) {
    const result = await runWorkload(workload, backend);
    await writeFile(
      resolve(outputDir, `raw-${workload.id}.json`),
      `${JSON.stringify(result.raw)}\n`,
    );
    workloads.push(result.summary);
  }
  const report = {
    schemaVersion: OIT_TIMING_SCHEMA_VERSION,
    frameSchema: 'renderer GpuPassTimingFrame 1.0',
    source: { sourceHead: sourceHead(), package: '@forgeax/engine-render' },
    backend,
    sampling: OIT_TIMING_SAMPLING,
    memory: oitTargetMemory(WIDTH, HEIGHT),
    threshold: null,
    workloads,
  };
  await writeFile(resolve(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const outputDir = resolve(
    process.cwd(),
    process.argv.find((argument) => argument.startsWith('--output-dir='))?.slice(13) ??
      'artifacts/oit/perf',
  );
  const report = await runOitGpuPassTiming({ outputDir });
  for (const workload of report.workloads) {
    console.error(
      `[oit-timing] ${workload.id} layers=${workload.layers} sorted.transparent p50=${workload.sorted.transparent.p50Ms} ms; ` +
        `oit accumulate p50=${workload.weightedBlended.accumulate.p50Ms} composite p50=${workload.weightedBlended.composite.p50Ms} total p50=${workload.weightedBlended.total.p50Ms} ms; ` +
        `completion p50 sorted=${workload.sorted.drawToCompletionMs.p50Ms} oit=${workload.weightedBlended.drawToCompletionMs.p50Ms} ms; ` +
        `nonFinite sorted=${workload.nonFinite.sorted?.nonFinite} oit=${workload.nonFinite['weighted-blended']?.nonFinite}`,
    );
  }
  console.error(
    `[oit-timing] report ${resolve(outputDir, 'report.json')} realGpu=${report.backend.realGpu}`,
  );
  process.exit(0);
}
