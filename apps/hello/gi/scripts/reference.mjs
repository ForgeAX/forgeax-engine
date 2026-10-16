// hello-gi reference and metrics tool. For each scene it renders the ordinary
// Renderer with GI off (direct) and with the selected gather lane, traces a
// high-sample bounded path reference on the same materials, and writes HDR
// (.pfm) + PNG images, indirect-only error heatmaps, a contact sheet and one
// JSON report. Indirect = image - direct for both the lane and the reference
// (reference direct = path tracer with maxBounces 1 and a black sky).
//
//   node scripts/reference.mjs [--scenes cornell,leak,courtyard] [--size 128]
//     [--frames 64] [--samples 1024] [--gather exact|irradiance-field|screen-probe|baked]
//     [--probe-budget N] [--bounces 1] [--reflections] [--receiver diffuse|full]
//     [--out <dir>] [--capture] [--browser <dir>] [--sponza <prepared dir>]
//     [--sponza-dist <hello-gi dist>] [--reference-cache <dir>]
//     [--perf-blocks N] [--perf-frames N] [--warmup N] [--pass-timing on|off]
//     [--seed N] (independent reference sampling; lane settings remain unchanged)
//     [--reference-only] (trace an independent reference without rendering a lane)
//     [--bake-rays 128] [--bake-samples 256] [--bake-density 1] [--bake-dir <dir>]
//
// --gather baked first cooks each scene's irradiance volume with the same exact
// integrator and bounce budget as the reference (scripts/gi-bake.mjs), writes it as
// a served catalog under --bake-dir (default <out>/baked) and renders the lane
// from that Catalog by GUID; the report adds the bake table (time, bytes, digest).
// --reflections enables Lite reflections on the lane; the receiver then defaults to
// 'full', because the lane composites specular indirect as well.
// --reference-cache reuses traced references across lanes (keyed by scene, size,
// samples, bounces and receiver). --perf-blocks N measures N blocks of
// --perf-frames queue-synchronized frames (wall time and per-pass GPU time).
//
// --browser <dir> substitutes <dir>/<scene>.json (written by browser-gi.mjs) for
// the Dawn Renderer images of that scene. Without it, the Sponza lane renders under
// Dawn from the built hello-gi catalog (--sponza-dist, default apps/hello/gi/dist).
// The Sponza reference uses scripts/raytracing/gltf/prepare.mjs output (--sponza).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import * as gi from './gi-dawn.mjs';
import { intermediateBufferReads, optionReader, referenceAssetCommit, referenceCoverage, replayTimingSummary } from './gi-comparison.mjs';
import {
  contactSheet,
  indirectMetrics,
  readPfm,
  luminance,
  regionMask,
  subtract,
  toDisplay,
  toHeatmap,
  unlitMask,
  writePfm,
  writePng,
} from './gi-metrics.mjs';

const args = process.argv.slice(2);
const option = optionReader(args);
const SIZE = Number(option('size', '128'));
const FRAMES = Number(option('frames', '64'));
const SAMPLES = Number(option('samples', '1024'));
const SEED = Number(option('seed', '47'));
if (!Number.isSafeInteger(SEED) || SEED < 0 || SEED > 0xffffffff) throw new Error('invalid reference seed');
const GATHER = option('gather', 'exact');
if (!['exact', 'irradiance-field', 'screen-probe', 'baked'].includes(GATHER))
  throw new Error(`--gather ${GATHER}: expected exact|irradiance-field|screen-probe|baked`);
const BAKE_RAYS = Number(option('bake-rays', '128'));
const BAKE_SAMPLES = Number(option('bake-samples', '256'));
const BAKE_DENSITY = Number(option('bake-density', '1'));
const PROBE_BUDGET = option('probe-budget') === undefined ? undefined : Number(option('probe-budget'));
const BOUNCES = Number(option('bounces', '1'));
const REFLECTIONS = args.includes('--reflections');
// Reference receiver: 'diffuse' (what the diffuse lane composites) or 'full' BSDF.
const RECEIVER = option('receiver', REFLECTIONS ? 'full' : 'diffuse');
const REFERENCE_CACHE = option('reference-cache');
const PERF_BLOCKS = Number(option('perf-blocks', '0'));
const PERF_FRAMES = Number(option('perf-frames', '32'));
const WARMUP = Number(option('warmup', '0'));
const CAPTURE = args.includes('--capture');
const REFERENCE_ONLY = args.includes('--reference-only');
if (REFERENCE_ONLY && CAPTURE) throw new Error('--reference-only has no renderer frame to capture');
// Per-pass timestamps add encoder work to every pass; `off` measures the bare frame.
const PASS_TIMING = option('pass-timing', 'on') !== 'off';
const BROWSER = option('browser');
const SPONZA = option('sponza');
// Built hello-gi catalog for the Dawn Sponza lane (`pnpm --filter @forgeax/hello-gi build`).
const SPONZA_DIST = resolve(option('sponza-dist', resolve(gi.appRoot, 'dist')));
const SCENES = option('scenes', SPONZA ? 'cornell,leak,courtyard,sponza' : 'cornell,leak,courtyard')
  .split(',')
  .filter(Boolean);
const OUT = resolve(option('out', resolve(gi.monorepoRoot, 'artifacts/gi-reference')));
mkdirSync(OUT, { recursive: true });
const BAKE_DIR = resolve(option('bake-dir', resolve(OUT, 'baked')));

const log = (line) => console.log(`[reference] ${line}`);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[sorted.length >> 1];
};
const meanLuminance = (rgb) => {
  let sum = 0;
  for (let p = 0; p < rgb.length / 3; p++) sum += luminance(rgb, p);
  return (sum * 3) / rgb.length;
};

