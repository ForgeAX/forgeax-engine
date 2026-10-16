#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { decodeTape } from '@forgeax/engine-rhi-debug';
import { bootstrapDawn } from '../../../shared/scripts/rhi-debug-verify.mjs';

// Production-input compose isolation. This diagnostic deliberately keeps the
// real HDR attachment, bind-group shape, viewport, load/store operations, and
// one-command-encoder/one-submit boundary. It only replaces the fragment
// body or draw call so a result can be attributed to shader arithmetic,
// blending/attachment, full-screen raster, or an empty pass.

const inputPath = resolve(process.argv[2] ?? '');
assert.ok(inputPath && existsSync(inputPath), `compose input JSON is missing: ${inputPath}`);
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const tapePath = resolve(dirname(inputPath), 'frame.rhitape');
assert.ok(existsSync(tapePath), `compose tape is missing beside input JSON: ${tapePath}`);
const decodedTape = decodeTape(new Uint8Array(readFileSync(tapePath)));
assert.ok(decodedTape.ok, `compose tape failed strict decode: ${decodedTape.error?.code ?? 'unknown'}`);
const outputPath = resolve(
  process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) ??
    resolve(dirname(inputPath), 'compose-profile.json'),
);
const warmupFrames = Number(
  process.argv.find((arg) => arg.startsWith('--warmup='))?.slice('--warmup='.length) ?? 120,
);
const measurementFrames = Number(
  process.argv.find((arg) => arg.startsWith('--measure='))?.slice('--measure='.length) ?? 60,
);
const serialMode = process.argv.includes('--serial');
assert.ok(Number.isInteger(warmupFrames) && warmupFrames >= 8 && warmupFrames <= 1024);
assert.ok(Number.isInteger(measurementFrames) && measurementFrames >= 8 && measurementFrames <= 1024);

const textureRows = (bytes, width, height, bytesPerPixel) => {
  assert.equal(bytes.byteLength, width * height * bytesPerPixel,
    `tight texture payload has unexpected size for ${width}x${height}`);
  const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
  const padded = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y += 1) {
    padded.set(
      bytes.subarray(y * width * bytesPerPixel, (y + 1) * width * bytesPerPixel),
      y * bytesPerRow,
    );
  }
  return { bytes: padded, bytesPerRow };
};

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readBytes = (entry) => new Uint8Array(readFileSync(entry.path));
const byName = new Map(input.textures.map((entry) => [entry.name, entry]));
for (const name of ['radiance', 'fallback', 'response', 'normal']) {
  assert.ok(byName.has(name), `compose input is missing ${name}`);
}
assert.ok(input.shader?.includes('fn fs_ssr_compose'), 'production compose shader is missing');
const width = byName.get('fallback').levels[0].width;
const height = byName.get('fallback').levels[0].height;
assert.equal(width, 1920, 'the compose diagnostic is intentionally bound to the captured 1920px input');
assert.equal(height, 1080, 'the compose diagnostic is intentionally bound to the captured 1080px input');

const constantShader = (value) => `
struct ComposeVertex { @builtin(position) position: vec4<f32>, }
@group(0) @binding(0) var radiance: texture_2d<f32>;
@group(0) @binding(1) var fallback: texture_2d<f32>;
@group(0) @binding(2) var response: texture_2d<f32>;
@group(0) @binding(3) var normalRoughness: texture_2d<f32>;
@group(0) @binding(4) var radianceSampler: sampler;
struct View { data: array<vec4<f32>, 60>, }
@group(0) @binding(5) var<uniform> view: View;
@vertex fn vs_ssr_compose(@builtin(vertex_index) index: u32) -> ComposeVertex {
  let x = select(-1.0, 3.0, index == 1u);
  let y = select(-1.0, 3.0, index == 2u);
  return ComposeVertex(vec4<f32>(x, y, 0.0, 1.0));
}
@fragment fn fs_ssr_compose(in: ComposeVertex) -> @location(0) vec4<f32> {
  return vec4<f32>(${value}, 0.0);
}
`;

const percentiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return { p50Ms: at(0.5), p95Ms: at(0.95), meanMs: mean, sampleCount: values.length };
};

const backend = await bootstrapDawn('SSR compose isolation', {
  ...decodedTape.value,
});
// The production tape did not request timestamp-query because timing is an
// optional observer. Re-request the same Dawn adapter with that one diagnostic
// feature enabled so the control comparison has real GPU timestamps.
const adapter = (await backend.rhiWebgpu.rhi.requestAdapter()).unwrap();
assert.ok(adapter.features.has('timestamp-query'), 'Dawn adapter does not expose timestamp-query');
backend.freshDevice.destroy?.();
const device = (await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })).unwrap();
const periodNs = device.caps.timestampPeriodNanoseconds;
assert.ok(device.caps.timestampQuery === true && Number.isFinite(periodNs) && periodNs > 0,
  'compose isolation requires Dawn timestamp-query evidence');