await gi.installDawn();
const {
  BAKED_VOLUMES,
  PROCEDURAL_SCENES,
  SPONZA: SPONZA_SCENE,
  diffuseGiFor,
  fieldFor,
} = await import('../src/scenes.ts');
const bake = await import('./gi-bake.mjs');
const { createGiBoxMesh, spawnCamera, spawnLight, spawnProceduralScene } = await import(
  '../src/build-scene.ts'
);
const boxMesh = await createGiBoxMesh();
const webgpu = await import('@forgeax/engine-rhi-webgpu');
const { buildRaySurfaceScene } = await import('@forgeax/engine-render/internal');
// Sponza loads its original cooked materials from the Catalog, never these boxes.
const cooked = SCENES.some((id) => id !== 'sponza') ? await gi.cookGiMaterials() : new Map();
const traceDevice = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
traceDevice.lost.then((info) => log(`reference device lost: ${JSON.stringify(info)}`));

/** Dawn Renderer images for one procedural scene, plus an optional RHI tape. */
async function rendererImages(scene) {
  const devices = [];
  const { renderer, assets, canvas, errors, recorder } = await gi.createGiRenderer({
    width: SIZE,
    height: SIZE,
    timing: PASS_TIMING,
    capture: CAPTURE,
    onDevice: (device) => devices.push({
      adapterInfo: device.adapterInfo,
      features: [...device.features],
      limits: device.limits,
    }),
  });
  const world = new World();
  if (scene === SPONZA_SCENE) await gi.spawnSponza(world, assets, SPONZA_DIST);
  else spawnProceduralScene(world, scene, gi.publishMaterials(world, assets, cooked), 1, boxMesh);
  // The baked lane resolves its volume GUID through the served bake catalog.
  const restoreCatalog = GATHER === 'baked' ? gi.installDistCatalog(assets, BAKE_DIR) : () => {};
  const lease = renderer.attach(world).unwrap();
  const driver = await gi.createFrameDriver({ renderer, world, lease });
  const direct = gi.directProfile(renderer.inspect().profile);
  const sample = async (frames) => {
    const sum = new Float32Array(SIZE * SIZE * 3);
    const timings = [];
    for (let k = 0; k < frames; k++) {
      const { observed } = await driver.observe(['linear-hdr'], ['linear-hdr', 'timings']);
      timings.push(observed.timings);
      const rgb = gi.hdrToRgb(
        observed.observations.find((o) => o.domain === 'linear-hdr'),
        SIZE,
        SIZE,
      );
      for (let i = 0; i < sum.length; i++) sum[i] += rgb[i] / frames;
    }
    return { rgb: sum, timings };
  };
  renderer.setProfile(direct).unwrap();
  await driver.settle();
  for (let i = 0; i < WARMUP; i++) await driver.draw();
  const off = await sample(FRAMES);
  const offPerf = PERF_BLOCKS > 0 ? await perfBlocks(renderer, driver) : undefined;
  const diffuseGi = diffuseGiFor(GATHER, scene, {
    maxBounces: BOUNCES,
    reflections: REFLECTIONS,
    volume: BAKED_VOLUMES[scene.id ?? 'sponza'],
    ...(PROBE_BUDGET === undefined ? {} : { field: { probeBudget: PROBE_BUDGET } }),
  });
  const profile = renderer.setProfile({ ...direct, diffuseGi });
  if (!profile.ok) throw new Error(`setProfile(${GATHER}): ${JSON.stringify(profile.error)}`);
  let started = performance.now();
  await driver.settle();
  const settleMs = performance.now() - started;
  // Field lanes integrate with temporal hysteresis; --warmup frames let them reach
  // steady state before the averaged sample window.
  for (let i = 0; i < WARMUP; i++) await driver.draw();
  started = performance.now();
  const on = await sample(FRAMES);
  const sampleMs = performance.now() - started;
  const perf = PERF_BLOCKS > 0 ? await perfBlocks(renderer, driver) : undefined;
  const result = {
    direct: off.rgb,
    gi: on.rgb,
    windows: { direct: { warmup: WARMUP, frames: FRAMES }, gi: { warmup: WARMUP, frames: FRAMES } },
    gpu: { direct: gi.summarizeTimings(off.timings), gi: gi.summarizeTimings(on.timings) },
    wallMs: { settle: settleMs, perGiFrame: sampleMs / FRAMES },
    perf: perf === undefined ? undefined : { ...perf, direct: offPerf },
    inspect: renderer.inspect().diffuseGi,
    backend: renderer.inspect().capabilities.backendKind,
    devices,
    errors,
  };
  if (recorder !== undefined)
    result.capture = await captureAndReplay(scene.id ?? 'sponza', recorder, driver, canvas);
  renderer.dispose?.();
  restoreCatalog();
  return result;
}

/**
 * Repeated blocks of queue-synchronized frames without image readback. Each block
 * reports the median wall time per frame (draw submit to `completed`) and the
 * median measured GPU pass sum; the summary is the median across blocks.
 */
async function perfBlocks(renderer, driver) {
  const blocks = [];
  for (let b = 0; b < PERF_BLOCKS; b++) {
    const wall = [];
    const timings = [];
    for (let k = 0; k < PERF_FRAMES; k++) {
      const started = performance.now();
      const receipt = await driver.draw();
      wall.push(performance.now() - started);
      const observed = await renderer.observe(receipt, { include: ['timings'] });
      if (observed.ok) timings.push(observed.value.timings);
    }
    const gpu = gi.summarizeTimings(timings);
    blocks.push({
      wallMs: median(wall),
      gpuTotalMs: gpu.totalMs,
      giMs: gpu.giMs,
      giTransportMs: gpu.giTransportMs,
      passes: gpu.passes,
      intervals: gpu.intervals,
      rawFrames: gpu.rawFrames,
      rawWallMs: wall,
    });
  }
  const pick = (key) => blocks.map((b) => b[key]).filter((v) => typeof v === 'number');
  const spread = (values) => ({
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  });
  const byPass = new Map();
  for (const block of blocks)
    for (const pass of block.passes ?? [])
      byPass.set(pass.name, [...(byPass.get(pass.name) ?? []), pass.ms]);
  return {
    blocks: PERF_BLOCKS,
    framesPerBlock: PERF_FRAMES,
    rawBlocks: blocks,
    wallMs: spread(pick('wallMs')),
    gpuTotalMs: spread(pick('gpuTotalMs')),
    giMs: spread(pick('giMs')),
    giTransportMs: spread(pick('giTransportMs')),
    measuredPasses: byPass.size,
    passes: [...byPass].map(([name, ms]) => ({ name, ms: median(ms) })).sort((a, b) => b.ms - a.ms),
  };
}

/** One-frame tape through the recorder, then fresh-device replay. */
async function captureAndReplay(id, recorder, driver, canvas) {
  const started = performance.now();
  const pending = recorder.captureFrame({ byteBudget: 2 ** 31, snapshotTimeoutMs: 600000 });
  const seeded = await recorder.frameBoundary();
  const seedMs = performance.now() - started;
  if (!seeded.ok) return { ok: false, stage: 'seed', error: seeded.error.code };
  await driver.draw();
  const tape = await pending;
  const captureMs = performance.now() - started;
  if (!tape.ok)
    return { ok: false, stage: 'capture', error: tape.error.code, detail: tape.error.detail };
  const live = await gi.readSurface(canvas);
  const path = resolve(OUT, `${id}.rhitape`);
  writeFileSync(path, tape.value.bytes);
  // The next frame's tape seeds every retained resource from the live device right
  // after this frame, so its bootstrap is this frame's live end state.
  const followingPending = recorder.captureFrame({ byteBudget: 2 ** 31, snapshotTimeoutMs: 600000 });
  const followingSeeded = await recorder.frameBoundary();
  if (followingSeeded.ok) await driver.draw();
  const following = await followingPending;
  if (following.ok) writeFileSync(resolve(OUT, `${id}.next.rhitape`), following.value.bytes);
  return {
    digest: tape.value.digest,
    seedMs,
    captureMs,
    ...(await replayTape(path, tape.value.bytes, live)),
    liveDivergence: following.ok
      ? await liveDivergence(id, tape.value.bytes, following.value.bytes)
      : { ok: false, error: following.error.code },
  };
}

/**
 * Live-vs-replay resource divergence: replay frame A to its last work and compare
 * every buffer and texture with frame B's bootstrap (A's live end state). Diverging
 * resources are ordered by their first potential writer in A. This is resource
 * lineage, not proof of the first actual divergence at that intermediate work.
 */