const makeTexture = (label, format, size, mipLevelCount = 1) => device.createTexture({
  label,
  size: { width: size.width, height: size.height, depthOrArrayLayers: 1 },
  mipLevelCount,
  format,
  usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
}).unwrap();

const uploads = [];
const radianceEntry = byName.get('radiance');
const radiance = makeTexture('compose-profile-radiance', 'rgba16float', radianceEntry.levels[0], radianceEntry.levels.length);
for (let level = 0; level < radianceEntry.levels.length; level += 1) {
  const row = radianceEntry.levels[level];
  const bytes = readBytes(row);
  const padded = textureRows(bytes, row.width, row.height, 8);
  device.queue.writeTexture(
    { texture: radiance, mipLevel: level, origin: [0, 0, 0] },
    padded.bytes,
    { offset: 0, bytesPerRow: padded.bytesPerRow, rowsPerImage: row.height },
    { width: row.width, height: row.height, depthOrArrayLayers: 1 },
  ).unwrap();
}
const fullTextures = {};
for (const name of ['fallback', 'response', 'normal']) {
  const entry = byName.get(name).levels[0];
  const texture = makeTexture(`compose-profile-${name}`, 'rgba16float', entry);
  const bytes = readBytes(entry);
  const padded = textureRows(bytes, entry.width, entry.height, 8);
  device.queue.writeTexture(
    { texture, mipLevel: 0, origin: [0, 0, 0] },
    padded.bytes,
    { offset: 0, bytesPerRow: padded.bytesPerRow, rowsPerImage: entry.height },
    { width: entry.width, height: entry.height, depthOrArrayLayers: 1 },
  ).unwrap();
  fullTextures[name] = texture;
}
const viewBytes = readBytes(input.view);
assert.equal(viewBytes.byteLength % 16, 0, 'view UBO must preserve 16-byte lanes');
const viewBuffer = device.createBuffer({
  label: 'compose-profile-view',
  size: Math.max(256, viewBytes.byteLength),
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
}).unwrap();
device.queue.writeBuffer(viewBuffer, 0, viewBytes).unwrap();

const radianceView = device.createTextureView(radiance, {
  baseMipLevel: 0,
  mipLevelCount: radianceEntry.levels.length,
}).unwrap();
const fullViews = Object.fromEntries(
  Object.entries(fullTextures).map(([name, texture]) => [name, device.createTextureView(texture, {}).unwrap()]),
);
const sampler = device.createSampler({
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
  minFilter: 'linear',
  magFilter: 'linear',
  mipmapFilter: 'linear',
}).unwrap();
const layout = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
  { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
  { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
]}).unwrap();
const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
const bindGroup = device.createBindGroup({
  layout,
  entries: [
    { binding: 0, resource: { kind: 'textureView', value: radianceView } },
    { binding: 1, resource: { kind: 'textureView', value: fullViews.fallback } },
    { binding: 2, resource: { kind: 'textureView', value: fullViews.response } },
    { binding: 3, resource: { kind: 'textureView', value: fullViews.normal } },
    { binding: 4, resource: { kind: 'sampler', value: sampler } },
    { binding: 5, resource: { kind: 'buffer', value: { buffer: viewBuffer } } },
  ],
}).unwrap();

const makeModule = async (code, label) => (await backend.rhiWebgpu.createShaderModule(device, { code, label })).unwrap();
const productionModule = await makeModule(input.shader, 'ssr-compose-profile-production');
const constantModule = await makeModule(constantShader('0.001, 0.001, 0.001'), 'ssr-compose-profile-constant');
const markerModule = await makeModule(`
@compute @workgroup_size(1) fn cs_ssr_compose_marker() {}
`, 'ssr-compose-profile-marker');
const markerPipeline = device.createComputePipeline({
  label: 'ssr-compose-profile-marker',
  layout: 'auto',
  compute: { module: markerModule, entryPoint: 'cs_ssr_compose_marker' },
}).unwrap();
const makePipeline = (module, blend) => device.createRenderPipeline({
  label: `ssr-compose-profile-${blend ? 'blend' : 'opaque'}`,
  layout: pipelineLayout,
  vertex: { module, entryPoint: 'vs_ssr_compose', buffers: [] },
  fragment: {
    module,
    entryPoint: 'fs_ssr_compose',
    targets: [{
      format: 'rgba16float',
      ...(blend ? { blend: {
        color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
        alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
      } } : {}),
    }],
  },
  primitive: { topology: 'triangle-list' },
}).unwrap();
const pipelines = {
  P: makePipeline(productionModule, true),
  B: makePipeline(constantModule, true),
  W: makePipeline(constantModule, false),
};