async function liveDivergence(id, frameBytes, followingBytes) {
  const { bindingReadRequest, buildFrameModel, decodeTape, openReplay, replayDeviceRequest } = await import(
    '@forgeax/engine-rhi-debug'
  );
  const a = decodeTape(frameBytes);
  const b = decodeTape(followingBytes);
  if (!a.ok || !b.ok) return { ok: false, stage: 'decode' };
  const model = buildFrameModel(a.value);
  const following = new Set(
    buildFrameModel(b.value)
      .resources.filter((r) => r.origin === 'bootstrap')
      .map((r) => r.resourceId),
  );
  const label = (r) => r.descriptor?.desc?.label ?? null;
  const viewTexture = new Map(
    model.resources
      .filter((r) => r.kind === 'texture-view')
      .map((r) => [r.resourceId, r.descriptor?.sourceHandleId]),
  );
  const writers = new Map();
  const wrote = (id, work) => {
    if (typeof id !== 'string') return;
    const target = viewTexture.get(id) ?? id;
    const list = writers.get(target) ?? [];
    if (list.at(-1) !== work) list.push(work);
    writers.set(target, list);
  };
  for (const work of model.works) {
    for (const bound of work.bindings)
      if (bound.access === 'write' || bound.access === 'read-write')
        wrote(bound.resourceId, work.workIndex);
    for (const view of work.attachments?.colorViewHandleIds ?? []) wrote(view, work.workIndex);
    wrote(work.attachments?.depthStencilViewHandleId, work.workIndex);
  }
  // Timestamp resolves and the presented swapchain image legitimately differ
  // between a live frame and its replay; neither feeds the next frame.
  const QUERY_RESOLVE = 0x200;
  const candidates = model.resources.filter(
    (r) =>
      (r.kind === 'buffer' || r.kind === 'texture') &&
      r.lifecycle.state === 'live' &&
      following.has(r.resourceId) &&
      r.descriptor?.origin !== 'swapchain' &&
      ((r.descriptor?.desc?.usage ?? 0) & QUERY_RESOLVE) === 0,
  );
  const lastWork = model.works.length - 1;
  const open = async (tape) => {
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule });
    return { device, replay };
  };
  const replayed = await open(a.value);
  const seeded = await open(b.value);
  if (!replayed.replay.ok || !seeded.replay.ok) return { ok: false, stage: 'replay-open' };
  const diverging = [];
  const unreadable = [];
  const perWork = [];
  const directory = resolve(OUT, `${id}.rhi-reads`);
  mkdirSync(directory, { recursive: true });
  const save = (name, value) => {
    writeFileSync(resolve(directory, `${name}.bin`), value.bytes);
    return { file: `${id}.rhi-reads/${name}.bin`, bytes: value.bytes.length,
      sha256: createHash('sha256').update(value.bytes).digest('hex'), provenance: value.provenance };
  };
  try {
    // Use recorded entry points, binding windows and work indices. These are
    // actual intermediate replay reads; following-frame seeds remain final live
    // inputs and must never be described as intermediate producer outputs.
    const workReads = [];
    for (const work of model.works) {
      // Resource ownership selects actual work, including newly added stages
      // such as Probe radiance history; no second entry-point roster can omit it.
      const fieldGather = work.bindings.some((bound) => bound.access === 'read-write' &&
        model.resources.some((r) => r.resourceId === bound.resourceId &&
          label(r) === 'irradiance-field.gathered'));
      const buffers = work.bindings.filter((bound) =>
        model.resources.some((r) => r.resourceId === bound.resourceId && r.kind === 'buffer' &&
          (fieldGather || /^(screen-probe\.|irradiance-field\.)/.test(label(r) ?? ''))));
      if (buffers.length === 0) continue;
      const requests = buffers.map((bound) => bindingReadRequest(work, bound.groupIndex, bound.binding).unwrap());
      const windows = requests.map((request) => {
        const resource = model.resources.find((r) => r.resourceId === request.resourceId);
        return { request, bytes: request.subresource?.size ?? resource.descriptor.desc.size - (request.subresource?.offset ?? 0) };
      });
      // The recorded depth writer initializes this frame before the gather.
      // Depth/stencil has no faithful following-frame seed; read its actual
      // producing frame with an explicit aspect rather than inventing a seed.
      const textures = fieldGather ? work.bindings.filter((bound) =>
        bound.groupIndex === 0 && bound.access === 'read' &&
        bound.resourceKind === 'textureView').map((binding) => {
          const texture = model.resources.find((r) =>
            r.resourceId === viewTexture.get(binding.resourceId));
          const desc = texture.descriptor.desc;
          if (desc.format !== 'r32uint' && !desc.format.startsWith('depth'))
            throw new Error('unexpected field receiver texture format');
          const request = bindingReadRequest(work, binding.groupIndex, binding.binding).unwrap();
          if (desc.format.startsWith('depth')) request.subresource = {
            ...request.subresource, aspect: 'depth-only',
          };
          return { binding, request, bytes: desc.size.width * desc.size.height * 4 };
        }) : [];
      workReads.push({ work, buffers, windows, textures });
    }
    const bounded = intermediateBufferReads(workReads.flatMap((read) => read.windows),
      workReads.flatMap((read) => read.textures).reduce((sum, read) => sum + read.bytes, 0));
    let cursor = 0;
    for (const { work, buffers, windows, textures } of workReads) {
      const requests = [...bounded.slice(cursor, cursor + windows.length),
        ...textures.map((read) => read.request)];
      const bindings = [...buffers, ...textures.map((read) => read.binding)];
      const sizes = [...windows, ...textures].map((read) => read.bytes);
      cursor += windows.length;
      const rows = (await replayed.replay.value.readAtWorks(requests)).unwrap();
      rows.forEach((row, k) => {
        const binding = bindings[k];
        const entry = { workIndex: work.workIndex, entryPoint: work.pipeline.shaders[0].entryPoint,
          group: binding.groupIndex, binding: binding.binding, resourceId: binding.resourceId,
          access: binding.access, request: requests[k], boundWindowBytes: sizes[k],
          byteCoverage: (requests[k].subresource?.size ?? sizes[k]) === sizes[k]
            ? 'full-bound-window' : 'prefix-of-bound-window' };
        if (!row.ok) { perWork.push({ ...entry, error: row.error }); return; }
        perWork.push({ ...entry, ...save(`work-${work.workIndex}-g${binding.groupIndex}-b${binding.binding}`, row.value) });
      });
    }
    for (let i = 0; i < candidates.length; i += 32) {
      const slice = candidates.slice(i, i + 32);
      const ends = await replayed.replay.value.readAtWorks(
        slice.map((r) => ({ resourceId: r.resourceId, workIndex: lastWork })),
      );
      const seeds = await seeded.replay.value.readAtWorks(
        slice.map((r) => ({ resourceId: r.resourceId })),
      );
      if (!ends.ok || !seeds.ok) return { ok: false, stage: 'read' };
      slice.forEach((resource, k) => {
        const end = ends.value[k];
        const seed = seeds.value[k];
        if (!end.ok || !seed.ok) {
          unreadable.push({ resourceId: resource.resourceId, label: label(resource) });
          return;
        }
        const x = end.value.bytes;
        const y = seed.value.bytes;
        let mismatched = 0;
        let first = -1;
        for (let j = 0; j < Math.min(x.length, y.length); j++)
          if (x[j] !== y[j]) {
            mismatched += 1;
            if (first < 0) first = j;
          }
        if (mismatched === 0 && x.length === y.length) return;
        const written = writers.get(resource.resourceId) ?? [];
        diverging.push({
          resourceId: resource.resourceId,
          label: label(resource),
          kind: resource.kind,
          bytes: x.length,
          mismatchedBytes: mismatched,
          firstByte: first,
          firstWriter: written[0] ?? null,
          firstWriterLabel:
            written[0] === undefined ? null : (model.works[written[0]]?.pipeline?.descriptor?.label ?? null),
          writers: written.length,
          replay: save(`resource-${i + k}-replay`, end.value),
          liveFinal: save(`resource-${i + k}-live-final`, seed.value),
        });
      });
    }
  } finally {
    await replayed.replay.value.dispose();
    await seeded.replay.value.dispose();
    replayed.device.destroy?.();
    seeded.device.destroy?.();
  }
  diverging.sort((p, q) => (p.firstWriter ?? Infinity) - (q.firstWriter ?? Infinity));
  return {
    ok: true,
    compared: candidates.length,
    diverging,
    unreadable: unreadable.length,
    firstPotentialWriterWork: diverging[0]?.firstWriter ?? null,
    perWork,
  };
}

/**
 * Fresh-device replay of a tape: decode, open, inspect the last draw (compared
 * with the live surface when given) and a sample of works with pixel readback.
 */