const initTarget = (label) => {
  const texture = makeTexture(label, 'rgba16float', { width, height });
  const view = device.createTextureView(texture, {}).unwrap();
  const encoder = device.createCommandEncoder({ label: `${label}-init` }).unwrap();
  const pass = encoder.beginRenderPass({ colorAttachments: [{
    view,
    loadOp: 'clear',
    storeOp: 'store',
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
  }] });
  pass.end();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  return { texture, view };
};

const resetTarget = async (source, target) => {
  const encoder = device.createCommandEncoder({ label: 'compose-profile-reset' }).unwrap();
  encoder.copyTextureToTexture(
    { texture: source.texture, mipLevel: 0, origin: [0, 0, 0] },
    { texture: target.texture, mipLevel: 0, origin: [0, 0, 0] },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
};

const runControl = async (control) => {
  // Keep one target per control, but restore it from an initialized seed before
  // measurement. This preserves the production loadOp=load contract without
  // letting additive accumulation or stale tile contents change later trials.
  const seed = initTarget(`compose-profile-${control}-seed`);
  const target = initTarget(`compose-profile-${control}`);
  const querySet = device.createQuerySet({ type: 'timestamp', count: 4 }).unwrap();
  const resolveBytes = 256;
  const resolve = device.createBuffer({
    label: `compose-profile-${control}-resolve`,
    size: resolveBytes,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  }).unwrap();
  const readback = device.createBuffer({
    label: `compose-profile-${control}-readback`,
    size: resolveBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  }).unwrap();
  const encodeBatch = (count, timed) => {
    const encoder = device.createCommandEncoder({ label: `compose-profile-${control}-${timed ? 'measure' : 'warmup'}` }).unwrap();
    if (timed) {
      // Dawn requires beginning/end indices to be present on the same pass.
      // Empty compute markers bracket the render-pass batch without adding a
      // color attachment load/store or relying on unsupported encoder-level
      // writeTimestamp commands.
      const start = encoder.beginComputePass({
        label: `compose-profile-${control}-start-marker`,
        timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
      });
      start.setPipeline(markerPipeline);
      start.dispatchWorkgroups(1);
      start.end();
    }
    for (let frame = 0; frame < count; frame += 1) {
      const descriptor = {
        colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }],
      };
      const pass = encoder.beginRenderPass(descriptor);
      if (control !== 'E') {
        pass.setPipeline(pipelines[control]);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
      }
      pass.end();
    }
    if (timed) {
      const end = encoder.beginComputePass({
        label: `compose-profile-${control}-end-marker`,
        timestampWrites: { querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 },
      });
      end.setPipeline(markerPipeline);
      end.dispatchWorkgroups(1);
      end.end();
      encoder.resolveQuerySet(querySet, 0, 4, resolve, 0).unwrap();
      encoder.copyBufferToBuffer(resolve, 0, readback, 0, 32);
    }
    return encoder.finish().unwrap();
  };
  await device.queue.onSubmittedWorkDone();
  device.queue.submit([encodeBatch(warmupFrames, false)]).unwrap();
  await device.queue.onSubmittedWorkDone();
  await resetTarget(seed, target);
  const wallStart = performance.now();
  device.queue.submit([encodeBatch(measurementFrames, true)]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const wallMs = performance.now() - wallStart;
  const mapped = (await readback.mapAsync(GPUMapMode.READ)).unwrap();
  const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
  mapped.unmap();
  const view = new DataView(bytes.buffer, bytes.byteOffset, 32);
  const ticks = [0, 1, 2, 3].map((index) => view.getBigUint64(index * 8, true));
  assert.ok(ticks[1] >= ticks[0] && ticks[2] >= ticks[1] && ticks[3] >= ticks[2], `${control} batch timestamp order is invalid`);
  const gpuMs = Number(ticks[2] - ticks[1]) * periodNs / 1e6;
  return {
    control,
    warmupFrames,
    measurementFrames,
    timestampPeriodNanoseconds: periodNs,
    rawTicks: { startBegin: ticks[0].toString(10), startEnd: ticks[1].toString(10), endBegin: ticks[2].toString(10), endEnd: ticks[3].toString(10) },
    timing: {
      gpuBatchMs: gpuMs,
      gpuPerPassMs: gpuMs / measurementFrames,
      wallBatchMs: wallMs,
      wallPerPassMs: wallMs / measurementFrames,
      throughputPassesPerSecond: measurementFrames / Math.max(wallMs, 1e-6) * 1000,
    },
  };
};