async function replayTape(path, bytes, live) {
  const { buildFrameModel, decodeTape, openReplay, replayDeviceRequest } = await import(
    '@forgeax/engine-rhi-debug'
  );
  let started = performance.now();
  const decoded = decodeTape(bytes);
  if (!decoded.ok) return { ok: false, stage: 'decode', error: decoded.error.code };
  const model = buildFrameModel(decoded.value);
  const decodeMs = performance.now() - started;
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(
      replayDeviceRequest(decoded.value, adapter.features, adapter.limits),
    )
  ).unwrap();
  started = performance.now();
  const replay = await openReplay(decoded.value, {
    device,
    createShaderModule: webgpu.createShaderModule,
  });
  const openMs = performance.now() - started;
  if (!replay.ok) return { ok: false, stage: 'replay-open', error: replay.error.code };
  const workKinds = {};
  for (const w of model.works) workKinds[w.kind] = (workKinds[w.kind] ?? 0) + 1;
  // Resource descriptors are the create event ({ desc: { label, size, ... } }). The
  // tape's tight-layout estimate skips 3D textures, so those are sized here from the
  // descriptor (all mips, tightly packed) for the common GI formats.
  const TEXEL_BYTES = {
    rgba32float: 16,
    rgba16float: 8,
    rg32float: 8,
    rgba8unorm: 4,
    r32float: 4,
    r32uint: 4,
    rg16float: 4,
    rgb10a2unorm: 4,
    rg11b10ufloat: 4,
    r16float: 2,
    r8unorm: 1,
  };
  const resourceBytes = (r) => {
    const estimate = r.lifecycle.byteEstimate;
    if (estimate?.status === 'known') return estimate.bytes;
    const desc = r.descriptor?.desc;
    const texel = TEXEL_BYTES[desc?.format];
    if (r.kind !== 'texture' || texel === undefined || desc.dimension !== '3d') return undefined;
    let { width, height = 1, depthOrArrayLayers: depth = 1 } = desc.size;
    let bytes = 0;
    for (let mip = 0; mip < (desc.mipLevelCount ?? 1); mip++) {
      bytes += width * height * depth * texel;
      width = Math.max(1, width >> 1);
      height = Math.max(1, height >> 1);
      depth = Math.max(1, depth >> 1);
    }
    return bytes;
  };
  const giResourceBytes = {};
  let allResourceBytes = 0;
  for (const r of model.resources) {
    const label = r.descriptor?.desc?.label;
    const size = resourceBytes(r);
    if (typeof size !== 'number') continue;
    allResourceBytes += size;
    if (typeof label !== 'string') continue;
    if (!/^(ray|irradiance|screen-probe|probe-|card|global-sdf|sdf|gi\.|radiance|reflection|surface|diffuse-gi|path)|[.-]ray/i.test(label))
      continue;
    giResourceBytes[label] = (giResourceBytes[label] ?? 0) + size;
  }
  const report = {
    ok: true,
    path,
    bytes: bytes.byteLength,
    works: model.works.length,
    workKinds,
    giResourceBytes,
    giResourceBytesTotal: Object.values(giResourceBytes).reduce((a, b) => a + b, 0),
    allResourceBytes,
    resources: model.resources.length,
    unseededResources: model.unseededResources.length,
    decodeMs,
    replayOpenMs: openMs,
  };
  try {
    started = performance.now();
    const timed = await replay.value.timePasses();
    report.replayTimingMs = performance.now() - started;
    if (timed.ok) {
      report.replayTiming = replayTimingSummary(timed.value.passes, model.works);
    } else report.replayTiming = { error: timed.error.code, detail: timed.error.detail };
    const last = model.works.findLast((w) => w.kind.startsWith('draw'));
    started = performance.now();
    const inspected = await replay.value.inspectWork(last.workIndex, ['pixels']);
    report.replayInspectLastMs = performance.now() - started;
    if (!inspected.ok) {
      report.pixels = { compared: false, error: inspected.error.code };
    } else if (live === undefined) {
      const a = inspected.value.attachment;
      report.pixels = {
        compared: false,
        reason: 'no live surface',
        width: a?.width,
        height: a?.height,
      };
    } else {
      const pixels = inspected.value.attachment;
      const comparable =
        pixels !== undefined && pixels.width === live.width && pixels.height === live.height;
      let maxDiff = 0;
      let mismatched = 0;
      if (comparable)
        for (let i = 0; i < live.bytes.length; i++) {
          const d = Math.abs(pixels.bytes[i] - live.bytes[i]);
          if (d > 0) mismatched += 1;
          maxDiff = Math.max(maxDiff, d);
        }
      report.pixels = comparable
        ? {
            compared: true,
            workIndex: last.workIndex,
            format: pixels.format,
            maxDiff,
            mismatchedBytes: mismatched,
          }
        : {
            compared: false,
            reason: `attachment ${pixels?.width}x${pixels?.height} vs surface ${live.width}x${live.height}`,
          };
    }
    const step = Math.max(1, Math.floor(model.works.length / 8));
    const sampled = model.works.filter((_, i) => i % step === 0).slice(0, 8);
    const times = [];
    const failures = [];
    for (const work of sampled) {
      started = performance.now();
      // Dispatches write buffers and storage textures, not attachments.
      const r = await replay.value.inspectWork(
        work.workIndex,
        work.kind.startsWith('draw') ? ['pixels'] : ['outputs'],
      );
      times.push(performance.now() - started);
      if (!r.ok)
        failures.push({
          workIndex: work.workIndex,
          kind: work.kind,
          code: r.error.code,
          reason: r.error.detail?.reason,
        });
    }
    report.replayInspectSample = {
      works: sampled.length,
      failures,
      medianMs: median(times),
      maxMs: Math.max(...times),
    };
  } finally {
    await replay.value.dispose();
    device.destroy?.();
  }
  return report;
}

/** Reference direct and indirect from the bounded path tracer. */
async function proceduralReference(scene) {
  const ray = await gi.proceduralRayScene(scene, cooked, true);
  const common = {
    device: traceDevice,
    compile: webgpu.createShaderModule,
    scene: buildRaySurfaceScene(ray.instances).unwrap(),
    materials: ray.materials,
    lights: [gi.lightSnapshot(scene.light)],
    camera: scene.camera,
    width: SIZE,
    height: SIZE,
    maxDistance: scene.maxDistance,
  };
  return traceReference(common, scene.environment);
}

async function traceReference(common, environment) {
  common = { ...common, seed: SEED };
  const started = performance.now();
  let coverage;
  const direct = await gi.tracePath({
    ...common,
    maxBounces: 1,
    environment: [0, 0, 0],
    samples: Math.max(64, SAMPLES >> 2),
    onAccumulation: (records) => {
      coverage = referenceCoverage(records, common.width * common.height);
    },
  });
  // The lane composites only the diffuse receiver response; the full BSDF would
  // also count receiver specular reflections of sky and walls as "indirect".
  const receiverDirect =
    RECEIVER === 'full'
      ? direct
      : await gi.tracePath({
          ...common,
          receiver: RECEIVER,
          maxBounces: 1,
          environment: [0, 0, 0],
          samples: Math.max(64, SAMPLES >> 2),
        });
  const full = await gi.tracePath({
    ...common,
    receiver: RECEIVER,
    maxBounces: 1 + BOUNCES,
    environment,
    samples: SAMPLES,
    onAccumulation: (records) => {
      const fullCoverage = referenceCoverage(records, common.width * common.height);
      if (coverage.some((hit, pixel) => hit !== fullCoverage[pixel]))
        throw new Error('reference primary coverage changed between bounce budgets');
    },
  });
  const indirect = subtract(full, receiverDirect);
  return {
    direct,
    coverage,
    // Displayed reference: what the lane should produce, direct + diffuse indirect.
    full: RECEIVER === 'full' ? full : direct.map((v, i) => v + (indirect[i] ?? 0)),
    indirect,
    ms: performance.now() - started,
  };
}

async function sponzaResources() {
  const { createGltfResources } = await import(
    '../../../../scripts/raytracing/gltf/resources.mjs'
  );
  const prepared = JSON.parse(readFileSync(resolve(SPONZA, 'prepared.json'), 'utf8'));
  const load = async (name) => new Uint8Array(readFileSync(resolve(SPONZA, name)));
  return {
    prepared,
    resources: await createGltfResources(traceDevice, webgpu.createShaderModule, prepared, load),
  };
}

/**
 * Cook every selected scene's volume with the reference integrator and bounce
 * budget: a receiver's path after its first vertex is the probe's path, so the
 * bake traces `BOUNCES` vertices where the reference traces `1 + BOUNCES`.
 */
async function bakeVolumes() {
  const settings = {
    raysPerProbe: BAKE_RAYS,
    samples: BAKE_SAMPLES,
    maxBounces: BOUNCES,
    seed: 47,
  };
  const products = [];
  for (const id of SCENES) {
    log(`${id}: baking irradiance volume (${BAKE_RAYS} rays x ${BAKE_SAMPLES} spp, ${BOUNCES} bounces)`);
    if (id === 'sponza') {
      if (SPONZA === undefined) continue;
      const { prepared, resources } = await sponzaResources();
      try {
        products.push(
          await bake.cookVolume({
            guid: BAKED_VOLUMES.sponza,
            device: traceDevice,
            compile: webgpu.createShaderModule,
            ray: {
              scene: resources.scene,
              materials: prepared.materials,
              resolveTexture: resources.resolveTexture,
            },
            lights: [gi.lightSnapshot(SPONZA_SCENE.light)],
            lattice: bake.bakeLatticeFor(fieldFor(SPONZA_SCENE.bounds), BAKE_DENSITY),
            settings: {
              ...settings,
              environment: SPONZA_SCENE.environment,
              maxDistance: SPONZA_SCENE.maxDistance,
            },
          }),
        );
      } finally {
        resources.dispose?.();
      }
      continue;
    }
    products.push(
      await bake.bakeProceduralScene({
        scene: PROCEDURAL_SCENES[id],
        cooked,
        guid: BAKED_VOLUMES[id],
        device: traceDevice,
        compile: webgpu.createShaderModule,
        settings,
        density: BAKE_DENSITY,
      }),
    );
  }
  for (const { stats } of products)
    log(
      `${stats.guid}: baked ${stats.probes} probes in ${(stats.bakeMs / 1000).toFixed(1)} s ` +
        `(${(stats.artifactBytes / 1024).toFixed(0)} KiB, ${stats.digest.slice(0, 19)})`,
    );
  await bake.writeBakedCatalog(BAKE_DIR, products);
  return products.map((p) => p.stats);
}

async function sponzaReference(size) {
  const { prepared, resources } = await sponzaResources();
  try {
    return await traceReference(
      {
        device: traceDevice,
        compile: webgpu.createShaderModule,
        scene: resources.scene,
        materials: prepared.materials,
        resolveTexture: resources.resolveTexture,
        lights: [gi.lightSnapshot(SPONZA_SCENE.light)],
        camera: SPONZA_SCENE.camera,
        width: size,
        height: size,
        maxDistance: SPONZA_SCENE.maxDistance,
      },
      SPONZA_SCENE.environment,
    );
  } finally {
    resources.dispose?.();
  }
}

/** Traced reference images, reused across lanes when --reference-cache is given. */
async function cachedReference(id, size) {
  const key = `${id}-${size}px-${SAMPLES}spp-b${BOUNCES}-${RECEIVER}-seed${SEED}`;
  const dir = REFERENCE_CACHE === undefined ? undefined : resolve(REFERENCE_CACHE, key);
  const parts = ['direct', 'full', 'indirect'];
  const receipt = JSON.stringify({ provenance, id, size, samples: SAMPLES, bounces: BOUNCES, receiver: RECEIVER, seed: SEED });
  const receiptPath = dir === undefined ? undefined : resolve(dir, 'source.json');
  if (dir !== undefined && parts.every((p) => existsSync(resolve(dir, `${p}.pfm`))) &&
      existsSync(resolve(dir, 'coverage.bin')) && existsSync(receiptPath) &&
      readFileSync(receiptPath, 'utf8') === receipt) {
    const read = Object.fromEntries(parts.map((p) => [p, readPfm(resolve(dir, `${p}.pfm`)).rgb]));
    return { ...read, coverage: new Uint8Array(readFileSync(resolve(dir, 'coverage.bin'))), ms: 0, cached: key };
  }
  const reference =
    id === 'sponza' ? await sponzaReference(size) : await proceduralReference(PROCEDURAL_SCENES[id]);
  if (dir !== undefined) {
    mkdirSync(dir, { recursive: true });
    for (const p of parts) writePfm(resolve(dir, `${p}.pfm`), reference[p], size, size);
    writeFileSync(resolve(dir, 'coverage.bin'), reference.coverage);
    writeFileSync(receiptPath, receipt);
  }
  return reference;
}