const runSerialControl = async (control) => {
  // A serial control is intentionally separate from the batch probe. Each
  // measured render pass gets a fresh copy of the same captured attachment,
  // one queue submission, one completion fence, and one timestamp pair. This
  // is the latency-oriented cross-check for the batch-throughput envelope;
  // it must not be mixed with the batch samples above.
  const seed = initTarget(`compose-profile-${control}-serial-seed`);
  const target = initTarget(`compose-profile-${control}-serial`);
  await device.queue.onSubmittedWorkDone();
  const querySet = device.createQuerySet({ type: 'timestamp', count: 2 }).unwrap();
  const resolve = device.createBuffer({
    label: `compose-profile-${control}-serial-resolve`,
    size: 256,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  }).unwrap();
  const readback = device.createBuffer({
    label: `compose-profile-${control}-serial-readback`,
    size: 256,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  }).unwrap();
  const gpuSamples = [];
  const wallSamples = [];
  const runOne = async (timed) => {
    await resetTarget(seed, target);
    const encoder = device.createCommandEncoder({
      label: `compose-profile-${control}-serial-${timed ? 'measure' : 'warmup'}`,
    }).unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }],
      ...(timed ? { timestampWrites: {
        querySet,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      } } : {}),
    });
    if (control !== 'E') {
      pass.setPipeline(pipelines[control]);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
    }
    pass.end();
    if (timed) {
      encoder.resolveQuerySet(querySet, 0, 2, resolve, 0).unwrap();
      encoder.copyBufferToBuffer(resolve, 0, readback, 0, 16);
    }
    const commandBuffer = encoder.finish().unwrap();
    const wallStart = performance.now();
    device.queue.submit([commandBuffer]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const wallMs = performance.now() - wallStart;
    if (!timed) return;
    const mapped = (await readback.mapAsync(GPUMapMode.READ)).unwrap();
    const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
    const begin = view.getBigUint64(0, true);
    const end = view.getBigUint64(8, true);
    assert.ok(end >= begin, `${control} serial timestamp order is invalid`);
    gpuSamples.push(Number(end - begin) * periodNs / 1e6);
    wallSamples.push(wallMs);
  };
  const serialWarmup = Math.min(warmupFrames, 32);
  for (let index = 0; index < serialWarmup; index += 1) await runOne(false);
  for (let index = 0; index < measurementFrames; index += 1) await runOne(true);
  const gpu = percentiles(gpuSamples);
  const wall = percentiles(wallSamples);
  return {
    control,
    warmupFrames: serialWarmup,
    measurementFrames,
    timestampPeriodNanoseconds: periodNs,
    timing: {
      gpu,
      wall,
      // Each serial sample contains exactly one submit->completion interval;
      // `wall.meanMs` is already the per-sample mean, so do not multiply by
      // the number of samples a second time.
      throughputPassesPerSecond: 1000 / Math.max(wall.meanMs, 1e-6),
    },
  };
};

const orderResults = {};
if (serialMode) {
  for (const control of ['P', 'B', 'W', 'E']) orderResults[control] = await runSerialControl(control);
} else {
  for (const order of [['P', 'B', 'W', 'E'], ['E', 'W', 'B', 'P']]) {
    const key = order.join('');
    orderResults[key] = {};
    for (const control of order) orderResults[key][control] = await runControl(control);
  }
}
const report = {
  schemaVersion: 'hello-ssr-compose-profile/1',
  input: {
    path: inputPath,
    artifactDigest: input.artifactDigest,
    workIndex: input.workIndex,
    shaderDigest: digest(Buffer.from(input.shader)),
    width,
    height,
    radianceLevels: radianceEntry.levels.map(({ width: levelWidth, height: levelHeight }) => ({ width: levelWidth, height: levelHeight })),
  },
  device: {
    backend: device.caps.backendKind,
    adapter: device.caps.adapter,
    timestampQuery: device.caps.timestampQuery,
    timestampPeriodNanoseconds: periodNs,
  },
  protocol: {
    controls: {
      P: 'production compose shader + additive blend',
      B: 'constant nonzero fragment + additive blend',
      W: 'constant nonzero fragment + no blend',
      E: 'same load/store attachment, no draw',
    },
    attachment: { format: 'rgba16float', width, height, loadOp: 'load', storeOp: 'store' },
    mode: serialMode ? 'serial-single-submit' : 'batch-envelope',
    order: serialMode ? ['P', 'B', 'W', 'E'] : ['P,B,W,E', 'E,W,B,P'],
    warmupFrames,
    measurementFrames,
  },
  results: orderResults,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outputPath, report: {
  input: report.input,
  device: report.device,
  timings: Object.fromEntries(Object.entries(orderResults).map(([order, rows]) => [order,
    serialMode ? rows.timing : Object.fromEntries(Object.entries(rows).map(([control, row]) => [control, row.timing]))])),
} }, null, 2));
device.destroy?.();
process.exit(0);