function browserImages(id) {
  const path = BROWSER === undefined ? undefined : resolve(BROWSER, `${id}.json`);
  if (path === undefined || !existsSync(path)) return undefined;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.settings?.size !== SIZE || data.settings.frames !== FRAMES ||
      data.settings.warmup !== WARMUP || data.settings.bounces !== BOUNCES ||
      data.settings.gather !== GATHER || data.commit !== provenance.commit ||
      data.errors?.length > 0 || data.state?.errors !== 0)
    throw new Error(`unmatched browser source/window or failed validation for ${id}`);
  const decode = (b64) => new Float32Array(new Uint8Array(Buffer.from(b64, 'base64')).buffer);
  return {
    size: data.width,
    direct: decode(data.direct.rgb),
    gi: decode(data.gi.rgb),
    windows: { direct: { warmup: WARMUP, frames: FRAMES }, gi: { warmup: WARMUP, frames: FRAMES } },
    gpu: {
      direct: gi.summarizeTimings([data.direct.timings]),
      gi: gi.summarizeTimings([data.gi.timings]),
    },
    wallMs: data.wallMs,
    inspect: data.gi.inspect,
    backend: `browser:${data.userAgent ?? 'unknown'}`,
    errors: data.errors ?? [],
    capture: data.capture,
  };
}

/** Browser tapes were uploaded by the dev server; replay them on a fresh local device. */
async function browserCapture(capture) {
  const path = capture?.artifact?.path;
  if (path === undefined || !existsSync(path)) return capture;
  return { ...capture, replay: await replayTape(path, new Uint8Array(readFileSync(path))) };
}

const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gi.appRoot }).toString().trim();
  } catch {
    return undefined;
  }
})();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const preparedPayloads = SPONZA === undefined ? undefined : (() => {
  const prepared = JSON.parse(readFileSync(resolve(SPONZA, 'prepared.json'), 'utf8'));
  return Object.fromEntries(['triangles.bin', 'nodes.bin', 'attributes.bin',
    ...prepared.images.map((image) => `image-${image.id}.bin`)].map(
      (name) => [name, sha256(readFileSync(resolve(SPONZA, name)))],
    ));
})();
const provenance = {
  commit,
  sourceDiffSha256: sha256(execFileSync('git', ['diff', 'HEAD', '--', 'packages', 'apps/hello/gi', 'scripts/raytracing'], { cwd: gi.monorepoRoot })),
  assetsCommit: referenceAssetCommit(gi.monorepoRoot, SCENES),
  ...(SPONZA === undefined ? {} : {
    preparedSha256: sha256(readFileSync(resolve(SPONZA, 'prepared.json'))),
    preparedPayloads,
    catalogSha256: sha256(readFileSync(resolve(SPONZA_DIST, 'pack-index.json'))),
  }),
};
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit,
  provenance,
  platform: `${process.platform}-${process.arch}`,
  settings: {
    reflections: REFLECTIONS,
    warmup: WARMUP,
    passTiming: PASS_TIMING,
    size: SIZE,
    frames: FRAMES,
    samples: SAMPLES,
    seed: SEED,
    gather: GATHER,
    referenceOnly: REFERENCE_ONLY,
    bounces: BOUNCES,
    receiver: RECEIVER,
  },
  scenes: [],
};
if (GATHER === 'baked') report.bake = await bakeVolumes();
const sheetRows = [];
for (const id of SCENES) {
  try {
  const scene = id === 'sponza' ? SPONZA_SCENE : PROCEDURAL_SCENES[id];
  if (scene === undefined) throw new Error(`unknown scene ${id}`);
  if (REFERENCE_ONLY) {
    log(`${id}: tracing independent reference (${SAMPLES} spp, seed ${SEED})`);
    const reference = await cachedReference(id, SIZE);
    writeFileSync(resolve(OUT, `${id}-coverage.bin`), reference.coverage);
    for (const [part, image] of [['reference', reference.full], ['reference-indirect', reference.indirect], ['direct', reference.direct]])
      writePfm(resolve(OUT, `${id}-${part}.pfm`), image, SIZE, SIZE);
    report.scenes.push({ id, size: SIZE, referenceMs: reference.ms,
      coverageSha256: sha256(reference.coverage), errors: [] });
    writeFileSync(resolve(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    continue;
  }
  log(`${id}: rendering ${GATHER} lane`);
  const lane =
    browserImages(id) ??
    (id !== 'sponza' || existsSync(resolve(SPONZA_DIST, 'pack-index.json'))
      ? await rendererImages(scene)
      : undefined);
  if (lane === undefined) {
    log(`${id}: skipped (needs a built dist or --browser <dir> with ${id}.json)`);
    continue;
  }
  if (lane.backend.startsWith('browser:')) lane.capture = await browserCapture(lane.capture);
  const size = lane.size ?? SIZE;
  report.pending = { id, size, backend: lane.backend, capture: lane.capture, errors: lane.errors };
  writePfm(resolve(OUT, `${id}-lane-before-reference.pfm`), lane.gi, size, size);
  writePfm(resolve(OUT, `${id}-direct-before-reference.pfm`), lane.direct, size, size);
  writeFileSync(resolve(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  log(`${id}: tracing reference (${SAMPLES} spp)`);
  const reference = await cachedReference(id, size);
  // Raster clears background to black while the reference shades primary misses
  // with the sky, so every metric is restricted to pixels covered by geometry.
  const legacyCovered = Uint8Array.from({ length: size * size }, (_, p) =>
    luminance(lane.gi, p) > 0 || luminance(lane.direct, p) > 0 ? 1 : 0,
  );
  const covered = reference.coverage;
  if (covered?.length !== size * size) throw new Error(`${id}: invalid reference coverage`);
  writeFileSync(resolve(OUT, `${id}-coverage.bin`), covered);
  const giIndirect = subtract(lane.gi, lane.direct);
  const unlit = unlitMask(reference.direct, size, size).map((v, p) => v & covered[p]);
  const coveredMean = (rgb) => {
    let sum = 0;
    let n = 0;
    for (let p = 0; p < size * size; p++)
      if (covered[p]) {
        sum += luminance(rgb, p);
        n += 1;
      }
    return sum / Math.max(1, n);
  };
  const metrics = {
    coverageSource: 'exact pixel-center primary identity; independent of GI brightness',
    coverageSha256: sha256(covered),
    coveredPixels: covered.reduce((a, b) => a + b, 0),
    legacyLaneCoverage: {
      pixels: legacyCovered.reduce((a, b) => a + b, 0),
      all: indirectMetrics(giIndirect, reference.indirect, legacyCovered),
    },
    // Whole-image energy (direct + indirect) of the lane against the displayed reference.
    totalRatio: coveredMean(lane.gi) / Math.max(1e-12, coveredMean(reference.full)),
    all: indirectMetrics(giIndirect, reference.indirect, covered),
    unlit: indirectMetrics(giIndirect, reference.indirect, unlit),
    direct: indirectMetrics(lane.direct, reference.direct, covered),
  };
  if (scene.darkRoom !== undefined) {
    const room = regionMask(scene.darkRoom, size, size);
    const roomMetrics = indirectMetrics(giIndirect, reference.indirect, room);
    metrics.leak = {
      ...roomMetrics,
      excessEnergy: roomMetrics.mean - roomMetrics.referenceMean,
      directInRoom: indirectMetrics(lane.direct, reference.direct, room).referenceMean,
    };
  }
  const exposure = 0.5 / Math.max(1e-4, meanLuminance(reference.full));
  const indirectExposure = 0.5 / Math.max(1e-4, meanLuminance(reference.indirect));
  const files = {};
  const emit = (name, rgb, gain) => {
    writePfm(resolve(OUT, `${id}-${name}.pfm`), rgb, size, size);
    const rgba = toDisplay(rgb, size, size, gain);
    writePng(resolve(OUT, `${id}-${name}.png`), rgba, size, size);
    files[name] = `${id}-${name}.png`;
    return rgba;
  };
  const tiles = [
    { label: `${id} direct`, rgba: emit('direct', lane.direct, exposure) },
    { label: `${id} ${GATHER}`, rgba: emit(GATHER, lane.gi, exposure) },
    { label: `${id} path ref`, rgba: emit('reference', reference.full, exposure) },
    { label: 'indirect lane', rgba: emit(`${GATHER}-indirect`, giIndirect, indirectExposure) },
    {
      label: 'indirect ref',
      rgba: emit('reference-indirect', reference.indirect, indirectExposure),
    },
  ];
  const coveredOnly = (rgb) => rgb.map((v, i) => (covered[Math.floor(i / 3)] ? v : 0));
  const heat = toHeatmap(
    giIndirect,
    coveredOnly(reference.indirect),
    size,
    size,
    2 * metrics.all.referenceMean,
  );
  writePng(resolve(OUT, `${id}-heatmap.png`), heat, size, size);
  files.heatmap = `${id}-heatmap.png`;
  tiles.push({ label: `err ${(metrics.all.relativeRmse * 100).toFixed(0)}% rmse`, rgba: heat });
  sheetRows.push({ size, tiles });
  report.scenes.push({
    id,
    backend: lane.backend,
    devices: lane.devices,
    size,
    lane: { gather: GATHER, bounces: BOUNCES, reflections: REFLECTIONS, windows: lane.windows, inspect: lane.inspect },
    perf: lane.perf,
    metrics,
    gpu: lane.gpu,
    wallMs: { ...lane.wallMs, reference: reference.ms },
    referenceCache: reference.cached,
    capture: lane.capture,
    errors: lane.errors.map((e) => (typeof e === 'string' ? e : (e.code ?? JSON.stringify(e)))),
    files,
  });
  const m = metrics.all;
  log(
    `${id}: indirect lane ${m.mean.toFixed(4)} vs ref ${m.referenceMean.toFixed(4)} ` +
      `(ratio ${m.ratio.toFixed(3)}, relRMSE ${m.relativeRmse.toFixed(3)}), ` +
      `GI GPU ${lane.gpu.gi.giMs?.toFixed?.(2) ?? lane.gpu.gi.status} ms`,
  );
  delete report.pending;
  } catch (error) {
    report.failure = { id, name: error.name, message: error.message,
      code: error.code, expected: error.expected, hint: error.hint, detail: error.detail };
    writeFileSync(resolve(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  }
}

// Tiles of different scene sizes are resampled to the smallest one.
if (sheetRows.length > 0) {
  const tile = Math.min(...sheetRows.map((row) => row.size));
  const resample = (rgba, from) => {
    if (from === tile) return rgba;
    const out = new Uint8Array(tile * tile * 4);
    for (let y = 0; y < tile; y++)
      for (let x = 0; x < tile; x++) {
        const sx = Math.floor((x * from) / tile);
        const sy = Math.floor((y * from) / tile);
        out.set(rgba.subarray((sy * from + sx) * 4, (sy * from + sx) * 4 + 4), (y * tile + x) * 4);
      }
    return out;
  };
  const sheet = contactSheet(
    sheetRows.map((row) => row.tiles.map((t) => ({ ...t, rgba: resample(t.rgba, row.size) }))),
    tile,
    tile,
  );
  writePng(resolve(OUT, 'contact-sheet.png'), sheet.rgba, sheet.width, sheet.height);
  report.contactSheet = 'contact-sheet.png';
}
writeFileSync(resolve(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
log(`wrote ${resolve(OUT, 'report.json')}`);
const failed = report.scenes.length !== SCENES.length || report.scenes.some((scene) =>
  scene.errors.length > 0 || (CAPTURE && (scene.capture?.ok !== true ||
    scene.capture.pixels?.compared !== true || scene.capture.pixels?.maxDiff !== 0 ||
    scene.capture.liveDivergence?.ok !== true ||
    scene.capture.liveDivergence.diverging.length > 0)),
);
process.exit(failed ? 1 : 0);
